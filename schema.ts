import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

export class StoreRefusal extends Error {
  constructor(message: string, public readonly status = 409) {
    super(message);
    this.name = 'StoreRefusal';
  }
}

interface ColumnRow {
  name: string;
}
interface VersionRow {
  user_version: number;
}
interface CheckpointRow {
  busy: number;
}
interface LegacyKeyRow {
  id: string;
  name: string;
  token: string;
  prefix: string;
  request_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  last_used_at: string | null;
  created_at: string;
}

const keysDDL = `CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL
)`;

export function migrate(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON');
  const { user_version: version } = db.query<VersionRow, []>('PRAGMA user_version').get()!;
  if (version > 3) throw new Error(`Unsupported gateway database version: ${version}`);

  // Version 1 replaces plaintext API tokens with hashes.
  if (version < 1) {
    db.transaction(() => {
      const columns = db.query<ColumnRow, []>('PRAGMA table_info(api_keys)').all().map((row) => row.name);
      if (columns.length === 0) {
        db.exec(keysDDL);
      } else if (columns.includes('token')) {
        db.exec('ALTER TABLE api_keys RENAME TO api_keys_legacy');
        db.exec(keysDDL);
        const rows = db.query<LegacyKeyRow, []>('SELECT * FROM api_keys_legacy').all();
        const insert = db.query('INSERT INTO api_keys VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const row of rows) {
          insert.run(row.id, row.name, createHash('sha256').update(row.token).digest('hex'), row.prefix,
            row.request_count, row.prompt_tokens, row.completion_tokens, row.last_used_at, row.created_at);
        }
        db.exec('DROP TABLE api_keys_legacy');
      } else if (!columns.includes('token_hash')) {
        throw new Error('Unrecognized gateway api_keys schema');
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS gateway_config (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL
        );
        INSERT OR IGNORE INTO gateway_config VALUES ('require_auth', '1');
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
    })();
    db.exec('VACUUM');
    const checkpoint = db.query<CheckpointRow, []>('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint?.busy) throw new Error('Gateway database WAL checkpoint was blocked');
    db.exec('PRAGMA user_version = 1');
  }

  // Version 2 introduces lifetime gateway totals.
  if (version < 2) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS gateway_totals (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          request_count INTEGER NOT NULL,
          prompt_tokens INTEGER NOT NULL,
          completion_tokens INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO gateway_totals (id, request_count, prompt_tokens, completion_tokens)
          SELECT 1, COUNT(*), COALESCE(SUM(prompt_tokens), 0),
            COALESCE(SUM(completion_tokens), 0) FROM request_logs;
        PRAGMA user_version = 2;
      `);
    })();
  }

  // Version 3 introduces providers, models, routes, key limits and daily usage.
  if (version < 3) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          token TEXT,
          node_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        );
        CREATE TABLE providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          connector TEXT NOT NULL,
          base_url TEXT,
          credential TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          auto_publish INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE provider_models (
          provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          upstream_id TEXT NOT NULL,
          context_length INTEGER,
          max_output_tokens INTEGER,
          input_price REAL,
          output_price REAL,
          cache_read_price REAL,
          cache_write_price REAL,
          fetched_at TEXT NOT NULL,
          PRIMARY KEY(provider_id, upstream_id)
        );
        CREATE TABLE models (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          input_price REAL,
          output_price REAL,
          cache_read_price REAL,
          cache_write_price REAL,
          context_length INTEGER,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
        CREATE TABLE routes (
          id TEXT PRIMARY KEY,
          model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          upstream_model TEXT NOT NULL,
          weight INTEGER NOT NULL DEFAULT 1 CHECK(weight > 0),
          enabled INTEGER NOT NULL DEFAULT 1,
          input_price REAL,
          output_price REAL,
          cache_read_price REAL,
          cache_write_price REAL,
          UNIQUE(model_id, provider_id, upstream_model)
        );
        ALTER TABLE api_keys ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE api_keys ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE api_keys ADD COLUMN cost_limit REAL;
        ALTER TABLE api_keys ADD COLUMN reset_period TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE api_keys ADD COLUMN period_start TEXT NOT NULL DEFAULT '';
        UPDATE api_keys SET period_start = created_at;
        ALTER TABLE api_keys ADD COLUMN period_cost REAL NOT NULL DEFAULT 0;
        ALTER TABLE api_keys ADD COLUMN total_cost REAL NOT NULL DEFAULT 0;
        ALTER TABLE api_keys ADD COLUMN max_concurrency INTEGER;
        ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
        CREATE TABLE key_models (
          key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
          model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
          PRIMARY KEY(key_id, model_id)
        );
        CREATE TABLE usage_daily (
          day TEXT NOT NULL,
          key_id TEXT NOT NULL,
          key_name TEXT NOT NULL,
          model_id TEXT NOT NULL,
          model_name TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          provider_name TEXT NOT NULL,
          requests INTEGER NOT NULL,
          errors INTEGER NOT NULL,
          unknown_usage INTEGER NOT NULL,
          uncosted INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL,
          cache_write_tokens INTEGER NOT NULL,
          cost REAL NOT NULL,
          PRIMARY KEY(day, key_id, model_id, provider_id)
        );
        ALTER TABLE request_logs RENAME TO request_logs_v2;
        CREATE TABLE request_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          protocol TEXT NOT NULL,
          key_name TEXT NOT NULL,
          model_name TEXT NOT NULL,
          provider_name TEXT,
          upstream_model TEXT,
          status INTEGER NOT NULL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER,
          cache_write_tokens INTEGER,
          cost REAL,
          ttft_ms REAL,
          latency_ms REAL NOT NULL,
          error TEXT
        );
        INSERT INTO request_logs (id, timestamp, protocol, key_name, model_name, status,
          input_tokens, output_tokens, ttft_ms, latency_ms)
          SELECT id, timestamp, protocol, key_name, model, status, prompt_tokens,
            completion_tokens, ttft_ms, latency_ms FROM request_logs_v2;
        DROP TABLE request_logs_v2;
        DROP TABLE IF EXISTS gateway_config;
        ALTER TABLE gateway_totals ADD COLUMN cost REAL NOT NULL DEFAULT 0;
        PRAGMA user_version = 3;
      `);
    })();
  }
}
