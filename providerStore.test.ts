import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Protocol } from './shared/api';
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

test('rule B1: a rejected credential is marked until a new one is stored', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const store = new ProviderStore(db);
    const created = store.create(input, now);
    expect(created.credentialRejected).toBe(false);
    expect(store.rejectCredential(created.id)).toBe(true);
    expect(store.get(created.id)).toMatchObject({ credentialRejected: true, hasCredential: true });
    expect(store.credential(created.id)).toBe(input.credential);
    expect(JSON.stringify(store.list())).not.toContain(input.credential);
    store.setCredential(created.id, 'replacement');
    expect(store.get(created.id)).toMatchObject({ credentialRejected: false });
    store.rejectCredential(created.id);
    store.setCredential(created.id, null);
    expect(store.get(created.id)).toMatchObject({ credentialRejected: false, hasCredential: false });
    expect(store.rejectCredential('prv-missing')).toBe(false);
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
      price: { input: 1, output: 2, cacheRead: 0 }, protocols: null,
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

/** One discovered model with `protocols`, as the store reads it back. */
function protocolsRoundTrip(protocols: Protocol[] | null): Protocol[] | null {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const store = new ProviderStore(db);
    const provider = store.create(input, now);
    store.replaceModels(provider.id, [{
      upstreamId: 'm', contextLength: null, maxOutputTokens: null,
      price: { input: null, output: null, cacheRead: null }, protocols,
    }], now);
    return store.models(provider.id)[0].protocols;
  } finally {
    db.close();
  }
}

test('a model whose provider said nothing about protocols reads back as null', () => {
  expect(protocolsRoundTrip(null)).toBeNull();
});

test('one protocol reads back as it was stored', () => {
  expect(protocolsRoundTrip(['messages'])).toEqual(['messages']);
});

test('several protocols read back as they were stored', () => {
  expect(protocolsRoundTrip(['chat', 'messages', 'responses']))
    .toEqual(['chat', 'messages', 'responses']);
});

test('an empty list reads back as an empty list, not as "not said"', () => {
  expect(protocolsRoundTrip([])).toEqual([]);
});

test('the store keeps the protocols in the order the provider gave them', () => {
  expect(protocolsRoundTrip(['responses', 'chat'])).toEqual(['responses', 'chat']);
});

test('a protocols text that is not a list of known protocols fails loudly', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const store = new ProviderStore(db);
    const provider = store.create(input, now);
    for (const text of ['"chat"', '{}', '["chat","grpc"]']) {
      db.query('DELETE FROM provider_models').run();
      db.query(`INSERT INTO provider_models (provider_id, upstream_id, protocols, fetched_at)
        VALUES (?, 'bad', ?, 'now')`).run(provider.id, text);
      expect(() => store.models(provider.id))
        .toThrow(`Corrupt protocols for provider ${provider.id} model bad`);
    }
  } finally {
    db.close();
  }
});
