import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from './schema';
import { KeyStore } from './keyStore';
import { ModelStore } from './modelStore';
import { GatewayStore } from './store';
import { openGatewayDatabase } from './database';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = new Date('2024-01-01T12:00:00Z');

test('deleting the only restricted model never grants all models', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const models = new ModelStore(db);
    const keys = new KeyStore(db);
    const model = models.create({ name: 'one' }, now);
    const other = models.create({ name: 'other' }, now);
    const key = keys.create({ name: 'key', restricted: true, modelIds: [model.id] }, now);
    models.delete(model.id);
    const current = keys.get(key.id, now)!;
    expect(current.modelIds).toEqual([]);
    expect(keys.mayUse(current, other.id)).toBe(false);
  } finally {
    db.close();
  }
});

test('changing limit or reset period preserves period cost', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const keys = new KeyStore(db);
    const key = keys.create({ name: 'key' }, now);
    db.query('UPDATE api_keys SET period_cost = 7 WHERE id = ?').run(key.id);
    expect(keys.update(key.id, { costLimit: 10, resetPeriod: 'day' }, now)?.periodCost).toBe(7);
  } finally {
    db.close();
  }
});

test('refusal order forbids models before unpriced before over limit', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const models = new ModelStore(db);
    const keys = new KeyStore(db);
    const model = models.create({ name: 'one' }, now);
    const price = { input: null, output: 1, cacheRead: null, cacheWrite: null };
    const key = keys.create({ name: 'key', restricted: true, costLimit: 0 }, now);
    expect(keys.refusalFor(key, model, [price])).toBe('forbidden-model');
    const allowed = keys.update(key.id, { restricted: false }, now)!;
    expect(keys.refusalFor(allowed, model, [price])).toBe('unpriced-model');
    expect(keys.refusalFor(allowed, model, [{ ...price, input: 0 }])).toBe('over-limit');
    const unlimited = keys.update(key.id, { costLimit: null }, now)!;
    expect(keys.refusalFor(unlimited, model, [price])).toBeNull();
  } finally {
    db.close();
  }
});

test('old gateway API key verifies after migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-key-'));
  try {
    const old = new GatewayStore(dir);
    const key = old.createKey('old');
    old.close();
    const db = openGatewayDatabase(dir);
    try {
      migrate(db);
      expect(new KeyStore(db).verify(key.token, now)).toMatchObject({ key: { id: key.id, name: key.name } });
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verification refuses unknown disabled and expired keys', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const store = new KeyStore(db);
    const key = store.create({ name: 'key', expiresAt: now.toISOString() }, now);
    expect(store.verify('wrong', now)).toEqual({ refused: 'unknown' });
    expect(store.verify(key.token, now)).toEqual({ refused: 'expired' });
    store.update(key.id, { enabled: false }, now);
    expect(store.verify(key.token, now)).toEqual({ refused: 'disabled' });
  } finally {
    db.close();
  }
});

test('reset usage preserves lifetime totals', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const store = new KeyStore(db);
    const key = store.create({ name: 'key' }, now);
    db.query('UPDATE api_keys SET period_cost = 5, total_cost = 9, request_count = 2 WHERE id = ?').run(key.id);
    expect(store.resetUsage(key.id, new Date(now.getTime() + 1000)))
      .toMatchObject({ periodCost: 0, totalCost: 9, requestCount: 2 });
  } finally {
    db.close();
  }
});
