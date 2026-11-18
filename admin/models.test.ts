// Model management uses real SQLite stores.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { ModelStore } from '../modelStore';
import { KeyStore } from '../keyStore';
import { ProviderStore } from '../providerStore';
import { migrate } from '../schema';
import { UsageStore } from '../usageStore';
import type { AdminDeps } from './deps';
import { handleModelRoute } from './models';
import { fixture, request } from './testing';

test('models and routes validate inputs and persist changes', async () => {
  const db = new Database(':memory:');
  migrate(db);
  const deps: AdminDeps = {
    providers: new ProviderStore(db),
    models: new ModelStore(db),
    keys: new KeyStore(db),
    usage: new UsageStore(db),
    connector: () => null,
    connectors: () => [],
    now: () => new Date('2026-01-01T00:00:00Z'),
  };
  const call = (path: string, method = 'GET', body?: unknown) => handleModelRoute(new Request(
    `http://localhost/api/gateway${path}`,
    { method, body: body === undefined ? undefined : JSON.stringify(body) }
  ), deps);
  const provider = deps.providers.create({
    name: 'p', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
  }, deps.now());
  expect((await call('/models', 'POST', []))?.status).toBe(400);
  expect((await call('/models', 'POST', { name: 'm' }))?.status).toBe(201);
  expect((await call('/models', 'POST', { name: 'm' }))?.status).toBe(409);
  const id = deps.models.list()[0].id;
  expect((await call(`/models/${id}/routes`, 'POST', {
    providerId: provider.id, upstreamModel: 'x', weight: 0,
  }))?.status).toBe(400);
  expect((await call(`/models/${id}/routes`, 'POST', {
    providerId: provider.id,
    upstreamModel: 'x',
    price: { input: -1, output: null, cacheRead: null },
  }))?.status).toBe(400);
  expect(deps.models.get(id)?.routes).toHaveLength(0);
  expect((await call(`/models/${id}/routes`, 'POST', {
    providerId: provider.id, upstreamModel: 'x',
  }))?.status).toBe(201);
  const route = deps.models.get(id)!.routes[0];
  expect(route.providerName).toBe('p');
  expect((await call(`/routes/${route.id}`, 'PATCH', { enabled: 'false' }))?.status).toBe(400);
  expect(deps.models.get(id)?.routes[0].enabled).toBe(true);
  expect((await call(`/routes/${route.id}`, 'DELETE'))?.status).toBe(204);
  expect((await call(`/routes/${route.id}`, 'DELETE'))?.status).toBe(404);
  expect((await call('/models', 'DELETE'))?.status).toBe(405);
  expect(await call('/models/a%2Fb')).toBeNull();
  db.close();
});

for (const [field, value] of [
  ['name', undefined], ['name', 5], ['name', ''], ['contextLength', 0], ['contextLength', 1.5],
  ['contextLength', '10'], ['price', 1], ['price', null],
] as const) {
  test(`POST models rule 2: invalid ${field} ${String(value)}`, async () => {
    const { deps, db } = fixture();
    const response = await handleModelRoute(request('/models', 'POST', { name: 'm', [field]: value }), deps);
    expect(response?.status).toBe(400);
    expect((await response?.json()).error).toContain(field);
    expect(deps.models.list()).toHaveLength(0);
    db.close();
  });
}

for (const field of ['input', 'output', 'cacheRead']) {
  for (const value of [-1, '1', undefined]) {
    test(`POST models rule 2: price.${field} ${String(value)} rejected`, async () => {
      const { deps, db } = fixture();
      const price = { input: null, output: null, cacheRead: null, [field]: value };
      const response = await handleModelRoute(request('/models', 'POST', { name: 'm', price }), deps);
      expect(response?.status).toBe(400);
      expect((await response?.json()).error).toContain(`price.${field}`);
      expect(deps.models.list()).toHaveLength(0);
      db.close();
    });
  }
}

for (const [field, value] of [
  ['name', 3], ['enabled', 'false'], ['contextLength', -1], ['price', []],
] as const) {
  test(`PATCH models rule 2: invalid ${field} rejected`, async () => {
    const { deps, db } = fixture();
    const model = deps.models.create({ name: 'm' }, deps.now());
    const req = request(`/models/${model.id}`, 'PATCH', { [field]: value });
    const response = await handleModelRoute(req, deps);
    expect(response?.status).toBe(400);
    expect((await response?.json()).error).toContain(field);
    expect(deps.models.get(model.id)).toEqual(model);
    db.close();
  });
}

for (const [field, value] of [
  ['providerId', undefined], ['providerId', 3], ['providerId', 'missing'],
  ['upstreamModel', undefined], ['upstreamModel', 3], ['upstreamModel', ''],
  ['weight', 0], ['weight', 1.5], ['weight', '1'], ['price', 1],
] as const) {
  test(`POST routes rule 2: invalid ${field} ${String(value)} rejected`, async () => {
    const { deps, db } = fixture();
    const provider = deps.providers.create({
      name: 'p', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
    }, deps.now());
    const model = deps.models.create({ name: 'm' }, deps.now());
    const body = { providerId: provider.id, upstreamModel: 'x', [field]: value };
    const response = await handleModelRoute(request(`/models/${model.id}/routes`, 'POST', body), deps);
    expect(response?.status).toBe(400);
    expect((await response?.json()).error).toContain(field);
    expect(deps.models.get(model.id)?.routes).toHaveLength(0);
    db.close();
  });
}

for (const field of ['input', 'output']) {
  test(`POST routes: price.${field} null is rejected`, async () => {
    const { deps, db } = fixture();
    const provider = deps.providers.create({
      name: 'p', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
    }, deps.now());
    const model = deps.models.create({ name: 'm' }, deps.now());
    const price = { input: 1, output: 1, cacheRead: null, [field]: null };
    const body = { providerId: provider.id, upstreamModel: 'x', price };
    const response = await handleModelRoute(request(`/models/${model.id}/routes`, 'POST', body), deps);
    expect(response?.status).toBe(400);
    expect((await response?.json()).error).toContain(`price.${field}`);
    expect(deps.models.get(model.id)?.routes).toHaveLength(0);
    db.close();
  });
}

for (const [field, value] of [['weight', 0], ['weight', '1'], ['enabled', 1], ['price', []]] as const) {
  test(`PATCH routes rule 2: invalid ${field} rejected`, async () => {
    const { deps, db } = fixture();
    const provider = deps.providers.create({
      name: 'p', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
    }, deps.now());
    const model = deps.models.create({ name: 'm' }, deps.now());
    const route = deps.models.addRoute(model.id, { providerId: provider.id, upstreamModel: 'x' });
    const req = request(`/routes/${route.id}`, 'PATCH', { [field]: value });
    const response = await handleModelRoute(req, deps);
    expect(response?.status).toBe(400);
    expect((await response?.json()).error).toContain(field);
    expect(deps.models.get(model.id)?.routes[0]).toEqual(route);
    db.close();
  });
}

// The price reader ignores a key it does not know, as it does everywhere else in a body, so a
// client that still sends the retired cache-write price is not refused: the price is stored
// without it. Rule 5.3 draws the line at malformed and out-of-range values, not unknown keys.
test('rule 4: a price with cacheWrite is stored without it, the unknown key ignored', async () => {
  const { deps, db } = fixture();
  const sent = { input: 1, output: 2, cacheRead: 3, cacheWrite: 9 };
  const stored = { input: 1, output: 2, cacheRead: 3 };
  try {
    const created = await handleModelRoute(request('/models', 'POST', { name: 'm', price: sent }), deps);
    expect(created?.status).toBe(201);
    const model = (await created!.json()).model;
    expect(model.price).toEqual(stored);
    const patched = await handleModelRoute(request(`/models/${model.id}`, 'PATCH', {
      price: { ...sent, input: 4 },
    }), deps);
    expect(patched?.status).toBe(200);
    expect((await patched!.json()).model.price).toEqual({ ...stored, input: 4 });
    const provider = deps.providers.create({
      name: 'p', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
    }, deps.now());
    const added = await handleModelRoute(request(`/models/${model.id}/routes`, 'POST', {
      providerId: provider.id, upstreamModel: 'x', price: sent,
    }), deps);
    expect(added?.status).toBe(201);
    const route = (await added!.json()).route;
    expect(route.price).toEqual(stored);
    const routePatched = await handleModelRoute(request(`/routes/${route.id}`, 'PATCH', {
      price: { ...sent, output: 5 },
    }), deps);
    expect(routePatched?.status).toBe(200);
    expect((await routePatched!.json()).route.price).toEqual({ ...stored, output: 5 });
  } finally {
    db.close();
  }
});

for (const [path, method] of [
  ['/models', 'PUT'], ['/models/x', 'POST'], ['/models/x/routes', 'GET'], ['/routes/x', 'GET'],
]) {
  test(`${method} ${path}: rule 5 wrong method is 405`, async () => {
    const { deps, db } = fixture();
    expect((await handleModelRoute(request(path, method), deps))?.status).toBe(405);
    db.close();
  });
}

test('GET models and GET model expose stored route providerName', async () => {
  const { deps, db } = fixture();
  const provider = deps.providers.create({
    name: 'provider', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
  }, deps.now());
  const model = deps.models.create({ name: 'm' }, deps.now());
  deps.models.addRoute(model.id, { providerId: provider.id, upstreamModel: 'x' });
  const list = await handleModelRoute(request('/models'), deps);
  expect((await list?.json()).models[0].routes[0].providerName).toBe('provider');
  const get = await handleModelRoute(request(`/models/${model.id}`), deps);
  expect((await get?.json()).model.routes[0].providerName).toBe('provider');
  expect(deps.models.get(model.id)?.routes).toHaveLength(1);
  db.close();
});

test('PATCH model updates stored values, DELETE model removes it', async () => {
  const { deps, db } = fixture();
  const model = deps.models.create({ name: 'm' }, deps.now());
  const response = await handleModelRoute(request(`/models/${model.id}`, 'PATCH', {
    name: 'updated', enabled: false, contextLength: 42,
  }), deps);
  expect((await response?.json()).model.name).toBe('updated');
  expect(deps.models.get(model.id)?.enabled).toBe(false);
  expect((await handleModelRoute(request(`/models/${model.id}`, 'DELETE'), deps))?.status).toBe(204);
  expect(deps.models.get(model.id)).toBeNull();
  db.close();
});

test('PATCH route updates price and weight, then null inherits model price', async () => {
  const { deps, db } = fixture();
  const provider = deps.providers.create({
    name: 'p', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
  }, deps.now());
  const model = deps.models.create({ name: 'm' }, deps.now());
  const route = deps.models.addRoute(model.id, { providerId: provider.id, upstreamModel: 'x' });
  const price = { input: 1, output: 2, cacheRead: null };
  const req = request(`/routes/${route.id}`, 'PATCH', { weight: 2, price });
  const response = await handleModelRoute(req, deps);
  expect((await response?.json()).route.price).toEqual(price);
  expect(deps.models.get(model.id)?.routes[0].weight).toBe(2);
  await handleModelRoute(request(`/routes/${route.id}`, 'PATCH', { price: null }), deps);
  expect(deps.models.get(model.id)?.routes[0].price).toBeNull();
  db.close();
});

for (const [path, method, body] of [
  ['/models/missing', 'GET', undefined], ['/models/missing', 'PATCH', {}],
  ['/models/missing', 'DELETE', undefined],
  ['/models/missing/routes', 'POST', { providerId: 'x', upstreamModel: 'x' }],
  ['/routes/missing', 'PATCH', {}], ['/routes/missing', 'DELETE', undefined],
] as const) {
  test(`${method} ${path}: unknown resource is 404`, async () => {
    const { deps, db } = fixture();
    const response = await handleModelRoute(request(path, method, body), deps);
    expect(response?.status).toBe(404);
    expect(deps.models.list()).toHaveLength(0);
    db.close();
  });
}
