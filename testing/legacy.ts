// Builds gateway databases exactly as the retired GatewayStore wrote version 2, a version-3
// database on top of that shape and an empty version-4 database built through the migration, so
// migration tests start from what exists in the field rather than from today's schema.
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { openGatewayDatabase } from '../database';
import { migrate, version3DDL } from '../schema';

/** The key the legacy database holds; its plaintext is gone from the file but its hash verifies. */
export const LEGACY_TOKEN = 'sk-gw-legacy-token-0123456789abcdef';
export const LEGACY_KEY_ID = 'key-legacy0000001';
export const LEGACY_MODELLED = 'old model';

/** The node the legacy database holds. */
export const LEGACY_NODE = {
  id: 'node-legacy0001',
  name: 'old node',
  url: 'http://127.0.0.1:4310',
  token: 'legacy-node-token',
  nodeId: 'legacy-daemon',
  createdAt: '2024-01-01T00:00:00.000Z',
};

/** The version-2 tables, as that version created them. */
const VERSION_2_DDL = `
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE gateway_config (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE request_logs (
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
  CREATE TABLE gateway_totals (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    request_count INTEGER NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL
  );
  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    token TEXT,
    node_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
`;

const LEGACY_SCHEMA = `${VERSION_2_DDL}
  INSERT INTO gateway_config (k, v) VALUES ('require_auth', '1');
  INSERT INTO gateway_totals (id, request_count, prompt_tokens, completion_tokens) VALUES (1, 1, 7, 3);
  INSERT INTO request_logs (timestamp, protocol, model, key_name, prompt_tokens, completion_tokens,
    ttft_ms, latency_ms, status)
    VALUES ('2024-01-01T00:00:00.000Z', 'openai', '${LEGACY_MODELLED}', 'old key', 7, 3, 2, 10, 200);
  PRAGMA user_version = 2;
`;

/**
 * An empty in-memory version-3 database: the version-2 shape with the version-3 schema on top,
 * and no rows.
 */
export function openVersion3Database(): Database {
  const db = new Database(':memory:');
  db.exec(VERSION_2_DDL);
  db.exec(version3DDL);
  return db;
}

/**
 * An empty in-memory version-4 database. Versions 5 to 9 change rows or add columns only, so the
 * migration is run to build the rest of the schema, then the later columns are dropped and the
 * version is set back to 4.
 */
export function openVersion4Database(): Database {
  const db = openVersion3Database();
  migrate(db);
  db.exec(`ALTER TABLE providers DROP COLUMN credential_rejected;
    ALTER TABLE providers DROP COLUMN models_refreshed_at;
    ALTER TABLE providers DROP COLUMN models_error;
    ALTER TABLE provider_models DROP COLUMN protocols;
    DROP INDEX request_logs_request_id;
    ALTER TABLE request_logs DROP COLUMN request_id;
    ALTER TABLE request_logs DROP COLUMN key_id;
    PRAGMA user_version = 4;`);
  return db;
}

/** An empty in-memory version-5 database: the version-4 schema, which version 5 does not change. */
export function openVersion5Database(): Database {
  const db = openVersion4Database();
  db.exec('PRAGMA user_version = 5');
  return db;
}

/**
 * An empty in-memory version-6 database: the version-5 schema with the refused-credential mark
 * and without the per-model protocols version 7 adds.
 */
export function openVersion6Database(): Database {
  const db = openVersion4Database();
  db.exec(`ALTER TABLE providers ADD COLUMN credential_rejected INTEGER NOT NULL DEFAULT 0;
    PRAGMA user_version = 6`);
  return db;
}

/**
 * An empty in-memory version-7 database: the version-6 schema with the per-model protocols
 * column version 7 adds.
 */
export function openVersion7Database(): Database {
  const db = openVersion6Database();
  db.exec(`ALTER TABLE provider_models ADD COLUMN protocols TEXT;
    PRAGMA user_version = 7`);
  return db;
}

/** An empty in-memory version-8 database: version 8 changes rows only, not the schema. */
export function openVersion8Database(): Database {
  const db = openVersion7Database();
  db.exec('PRAGMA user_version = 8');
  return db;
}

/** An empty in-memory version-9 database: version 9 adds the model sync fields. */
export function openVersion9Database(): Database {
  const db = openVersion8Database();
  db.exec(`ALTER TABLE providers ADD COLUMN models_refreshed_at TEXT;
    ALTER TABLE providers ADD COLUMN models_error TEXT;
    PRAGMA user_version = 9`);
  return db;
}

/** An empty in-memory version-10 database: version 10 changes rows only, not the schema. */
export function openVersion10Database(): Database {
  const db = openVersion9Database();
  db.exec('PRAGMA user_version = 10');
  return db;
}

/** Writes the version-2 database under `dataDir`; returns the token its API key was created with. */
export function writeLegacyDatabase(dataDir: string, token = LEGACY_TOKEN): string {
  const db = openGatewayDatabase(dataDir);
  try {
    db.exec(LEGACY_SCHEMA);
    db.query(`INSERT INTO api_keys (id, name, token_hash, prefix, request_count, prompt_tokens,
      completion_tokens, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      LEGACY_KEY_ID, 'old key', createHash('sha256').update(token).digest('hex'),
      `${token.slice(0, 12)}...${token.slice(-4)}`, 1, 7, 3, '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:00:00.000Z'
    );
    db.query(`INSERT INTO nodes (id, name, url, token, node_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(LEGACY_NODE.id, LEGACY_NODE.name, LEGACY_NODE.url, LEGACY_NODE.token,
        LEGACY_NODE.nodeId, LEGACY_NODE.createdAt);
  } finally {
    db.close();
  }
  return token;
}
