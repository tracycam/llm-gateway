import { expect, test } from 'bun:test';
import { Candidate, classify, Outcome, Router } from './router';

const light: Candidate = { id: 'light', weight: 1, order: 1, limit: null };
const heavy: Candidate = { id: 'heavy', weight: 2, order: 2, limit: null };
const NONE = new Set<string>();
const UNAVAILABLE: Outcome = { kind: 'unavailable' };

/** Picks a route and starts a request on it. */
function take(router: Router, candidates: Candidate[], now = 0): string {
  const picked = router.pick(candidates, NONE, now);
  if (!('route' in picked)) throw new Error(`no route: ${picked.none}`);
  router.begin(picked.route.id);
  return picked.route.id;
}

function fail(router: Router, id: string, times: number, now: number): void {
  for (let i = 0; i < times; i++) router.report(id, UNAVAILABLE, now);
}

// classify

test('2xx is ok', () => {
  for (const status of [200, 201, 299]) expect(classify(status, null, 0)).toEqual({ kind: 'ok' });
});

test('a failed connection and 5xx are unavailable', () => {
  for (const status of [null, 500, 503, 599]) expect(classify(status, null, 0)).toEqual(UNAVAILABLE);
});

test('401, 402, 403 and 404 put the route at fault', () => {
  for (const status of [401, 402, 403, 404]) expect(classify(status, null, 0)).toEqual({ kind: 'route' });
});

test('every other 4xx puts the request at fault', () => {
  for (const status of [400, 405, 413, 418, 422, 499]) expect(classify(status, null, 0)).toEqual({ kind: 'client' });
});

test('429 is rate-limited, with the delay of Retry-After in seconds', () => {
  expect(classify(429, '15', 0)).toEqual({ kind: 'rate-limited', retryAfterMs: 15_000 });
});

test('Retry-After as a date is the time from now until then', () => {
  expect(classify(429, 'Thu, 01 Jan 1970 00:00:20 GMT', 5_000)).toEqual({ kind: 'rate-limited', retryAfterMs: 15_000 });
});

test('Retry-After is kept within one second and five minutes', () => {
  expect(classify(429, '0', 0)).toEqual({ kind: 'rate-limited', retryAfterMs: 1_000 });
  expect(classify(429, '301', 0)).toEqual({ kind: 'rate-limited', retryAfterMs: 300_000 });
  expect(classify(429, 'Thu, 01 Jan 1970 00:00:01 GMT', 5_000)).toEqual({ kind: 'rate-limited', retryAfterMs: 1_000 });
});

test('a missing or unreadable Retry-After gives no delay', () => {
  for (const header of [null, '', 'soon']) {
    expect(classify(429, header, 0)).toEqual({ kind: 'rate-limited', retryAfterMs: null });
  }
});

// pick

test('with nothing in flight the heaviest route is picked', () => {
  expect(new Router().pick([light, heavy], NONE, 0)).toEqual({ route: heavy });
});

test('routes of equal load: the one created first is picked, whatever the list order', () => {
  const twin = { ...heavy, weight: 1 };
  expect(new Router().pick([twin, light], NONE, 0)).toEqual({ route: light });
});

test('under load, routes fill in proportion to their weights', () => {
  const router = new Router();
  for (let i = 0; i < 30; i++) take(router, [light, heavy]);
  expect([router.inflight('light'), router.inflight('heavy')]).toEqual([10, 20]);
});

test('a finished request frees its place', () => {
  const router = new Router();
  expect(take(router, [light, heavy])).toBe('heavy');
  expect(take(router, [light, heavy])).toBe('light');
  router.end('heavy');
  expect(take(router, [light, heavy])).toBe('heavy');
});

test('a route already tried for this request is not offered again', () => {
  expect(new Router().pick([light, heavy], new Set(['heavy']), 0)).toEqual({ route: light });
});

test('a route that is cooling down is not offered', () => {
  const router = new Router();
  router.report('heavy', { kind: 'route' }, 0);
  expect(router.pick([light, heavy], NONE, 0)).toEqual({ route: light });
});

test('a route at its limit is skipped while another has room', () => {
  const router = new Router();
  const capped = { ...heavy, limit: 1 };
  expect(take(router, [light, capped])).toBe('heavy');
  expect(take(router, [light, capped])).toBe('light');
  expect(take(router, [light, capped])).toBe('light');
});

test('every usable route at its limit: all-busy', () => {
  const router = new Router();
  const capped = { ...light, limit: 1 };
  take(router, [capped]);
  expect(router.pick([capped], NONE, 0)).toEqual({ none: 'all-busy' });
});

test('no usable route: unavailable', () => {
  const router = new Router();
  expect(router.pick([], NONE, 0)).toEqual({ none: 'unavailable' });
  expect(router.pick([light], new Set(['light']), 0)).toEqual({ none: 'unavailable' });
  router.report('heavy', { kind: 'route' }, 0);
  expect(router.pick([heavy], NONE, 0)).toEqual({ none: 'unavailable' });
});

test('a busy route next to a cooling one is all-busy, not unavailable', () => {
  const router = new Router();
  const capped = { ...light, limit: 1 };
  take(router, [capped]);
  router.report('heavy', { kind: 'route' }, 0);
  expect(router.pick([capped, heavy], NONE, 0)).toEqual({ none: 'all-busy' });
});

// report

test('the third unavailable in a row cools the route down for 30 s', () => {
  const router = new Router();
  fail(router, 'light', 2, 0);
  expect(router.cooldownUntil('light', 0)).toBeNull();
  fail(router, 'light', 1, 7);
  expect(router.cooldownUntil('light', 7)).toBe(30_007);
});

test('an ok in between starts the count again', () => {
  const router = new Router();
  fail(router, 'light', 2, 0);
  router.report('light', { kind: 'ok' }, 0);
  fail(router, 'light', 2, 0);
  expect(router.cooldownUntil('light', 0)).toBeNull();
});

test('a client outcome does not count as a failure', () => {
  const router = new Router();
  fail(router, 'light', 1, 0);
  router.report('light', { kind: 'client' }, 0);
  fail(router, 'light', 1, 0);
  expect(router.cooldownUntil('light', 0)).toBeNull();
});

test('a client outcome does not reset the count', () => {
  const router = new Router();
  fail(router, 'light', 2, 0);
  router.report('light', { kind: 'client' }, 0);
  fail(router, 'light', 1, 0);
  expect(router.cooldownUntil('light', 0)).toBe(30_000);
});

test('after a cooldown the count starts again from zero', () => {
  const router = new Router();
  fail(router, 'light', 3, 0);
  fail(router, 'light', 2, 30_000);
  expect(router.cooldownUntil('light', 30_000)).toBeNull();
});

test('rate-limited cools down at once, for the delay it names', () => {
  const router = new Router();
  router.report('light', { kind: 'rate-limited', retryAfterMs: 4_000 }, 10);
  expect(router.cooldownUntil('light', 10)).toBe(4_010);
});

test('rate-limited without a delay cools down for 30 s', () => {
  const router = new Router();
  router.report('light', { kind: 'rate-limited', retryAfterMs: null }, 10);
  expect(router.cooldownUntil('light', 10)).toBe(30_010);
});

test('a route at fault cools down at once, for 5 min', () => {
  const router = new Router();
  router.report('light', { kind: 'route' }, 10);
  expect(router.cooldownUntil('light', 10)).toBe(300_010);
});

test('a cooldown ends by time alone', () => {
  const router = new Router();
  router.report('light', { kind: 'route' }, 0);
  expect(router.pick([light], NONE, 299_999)).toEqual({ none: 'unavailable' });
  expect(router.pick([light], NONE, 300_000)).toEqual({ route: light });
});

test('a later, shorter cooldown does not shorten a running one', () => {
  const router = new Router();
  router.report('light', { kind: 'route' }, 0);
  router.report('light', { kind: 'rate-limited', retryAfterMs: 1_000 }, 100);
  expect(router.cooldownUntil('light', 100)).toBe(300_000);
});

// begin / end / forget

test('end without a request in flight throws', () => {
  const router = new Router();
  expect(() => router.end('light')).toThrow('no request in flight');
  router.begin('light');
  router.end('light');
  expect(() => router.end('light')).toThrow('no request in flight');
});

test('forget drops the in-flight count, the failure count and the cooldown of a route', () => {
  const router = new Router();
  router.begin('light');
  fail(router, 'light', 2, 0);
  router.report('light', { kind: 'route' }, 0);
  router.forget('light');
  expect(router.inflight('light')).toBe(0);
  expect(router.cooldownUntil('light', 0)).toBeNull();
  fail(router, 'light', 1, 0);
  expect(router.cooldownUntil('light', 0)).toBeNull();
});
