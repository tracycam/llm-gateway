import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate, StoreRefusal } from './schema';
import { ModelStore, priceOf } from './modelStore';
import { ProviderStore } from './providerStore';

const now = new Date('2024-01-01T00:00:00Z');
const price = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };

function setup() {
  const db = new Database(':memory:');
  migrate(db);
  const providers = new ProviderStore(db);
  const models = new ModelStore(db);
  const provider = providers.create({ name: 'p', connector: 'test', baseUrl: null, credential: null, autoPublish: false }, now);
  return { db, providers, models, provider };
}

test('model CRUD and route CRUD', () => {
  const { db, models, provider } = setup();
  try {
    const model = models.create({ name: 'm', price, contextLength: 100 }, now);
    expect(model.id).toMatch(/^mdl-[0-9a-f]{8}$/);
    expect(models.byName('m')?.id).toBe(model.id);
    expect(models.update(model.id, { name: 'new', contextLength: null, enabled: false }))
      .toMatchObject({ name: 'new', contextLength: null, enabled: false });
    const route = models.addRoute(model.id, { providerId: provider.id, upstreamModel: 'up' });
    expect(models.updateRoute(route.id, { weight: 2, enabled: false })).toMatchObject({ weight: 2, enabled: false });
    expect(models.list()[0].routes).toHaveLength(1);
    expect(models.removeRoute(route.id)).toBe(true);
    expect(models.delete(model.id)).toBe(true);
    expect(models.get(model.id)).toBeNull();
  } finally {
    db.close();
  }
});

test('duplicate model name is refused', () => {
  const { db, models } = setup();
  try {
    models.create({ name: 'm' }, now);
    expect(() => models.create({ name: 'm' }, now)).toThrow(StoreRefusal);
    expect(() => models.create({ name: 'm' }, now)).toThrow('名称已存在');
    const other = models.create({ name: 'other' }, now);
    expect(() => models.update(other.id, { name: 'm' })).toThrow(StoreRefusal);
  } finally {
    db.close();
  }
});

test('publish creates a model with discovered price and context', () => {
  const { db, models, providers, provider } = setup();
  try {
    providers.replaceModels(provider.id, [{ upstreamId: 'up', contextLength: 123, maxOutputTokens: null, price }], now);
    const route = models.publish(provider.id, 'up', now);
    expect(models.get(route.modelId)).toMatchObject({ name: 'up', price, contextLength: 123 });
  } finally {
    db.close();
  }
});

test('publish attaches same-name model without overwriting price or context', () => {
  const { db, models, providers, provider } = setup();
  try {
    const original = models.create({ name: 'up', price, contextLength: 50 }, now);
    providers.replaceModels(provider.id, [{ upstreamId: 'up', contextLength: 123, maxOutputTokens: null, price: { ...price, input: 99 } }], now);
    expect(models.publish(provider.id, 'up', now).modelId).toBe(original.id);
    expect(models.get(original.id)).toMatchObject({ price, contextLength: 50 });
  } finally {
    db.close();
  }
});

test('publish twice returns the existing route', () => {
  const { db, models, providers, provider } = setup();
  try {
    providers.replaceModels(provider.id, [{ upstreamId: 'up', contextLength: null, maxOutputTokens: null, price }], now);
    const first = models.publish(provider.id, 'up', now);
    expect(models.publish(provider.id, 'up', now)).toEqual(first);
    expect(models.get(first.modelId)?.routes).toHaveLength(1);
  } finally {
    db.close();
  }
});

test('route price overrides model price as a group', () => {
  const { db, models, provider } = setup();
  try {
    const model = models.create({ name: 'm', price }, now);
    const routePrice = { input: 0, output: null, cacheRead: null, cacheWrite: 7 };
    const route = models.addRoute(model.id, { providerId: provider.id, upstreamModel: 'up', price: routePrice });
    expect(priceOf(route, model)).toEqual(routePrice);
    const cleared = models.updateRoute(route.id, { price: null })!;
    expect(priceOf(cleared, model)).toEqual(price);
    const partial = models.updateRoute(route.id, {
      price: { input: null, output: null, cacheRead: 9, cacheWrite: null },
    })!;
    expect(partial.price).toBeNull();
    expect(priceOf(partial, model)).toEqual(price);
  } finally {
    db.close();
  }
});
