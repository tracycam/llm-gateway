// Tests for the provider-store connector adapter.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ProviderStore } from '../providerStore';
import { providerAccess } from './access';
import { CredentialRenewals } from './tokens';

function setup() {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE providers (id TEXT, name TEXT, connector TEXT, base_url TEXT, credential TEXT,
    auto_publish INTEGER, enabled INTEGER DEFAULT 1, credential_rejected INTEGER DEFAULT 0,
    models_refreshed_at TEXT, models_error TEXT, created_at TEXT)`);
  db.run(`CREATE TABLE provider_models (provider_id TEXT, upstream_id TEXT, context_length INTEGER,
    max_output_tokens INTEGER, input_price REAL, output_price REAL, cache_read_price REAL,
    protocols TEXT, fetched_at TEXT)`);
  const store = new ProviderStore(db);
  const provider = store.create({
    name: 'provider', connector: 'test', baseUrl: 'http://localhost', credential: 'old', autoPublish: false,
  }, new Date(0));
  return { db, store, provider, renewals: new CredentialRenewals() };
}

test('id and baseUrl are copied from the provider', () => {
  const { db, store, provider, renewals } = setup();
  const access = providerAccess(store, provider, renewals);
  expect(access.id).toBe(provider.id);
  expect(access.baseUrl).toBe('http://localhost');
  db.close();
});

test('rule A: credential is read as stored now, not copied when the access is built', () => {
  const { db, store, provider, renewals } = setup();
  const one = providerAccess(store, provider, renewals);
  const two = providerAccess(store, provider, renewals);
  // A renewal stored through another access object is visible at once.
  two.saveCredential('second');
  expect(one.credential).toBe('second');
  store.setCredential(provider.id, 'third');
  expect(one.credential).toBe('third');
  db.close();
});

test('saveCredential writes through to the provider store', () => {
  const { db, store, provider, renewals } = setup();
  providerAccess(store, provider, renewals).saveCredential('new');
  expect(store.credential(provider.id)).toBe('new');
  db.close();
});

test('model loads the stored list once for several lookups', () => {
  const { db, store, provider, renewals } = setup();
  const model = {
    upstreamId: 'one', contextLength: 10, maxOutputTokens: 5,
    price: { input: null, output: null, cacheRead: null }, protocols: null,
  };
  store.replaceModels(provider.id, [model], new Date(0));
  let queries = 0;
  const original = store.models.bind(store);
  store.models = (id) => {
    queries += 1;
    return original(id);
  };
  const access = providerAccess(store, provider, renewals);
  expect(queries).toBe(0);
  expect(access.model('one')).toMatchObject(model);
  expect(access.model('two')).toBeNull();
  expect(queries).toBe(1);
  db.close();
});
