// Builds gateway databases exactly as the retired GatewayStore wrote version 2, and a version-3
// database on top of that shape, so migration tests start from what exists in the field rather
// than from today's schema.
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { openGatewayDatabase } from '../database';
import { version3DDL } from '../schema';

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
