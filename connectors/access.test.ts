// Tests for the provider-store connector adapter.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ProviderStore } from '../providerStore';
import { providerAccess } from './access';

function setup() {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE providers (id TEXT, name TEXT, connector TEXT, base_url TEXT, credential TEXT,
    auto_publish INTEGER, enabled INTEGER DEFAULT 1, created_at TEXT)`);
  db.run(`CREATE TABLE provider_models (provider_id TEXT, upstream_id TEXT, context_length INTEGER,
    max_output_tokens INTEGER, input_price REAL, output_price REAL, cache_read_price REAL,
    fetched_at TEXT)`);
  const store = new ProviderStore(db);
  const provider = store.create({
    name: 'provider', connector: 'test', baseUrl: 'http://localhost', credential: 'old', autoPublish: false,
  }, new Date(0));
  return { db, store, provider };
}

test('id and baseUrl are copied from the provider', () => {
  const { db, store, provider } = setup();
  const access = providerAccess(store, provider);
  expect(access.id).toBe(provider.id);
  expect(access.baseUrl).toBe('http://localhost');
  db.close();
});

test('credential is read when access is constructed', () => {
  const { db, store, provider } = setup();
  store.setCredential(provider.id, 'new');
  const access = providerAccess(store, provider);
  store.setCredential(provider.id, 'later');
  expect(access.credential).toBe('new');
  db.close();
});

test('saveCredential writes through to the provider store', () => {
  const { db, store, provider } = setup();
  providerAccess(store, provider).saveCredential('new');
  expect(store.credential(provider.id)).toBe('new');
  db.close();
});

test('model loads the stored list once for several lookups', () => {
  const { db, store, provider } = setup();
  const model = {
    upstreamId: 'one', contextLength: 10, maxOutputTokens: 5,
    price: { input: null, output: null, cacheRead: null },
  };
  store.replaceModels(provider.id, [model], new Date(0));
  let queries = 0;
  const original = store.models.bind(store);
  store.models = (id) => {
    queries += 1;
    return original(id);
  };
  const access = providerAccess(store, provider);
  expect(queries).toBe(0);
  expect(access.model('one')).toMatchObject(model);
  expect(access.model('two')).toBeNull();
  expect(queries).toBe(1);
  db.close();
});
