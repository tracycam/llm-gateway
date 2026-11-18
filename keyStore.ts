import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { nextReset, periodStart, type ResetPeriod } from './period';
import type { Price } from './pricing';
import type { ModelRecord } from './modelStore';

export interface KeyRecord {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  restricted: boolean;
  modelIds: string[];
  costLimit: number | null;
  resetPeriod: ResetPeriod;
  periodStart: string;
  periodCost: number;
  nextResetAt: string | null;
  maxConcurrency: number | null;
  expiresAt: string | null;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface KeyInput {
  name: string;
  restricted?: boolean;
  modelIds?: string[];
  costLimit?: number | null;
  resetPeriod?: ResetPeriod;
  maxConcurrency?: number | null;
  expiresAt?: string | null;
}
export interface KeyPatch {
  name?: string;
  enabled?: boolean;
  restricted?: boolean;
  modelIds?: string[];
  costLimit?: number | null;
  resetPeriod?: ResetPeriod;
  maxConcurrency?: number | null;
  expiresAt?: string | null;
}
interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  enabled: number;
  restricted: number;
  cost_limit: number | null;
  reset_period: ResetPeriod;
  period_start: string;
  period_cost: number;
  max_concurrency: number | null;
  expires_at: string | null;
  request_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_cost: number;
  last_used_at: string | null;
  created_at: string;
}
interface ModelIdRow {
  model_id: string;
}
interface PeriodRow {
  reset_period: ResetPeriod;
  period_start: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function rollKeyPeriod(db: Database, id: string, now: Date): void {
  const row = db.query<PeriodRow, [string]>(
    'SELECT reset_period, period_start FROM api_keys WHERE id = ?'
  ).get(id);
  if (!row) return;
  const start = periodStart(row.reset_period, now);
  if (start && Date.parse(row.period_start) < start.getTime()) {
    db.query('UPDATE api_keys SET period_start = ?, period_cost = 0 WHERE id = ?')
      .run(start.toISOString(), id);
  }
}

export class KeyStore {
  constructor(private readonly db: Database) {}

  create(input: KeyInput, now: Date): KeyRecord & { token: string } {
    const token = `sk-gw-${randomBytes(16).toString('hex')}`;
    const id = `key-${randomBytes(6).toString('hex')}`;
    const prefix = `${token.slice(0, 12)}...${token.slice(-4)}`;
    const period = input.resetPeriod ?? 'none';
    this.db.transaction(() => {
      this.db.query(`INSERT INTO api_keys (id, name, token_hash, prefix, created_at, restricted,
        cost_limit, reset_period, period_start, max_concurrency, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.name.trim() || '未命名密钥', hashToken(token), prefix, now.toISOString(),
        Number(input.restricted ?? false), input.costLimit ?? null, period,
        (periodStart(period, now) ?? now).toISOString(), input.maxConcurrency ?? null, input.expiresAt ?? null
      );
      this.replaceModels(id, input.modelIds ?? []);
    })();
    return { ...this.get(id, now)!, token };
  }

  update(id: string, patch: KeyPatch, now: Date): KeyRecord | null {
    return this.db.transaction(() => {
      const old = this.get(id, now);
      if (!old) return null;
      const period = patch.resetPeriod ?? old.resetPeriod;
      const start = period !== old.resetPeriod ? (periodStart(period, now) ?? now).toISOString() : old.periodStart;
      this.db.query(`UPDATE api_keys SET name = ?, enabled = ?, restricted = ?, cost_limit = ?,
        reset_period = ?, period_start = ?, max_concurrency = ?, expires_at = ? WHERE id = ?`)
        .run(patch.name ?? old.name, Number(patch.enabled ?? old.enabled), Number(patch.restricted ?? old.restricted),
          patch.costLimit === undefined ? old.costLimit : patch.costLimit, period, start,
          patch.maxConcurrency === undefined ? old.maxConcurrency : patch.maxConcurrency,
          patch.expiresAt === undefined ? old.expiresAt : patch.expiresAt, id);
      if (patch.modelIds !== undefined) this.replaceModels(id, patch.modelIds);
      return this.get(id, now);
    })();
  }

  resetUsage(id: string, now: Date): KeyRecord | null {
    const key = this.get(id, now);
    if (!key) return null;
    this.db.query('UPDATE api_keys SET period_cost = 0, period_start = ? WHERE id = ?')
      .run(key.resetPeriod === 'none' ? now.toISOString() : key.periodStart, id);
    return this.get(id, now);
  }

  list(now: Date): KeyRecord[] {
    return this.db.transaction(() => {
      const rows = this.db.query<KeyRow, []>('SELECT * FROM api_keys ORDER BY created_at, id').all();
      return rows.map((row) => this.get(row.id, now)!);
    })();
  }

  get(id: string, now: Date): KeyRecord | null {
    rollKeyPeriod(this.db, id, now);
    const row = this.db.query<KeyRow, [string]>('SELECT * FROM api_keys WHERE id = ?').get(id);
    return row ? this.map(row, now) : null;
  }

  verify(token: string, now: Date): { key: KeyRecord } | { refused: 'unknown' | 'disabled' | 'expired' } {
    const row = this.db.query<KeyRow, [string]>('SELECT * FROM api_keys WHERE token_hash = ?').get(hashToken(token));
    if (!row) return { refused: 'unknown' };
    const key = this.get(row.id, now)!;
    if (!key.enabled) return { refused: 'disabled' };
    if (key.expiresAt !== null && Date.parse(key.expiresAt) <= now.getTime()) return { refused: 'expired' };
    return { key };
  }

  mayUse(key: KeyRecord, modelId: string): boolean {
    return !key.restricted || key.modelIds.includes(modelId);
  }

  overLimit(key: KeyRecord): boolean {
    return key.costLimit !== null && key.periodCost >= key.costLimit;
  }

  refusalFor(key: KeyRecord, model: ModelRecord, routePrices: Price[]):
    'forbidden-model' | 'unpriced-model' | 'over-limit' | null {
    if (!this.mayUse(key, model.id)) return 'forbidden-model';
    if (key.costLimit !== null && routePrices.some((price) => price.input === null || price.output === null)) {
      return 'unpriced-model';
    }
    if (this.overLimit(key)) return 'over-limit';
    return null;
  }

  delete(id: string): boolean {
    return this.db.query('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0;
  }

  private replaceModels(id: string, models: string[]): void {
    this.db.query('DELETE FROM key_models WHERE key_id = ?').run(id);
    const insert = this.db.query('INSERT INTO key_models (key_id, model_id) VALUES (?, ?)');
    for (const model of models) insert.run(id, model);
  }

  private map(row: KeyRow, now: Date): KeyRecord {
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      enabled: row.enabled !== 0,
      restricted: row.restricted !== 0,
      modelIds: this.db.query<ModelIdRow, [string]>(
        'SELECT model_id FROM key_models WHERE key_id = ? ORDER BY model_id'
      ).all(row.id).map((model) => model.model_id),
      costLimit: row.cost_limit,
      resetPeriod: row.reset_period,
      periodStart: row.period_start,
      periodCost: row.period_cost,
      nextResetAt: nextReset(row.reset_period, now)?.toISOString() ?? null,
      maxConcurrency: row.max_concurrency,
      expiresAt: row.expires_at,
      requestCount: row.request_count,
      inputTokens: row.prompt_tokens,
      outputTokens: row.completion_tokens,
      totalCost: row.total_cost,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
    };
  }
}
