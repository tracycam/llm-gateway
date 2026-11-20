import { Database } from 'bun:sqlite';
import { localDay } from './period';
import { rollKeyPeriod } from './keyStore';
import type { Usage } from './pricing';
import type {
  RequestLogRow,
  UsageByDayRow,
  UsageByKeyRow,
  UsageByModelRow,
  UsageByProviderRow,
  UsageSummary,
  UsageTotals,
} from './shared/api';

// `UsageSummary` crosses the management API; shared/api.ts defines it once and this module
// re-exports it under its current name.
export type { UsageSummary };

export interface UsageEntry {
  protocol: string;
  /** The request's `gen-` id; null for rows written before version 11 or by other callers. */
  requestId?: string;
  key: { id: string; name: string };
  model: { id: string; name: string };
  provider: { id: string; name: string } | null;
  upstreamModel: string | null;
  status: number;
  usage: Usage | null;
  cost: number | null;
  ttftMs: number | null;
  latencyMs: number;
  error: string | null;
}

/** What GET /v1/generation answers for one request of one key. */
export interface GenerationRow {
  requestId: string;
  modelName: string;
  providerName: string | null;
  upstreamModel: string | null;
  protocol: string;
  status: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cost: number | null;
  latencyMs: number;
  ttftMs: number | null;
  timestamp: string;
  error: string | null;
}
export interface DayRange {
  from?: string;
  to?: string;
}
interface SummaryRow {
  id: string;
  name: string;
  requests: number;
  errors: number;
  unknown_usage: number;
  uncosted: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost: number;
}
interface TotalRow {
  request_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
}
interface LogRow {
  id: number;
  timestamp: string;
  protocol: string;
  key_name: string;
  model_name: string;
  provider_name: string | null;
  upstream_model: string | null;
  status: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost: number | null;
  ttft_ms: number | null;
  latency_ms: number;
  error: string | null;
}

interface GenerationDbRow {
  request_id: string;
  model_name: string;
  provider_name: string | null;
  upstream_model: string | null;
  protocol: string;
  status: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost: number | null;
  latency_ms: number;
  ttft_ms: number | null;
  timestamp: string;
  error: string | null;
}

/** The table that holds the current name of what a usage column refers to. */
const LIVE_TABLE = { model_id: 'models', provider_id: 'providers', key_id: 'api_keys' } as const;

/**
 * The name to show for a group: the current one while the model, provider or key exists,
 * otherwise the one recorded with its most recent usage.
 */
function nameOf(id: 'model_id' | 'provider_id' | 'key_id' | 'day', name: string): string {
  if (id === 'day') return 'day';
  const recorded = `(SELECT latest.${name} FROM usage_daily latest WHERE latest.${id} = grouped.${id}
    ORDER BY latest.day DESC LIMIT 1)`;
  return `COALESCE((SELECT live.name FROM ${LIVE_TABLE[id]} live WHERE live.id = grouped.${id}), ${recorded})`;
}

function mapSummary(row: SummaryRow): UsageSummary {
  return {
    requests: row.requests,
    errors: row.errors,
    unknownUsage: row.unknown_usage,
    uncosted: row.uncosted,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cost: row.cost,
  };
}

export class UsageStore {
  constructor(private readonly db: Database) {}

  record(entry: UsageEntry, now: Date): void {
    this.db.transaction(() => {
      rollKeyPeriod(this.db, entry.key.id, now);
      const u = entry.usage;
      const cost = entry.cost ?? 0;
      // A failed request has nothing to count; only an answered one can be missing its figures.
      const answered = entry.status < 400;
      const allInput = u === null ? 0 : u.inputTokens + u.cacheReadTokens;
      this.db.query(`INSERT INTO usage_daily (day, key_id, key_name, model_id, model_name,
        provider_id, provider_name, requests, errors, unknown_usage, uncosted,
        input_tokens, output_tokens, cache_read_tokens, cost)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, key_id, model_id, provider_id) DO UPDATE SET
          key_name = excluded.key_name, model_name = excluded.model_name,
          provider_name = excluded.provider_name, requests = requests + 1,
          errors = errors + excluded.errors, unknown_usage = unknown_usage + excluded.unknown_usage,
          uncosted = uncosted + excluded.uncosted, input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
          cost = cost + excluded.cost`)
        .run(localDay(now), entry.key.id, entry.key.name, entry.model.id, entry.model.name,
          entry.provider?.id ?? '', entry.provider?.name ?? '', Number(!answered),
          Number(answered && u === null), Number(answered && entry.cost === null),
          u?.inputTokens ?? 0, u?.outputTokens ?? 0,
          u?.cacheReadTokens ?? 0, cost);
      this.db.query(`UPDATE api_keys SET request_count = request_count + 1,
        prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?,
        period_cost = period_cost + ?, total_cost = total_cost + ?, last_used_at = ? WHERE id = ?`)
        .run(allInput, u?.outputTokens ?? 0, cost, cost, now.toISOString(), entry.key.id);
      this.db.query(`UPDATE gateway_totals SET request_count = request_count + 1,
        prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?, cost = cost + ? WHERE id = 1`)
        .run(allInput, u?.outputTokens ?? 0, cost);
      this.db.query(`INSERT INTO request_logs (timestamp, protocol, key_name, model_name, provider_name,
        upstream_model, status, input_tokens, output_tokens, cache_read_tokens,
        cost, ttft_ms, latency_ms, error, request_id, key_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(now.toISOString(), entry.protocol, entry.key.name, entry.model.name, entry.provider?.name ?? null,
          entry.upstreamModel, entry.status, u?.inputTokens ?? null, u?.outputTokens ?? null,
          u?.cacheReadTokens ?? null, entry.cost, entry.ttftMs,
          entry.latencyMs, entry.error, entry.requestId ?? null, entry.key.id);
      this.db.exec('DELETE FROM request_logs WHERE id NOT IN (SELECT id FROM request_logs ORDER BY id DESC LIMIT 200)');
    })();
  }

  byModel(range: DayRange = {}): UsageByModelRow[] {
    return this.summarize('model_id', 'model_name', range).map((row) => ({
      modelId: row.id,
      modelName: row.name,
      ...mapSummary(row),
    }));
  }

  byProvider(modelId: string, range: DayRange = {}): UsageByProviderRow[] {
    return this.summarize('provider_id', 'provider_name', range, { modelId }).map((row) => ({
      providerId: row.id,
      providerName: row.name,
      ...mapSummary(row),
    }));
  }

  byKey(range: DayRange = {}): UsageByKeyRow[] {
    return this.summarize('key_id', 'key_name', range).map((row) => ({
      keyId: row.id,
      keyName: row.name,
      ...mapSummary(row),
    }));
  }

  byDay(range: DayRange = {}, filter: { modelId?: string; keyId?: string } = {}): UsageByDayRow[] {
    return this.summarize('day', 'day', range, filter).map((row) => ({ day: row.id, ...mapSummary(row) }));
  }

  totals(): UsageTotals {
    const row = this.db.query<TotalRow, []>('SELECT * FROM gateway_totals WHERE id = 1').get()!;
    return { requestCount: row.request_count, inputTokens: row.prompt_tokens, outputTokens: row.completion_tokens, cost: row.cost };
  }

  logs(): RequestLogRow[] {
    return this.db.query<LogRow, []>('SELECT * FROM request_logs ORDER BY id DESC LIMIT 200').all().map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      protocol: row.protocol,
      keyName: row.key_name,
      modelName: row.model_name,
      providerName: row.provider_name,
      upstreamModel: row.upstream_model,
      status: row.status,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cost: row.cost,
      ttftMs: row.ttft_ms,
      latencyMs: row.latency_ms,
      error: row.error,
    }));
  }

  clearLogs(): void {
    this.db.exec('DELETE FROM request_logs');
  }

  /**
   * The log row of one request of one key. `request_logs` keeps only the last 200 requests, so a
   * row that has rotated out is indistinguishable from an unknown id: both answer null.
   */
  generation(requestId: string, keyId: string): GenerationRow | null {
    const row = this.db.query<GenerationDbRow, [string, string]>(`SELECT request_id, model_name,
      provider_name, upstream_model, protocol, status, input_tokens, output_tokens,
      cache_read_tokens, cost, latency_ms, ttft_ms, timestamp, error
      FROM request_logs WHERE request_id = ? AND key_id = ? ORDER BY id DESC LIMIT 1`)
      .get(requestId, keyId);
    if (!row) return null;
    return {
      requestId: row.request_id,
      modelName: row.model_name,
      providerName: row.provider_name,
      upstreamModel: row.upstream_model,
      protocol: row.protocol,
      status: row.status,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cost: row.cost,
      latencyMs: row.latency_ms,
      ttftMs: row.ttft_ms,
      timestamp: row.timestamp,
      error: row.error,
    };
  }

  private summarize(
    id: 'model_id' | 'provider_id' | 'key_id' | 'day',
    name: 'model_name' | 'provider_name' | 'key_name' | 'day',
    range: DayRange,
    filter: { modelId?: string; keyId?: string } = {}
  ): SummaryRow[] {
    const where = '(:from IS NULL OR day >= :from) AND (:to IS NULL OR day <= :to)'
      + ' AND (:model IS NULL OR model_id = :model) AND (:key IS NULL OR key_id = :key)';
    return this.db.query<SummaryRow, {
      ':from': string | null;
      ':to': string | null;
      ':model': string | null;
      ':key': string | null;
    }>(`SELECT ${id} AS id, ${nameOf(id, name)} AS name,
      SUM(requests) AS requests, SUM(errors) AS errors, SUM(unknown_usage) AS unknown_usage,
      SUM(uncosted) AS uncosted, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens, SUM(cost) AS cost FROM usage_daily grouped
      WHERE ${where} GROUP BY ${id} ORDER BY ${id}`)
      .all({ ':from': range.from ?? null, ':to': range.to ?? null,
        ':model': filter.modelId ?? null, ':key': filter.keyId ?? null });
  }
}
