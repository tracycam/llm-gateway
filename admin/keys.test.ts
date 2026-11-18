// Key management uses real stores and never returns stored secrets.
import { expect, test } from 'bun:test';
import { handleKeyRoute } from './keys';
import { fixture, request, usageEntry } from './testing';

test('POST key returns plaintext only once; GET PATCH reset never return token or hash', async () => {
  const { deps, db } = fixture();
  const response = await handleKeyRoute(request('/keys', 'POST', { name: 'key', restricted: true }), deps);
  expect(response?.status).toBe(201);
  const createdText = await response!.text();
  const created = JSON.parse(createdText);
  expect(created.token).toStartWith('sk-gw-');
  expect(created.key.token).toBeUndefined();
  expect(createdText).not.toContain('token_hash');
  expect(deps.keys.verify(created.token, deps.now())).toHaveProperty('key.id', created.key.id);
  for (const req of [
    request('/keys'),
    request(`/keys/${created.key.id}`, 'PATCH', { name: 'updated' }),
    request(`/keys/${created.key.id}/reset`, 'POST'),
  ]) {
    const result = await handleKeyRoute(req, deps);
    expect(result?.status).toBe(200);
    const text = await result!.text();
    expect(text).not.toContain(created.token);
    expect(text).not.toContain('token_hash');
  }
  expect(deps.keys.get(created.key.id, deps.now())?.name).toBe('updated');
  expect(deps.keys.get(created.key.id, deps.now())?.modelIds).toEqual([]);
  db.close();
});

for (const enabled of [false, 'no']) {
  test(`POST keys ignores unsupported enabled ${JSON.stringify(enabled)}`, async () => {
    const { deps, db } = fixture();
    const response = await handleKeyRoute(request('/keys', 'POST', { name: 'key', enabled }), deps);
    expect(response?.status).toBe(201);
    const { key } = await response!.json();
    expect(key.enabled).toBe(true);
    expect(deps.keys.get(key.id, deps.now())?.enabled).toBe(true);
    db.close();
  });
}

const invalid: Array<[string, unknown]> = [
  ['name', undefined], ['name', 1], ['name', ''], ['restricted', 'true'],
  ['modelIds', 'x'], ['modelIds', [1]], ['modelIds', ['missing']], ['modelIds', ['x', 'x']],
  ['costLimit', -1], ['costLimit', '1'], ['resetPeriod', 'year'], ['resetPeriod', 1],
  ['maxConcurrency', 0], ['maxConcurrency', 1.5], ['maxConcurrency', '1'],
  ['expiresAt', 'invalid'], ['expiresAt', 1],
];

for (const [field, value] of invalid) {
  test(`POST keys: invalid ${field} ${JSON.stringify(value)} is 400`, async () => {
    const { deps, db } = fixture();
    const req = request('/keys', 'POST', { name: 'key', [field]: value });
    const response = await handleKeyRoute(req, deps);
    expect(response?.status).toBe(400);
    expect((await response?.json()).error).toContain(field);
    expect(deps.keys.list(deps.now())).toHaveLength(0);
    db.close();
  });
}

test('POST keys duplicate existing modelIds is rejected', async () => {
  const { deps, db } = fixture();
  const model = deps.models.create({ name: 'm' }, deps.now());
  const response = await handleKeyRoute(request('/keys', 'POST', {
    name: 'key', modelIds: [model.id, model.id],
  }), deps);
  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual({ error: 'modelIds 无效' });
  expect(deps.keys.list(deps.now())).toHaveLength(0);
  db.close();
});

test('POST keys validates valid fields and normalizes expiration', async () => {
  const { deps, db } = fixture();
  const model = deps.models.create({ name: 'm' }, deps.now());
  const response = await handleKeyRoute(request('/keys', 'POST', {
    name: 'key', restricted: true, modelIds: [model.id], costLimit: 0, resetPeriod: 'week',
    maxConcurrency: 1, expiresAt: '2027-01-01T03:00:00+03:00',
  }), deps);
  expect(response?.status).toBe(201);
  const { key } = await response!.json();
  expect(key.modelIds).toEqual([model.id]);
  expect(key.expiresAt).toBe('2027-01-01T00:00:00.000Z');
  expect(deps.keys.get(key.id, deps.now())).toEqual(key);
  db.close();
});

for (const [field, value] of [...invalid.filter(([name, value]) => name !== 'name' || value !== undefined),
  ['enabled', 'false'] as [string, unknown]]) {
  test(`PATCH keys: invalid ${field} ${JSON.stringify(value)} is 400`, async () => {
    const { deps, db } = fixture();
    const original = deps.keys.create({ name: 'key' }, deps.now());
    const response = await handleKeyRoute(request(`/keys/${original.id}`, 'PATCH', { [field]: value }), deps);
    expect(response?.status).toBe(400);
    expect((await response?.json()).error).toContain(field);
    expect(deps.keys.get(original.id, deps.now())?.name).toBe('key');
    db.close();
  });
}

test('PATCH keys applies nullable limits and enabled', async () => {
  const { deps, db } = fixture();
  const key = deps.keys.create({ name: 'key', costLimit: 5, maxConcurrency: 2 }, deps.now());
  const response = await handleKeyRoute(request(`/keys/${key.id}`, 'PATCH', {
    enabled: false, costLimit: null, maxConcurrency: null, expiresAt: null,
  }), deps);
  const updated = (await response!.json()).key;
  expect(response?.status).toBe(200);
  expect(updated.enabled).toBe(false);
  expect(updated.costLimit).toBeNull();
  expect(updated.maxConcurrency).toBeNull();
  expect(deps.keys.get(key.id, deps.now())).toEqual(updated);
  db.close();
});

test('POST reset clears period cost but preserves lifetime totals', async () => {
  const { deps, db } = fixture();
  const key = deps.keys.create({ name: 'key' }, deps.now());
  deps.usage.record(usageEntry(key.id, 'm'), deps.now());
  const response = await handleKeyRoute(request(`/keys/${key.id}/reset`, 'POST'), deps);
  const reset = (await response!.json()).key;
  expect(reset.periodCost).toBe(0);
  expect(reset.totalCost).toBe(2);
  expect(reset.requestCount).toBe(1);
  expect(deps.keys.get(key.id, deps.now())).toEqual(reset);
  db.close();
});

for (const [path, method, body] of [
  ['/keys/missing', 'PATCH', {}], ['/keys/missing', 'DELETE', undefined],
  ['/keys/missing/reset', 'POST', undefined],
] as const) {
  test(`${method} ${path}: unknown key is 404`, async () => {
    const { deps, db } = fixture();
    expect((await handleKeyRoute(request(path, method, body), deps))?.status).toBe(404);
    expect(deps.keys.list(deps.now())).toHaveLength(0);
    db.close();
  });
}

test('DELETE keys removes key', async () => {
  const { deps, db } = fixture();
  const key = deps.keys.create({ name: 'key' }, deps.now());
  expect((await handleKeyRoute(request(`/keys/${key.id}`, 'DELETE'), deps))?.status).toBe(204);
  expect(deps.keys.get(key.id, deps.now())).toBeNull();
  db.close();
});

for (const [path, method] of [['/keys', 'PUT'], ['/keys/id', 'GET'], ['/keys/id/reset', 'GET']]) {
  test(`${method} ${path}: wrong method is 405`, async () => {
    const { deps, db } = fixture();
    expect((await handleKeyRoute(request(path, method), deps))?.status).toBe(405);
    db.close();
  });
}

test('key paths reject foreign and encoded slash paths', async () => {
  const { deps, db } = fixture();
  expect(await handleKeyRoute(request('/other'), deps)).toBeNull();
  expect(await handleKeyRoute(request('/keys/a%2Fb', 'PATCH', {}), deps)).toBeNull();
  db.close();
});
