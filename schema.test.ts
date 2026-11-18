import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGatewayDatabase } from './database';
import { Database } from 'bun:sqlite';
import { migrate } from './schema';
import {
  LEGACY_KEY_ID, LEGACY_MODELLED, LEGACY_NODE, openVersion3Database, openVersion4Database,
  openVersion5Database, openVersion6Database, openVersion7Database, writeLegacyDatabase,
} from './testing/legacy';
import { ModelStore } from './modelStore';
import { ProviderStore } from './providerStore';
import { connectorById } from './connectors/registry';
import { providerAccess } from './connectors/access';
import { CredentialRenewals } from './connectors/tokens';
import { usableRoutes } from './inference/routes';

test('version 2 migration preserves key, node and request log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-'));
  try {
    const token = writeLegacyDatabase(dir);
    const db = openGatewayDatabase(dir);
    try {
      migrate(db);
      expect(db.query('SELECT id, name, token_hash, request_count, prompt_tokens, completion_tokens FROM api_keys').get()).toEqual(
        expect.objectContaining({
          id: LEGACY_KEY_ID, name: 'old key',
          token_hash: createHash('sha256').update(token).digest('hex'),
          request_count: 1, prompt_tokens: 7, completion_tokens: 3,
        })
      );
      expect(db.query('SELECT * FROM nodes').get()).toEqual({
        id: LEGACY_NODE.id, name: LEGACY_NODE.name, url: LEGACY_NODE.url, token: LEGACY_NODE.token,
        node_id: LEGACY_NODE.nodeId, created_at: LEGACY_NODE.createdAt,
      });
      expect(db.query('SELECT model_name, input_tokens, output_tokens FROM request_logs').get()).toEqual({
        model_name: LEGACY_MODELLED, input_tokens: 7, output_tokens: 3,
      });
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
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
  } finally {
    db.close();
  }
});

test('migration refuses version 9', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA user_version = 9');
    expect(() => migrate(db)).toThrow('Unsupported gateway database version: 9');
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
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
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

/** Every table's columns, for a schema comparison that does not depend on DDL whitespace. */
function schemaOf(db: Database): Record<string, unknown> {
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.query(`PRAGMA table_info(${name})`).all()]));
}

function columnsOf(db: Database, table: string): string[] {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

/** A version-3 database holding the rows the version-4 migration must carry. */
function version3WithRows(): Database {
  const db = openVersion3Database();
  db.exec(`
    INSERT INTO providers (id, name, connector, created_at) VALUES ('p1', 'provider', 'test', 'now');
    INSERT INTO provider_models (provider_id, upstream_id, context_length, max_output_tokens,
      input_price, output_price, cache_read_price, cache_write_price, fetched_at)
      VALUES ('p1', 'm1', 1000, 100, 1, 2, 0.5, 3, 'now');
    INSERT INTO models (id, name, input_price, output_price, cache_read_price, cache_write_price,
      context_length, created_at) VALUES ('m1', 'model', 1, 2, 0.5, 7, 1000, 'now');
    INSERT INTO routes (id, model_id, provider_id, upstream_model, input_price, output_price,
      cache_read_price, cache_write_price) VALUES
      ('rte-c', 'm1', 'p1', 'third', NULL, NULL, NULL, NULL),
      ('rte-b', 'm1', 'p1', 'second', 1, 2, 0.5, 4),
      ('rte-a', 'm1', 'p1', 'first', NULL, NULL, NULL, NULL);
    INSERT INTO usage_daily (day, key_id, key_name, model_id, model_name, provider_id, provider_name,
      requests, errors, unknown_usage, uncosted, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, cost) VALUES
      ('2026-11-01', 'k1', 'key', 'm1', 'model', 'p1', 'provider', 2, 0, 0, 0, 30, 10, 20, 50, 0.5),
      ('2026-11-02', 'k1', 'key', 'm1', 'model', 'p1', 'provider', 1, 0, 0, 0, 0, 5, 0, 7, 0.25);
    INSERT INTO request_logs (id, timestamp, protocol, key_name, model_name, status, input_tokens,
      output_tokens, cache_read_tokens, cache_write_tokens, cost, latency_ms) VALUES
      (1, '2026-11-01T00:00:00.000Z', 'chat', 'key', 'model', 200, 10, 3, 5, 4, 0.1, 10),
      (2, '2026-11-01T00:00:01.000Z', 'chat', 'key', 'model', 200, NULL, 2, 0, 9, 0.05, 10),
      (3, '2026-11-01T00:00:02.000Z', 'chat', 'key', 'model', 200, 8, 1, NULL, NULL, NULL, 10);
    INSERT INTO api_keys (id, name, token_hash, prefix, request_count, prompt_tokens,
      completion_tokens, created_at) VALUES ('k1', 'key', 'hash', 'prefix', 3, 100, 20, 'now');
    INSERT INTO gateway_totals (id, request_count, prompt_tokens, completion_tokens, cost)
      VALUES (1, 3, 100, 20, 0.5);
  `);
  return db;
}

test('version 4 folds cache-write tokens into input and keeps every recorded cost', () => {
  const db = version3WithRows();
  try {
    // The whole input of the rows, and the cost the reports carry, before the migration.
    expect(db.query(`SELECT SUM(input_tokens) + SUM(cache_read_tokens) + SUM(cache_write_tokens) AS input,
      SUM(cost) AS cost FROM usage_daily`).get()).toEqual({ input: 107, cost: 0.75 });
    migrate(db);
    expect(db.query(`SELECT day, input_tokens, output_tokens, cache_read_tokens, cost
      FROM usage_daily ORDER BY day`).all()).toEqual([
      { day: '2026-11-01', input_tokens: 80, output_tokens: 10, cache_read_tokens: 20, cost: 0.5 },
      { day: '2026-11-02', input_tokens: 7, output_tokens: 5, cache_read_tokens: 0, cost: 0.25 },
    ]);
    expect(db.query(`SELECT id, input_tokens, output_tokens, cache_read_tokens, cost
      FROM request_logs ORDER BY id`).all()).toEqual([
      { id: 1, input_tokens: 14, output_tokens: 3, cache_read_tokens: 5, cost: 0.1 },
      { id: 2, input_tokens: 9, output_tokens: 2, cache_read_tokens: 0, cost: 0.05 },
      { id: 3, input_tokens: 8, output_tokens: 1, cache_read_tokens: null, cost: null },
    ]);
    // The whole input of the group is what it was; only its split changed.
    expect(db.query('SELECT SUM(input_tokens) + SUM(cache_read_tokens) AS input FROM usage_daily').get())
      .toEqual({ input: 107 });
  } finally {
    db.close();
  }
});

test('version 4 drops every cache-write column', () => {
  const db = version3WithRows();
  try {
    migrate(db);
    for (const table of ['usage_daily', 'request_logs', 'models', 'routes', 'provider_models']) {
      expect(columnsOf(db, table).filter((name) => name.startsWith('cache_write'))).toEqual([]);
    }
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
  } finally {
    db.close();
  }
});

test('version 4 keeps the other prices and the route order', () => {
  const db = version3WithRows();
  try {
    migrate(db);
    const model = new ModelStore(db).get('m1')!;
    expect(model.price).toEqual({ input: 1, output: 2, cacheRead: 0.5 });
    expect(model.routes.map((route) => route.upstreamModel)).toEqual(['third', 'second', 'first']);
    expect(model.routes[1].price).toEqual({ input: 1, output: 2, cacheRead: 0.5 });
    expect(new ProviderStore(db).models('p1')).toMatchObject([
      { upstreamId: 'm1', price: { input: 1, output: 2, cacheRead: 0.5 } },
    ]);
  } finally {
    db.close();
  }
});

test('version 4 leaves the key and gateway totals alone, which already sum all input', () => {
  const db = version3WithRows();
  try {
    migrate(db);
    expect(db.query('SELECT prompt_tokens, completion_tokens FROM api_keys WHERE id = ?').get('k1'))
      .toEqual({ prompt_tokens: 100, completion_tokens: 20 });
    expect(db.query('SELECT request_count, prompt_tokens, completion_tokens, cost FROM gateway_totals').get())
      .toEqual({ request_count: 3, prompt_tokens: 100, completion_tokens: 20, cost: 0.5 });
  } finally {
    db.close();
  }
});

/** A version-4 database holding providers on the connector ids version 5 renames. */
function version4WithProviders(): Database {
  const db = openVersion4Database();
  db.exec(`
    INSERT INTO providers (id, name, connector, base_url, credential, created_at) VALUES
      ('p-default', 'official default', 'openai', NULL, '{"apiKey":"a"}', 'now'),
      ('p-address', 'official address', 'openai', 'https://proxy.example/v1', NULL, 'now'),
      ('p-messages', 'anthropic', 'anthropic', NULL, '{"apiKey":"b"}', 'now'),
      ('p-openrouter', 'openrouter', 'openrouter', 'https://openrouter.ai/api/v1', '{"apiKey":"c"}', 'now');
    INSERT INTO models (id, name, created_at) VALUES ('m', 'model', 'now');
    INSERT INTO routes (id, model_id, provider_id, upstream_model) VALUES
      ('r', 'm', 'p-default', 'gpt');
  `);
  return db;
}

test('version 5 renames the two protocol connector ids and leaves the rows alone', () => {
  const db = version4WithProviders();
  try {
    migrate(db);
    expect(db.query('SELECT id, connector, base_url, credential FROM providers ORDER BY id').all())
      .toEqual([
        { id: 'p-address', connector: 'openai-compatible',
          base_url: 'https://proxy.example/v1', credential: null },
        { id: 'p-default', connector: 'openai-compatible',
          base_url: null, credential: '{"apiKey":"a"}' },
        { id: 'p-messages', connector: 'anthropic-compatible',
          base_url: null, credential: '{"apiKey":"b"}' },
        { id: 'p-openrouter', connector: 'openrouter',
          base_url: 'https://openrouter.ai/api/v1', credential: '{"apiKey":"c"}' },
      ]);
    expect(db.query('SELECT id, provider_id, upstream_model FROM routes').all())
      .toEqual([{ id: 'r', provider_id: 'p-default', upstream_model: 'gpt' }]);
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
    const renamed = db.query('SELECT id, connector FROM providers ORDER BY id').all();
    migrate(db);
    expect(db.query('SELECT id, connector FROM providers ORDER BY id').all()).toEqual(renamed);
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
  } finally {
    db.close();
  }
});

test('version 5 leaves a renamed provider usable on its route', () => {
  const db = version4WithProviders();
  try {
    migrate(db);
    const model = new ModelStore(db).get('m')!;
    const usable = usableRoutes(model, new ProviderStore(db), connectorById);
    expect(usable.map(({ connector, provider }) => [provider.connector, connector.id])).toEqual([
      ['openai-compatible', 'openai-compatible'],
    ]);
  } finally {
    db.close();
  }
});

test('a fresh database has the schema a migrated version-3 database has', () => {
  const fresh = new Database(':memory:');
  const migrated = openVersion3Database();
  try {
    migrate(fresh);
    migrate(migrated);
    expect(schemaOf(migrated)).toEqual(schemaOf(fresh));
  } finally {
    fresh.close();
    migrated.close();
  }
});

/** A version-5 database holding providers the version-6 migration must keep. */
function version5WithProviders(): Database {
  const db = openVersion5Database();
  db.exec(`
    INSERT INTO providers (id, name, connector, base_url, credential, enabled, auto_publish, created_at)
      VALUES ('p-key', 'key provider', 'openai-compatible', NULL, '{"apiKey":"k"}', 1, 0, 'now'),
        ('p-login', 'login provider', 'grok', 'https://cli-chat-proxy.grok.com/v1', NULL, 0, 1, 'now');
    INSERT INTO models (id, name, created_at) VALUES ('m', 'model', 'now');
    INSERT INTO routes (id, model_id, provider_id, upstream_model) VALUES ('r', 'm', 'p-key', 'gpt');
  `);
  return db;
}

test('version 6 adds credential_rejected at 0 and keeps every provider row', () => {
  const db = version5WithProviders();
  try {
    migrate(db);
    expect(db.query('SELECT id, connector, base_url, credential, enabled, auto_publish, created_at,' +
      ' credential_rejected FROM providers ORDER BY id').all()).toEqual([
      { id: 'p-key', connector: 'openai-compatible', base_url: null, credential: '{"apiKey":"k"}',
        enabled: 1, auto_publish: 0, created_at: 'now', credential_rejected: 0 },
      { id: 'p-login', connector: 'grok', base_url: 'https://cli-chat-proxy.grok.com/v1',
        credential: null, enabled: 0, auto_publish: 1, created_at: 'now', credential_rejected: 0 },
    ]);
    expect(db.query('SELECT id, model_id, provider_id, upstream_model FROM routes').all())
      .toEqual([{ id: 'r', model_id: 'm', provider_id: 'p-key', upstream_model: 'gpt' }]);
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
    expect(columnsOf(db, 'providers')).toContain('credential_rejected');
  } finally {
    db.close();
  }
});

test('version 6 migration run twice changes nothing', () => {
  const db = version5WithProviders();
  try {
    migrate(db);
    const schema = schemaOf(db);
    const providers = db.query('SELECT * FROM providers ORDER BY id').all();
    migrate(db);
    expect(schemaOf(db)).toEqual(schema);
    expect(db.query('SELECT * FROM providers ORDER BY id').all()).toEqual(providers);
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
  } finally {
    db.close();
  }
});

test('a fresh database has the schema a migrated empty version-5 database has', () => {
  const fresh = new Database(':memory:');
  const migrated = openVersion5Database();
  try {
    migrate(fresh);
    migrate(migrated);
    expect(schemaOf(migrated)).toEqual(schemaOf(fresh));
  } finally {
    fresh.close();
    migrated.close();
  }
});

/** A version-6 database holding discovered models the version-7 migration must keep. */
function version6WithModels(): Database {
  const db = openVersion6Database();
  db.exec(`
    INSERT INTO providers (id, name, connector, base_url, credential, enabled, auto_publish,
      created_at, credential_rejected) VALUES
      ('p-key', 'key provider', 'openai-compatible', NULL, '{"apiKey":"k"}', 1, 0, 'now', 0);
    INSERT INTO provider_models (provider_id, upstream_id, context_length, max_output_tokens,
      input_price, output_price, cache_read_price, fetched_at) VALUES
      ('p-key', 'gpt', 128000, 4096, 1, 2, 0.5, 'now');
  `);
  return db;
}

test('version 7 adds protocols as null and keeps every provider model', () => {
  const db = version6WithModels();
  try {
    migrate(db);
    expect(db.query('SELECT provider_id, upstream_id, context_length, max_output_tokens,' +
      ' input_price, output_price, cache_read_price, protocols, fetched_at FROM provider_models')
      .get()).toEqual({
      provider_id: 'p-key', upstream_id: 'gpt', context_length: 128000, max_output_tokens: 4096,
      input_price: 1, output_price: 2, cache_read_price: 0.5, protocols: null, fetched_at: 'now',
    });
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
    expect(columnsOf(db, 'provider_models')).toContain('protocols');
  } finally {
    db.close();
  }
});

test('version 7 migration run twice changes nothing', () => {
  const db = version6WithModels();
  try {
    migrate(db);
    const schema = schemaOf(db);
    const models = db.query('SELECT * FROM provider_models').all();
    migrate(db);
    expect(schemaOf(db)).toEqual(schema);
    expect(db.query('SELECT * FROM provider_models').all()).toEqual(models);
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
  } finally {
    db.close();
  }
});

test('a fresh database has the schema a migrated empty version-6 database has', () => {
  const fresh = new Database(':memory:');
  const migrated = openVersion6Database();
  try {
    migrate(fresh);
    migrate(migrated);
    expect(schemaOf(migrated)).toEqual(schemaOf(fresh));
  } finally {
    fresh.close();
    migrated.close();
  }
});

/** A version-7 database holding providers on the connector id version 8 retires. */
function version7WithXaiProviders(): Database {
  const db = openVersion7Database();
  db.exec(`
    INSERT INTO providers (id, name, connector, base_url, credential, enabled, auto_publish,
      created_at, credential_rejected) VALUES
      ('p-default', 'xai default', 'xai', NULL, '{"apiKey":"a"}', 1, 0, 'now', 0),
      ('p-address', 'xai address', 'xai', 'https://proxy.example/v1', '{"apiKey":"b"}', 1, 0,
        'now', 0),
      ('p-other', 'other', 'openrouter', NULL, '{"apiKey":"c"}', 1, 1, 'now', 0);
    INSERT INTO provider_models (provider_id, upstream_id, context_length, max_output_tokens,
      input_price, output_price, cache_read_price, protocols, fetched_at) VALUES
      ('p-default', 'grok-4', 131072, NULL, 2, 5, 0.5, NULL, 'now');
    INSERT INTO models (id, name, created_at) VALUES ('m', 'grok-4', 'now');
    INSERT INTO routes (id, model_id, provider_id, upstream_model)
      VALUES ('r', 'm', 'p-default', 'grok-4');
  `);
  return db;
}

test('version 8 retires the xai connector and keeps every provider row', () => {
  const db = version7WithXaiProviders();
  try {
    migrate(db);
    expect(db.query(`SELECT id, connector, base_url, credential, enabled, auto_publish,
      credential_rejected FROM providers ORDER BY id`).all()).toEqual([
      { id: 'p-address', connector: 'openai-compatible', base_url: 'https://proxy.example/v1',
        credential: '{"apiKey":"b"}', enabled: 1, auto_publish: 0, credential_rejected: 0 },
      { id: 'p-default', connector: 'openai-compatible', base_url: 'https://api.x.ai/v1',
        credential: '{"apiKey":"a"}', enabled: 1, auto_publish: 0, credential_rejected: 0 },
      // A provider of another connector keeps its id and its "no address of its own".
      { id: 'p-other', connector: 'openrouter', base_url: null, credential: '{"apiKey":"c"}',
        enabled: 1, auto_publish: 1, credential_rejected: 0 },
    ]);
    expect(db.query(`SELECT provider_id, upstream_id, context_length, input_price, output_price,
      cache_read_price, protocols FROM provider_models`).all()).toEqual([{
      provider_id: 'p-default', upstream_id: 'grok-4', context_length: 131072,
      input_price: 2, output_price: 5, cache_read_price: 0.5, protocols: null,
    }]);
    expect(db.query('SELECT id, model_id, provider_id, upstream_model FROM routes').all())
      .toEqual([{ id: 'r', model_id: 'm', provider_id: 'p-default', upstream_model: 'grok-4' }]);
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
  } finally {
    db.close();
  }
});

test('version 8 leaves a migrated provider serving Responses clients at its address', async () => {
  const db = version7WithXaiProviders();
  try {
    migrate(db);
    const providers = new ProviderStore(db);
    const access = providerAccess(providers, providers.get('p-default')!, new CredentialRenewals());
    const openaiCompatible = connectorById('openai-compatible')!;
    expect(await openaiCompatible.target(access, 'grok-4', 'responses')).toEqual({
      url: 'https://api.x.ai/v1/responses',
      headers: { Authorization: 'Bearer a' },
      protocol: 'responses',
    });
  } finally {
    db.close();
  }
});

test('version 8 migration run twice changes nothing', () => {
  const db = version7WithXaiProviders();
  try {
    migrate(db);
    const schema = schemaOf(db);
    const providers = db.query('SELECT * FROM providers ORDER BY id').all();
    migrate(db);
    expect(schemaOf(db)).toEqual(schema);
    expect(db.query('SELECT * FROM providers ORDER BY id').all()).toEqual(providers);
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
  } finally {
    db.close();
  }
});

test('a fresh database has the schema a migrated empty version-7 database has', () => {
  const fresh = new Database(':memory:');
  const migrated = openVersion7Database();
  try {
    migrate(fresh);
    migrate(migrated);
    expect(schemaOf(migrated)).toEqual(schemaOf(fresh));
  } finally {
    fresh.close();
    migrated.close();
  }
});
