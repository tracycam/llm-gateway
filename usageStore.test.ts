import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from './schema';
import { KeyStore } from './keyStore';
import { ModelStore } from './modelStore';
import { UsageStore, type UsageEntry } from './usageStore';
import { ProviderStore } from './providerStore';
import { openGatewayDatabase } from './database';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup(period: 'day' | 'week' | 'month' | 'none' = 'day') {
  const db = new Database(':memory:');
  migrate(db);
  const keys = new KeyStore(db);
  const models = new ModelStore(db);
  const before = new Date(2024, 0, 31, 23, 59);
  const key = keys.create({ name: 'key', resetPeriod: period }, before);
  const model = models.create({ name: 'model' }, before);
  const usage = new UsageStore(db);
  const entry: UsageEntry = {
    protocol: 'openai', key, model, provider: null, upstreamModel: null, status: 200,
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1 },
    cost: 2, ttftMs: null, latencyMs: 50, error: null,
  };
  return { db, keys, models, key, model, usage, entry };
}

test('record is atomic when log insertion fails', () => {
  const { db, keys, key, usage, entry } = setup();
  try {
    db.exec("CREATE TRIGGER fail_log BEFORE INSERT ON request_logs BEGIN SELECT RAISE(ABORT, 'failed'); END");
    expect(() => usage.record(entry, new Date(2024, 0, 31, 23, 59))).toThrow();
    expect(keys.get(key.id, new Date(2024, 0, 31, 23, 59))?.requestCount).toBe(0);
    expect(usage.byModel()).toEqual([]);
    expect(usage.totals()).toMatchObject({ requestCount: 0 });
  } finally {
    db.close();
  }
});

for (const [period, before, after] of [
  ['day', new Date(2024, 0, 31, 23, 59), new Date(2024, 1, 1, 0, 1)],
  ['week', new Date(2024, 0, 7, 23, 59), new Date(2024, 0, 8, 0, 1)],
  ['month', new Date(2024, 0, 31, 23, 59), new Date(2024, 1, 1, 0, 1)],
  ['none', new Date(2024, 0, 31, 23, 59), new Date(2024, 1, 1, 0, 1)],
] as const) {
  test(`record rolls over ${period} period at its boundary`, () => {
    const { db, keys, key, usage, entry } = setup(period);
    try {
      db.query('UPDATE api_keys SET period_start = ? WHERE id = ?').run(before.toISOString(), key.id);
      usage.record(entry, before);
      usage.record(entry, after);
      expect(keys.get(key.id, after)?.periodCost).toBe(period === 'none' ? 4 : 2);
      expect(keys.get(key.id, after)?.totalCost).toBe(4);
    } finally {
      db.close();
    }
  });
}

test('unknown usage and uncosted count different conditions', () => {
  const { db, usage, entry } = setup();
  try {
    usage.record({ ...entry, cost: null }, new Date(2024, 0, 31, 23, 59));
    usage.record({ ...entry, usage: null, cost: null }, new Date(2024, 0, 31, 23, 59));
    expect(usage.byModel()[0]).toMatchObject({ requests: 2, unknownUsage: 1, uncosted: 2 });
  } finally {
    db.close();
  }
});

test('daily usage survives closing and reopening database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-store-'));
  try {
    const db = openGatewayDatabase(dir);
    migrate(db);
    const date = new Date(2024, 0, 1, 12);
    const key = new KeyStore(db).create({ name: 'key' }, date);
    const model = new ModelStore(db).create({ name: 'model' }, date);
    const entry: UsageEntry = {
      protocol: 'openai', key, model, provider: null, upstreamModel: null, status: 200,
      usage: null, cost: null, ttftMs: null, latencyMs: 1, error: null,
    };
    new UsageStore(db).record(entry, date);
    db.close();
    const reopened = openGatewayDatabase(dir);
    try {
      expect(new UsageStore(reopened).byModel()).toMatchObject([
        { modelId: model.id, modelName: 'model', requests: 1, unknownUsage: 1, uncosted: 1 },
      ]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage names and rows survive deleting provider model and key', () => {
  const { db, keys, models, key, model, usage, entry } = setup();
  try {
    const providers = new ProviderStore(db);
    const provider = providers.create({
      name: 'provider', connector: 'test', baseUrl: null, credential: null, autoPublish: false,
    }, new Date(2024, 0, 1));
    usage.record({ ...entry, provider }, new Date(2024, 0, 31, 23, 59));
    providers.delete(provider.id);
    models.delete(model.id);
    keys.delete(key.id);
    expect(usage.byModel()).toMatchObject([{ modelId: model.id, modelName: 'model', requests: 1 }]);
    expect(usage.byProvider(model.id)).toMatchObject([{ providerId: provider.id, providerName: 'provider' }]);
    expect(usage.byKey()).toMatchObject([{ keyId: key.id, keyName: 'key' }]);
  } finally {
    db.close();
  }
});

test('range filters, log trimming and clearing do not alter totals', () => {
  const { db, usage, entry, model } = setup();
  try {
    for (let i = 0; i < 201; i++) usage.record(entry, new Date(2024, 0, 31, 12));
    usage.record({ ...entry, status: 500 }, new Date(2024, 1, 1, 12));
    expect(usage.logs()).toHaveLength(200);
    expect(db.query('SELECT COUNT(*) AS n FROM request_logs').get()).toEqual({ n: 200 });
    expect(usage.byDay({ from: '2024-02-01', to: '2024-02-01' }, { modelId: model.id }))
      .toMatchObject([{ day: '2024-02-01', requests: 1, errors: 1 }]);
    usage.clearLogs();
    expect(usage.logs()).toEqual([]);
    expect(usage.totals()).toMatchObject({ requestCount: 202, cost: 404 });
  } finally {
    db.close();
  }
});

test('model price changes do not alter recorded cost', () => {
  const { db, usage, entry, models, model } = setup();
  try {
    usage.record(entry, new Date(2024, 0, 31, 12));
    models.update(model.id, { price: { input: 999, output: 999, cacheRead: null } });
    expect(usage.byModel()[0].cost).toBe(2);
  } finally {
    db.close();
  }
});

test('a model that still exists is listed under its current name', () => {
  const { db, usage, entry, models, model } = setup();
  try {
    usage.record(entry, new Date(2024, 0, 31, 12));
    models.update(model.id, { name: 'renamed' });
    expect(usage.byModel()[0].modelName).toBe('renamed');
  } finally {
    db.close();
  }
});

test('a failed request counts as an error and not as missing usage or cost', () => {
  const { db, usage, entry } = setup();
  try {
    usage.record({ ...entry, status: 503, usage: null, cost: null }, new Date(2024, 0, 31, 12));
    expect(usage.byModel()[0]).toMatchObject({ requests: 1, errors: 1, unknownUsage: 0, uncosted: 0 });
  } finally {
    db.close();
  }
});

test('the lifetime input count of a key includes cached tokens', () => {
  const { db, usage, entry, keys, key } = setup();
  try {
    const now = new Date(2024, 0, 31, 12);
    usage.record({ ...entry, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 } }, now);
    expect(keys.get(key.id, now)).toMatchObject({ inputTokens: 15, outputTokens: 2 });
    expect(usage.totals()).toMatchObject({ inputTokens: 15, outputTokens: 2 });
  } finally {
    db.close();
  }
});
