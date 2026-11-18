// Usage management reads real accounted requests.
import { expect, test } from 'bun:test';
import { fixture, request, usageEntry } from './testing';
import { handleUsageRoute } from './usage';

function filteredFixture(): ReturnType<typeof fixture> & { keys: string[]; models: string[] } {
  const setup = fixture();
  const keys = ['k1', 'k2'];
  const models = ['m1', 'm2'];
  const providers = ['p1', 'p2'];
  for (let day = 0; day < 2; day++) {
    for (let index = 0; index < 2; index++) {
      const count = 1 + index + 2 * day;
      for (let n = 0; n < count; n++) {
        setup.deps.usage.record(usageEntry(keys[index], models[index], providers[index]),
          new Date(2026, 0, 2 + day, 12));
      }
    }
  }
  return { ...setup, keys, models };
}

test('GET usage by day applies key filter independently', async () => {
  const { deps, db, keys } = filteredFixture();
  const response = await handleUsageRoute(request(`/usage?by=day&key=${keys[0]}`), deps);
  expect(response?.status).toBe(200);
  const { rows } = await response!.json();
  expect(rows.map((row: { day: string; requests: number }) => [row.day, row.requests])).toEqual([
    ['2026-01-02', 1], ['2026-01-03', 3],
  ]);
  db.close();
});

test('GET usage by day applies model filter independently', async () => {
  const { deps, db, models } = filteredFixture();
  const response = await handleUsageRoute(request(`/usage?by=day&model=${models[1]}`), deps);
  expect(response?.status).toBe(200);
  const { rows } = await response!.json();
  expect(rows.map((row: { day: string; requests: number }) => [row.day, row.requests])).toEqual([
    ['2026-01-02', 2], ['2026-01-03', 4],
  ]);
  db.close();
});

for (const [by, idField, expected] of [
  ['key', 'keyId', [['k1', 1], ['k2', 2]]],
  ['model', 'modelId', [['m1', 1], ['m2', 2]]],
  ['provider', 'providerId', [['p1', 1]]],
  ['day', 'day', [['2026-01-02', 3]]],
] as const) {
  test(`GET usage by ${by} applies date range to rows inside and outside it`, async () => {
    const { deps, db } = filteredFixture();
    const model = by === 'provider' ? '&model=m1' : '';
    const query = `/usage?by=${by}${model}&from=2026-01-02&to=2026-01-02`;
    const response = await handleUsageRoute(request(query), deps);
    expect(response?.status).toBe(200);
    const { rows } = await response!.json();
    expect(rows.map((row: Record<string, unknown>) => [row[idField], row.requests])).toEqual(expected);
    db.close();
  });
}

for (const by of ['model', 'key', 'day', 'provider']) {
  test(`GET usage by ${by} returns stored summary`, async () => {
    const { deps, db } = fixture();
    const key = deps.keys.create({ name: 'key' }, deps.now());
    const model = deps.models.create({ name: 'model' }, deps.now());
    deps.usage.record(usageEntry(key.id, model.id), deps.now());
    deps.usage.record(usageEntry(key.id, model.id), deps.now());
    const query = `?by=${by}&model=${model.id}`;
    const response = await handleUsageRoute(request(`/usage${query}`), deps);
    expect(response?.status).toBe(200);
    const { rows } = await response!.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].requests).toBe(2);
    expect(rows[0].cost).toBe(4);
    expect(deps.usage.totals().requestCount).toBe(2);
    db.close();
  });
}

test('GET usage day filters by model, key and date', async () => {
  const { deps, db } = fixture();
  const first = deps.keys.create({ name: 'first' }, deps.now());
  const second = deps.keys.create({ name: 'second' }, deps.now());
  deps.usage.record(usageEntry(first.id, 'm1'), new Date('2026-01-02T12:00:00Z'));
  deps.usage.record(usageEntry(second.id, 'm2'), new Date('2026-01-03T12:00:00Z'));
  const query = `?by=day&model=m1&key=${first.id}&from=2026-01-02&to=2026-01-02`;
  const response = await handleUsageRoute(request(`/usage${query}`), deps);
  const { rows } = await response!.json();
  expect(rows).toEqual(deps.usage.byDay({ from: '2026-01-02', to: '2026-01-02' }, {
    modelId: 'm1', keyId: first.id,
  }));
  expect(rows).toHaveLength(1);
  expect(rows[0].requests).toBe(1);
  expect(deps.usage.totals().requestCount).toBe(2);
  db.close();
});

for (const query of ['', '?by=other', '?by=provider', '?by=provider&model=']) {
  test(`GET usage ${query}: invalid grouping or missing model is 400`, async () => {
    const { deps, db } = fixture();
    const response = await handleUsageRoute(request(`/usage${query}`), deps);
    expect(response?.status).toBe(400);
    expect((await response?.json()).error).toContain(query.includes('provider') ? 'model' : 'by');
    expect(deps.usage.totals().requestCount).toBe(0);
    db.close();
  });
}

for (const query of [
  '?by=day&from=2026-02-30', '?by=model&to=2026-1-01',
  '?by=key&from=bad', '?by=day&from=2026-02-01&to=2026-01-01',
]) {
  test(`GET usage ${query}: invalid range is 400`, async () => {
    const { deps, db } = fixture();
    expect((await handleUsageRoute(request(`/usage${query}`), deps))?.status).toBe(400);
    expect(deps.usage.totals().requestCount).toBe(0);
    db.close();
  });
}

test('GET totals returns lifetime totals', async () => {
  const { deps, db } = fixture();
  deps.usage.record(usageEntry('k', 'm'), deps.now());
  const response = await handleUsageRoute(request('/usage/totals'), deps);
  expect(await response?.json()).toEqual({ totals: deps.usage.totals() });
  expect(deps.usage.totals().requestCount).toBe(1);
  db.close();
});

test('GET logs returns recorded entries and DELETE logs preserves totals and summaries', async () => {
  const { deps, db } = fixture();
  deps.usage.record(usageEntry('k', 'm'), deps.now());
  const response = await handleUsageRoute(request('/logs'), deps);
  expect(await response?.json()).toEqual({ logs: deps.usage.logs() });
  const totals = deps.usage.totals();
  const rows = deps.usage.byModel();
  expect((await handleUsageRoute(request('/logs', 'DELETE'), deps))?.status).toBe(204);
  expect(deps.usage.logs()).toEqual([]);
  expect(deps.usage.totals()).toEqual(totals);
  expect(deps.usage.byModel()).toEqual(rows);
  db.close();
});

for (const [path, method] of [['/usage', 'POST'], ['/usage/totals', 'DELETE'], ['/logs', 'POST']]) {
  test(`${method} ${path}: wrong method is 405`, async () => {
    const { deps, db } = fixture();
    expect((await handleUsageRoute(request(path, method), deps))?.status).toBe(405);
    db.close();
  });
}

test('usage foreign path returns null', async () => {
  const { deps, db } = fixture();
  expect(await handleUsageRoute(request('/other'), deps)).toBeNull();
  db.close();
});
