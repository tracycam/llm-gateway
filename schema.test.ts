import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGatewayDatabase } from './database';
import { Database } from 'bun:sqlite';
import { GatewayStore } from './store';
import { NodeStore } from './nodeStore';
import { migrate } from './schema';

interface TokenHashRow { token_hash: string }

test('version 2 migration preserves key, node and request log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-'));
  try {
    const old = new GatewayStore(dir);
    const key = old.createKey('old key');
    old.recordRequest({ protocol: 'openai', model: 'old model', key, promptTokens: 7, completionTokens: 3, ttftMs: 2, latencyMs: 10, status: 200 });
    const nodes = new NodeStore(dir);
    const node = { id: 'node-1', name: 'node', url: 'http://localhost', token: 'secret', nodeId: 'machine', createdAt: '2024-01-01T00:00:00.000Z' };
    nodes.insert(node);
    nodes.close();
    old.close();
    const db = openGatewayDatabase(dir);
    try {
      const before = db.query<TokenHashRow, []>('SELECT token_hash FROM api_keys').get()!;
      migrate(db);
      expect(db.query('SELECT id, name, token_hash, request_count, prompt_tokens, completion_tokens FROM api_keys').get()).toEqual(
        expect.objectContaining({ id: key.id, name: key.name, token_hash: before.token_hash, request_count: 1, prompt_tokens: 7, completion_tokens: 3 })
      );
      expect(db.query('SELECT * FROM nodes').get()).toEqual({ id: node.id, name: node.name, url: node.url, token: node.token, node_id: node.nodeId, created_at: node.createdAt });
      expect(db.query('SELECT model_name, input_tokens, output_tokens FROM request_logs').get()).toEqual({ model_name: 'old model', input_tokens: 7, output_tokens: 3 });
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration is idempotent', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const before = db.query('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
    migrate(db);
    expect(db.query('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()).toEqual(before);
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
  } finally {
    db.close();
  }
});

test('migration refuses version 4', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA user_version = 4');
    expect(() => migrate(db)).toThrow('Unsupported gateway database version: 4');
  } finally {
    db.close();
  }
});

test('foreign keys cascade routes when a provider is deleted', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    db.exec(`INSERT INTO providers (id, name, connector, created_at) VALUES ('p', 'provider', 'x', 'now');
      INSERT INTO models (id, name, created_at) VALUES ('m', 'model', 'now');
      INSERT INTO routes (id, model_id, provider_id, upstream_model) VALUES ('r', 'm', 'p', 'upstream');
      DELETE FROM providers WHERE id = 'p';`);
    expect(db.query('SELECT * FROM routes').all()).toEqual([]);
  } finally {
    db.close();
  }
});

test('version 1 totals are seeded from existing logs', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT, token_hash TEXT, prefix TEXT,
      request_count INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, last_used_at TEXT, created_at TEXT);
      CREATE TABLE gateway_config (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE request_logs (id INTEGER PRIMARY KEY, timestamp TEXT, protocol TEXT, model TEXT,
      key_name TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, ttft_ms INTEGER, latency_ms INTEGER, status INTEGER);
      INSERT INTO request_logs VALUES (1, 't', 'openai', 'm', 'k', 5, 3, NULL, 1, 200);
      PRAGMA user_version = 1;`);
    migrate(db);
    expect(db.query('SELECT request_count, prompt_tokens, completion_tokens, cost FROM gateway_totals').get())
      .toEqual({ request_count: 1, prompt_tokens: 5, completion_tokens: 3, cost: 0 });
  } finally {
    db.close();
  }
});

test('version 0 plaintext token is purged from database and WAL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-legacy-'));
  const token = 'plaintext-legacy-token-not-for-storage';
  try {
    const db = openGatewayDatabase(dir);
    try {
      db.exec(`CREATE TABLE api_keys (
        id TEXT PRIMARY KEY, name TEXT, token TEXT, prefix TEXT, request_count INTEGER,
        prompt_tokens INTEGER, completion_tokens INTEGER, last_used_at TEXT, created_at TEXT
      )`);
      db.query('INSERT INTO api_keys VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('id', 'name', token, 'prefix', 1, 2, 3, null, '2024-01-01');
      migrate(db);
      const hash = createHash('sha256').update(token).digest('hex');
      expect(db.query('SELECT id FROM api_keys WHERE token_hash = ?').get(hash)).toEqual({ id: 'id' });
      for (const suffix of ['', '-wal']) {
        const filename = join(dir, `gateway.sqlite${suffix}`);
        if (existsSync(filename)) expect(readFileSync(filename).includes(Buffer.from(token))).toBe(false);
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('version 0 remains retryable if WAL purge is blocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-checkpoint-'));
  try {
    const db = openGatewayDatabase(dir);
    const reader = openGatewayDatabase(dir);
    try {
      db.exec('CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES (\'before\')');
      reader.exec('BEGIN');
      reader.query('SELECT * FROM marker').all();
      db.exec('PRAGMA busy_timeout = 1');
      expect(() => migrate(db)).toThrow('Gateway database WAL checkpoint was blocked');
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      reader.exec('ROLLBACK');
      migrate(db);
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    } finally {
      reader.close();
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('version 3 removes anonymous gateway configuration', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'gateway_config'").get()).toBeNull();
  } finally {
    db.close();
  }
});
