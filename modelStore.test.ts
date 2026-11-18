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
  const provider = providers.create({
    name: 'p', connector: 'test', baseUrl: null, credential: null, autoPublish: false,
  }, now);
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
    expect(models.updateRoute(route.id, { weight: 2, enabled: false }))
      .toMatchObject({ weight: 2, enabled: false });
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

/** A second provider with the same connector, for the two-provider cases below. */
function addProvider(providers: ProviderStore, name: string) {
  return providers.create({
    name, connector: 'test', baseUrl: null, credential: null, autoPublish: false,
  }, now);
}

/** Replace one route id, so id order can be made the reverse of creation order. */
function renameRoute(db: Database, id: string, name: string): void {
  db.query('UPDATE routes SET id = ? WHERE id = ?').run(name, id);
}

test('routes are returned in creation order, not in id order', () => {
  const { db, models, provider } = setup();
  try {
    const model = models.create({ name: 'm', price }, now);
    const created = ['first', 'second', 'third'].map((upstreamModel) =>
      models.addRoute(model.id, { providerId: provider.id, upstreamModel }));
    // Ids are random; reversing them here keeps the test independent of what they happened to be.
    ['rte-z', 'rte-m', 'rte-a'].forEach((id, index) => renameRoute(db, created[index].id, id));
    expect(models.get(model.id)!.routes.map((route) => route.upstreamModel))
      .toEqual(['first', 'second', 'third']);
  } finally {
    db.close();
  }
});

test('a model published from two providers lists the routes in publication order', () => {
  const { db, models, providers, provider } = setup();
  try {
    const other = addProvider(providers, 'other');
    const published = [{ upstreamId: 'up', contextLength: null, maxOutputTokens: null, price }];
    providers.replaceModels(provider.id, published, now);
    providers.replaceModels(other.id, published, now);
    const first = models.publish(provider.id, 'up', now);
    const second = models.publish(other.id, 'up', now);
    renameRoute(db, first.id, 'rte-z');
    renameRoute(db, second.id, 'rte-a');
    expect(models.byName('up')!.routes.map((route) => route.providerId)).toEqual([provider.id, other.id]);
  } finally {
    db.close();
  }
});

test('publish creates a model with discovered price and context', () => {
  const { db, models, providers, provider } = setup();
  try {
    providers.replaceModels(provider.id, [
      { upstreamId: 'up', contextLength: 123, maxOutputTokens: null, price },
    ], now);
    const route = models.publish(provider.id, 'up', now);
    expect(models.get(route.modelId)).toMatchObject({ name: 'up', price, contextLength: 123 });
  } finally {
    db.close();
  }
});

test('the publish that creates the model gives the model the discovered price and the route none', () => {
  const { db, models, providers, provider } = setup();
  try {
    providers.replaceModels(provider.id, [
      { upstreamId: 'up', contextLength: null, maxOutputTokens: null, price },
    ], now);
    const route = models.publish(provider.id, 'up', now);
    const model = models.get(route.modelId)!;
    expect(model.price).toEqual(price);
    expect(route.price).toBeNull();
    expect(priceOf(route, model)).toEqual(price);
  } finally {
    db.close();
  }
});

test('a publish that adds a route to an existing model gives the route its discovered price', () => {
  const { db, models, providers, provider } = setup();
  const cheap = { input: 0.15, output: 0.6, cacheRead: null, cacheWrite: null };
  try {
    const other = addProvider(providers, 'other');
    providers.replaceModels(provider.id, [
      { upstreamId: 'up', contextLength: null, maxOutputTokens: null, price },
    ], now);
    providers.replaceModels(other.id, [
      { upstreamId: 'up', contextLength: null, maxOutputTokens: null, price: cheap },
    ], now);
    const first = models.publish(provider.id, 'up', now);
    const second = models.publish(other.id, 'up', now);
    const model = models.get(second.modelId)!;
    expect(second.price).toEqual(cheap);
    expect(priceOf(second, model)).toEqual(cheap);
    expect(priceOf(model.routes[0], model)).toEqual(price);
    expect(first.price).toBeNull();
  } finally {
    db.close();
  }
});

test('a route gets no price when the discovered price is the model price', () => {
  const { db, models, providers, provider } = setup();
  try {
    const other = addProvider(providers, 'other');
    const published = [{ upstreamId: 'up', contextLength: null, maxOutputTokens: null, price }];
    providers.replaceModels(provider.id, published, now);
    providers.replaceModels(other.id, published, now);
    models.publish(provider.id, 'up', now);
    const second = models.publish(other.id, 'up', now);
    const model = models.get(second.modelId)!;
    expect(second.price).toBeNull();
    expect(priceOf(second, model)).toEqual(price);
  } finally {
    db.close();
  }
});

// A difference in any one of the four fields is a difference, so each field gets its own case.
for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
  test(`a discovered price differing only in ${field} is the route price`, () => {
    const { db, models, providers, provider } = setup();
    const changed = { ...price, [field]: price[field] + 10 };
    try {
      const other = addProvider(providers, 'other');
      providers.replaceModels(provider.id, [
        { upstreamId: 'up', contextLength: null, maxOutputTokens: null, price },
      ], now);
      providers.replaceModels(other.id, [
        { upstreamId: 'up', contextLength: null, maxOutputTokens: null, price: changed },
      ], now);
      models.publish(provider.id, 'up', now);
      const second = models.publish(other.id, 'up', now);
      expect(second.price).toEqual(changed);
      expect(priceOf(second, models.get(second.modelId)!)).toEqual(changed);
    } finally {
      db.close();
    }
  });
}

test('a discovered price without input or output gives the route no price', () => {
  const { db, models, providers, provider } = setup();
  const partials = [
    { input: null, output: 0.6, cacheRead: null, cacheWrite: null },
    { input: 0.15, output: null, cacheRead: null, cacheWrite: null },
  ];
  try {
    const model = models.create({ name: 'up', price }, now);
    for (const [index, partial] of partials.entries()) {
      const other = addProvider(providers, `other-${String(index)}`);
      providers.replaceModels(other.id, [
        { upstreamId: 'up', contextLength: null, maxOutputTokens: null, price: partial },
      ], now);
      const route = models.publish(other.id, 'up', now);
      expect(route.price).toBeNull();
      expect(priceOf(route, models.get(model.id)!)).toEqual(price);
    }
  } finally {
    db.close();
  }
});

test('publish attaches same-name model without overwriting price or context', () => {
  const { db, models, providers, provider } = setup();
  try {
    const original = models.create({ name: 'up', price, contextLength: 50 }, now);
    providers.replaceModels(provider.id, [
      { upstreamId: 'up', contextLength: 123, maxOutputTokens: null, price: { ...price, input: 99 } },
    ], now);
    expect(models.publish(provider.id, 'up', now).modelId).toBe(original.id);
    expect(models.get(original.id)).toMatchObject({ price, contextLength: 50 });
  } finally {
    db.close();
  }
});

test('publish twice returns the existing route', () => {
  const { db, models, providers, provider } = setup();
  try {
    providers.replaceModels(provider.id, [
      { upstreamId: 'up', contextLength: null, maxOutputTokens: null, price },
    ], now);
    const first = models.publish(provider.id, 'up', now);
    // The upstream price may have moved since; publishing again still returns the route as stored.
    const moved = { input: 9, output: 10, cacheRead: null, cacheWrite: null };
    providers.replaceModels(provider.id, [
      { upstreamId: 'up', contextLength: null, maxOutputTokens: null, price: moved },
    ], now);
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
    const route = models.addRoute(model.id, {
      providerId: provider.id, upstreamModel: 'up', price: routePrice,
    });
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
