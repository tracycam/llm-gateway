import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate, StoreRefusal } from './schema';
import { ProviderStore } from './providerStore';

const now = new Date('2024-01-01T00:00:00Z');
const input = {
  name: 'provider', connector: 'openai-compatible', baseUrl: 'https://example.com',
  credential: 'secret-value', autoPublish: false,
};

test('provider results never contain credentials', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const store = new ProviderStore(db);
    const created = store.create(input, now);
    const updated = store.update(created.id, { enabled: false });
    expect(JSON.stringify([created, updated, store.get(created.id), store.list()])).not.toContain(input.credential);
    expect(created.hasCredential).toBe(true);
    expect(store.credential(created.id)).toBe(input.credential);
  } finally {
    db.close();
  }
});

test('provider CRUD and credential replacement', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const store = new ProviderStore(db);
    const created = store.create(input, now);
    expect(created.id).toMatch(/^prv-[0-9a-f]{8}$/);
    expect(store.update(created.id, { name: 'changed', baseUrl: null, autoPublish: true, enabled: false }))
      .toMatchObject({ name: 'changed', baseUrl: null, autoPublish: true, enabled: false });
    expect(store.setCredential(created.id, null)).toBe(true);
    expect(store.get(created.id)?.hasCredential).toBe(false);
    expect(store.delete(created.id)).toBe(true);
    expect(store.get(created.id)).toBeNull();
  } finally {
    db.close();
  }
});

test('duplicate provider name is refused', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const store = new ProviderStore(db);
    store.create(input, now);
    expect(() => store.create(input, now)).toThrow(StoreRefusal);
    expect(() => store.create(input, now)).toThrow('名称已存在');
    const other = store.create({ ...input, name: 'other' }, now);
    expect(() => store.update(other.id, { name: input.name })).toThrow(StoreRefusal);
  } finally {
    db.close();
  }
});

test('replacing discovered models is atomic', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const store = new ProviderStore(db);
    const provider = store.create(input, now);
    const model = {
      upstreamId: 'm', contextLength: 1024, maxOutputTokens: 512,
      price: { input: 1, output: 2, cacheRead: 0 },
    };
    store.replaceModels(provider.id, [model], now);
    expect(store.models(provider.id)).toEqual([{ ...model, fetchedAt: now.toISOString() }]);
    expect(() => store.replaceModels(provider.id, [model, model], now)).toThrow();
    expect(store.models(provider.id)).toHaveLength(1);
    store.replaceModels(provider.id, [], now);
    expect(store.models(provider.id)).toEqual([]);
  } finally {
    db.close();
  }
});
