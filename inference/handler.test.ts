// Tests for routing, admission and accounting of client inference requests.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Admission } from '../admission';
import type { Connector } from '../connectors/connector';
import { KeyStore, type KeyInput } from '../keyStore';
import { ModelStore } from '../modelStore';
import type { Usage } from '../pricing';
import type { Finished } from '../protocols/bridge';
import { protocolModule, type Protocol } from '../protocols/protocol';
import { ProviderStore } from '../providerStore';
import { Router } from '../router';
import { migrate } from '../schema';
import { UsageStore } from '../usageStore';
import type { AttemptInput, AttemptResult } from './attempt';
import { handleInference, type InferenceDeps } from './handler';

const price = { input: 1, output: 2, cacheRead: null, cacheWrite: null };
const tokens: Usage = {
  inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0,
};
const complete: AttemptResult = { kind: 'complete', body: '{"answer":"ok"}', usage: tokens };
const rejected: AttemptResult = { kind: 'rejected', status: 400, body: '{"error":"rejected"}' };
const refused: AttemptResult = { kind: 'refused', message: 'unsupported', param: 'tools' };
const failed: AttemptResult = {
  kind: 'failed', outcome: { kind: 'rate-limited', retryAfterMs: 2500 }, status: 429, reason: 'busy',
};
const connector: Connector = {
  id: 'fake', name: 'fake', credential: 'api-key', defaultBaseUrl: null,
  target: async () => ({ url: 'http://example.test', protocol: 'chat', headers: {} }),
  models: async () => [],
};

function fixture(options: { routes?: number; key?: Partial<KeyInput>; priced?: boolean } = {}) {
  const db = new Database(':memory:');
  migrate(db);
  let time = Date.parse('2025-01-01T00:00:00Z');
  const now = () => new Date(time);
  const keys = new KeyStore(db);
  const models = new ModelStore(db);
  const providers = new ProviderStore(db);
  const usage = new UsageStore(db);
  const router = new Router();
  const admission = new Admission();
  const provider = providers.create({ name: 'provider', connector: 'fake', baseUrl: null,
    credential: 'provider-secret', autoPublish: false }, now());
  const model = models.create({ name: 'model', ...(options.priced === false ? {} : { price }) }, now());
  const routes = Array.from({ length: options.routes ?? 1 }, (_, i) =>
    models.addRoute(model.id, { providerId: provider.id, upstreamModel: `upstream-${i}` }));
  const key = keys.create({ name: 'key name', ...options.key }, now());
  const scripts = new Map<string, Array<AttemptResult | Error>>();
  const calls: AttemptInput[] = [];
  const deps: InferenceDeps = {
    keys, models, providers, usage, router, admission, now, fetch,
    connector: (id) => id === 'fake' ? connector : null,
    attempt: async (input) => {
      calls.push(input);
      const result = scripts.get(input.upstreamModel)?.shift();
      if (!result) throw new Error(`No scripted result for ${input.upstreamModel}`);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  function script(route: typeof routes[number], ...results: Array<AttemptResult | Error>) {
    scripts.set(route.upstreamModel, results);
  }
  function request(body: unknown = { model: 'model' }, headers: HeadersInit = {}, signal?: AbortSignal) {
    return new Request('http://localhost/v1/chat/completions', {
      method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { authorization: `Bearer ${key.token}`, ...headers }, signal,
    });
  }
  return { db, keys, models, providers, usage, router, admission, provider, model, routes, key, deps,
    calls, script, request, now, advance: (ms: number) => { time += ms; } };
}

function stream() {
  let finish!: (result: Finished) => void;
  const finished = new Promise<Finished>((resolve) => { finish = resolve; });
  const body = new Response('data: complete\n\n').body!;
  const result: AttemptResult = { kind: 'stream', body, finished };
  return { result, finished, finish };
}

async function answer(f: ReturnType<typeof fixture>, req = f.request(), protocol: Protocol = 'chat') {
  const response = await handleInference(req, protocol, f.deps);
  return { response, text: await response.text() };
}

function errorBody(protocol: Protocol, status: number, message: string, param?: string) {
  return JSON.stringify(protocolModule(protocol).errorBody(status, message, param));
}

function released(f: ReturnType<typeof fixture>): Promise<void> {
  let resolve!: () => void;
  const done = new Promise<void>((finish) => { resolve = finish; });
  const enter = f.admission.enter.bind(f.admission);
  f.admission.enter = async (id, limit, signal) => {
    const release = await enter(id, limit, signal);
    return () => {
      release();
      resolve();
    };
  };
  return done;
}

function expectLog(f: ReturnType<typeof fixture>, expected: Partial<ReturnType<UsageStore['logs']>[number]>) {
  expect(f.usage.logs()).toEqual([{
    id: 1,
    timestamp: '2025-01-01T00:00:00.000Z',
    protocol: 'chat',
    keyName: 'key name',
    modelName: 'model',
    providerName: 'provider',
    upstreamModel: 'upstream-0',
    status: 200,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cost: null,
    ttftMs: null,
    latencyMs: 0,
    error: null,
    ...expected,
  }]);
}

test('rule 1: cookie containing only a valid key is not authentication', async () => {
  const f = fixture();
  const req = new Request('http://localhost', {
    method: 'POST', body: '{"model":"model"}', headers: { cookie: f.key.token },
  });
  const { response, text } = await answer(f, req);
  expect(response.status).toBe(401);
  expect(text).toBe(errorBody('chat', 401, 'Invalid API key'));
  expect(f.calls).toHaveLength(0);
  f.db.close();
});

test('rule 7: failed outcomes cool routes immediately or after three unavailable failures', async () => {
  const f = fixture();
  const route = f.routes[0];
  const unavailable: AttemptResult = {
    kind: 'failed', outcome: { kind: 'unavailable' }, status: 500, reason: 'down',
  };
  f.script(route, { kind: 'failed', outcome: { kind: 'route' }, status: 404, reason: 'missing' });
  expect((await answer(f)).response.status).toBe(502);
  expect(f.router.cooldownUntil(route.id, f.now().getTime())).not.toBeNull();
  expect((await answer(f)).response.status).toBe(503);
  expect(f.calls).toHaveLength(1);
  f.advance(300001);
  f.script(route, unavailable, unavailable, unavailable);
  for (let i = 0; i < 3; i++) expect((await answer(f)).response.status).toBe(502);
  expect(f.router.cooldownUntil(route.id, f.now().getTime())).not.toBeNull();
  expect((await answer(f)).response.status).toBe(503);
  expect(f.calls).toHaveLength(4);
  f.db.close();
});

test('rule 7: successful attempts reset consecutive unavailable failures', async () => {
  const f = fixture();
  const unavailable: AttemptResult = {
    kind: 'failed', outcome: { kind: 'unavailable' }, status: 500, reason: 'down',
  };
  f.script(f.routes[0], unavailable, unavailable, complete, unavailable, unavailable);
  for (const status of [502, 502, 200, 502, 502]) expect((await answer(f)).response.status).toBe(status);
  expect(f.router.cooldownUntil(f.routes[0].id, f.now().getTime())).toBeNull();
  expect(f.calls).toHaveLength(5);
  f.db.close();
});

test('rule 4: the heavier route is picked before an idle lighter route', async () => {
  const f = fixture({ routes: 2 });
  f.db.query('UPDATE routes SET id = ? WHERE id = ?').run('rte-a', f.routes[0].id);
  f.db.query('UPDATE routes SET id = ? WHERE id = ?').run('rte-z', f.routes[1].id);
  const ordered = f.models.get(f.model.id)!.routes;
  f.models.updateRoute(ordered[1].id, { weight: 5 });
  expect(ordered[1].upstreamModel).toBe(f.routes[1].upstreamModel);
  f.script(ordered[0], complete);
  f.script(ordered[1], complete);
  expect((await answer(f)).response.status).toBe(200);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].upstreamModel).toBe(ordered[1].upstreamModel);
  f.db.close();
});

test('rule 5: a route price permits a cost-limited key when the model has no price', async () => {
  const f = fixture({ priced: false, key: { costLimit: 100 } });
  f.models.updateRoute(f.routes[0].id, { price });
  f.script(f.routes[0], complete);
  const { response, text } = await answer(f);
  expect(response.status).toBe(200);
  expect(text).toBe('{"answer":"ok"}');
  f.db.close();
});

test('rule 5: an incomplete route price refuses a cost-limited key despite a priced model', async () => {
  const f = fixture({ key: { costLimit: 100 } });
  f.models.updateRoute(f.routes[0].id, { price: { ...price, output: null } });
  const { response, text } = await answer(f);
  expect(response.status).toBe(403);
  expect(text).toBe(errorBody('chat', 403, 'Key has a cost limit and the model has no price'));
  expect(f.calls).toHaveLength(0);
  f.db.close();
});

test('rule 4: no usable routes returns 503 and releases admission without accounting', async () => {
  const f = fixture({ routes: 0 });
  const done = released(f);
  const { response, text } = await answer(f);
  await done;
  expect(response.status).toBe(503);
  expect(text).toBe(errorBody('chat', 503, 'No route available'));
  expect(f.calls).toHaveLength(0);
  expect(f.admission.running(f.key.id)).toBe(0);
  expect(f.usage.logs()).toEqual([]);
  f.db.close();
});

test('rule 5: forbidden model returns 403 even when it has no usable routes', async () => {
  const f = fixture({ routes: 0, key: { restricted: true } });
  const { response, text } = await answer(f);
  expect(response.status).toBe(403);
  expect(text).toBe(errorBody('chat', 403, 'Key cannot use this model'));
  expect(f.calls).toHaveLength(0);
  expect(f.usage.logs()).toEqual([]);
  f.db.close();
});

test('rule 1: a missing key is 401 in the Chat Completions error shape', async () => {
  const f = fixture();
  const req = new Request('http://localhost/v1/chat/completions', {
    method: 'POST', body: '{"model":"model"}',
  });
  const { response, text } = await answer(f, req, 'chat');
  expect(response.status).toBe(401);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(text).toBe(errorBody('chat', 401, 'Invalid API key'));
  expect(f.calls).toHaveLength(0);
  f.db.close();
});

test('rule 1: a refused key is 401 in the Messages error shape', async () => {
  const f = fixture();
  f.keys.update(f.key.id, { enabled: false }, f.now());
  const { response, text } = await answer(f, f.request(), 'messages');
  expect(response.status).toBe(401);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(text).toBe(errorBody('messages', 401, 'Invalid API key'));
  expect(f.calls).toHaveLength(0);
  f.db.close();
});

for (const [kind, body, invalidModel] of [
  ['malformed JSON', '{', false],
  ['non-object', '[]', false],
  ['missing model', '{}', true],
  ['empty model', '{"model":" "}', true],
] as const) {
  test(`rule 2: ${kind} is 400`, async () => {
    const f = fixture();
    const { response, text } = await answer(f, f.request(body), 'messages');
    expect(response.status).toBe(400);
    expect(text).toBe(errorBody('messages', 400, invalidModel ? 'Expected a non-empty model'
      : 'Expected a JSON object', invalidModel ? 'model' : undefined));
    expect(f.calls).toHaveLength(0);
    f.db.close();
  });
}

for (const kind of ['missing', 'disabled'] as const) {
  test(`rule 3: ${kind} model is 404`, async () => {
    const f = fixture();
    if (kind === 'disabled') f.models.update(f.model.id, { enabled: false });
    const request = kind === 'missing' ? f.request({ model: 'missing' }) : f.request();
    const { response, text } = await answer(f, request);
    expect(response.status).toBe(404);
    expect(text).toBe(errorBody('chat', 404, 'Model not found'));
    expect(f.calls).toHaveLength(0);
    f.db.close();
  });
}

for (const kind of ['disabled route', 'disabled provider', 'unknown connector'] as const) {
  test(`rule 4: ${kind} has no candidate`, async () => {
    const f = fixture();
    if (kind === 'disabled route') f.models.updateRoute(f.routes[0].id, { enabled: false });
    if (kind === 'disabled provider') f.providers.update(f.provider.id, { enabled: false });
    if (kind === 'unknown connector') f.deps.connector = () => null;
    const { response, text } = await answer(f);
    expect(response.status).toBe(503);
    expect(text).toBe(errorBody('chat', 503, 'No route available'));
    expect(f.calls).toHaveLength(0);
    f.db.close();
  });
}

for (const kind of ['forbidden', 'unpriced', 'over-limit'] as const) {
  test(`rule 5: ${kind} key is refused`, async () => {
    const f = fixture({ priced: kind !== 'unpriced', key: {
      restricted: kind === 'forbidden', costLimit: kind === 'over-limit' ? 0 : 1,
    } });
    const status = kind === 'over-limit' ? 429 : 403;
    const message = {
      forbidden: 'Key cannot use this model',
      unpriced: 'Key has a cost limit and the model has no price',
      'over-limit': 'Key cost limit reached',
    }[kind];
    const { response, text } = await answer(f);
    expect(response.status).toBe(status);
    expect(text).toBe(errorBody('chat', status, message));
    expect(f.calls).toHaveLength(0);
    f.db.close();
  });
}

test('rule 6: queued abandonment makes no attempt and preserves the existing place', async () => {
  const f = fixture({ key: { maxConcurrency: 1 } });
  const release = await f.admission.enter(f.key.id, 1, new AbortController().signal);
  const controller = new AbortController();
  let entered!: () => void;
  const queued = new Promise<void>((resolve) => { entered = resolve; });
  const enter = f.admission.enter.bind(f.admission);
  f.admission.enter = (id, limit, signal) => {
    const pending = enter(id, limit, signal);
    entered();
    return pending;
  };
  const pending = handleInference(f.request(undefined, {}, controller.signal), 'chat', f.deps);
  await queued;
  expect(f.admission.waiting(f.key.id)).toBe(1);
  controller.abort();
  const response = await pending;
  expect(response.status).toBe(499);
  expect(await response.text()).toBe(errorBody('chat', 499, 'Client disconnected'));
  expect(f.calls).toHaveLength(0);
  expect(f.usage.logs()).toEqual([]);
  expect(f.admission.running(f.key.id)).toBe(1);
  release();
  expect(f.admission.running(f.key.id)).toBe(0);
  f.db.close();
});

test('rule 7: failure retries once then success records exactly one request', async () => {
  const f = fixture({ routes: 2 });
  const routes = f.models.get(f.model.id)!.routes;
  f.script(routes[0], { kind: 'failed', outcome: { kind: 'unavailable' }, status: 500, reason: 'down' });
  f.script(routes[1], complete);
  const { response, text } = await answer(f);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(text).toBe('{"answer":"ok"}');
  expect(f.calls.map((call) => call.upstreamModel)).toEqual(routes.map((route) => route.upstreamModel));
  expect(f.usage.byKey()[0].requests).toBe(1);
  expect(f.usage.logs()).toHaveLength(1);
  expect(f.admission.running(f.key.id)).toBe(0);
  for (const route of routes) expect(f.router.inflight(route.id)).toBe(0);
  f.db.close();
});

test('rule 7: rejected ends route and place without retry', async () => {
  const f = fixture({ routes: 2 });
  const first = f.models.get(f.model.id)!.routes[0];
  f.script(first, rejected);
  const { response, text } = await answer(f);
  expect(response.status).toBe(400);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(text).toBe('{"error":"rejected"}');
  expect(f.calls).toHaveLength(1);
  expect(f.router.inflight(first.id)).toBe(0);
  expect(f.admission.running(f.key.id)).toBe(0);
  expectLog(f, { upstreamModel: first.upstreamModel, status: 400,
    error: 'Upstream rejected the request with 400' });
  f.db.close();
});

test('rule 7: refusals are not reported and only refusals are not recorded', async () => {
  const f = fixture();
  f.script(f.routes[0], refused, complete);
  const first = await answer(f);
  expect(first.response.status).toBe(400);
  expect(first.text).toBe(errorBody('chat', 400, 'unsupported', 'tools'));
  expect(f.router.cooldownUntil(f.routes[0].id, f.now().getTime())).toBeNull();
  expect(f.usage.logs()).toEqual([]);
  expect((await answer(f)).response.status).toBe(200);
  f.db.close();
});

test('rule 7: all failed uses last rate limit and retry-after, and records once', async () => {
  const f = fixture({ routes: 2 });
  const routes = f.models.get(f.model.id)!.routes;
  f.script(routes[0], { kind: 'failed', outcome: { kind: 'unavailable' }, status: 500, reason: 'down' });
  f.script(routes[1], failed);
  const { response, text } = await answer(f);
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('3');
  expect(text).toBe(errorBody('chat', 429, 'busy'));
  expect(f.usage.logs()).toHaveLength(1);
  expectLog(f, {
    status: 429, error: 'busy', upstreamModel: routes[1].upstreamModel,
  });
  expect(f.admission.running(f.key.id)).toBe(0);
  f.db.close();
});

test('rule 9: failed route followed by refusal records failed provider and model', async () => {
  const f = fixture();
  const second = f.providers.create({ name: 'second', connector: 'fake', baseUrl: null,
    credential: null, autoPublish: false }, f.now());
  const route = f.models.addRoute(f.model.id, { providerId: second.id, upstreamModel: 'second-model' });
  const ordered = f.models.get(f.model.id)!.routes;
  f.models.updateRoute(f.routes[0].id, { weight: 10 });
  f.script(f.routes[0], failed);
  f.script(route, refused);
  const { response, text } = await answer(f);
  expect(response.status).toBe(429);
  expect(text).toBe(errorBody('chat', 429, 'busy'));
  expect(ordered).toHaveLength(2);
  expectLog(f, { status: 429, error: 'busy' });
  f.db.close();
});

test('rule 7: attempt exceptions propagate with balanced route and admission', async () => {
  const f = fixture();
  const bug = new Error('bug');
  f.script(f.routes[0], bug);
  await expect(handleInference(f.request(), 'chat', f.deps)).rejects.toBe(bug);
  expect(f.router.inflight(f.routes[0].id)).toBe(0);
  expect(f.admission.running(f.key.id)).toBe(0);
  f.db.close();
});

test('rule 7: abandoned attempts do not record', async () => {
  const f = fixture();
  f.script(f.routes[0], { kind: 'abandoned' });
  const abandoned = await answer(f);
  expect(abandoned.response.status).toBe(499);
  expect(abandoned.text).toBe(errorBody('chat', 499, 'Client disconnected'));
  expect(f.usage.logs()).toEqual([]);
  expect(f.router.inflight(f.routes[0].id)).toBe(0);
  expect(f.admission.running(f.key.id)).toBe(0);
  f.db.close();
});

test('rule 7: cooling routes answer 503 without an attempt', async () => {
  const f = fixture();
  f.router.report(f.routes[0].id, { kind: 'route' }, f.now().getTime());
  const cooling = await answer(f);
  expect(cooling.response.status).toBe(503);
  expect(cooling.text).toBe(errorBody('chat', 503, 'No route available'));
  expect(f.calls).toHaveLength(0);
  f.db.close();
});

test('rule 7: unavailable failure returns 502 and records the reason', async () => {
  const f = fixture();
  f.script(f.routes[0], { kind: 'failed', outcome: { kind: 'unavailable' }, status: 500, reason: 'down' });
  const { response, text } = await answer(f);
  expect(response.status).toBe(502);
  expect(text).toBe(errorBody('chat', 502, 'down'));
  expectLog(f, { status: 502, error: 'down' });
  expect(f.router.inflight(f.routes[0].id)).toBe(0);
  expect(f.admission.running(f.key.id)).toBe(0);
  f.db.close();
});

test('rule 9: synchronous recording failure propagates and releases resources', async () => {
  const f = fixture();
  const bug = new Error('record failed');
  f.script(f.routes[0], complete);
  f.usage.record = () => { throw bug; };
  await expect(handleInference(f.request(), 'chat', f.deps)).rejects.toBe(bug);
  expect(f.router.inflight(f.routes[0].id)).toBe(0);
  expect(f.admission.running(f.key.id)).toBe(0);
  f.db.close();
});

test('rule 8: attempt receives the selected route and request dependencies', async () => {
  const f = fixture();
  f.script(f.routes[0], complete);
  const req = f.request({ model: 'model', extra: 4 });
  await answer(f, req, 'messages');
  const input = f.calls[0];
  expect(input.connector).toBe(connector);
  expect(input.provider.id).toBe(f.provider.id);
  expect(input.provider.credential).toBe('provider-secret');
  expect(input.upstreamModel).toBe(f.routes[0].upstreamModel);
  expect(input.inbound).toBe('messages');
  expect(input.body).toEqual({ model: 'model', extra: 4 });
  expect(input.clientHeaders).toBe(req.headers);
  expect(input.signal).toBe(req.signal);
  expect(input.fetch).toBe(f.deps.fetch);
  expect(input.now()).toBe(f.now().getTime());
  f.db.close();
});

test('rule 9: complete accounting uses route price and null ttft', async () => {
  const f = fixture();
  f.models.updateRoute(f.routes[0].id, { price: { ...price, input: 5 } });
  f.script(f.routes[0], complete);
  await answer(f);
  expectLog(f, { cost: 7, inputTokens: 1000000, outputTokens: 1000000,
    cacheReadTokens: 0, cacheWriteTokens: 0 });
  expect(f.usage.byModel()[0]).toMatchObject({ requests: 1, cost: 7 });
  f.db.close();
});

for (const outcome of ['clean', 'error', 'cancelled'] as const) {
  test(`rule 9: stream ${outcome} holds route and place until finished`, async () => {
    const f = fixture();
    const s = stream();
    f.script(f.routes[0], s.result);
    const done = released(f);
    const attempt = f.deps.attempt;
    f.deps.attempt = async (input) => {
      f.advance(10);
      return attempt(input);
    };
    const response = await handleInference(f.request(), 'chat', f.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(f.router.inflight(f.routes[0].id)).toBe(1);
    expect(f.admission.running(f.key.id)).toBe(1);
    expect(f.usage.logs()).toEqual([]);
    expect(await response.text()).toBe('data: complete\n\n');
    f.advance(50);
    s.finish({
      usage: tokens, error: outcome === 'error' ? 'broken' : null, cancelled: outcome === 'cancelled',
    });
    await done;
    expect(f.router.inflight(f.routes[0].id)).toBe(0);
    expect(f.admission.running(f.key.id)).toBe(0);
    const status = { clean: 200, error: 502, cancelled: 499 }[outcome];
    const error = { clean: null, error: 'broken', cancelled: 'client disconnected' }[outcome];
    expectLog(f, { timestamp: '2025-01-01T00:00:00.060Z', status, error, ttftMs: 10, latencyMs: 60,
      inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 3 });
    f.db.close();
  });
}

test('rule 9: recording after stream is logged without a key', async () => {
  const f = fixture();
  const s = stream();
  f.script(f.routes[0], s.result);
  const done = released(f);
  const failure = new Error('database unavailable');
  f.usage.record = () => { throw failure; };
  const lines: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args); };
  try {
    const response = await handleInference(f.request(), 'chat', f.deps);
    expect(await response.text()).toBe('data: complete\n\n');
    s.finish({ usage: null, error: null, cancelled: false });
    await done;
    expect(lines).toEqual([['Failed to record stream for model model, key key name', failure]]);
    expect(lines.join()).not.toContain(f.key.token);
    expect(f.router.inflight(f.routes[0].id)).toBe(0);
    expect(f.admission.running(f.key.id)).toBe(0);
  } finally {
    console.error = original;
    f.db.close();
  }
});

test('rule 10: cost limit is checked on the next request, not during a stream', async () => {
  const f = fixture({ key: { costLimit: 1 } });
  const s = stream();
  f.script(f.routes[0], s.result);
  const response = await handleInference(f.request(), 'chat', f.deps);
  f.usage.record({
    protocol: 'chat',
    key: { id: f.key.id, name: f.key.name },
    model: { id: f.model.id, name: f.model.name },
    provider: { id: f.provider.id, name: f.provider.name },
    upstreamModel: f.routes[0].upstreamModel,
    status: 200,
    usage: tokens,
    cost: 3,
    ttftMs: null,
    latencyMs: 0,
    error: null,
  }, f.now());
  expect(f.keys.get(f.key.id, f.now())!.periodCost).toBeGreaterThan(1);
  expect(await response.text()).toBe('data: complete\n\n');
  s.finish({ usage: tokens, error: null, cancelled: false });
  await s.finished;
  const next = await answer(f);
  expect(next.response.status).toBe(429);
  expect(next.text).toBe(errorBody('chat', 429, 'Key cost limit reached'));
  expect(f.calls).toHaveLength(1);
  f.db.close();
});

test('rule 11: composed errors and recorded entries contain no secrets', async () => {
  const f = fixture();
  f.script(f.routes[0], complete, rejected, failed);
  const bodies: string[] = [];
  bodies.push((await answer(f)).text);
  bodies.push((await answer(f)).text);
  bodies.push((await answer(f)).text);
  bodies.push((await answer(f, f.request({}, { authorization: 'Bearer invalid' }))).text);
  bodies.push((await answer(f, f.request({}))).text);
  bodies.push((await answer(f, f.request({ model: 'missing' }))).text);
  f.keys.update(f.key.id, { restricted: true }, f.now());
  bodies.push((await answer(f)).text);
  f.keys.update(f.key.id, { restricted: false }, f.now());
  f.advance(30000);
  f.script(f.routes[0], { kind: 'failed', outcome: { kind: 'unavailable' }, status: 500, reason: 'down' });
  bodies.push((await answer(f)).text);
  f.models.updateRoute(f.routes[0].id, { enabled: false });
  bodies.push((await answer(f)).text);
  const recorded = JSON.stringify([f.usage.logs(), f.usage.byKey()]);
  for (const text of [...bodies, recorded]) {
    expect(text).not.toContain(f.key.token);
    expect(text).not.toContain('provider-secret');
  }
  f.db.close();
});
