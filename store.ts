import { Database } from 'bun:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const SCHEMA_VERSION = 2;

const API_KEYS_DDL = (table: string) => `
  CREATE TABLE ${table} (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL
  );`;

export interface GatewayKeyRecord {
  id: string;
  name: string;
  prefix: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export type CreatedGatewayKey = GatewayKeyRecord & { token: string };

export interface GatewayRequestLog {
  id: number;
  timestamp: string;
  protocol: 'openai' | 'anthropic';
  model: string;
  keyName: string;
  promptTokens: number;
  completionTokens: number;
  ttftMs: number | null;
  latencyMs: number;
  status: number;
}

export interface GatewayConfig {
  requireAuth: boolean;
}

interface RawKeyRow {
  id: string;
  name: string;
  prefix: string;
  request_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  last_used_at: string | null;
  created_at: string;
}

interface RawLogRow {
  id: number;
  timestamp: string;
  protocol: 'openai' | 'anthropic';
  model: string;
  key_name: string;
  prompt_tokens: number;
  completion_tokens: number;
  ttft_ms: number | null;
  latency_ms: number;
  status: number;
}

export class GatewayStore {
  private db: Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, 'gateway.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.initSchema();
  }

  private initSchema(): void {
    this.migrateApiKeys();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_config (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        protocol TEXT NOT NULL,
        model TEXT NOT NULL,
        key_name TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        ttft_ms INTEGER,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        status INTEGER NOT NULL DEFAULT 200
      );
    `);
    this.migrateTotals();

    const authRow = this.db
      .query("SELECT v FROM gateway_config WHERE k = 'require_auth'")
      .get() as { v: string } | null;
    if (!authRow) {
      this.db
        .query("INSERT INTO gateway_config (k, v) VALUES ('require_auth', '1')")
        .run();
    }
  }

  /**
   * Schema v1 stores only sha256(token). Version 0 is a fresh file, a legacy
   * table with a plaintext `token` column, or a rebuild whose purge was
   * interrupted; all three converge here.
   */
  private migrateApiKeys(): void {
    const { user_version: version } = this.db
      .query('PRAGMA user_version')
      .get() as { user_version: number };
    if (version > SCHEMA_VERSION) {
      throw new Error(`Unsupported gateway database version: ${version}`);
    }
    if (version >= 1) return;

    const columns = (
      this.db.query('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>
    ).map((c) => c.name);

    if (columns.length === 0) {
      this.db.exec(API_KEYS_DDL('api_keys'));
    } else if (columns.includes('token')) {
      this.db.transaction(() => {
        this.db.exec(API_KEYS_DDL('api_keys_v1'));
        const legacy = this.db
          .query('SELECT * FROM api_keys')
          .all() as Array<RawKeyRow & { token: string }>;
        const insert = this.db.query(
          'INSERT INTO api_keys_v1 (id, name, token_hash, prefix, request_count, prompt_tokens, completion_tokens, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        for (const row of legacy) {
          insert.run(
            row.id, row.name, hashToken(row.token), row.prefix, row.request_count,
            row.prompt_tokens, row.completion_tokens, row.last_used_at, row.created_at
          );
        }
        this.db.exec('DROP TABLE api_keys; ALTER TABLE api_keys_v1 RENAME TO api_keys;');
      })();
    } else if (!columns.includes('token_hash')) {
      throw new Error('Unrecognized gateway api_keys schema');
    }

    // Dropped rows still sit in free pages and in the WAL. Rewrite the file and
    // fold the WAL back in before declaring v1, so an interrupted purge reruns.
    this.db.exec('VACUUM');
    const { busy } = this.db
      .query('PRAGMA wal_checkpoint(TRUNCATE)')
      .get() as { busy: number };
    if (busy) throw new Error('Gateway database WAL checkpoint was blocked');
    this.db.exec('PRAGMA user_version = 1');
  }

  private migrateTotals(): void {
    const { user_version: version } = this.db
      .query('PRAGMA user_version')
      .get() as { user_version: number };
    if (version >= 2) return;

    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS gateway_totals (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          request_count INTEGER NOT NULL,
          prompt_tokens INTEGER NOT NULL,
          completion_tokens INTEGER NOT NULL
        );
      `);
      // Older logs were already trimmed, so this seed is a lower bound on the true totals.
      this.db.exec(`
        INSERT OR IGNORE INTO gateway_totals (id, request_count, prompt_tokens, completion_tokens)
        SELECT 1, COUNT(*), COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0) FROM request_logs;
        PRAGMA user_version = 2;
      `);
    })();
  }

  public close(): void {
    this.db.close();
  }

  public getConfig(): GatewayConfig {
    const row = this.db
      .query("SELECT v FROM gateway_config WHERE k = 'require_auth'")
      .get() as { v: string } | null;
    return { requireAuth: row ? row.v !== '0' : true };
  }

  public setRequireAuth(requireAuth: boolean): GatewayConfig {
    this.db
      .query(
        "INSERT INTO gateway_config (k, v) VALUES ('require_auth', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
      )
      .run(requireAuth ? '1' : '0');
    return { requireAuth };
  }

  public verifyToken(rawToken: string): GatewayKeyRecord | 'anonymous' | null {
    const cfg = this.getConfig();
    if (!rawToken) {
      return cfg.requireAuth ? null : 'anonymous';
    }
    const row = this.db
      .query('SELECT * FROM api_keys WHERE token_hash = ?')
      .get(hashToken(rawToken)) as RawKeyRow | null;
    if (!row) {
      return cfg.requireAuth ? null : 'anonymous';
    }
    return this.mapKeyRow(row);
  }

  public listKeys(): GatewayKeyRecord[] {
    const rows = this.db
      .query('SELECT * FROM api_keys ORDER BY created_at ASC')
      .all() as RawKeyRow[];
    return rows.map((r) => this.mapKeyRow(r));
  }

  public createKey(name: string): CreatedGatewayKey {
    const cleanName = name.trim() || '未命名密钥';
    const token = `sk-gw-${crypto.randomBytes(16).toString('hex')}`;
    const prefix = `${token.slice(0, 12)}...${token.slice(-4)}`;
    const id = `key-${crypto.randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();

    this.db
      .query(
        'INSERT INTO api_keys (id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, cleanName, hashToken(token), prefix, now);

    return {
      id,
      name: cleanName,
      token,
      prefix,
      requestCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      lastUsedAt: null,
      createdAt: now,
    };
  }

  public deleteKey(id: string): boolean {
    const res = this.db.query('DELETE FROM api_keys WHERE id = ?').run(id);
    return res.changes > 0;
  }

  public recordRequest(entry: {
    protocol: 'openai' | 'anthropic';
    model: string;
    key: GatewayKeyRecord | 'anonymous';
    promptTokens: number;
    completionTokens: number;
    ttftMs: number | null;
    latencyMs: number;
    status: number;
  }): void {
    const now = new Date().toISOString();
    const keyName = entry.key === 'anonymous' ? '免鉴权访问' : entry.key.name;

    this.db.transaction(() => {
      if (entry.key !== 'anonymous') {
        this.db
          .query(
            'UPDATE api_keys SET request_count = request_count + 1, prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?, last_used_at = ? WHERE id = ?'
          )
          .run(
            entry.promptTokens,
            entry.completionTokens,
            now,
            entry.key.id
          );
      }

      this.db
        .query(
          'INSERT INTO request_logs (timestamp, protocol, model, key_name, prompt_tokens, completion_tokens, ttft_ms, latency_ms, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          now,
          entry.protocol,
          entry.model,
          keyName,
          entry.promptTokens,
          entry.completionTokens,
          entry.ttftMs !== null ? Math.round(entry.ttftMs) : null,
          Math.round(entry.latencyMs),
          entry.status
        );

      this.db
        .query(
          'UPDATE gateway_totals SET request_count = request_count + 1, prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ? WHERE id = 1'
        )
        .run(entry.promptTokens, entry.completionTokens);

      this.db
        .query(
          'DELETE FROM request_logs WHERE id NOT IN (SELECT id FROM request_logs ORDER BY id DESC LIMIT 200)'
        )
        .run();
    })();
  }

  public getTotals(): {
    totalRequests: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
  } {
    const row = this.db
      .query(
        'SELECT request_count as reqs, prompt_tokens as pin, completion_tokens as pout FROM gateway_totals WHERE id = 1'
      )
      .get() as { reqs: number; pin: number; pout: number };
    return {
      totalRequests: row.reqs,
      totalPromptTokens: row.pin,
      totalCompletionTokens: row.pout,
    };
  }

  public listLogs(): GatewayRequestLog[] {
    const rows = this.db
      .query('SELECT * FROM request_logs ORDER BY id DESC LIMIT 100')
      .all() as RawLogRow[];
    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      protocol: r.protocol,
      model: r.model,
      keyName: r.key_name,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      ttftMs: r.ttft_ms,
      latencyMs: r.latency_ms,
      status: r.status,
    }));
  }

  public clearLogs(): void {
    this.db.exec('DELETE FROM request_logs;');
  }

  private mapKeyRow(r: RawKeyRow): GatewayKeyRecord {
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      requestCount: r.request_count,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
    };
  }
}
