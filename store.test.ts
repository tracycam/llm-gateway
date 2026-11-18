import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../server/testing/fixtures';
import { GatewayStore } from './store';

const dirs: string[] = [];
function dir(): string { const d = tempDir(); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

test('fresh keys authenticate without exposing tokens', () => {
  const store = new GatewayStore(dir());
  expect(store.listKeys()).toEqual([]);
  const key = store.createKey('test');
  expect(key.token.startsWith('sk-gw-')).toBe(true);
  expect(store.verifyToken(key.token)).toEqual(store.listKeys()[0]);
  expect(Object.keys(store.listKeys()[0])).not.toContain('token');
  expect(store.verifyToken('wrong')).toBeNull();
  store.setRequireAuth(false);
  expect(store.verifyToken('wrong')).toBe('anonymous');
  store.close();
});

test('legacy migration preserves keys and removes plaintext, including on reopening', () => {
  const d = dir(); const file = path.join(d, 'gateway.sqlite');
  const token = 'sk-gw-0123456789abcdef0123456789abcdef';
  const db = new Database(file);
  db.exec(`CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL, request_count INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT, created_at TEXT NOT NULL
  );`);
  db.query('INSERT INTO api_keys VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('id', 'legacy', token, 'sk-gw-012345...cdef', 3, 4, 5, 'last', 'created');
  db.close();
  for (let i = 0; i < 2; i++) {
    const store = new GatewayStore(d);
    expect(store.verifyToken(token)).toEqual({ id: 'id', name: 'legacy', prefix: 'sk-gw-012345...cdef', requestCount: 3, promptTokens: 4, completionTokens: 5, lastUsedAt: 'last', createdAt: 'created' });
    // The running gateway never closes its handle, so the files must already be clean here.
    for (const f of [file, `${file}-wal`]) if (fs.existsSync(f)) expect(fs.readFileSync(f).includes(token)).toBe(false);
    store.close();
    const inspect = new Database(file, { readonly: true });
    expect(inspect.query('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    inspect.close();
    for (const f of [file, `${file}-wal`]) if (fs.existsSync(f)) expect(fs.readFileSync(f).includes(token)).toBe(false);
  }
});

test('a rebuild interrupted before the purge is finished on the next open', () => {
  const d = dir(); const file = path.join(d, 'gateway.sqlite');
  const first = new GatewayStore(d);
  const key = first.createKey('kept');
  first.close();
  const db = new Database(file);
  db.exec('PRAGMA user_version = 0');
  db.close();
  const store = new GatewayStore(d);
  expect(store.verifyToken(key.token)).toEqual(store.listKeys()[0]);
  store.close();
  const inspect = new Database(file, { readonly: true });
  expect(inspect.query('PRAGMA user_version').get()).toEqual({ user_version: 2 });
  inspect.close();
});

test('a newer schema version is refused', () => {
  const d = dir();
  new GatewayStore(d).close();
  const db = new Database(path.join(d, 'gateway.sqlite'));
  db.exec('PRAGMA user_version = 3');
  db.close();
  expect(() => new GatewayStore(d)).toThrow('Unsupported gateway database version: 3');
});

function record(store: GatewayStore, promptTokens: number, completionTokens: number): void {
  store.recordRequest({ protocol: 'openai', model: 'model', key: 'anonymous', promptTokens, completionTokens, ttftMs: null, latencyMs: 1, status: 200 });
}

test('totals include all requests after logs are trimmed', () => {
  const d = dir();
  const store = new GatewayStore(d);
  for (let i = 1; i <= 250; i++) record(store, i, i * 2);
  expect(store.getTotals()).toEqual({ totalRequests: 250, totalPromptTokens: 31375, totalCompletionTokens: 62750 });
  const db = new Database(path.join(d, 'gateway.sqlite'), { readonly: true });
  expect(db.query('SELECT COUNT(*) AS count FROM request_logs').get()).toEqual({ count: 200 });
  db.close();
  store.close();
});

test('totals survive closing and reopening', () => {
  const d = dir();
  const store = new GatewayStore(d);
  for (let i = 0; i < 250; i++) record(store, 2, 3);
  store.close();
  const reopened = new GatewayStore(d);
  expect(reopened.getTotals()).toEqual({ totalRequests: 250, totalPromptTokens: 500, totalCompletionTokens: 750 });
  reopened.close();
});

test('migration seeds totals from existing logs and counts subsequent requests', () => {
  const d = dir();
  const store = new GatewayStore(d);
  record(store, 4, 7);
  record(store, 5, 8);
  store.close();
  const db = new Database(path.join(d, 'gateway.sqlite'));
  db.exec('DROP TABLE IF EXISTS gateway_totals; PRAGMA user_version = 1;');
  db.close();
  const migrated = new GatewayStore(d);
  expect(migrated.getTotals()).toEqual({ totalRequests: 2, totalPromptTokens: 9, totalCompletionTokens: 15 });
  migrated.clearLogs();
  record(migrated, 2, 3);
  expect(migrated.getTotals()).toEqual({ totalRequests: 3, totalPromptTokens: 11, totalCompletionTokens: 18 });
  migrated.close();
});

test('an aborted log insert does not increment counters', () => {
  const d = dir();
  const store = new GatewayStore(d);
  const key = store.createKey('test');
  const db = new Database(path.join(d, 'gateway.sqlite'));
  db.exec("CREATE TRIGGER reject_log BEFORE INSERT ON request_logs BEGIN SELECT RAISE(ABORT, 'rejected'); END;");
  expect(() => store.recordRequest({ protocol: 'openai', model: 'model', key, promptTokens: 4, completionTokens: 7, ttftMs: null, latencyMs: 1, status: 200 })).toThrow('rejected');
  expect(store.getTotals()).toEqual({ totalRequests: 0, totalPromptTokens: 0, totalCompletionTokens: 0 });
  expect(store.listKeys()[0].requestCount).toBe(0);
  expect(db.query('SELECT COUNT(*) AS count FROM request_logs').get()).toEqual({ count: 0 });
  db.close();
  store.close();
});
