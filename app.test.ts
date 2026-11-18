// The gateway's HTTP surface, built in-process over a temporary database and a stub upstream:
// one test per routing, authentication, CORS and error-shape criterion.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, GATEWAY_IDLE_TIMEOUT, queueDeadline, type GatewayApp } from './app';
import { issueCookie } from './adminAuth';
import type { Connector } from './connectors/connector';
import { openGatewayDatabase } from './database';
import { MAX_QUEUE_WAIT_MS } from './inference/handler';
import { KeyStore } from './keyStore';
import { ModelStore } from './modelStore';
import { ProviderStore } from './providerStore';
import { FakeDaemon } from './testing/fakeDaemon';

const ADMIN = 'admin-token-0123456789';
const NOW = new Date('2026-01-01T00:00:00.000Z');
const ADMIN_HEADER = { authorization: `Bearer ${ADMIN}` };

const dirs: string[] = [];
const apps: GatewayApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface UpstreamCall {
  url: string;
  body: Record<string, unknown> | null;
}

/** Records provider requests and answers like an OpenAI-compatible upstream. */
function stubFetch(upstream?: (body: Record<string, unknown> | null) => Response | undefined) {
  const calls: UpstreamCall[] = [];
  const fetchStub = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ url, body });
      const overridden = upstream?.(body);
      if (overridden !== undefined) return overridden;
      if (body?.stream === true) {
        const frames = [
          { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ];
        const framesText = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
        const text = `${framesText}data: [DONE]\n\n`;
        return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 0,
        model: body?.model ?? 'upstream-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'stub answer' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });
    },
    { preconnect: () => undefined }
  );
  return { calls, fetchStub };
}

const connector: Connector = {
  id: 'stub',
  name: 'Stub',
  defaultBaseUrl: null,
  credential: 'optional-api-key',
  async target() {
    return { url: 'http://upstream.test/chat/completions', headers: {}, protocol: 'chat' };
  },
  async models() {
    return [];
  },
};

interface Fixture {
  dir: string;
  app: GatewayApp;
  webDistDir: string;
  key: string;
  modelId: string;
  request(pathname: string, init?: RequestInit): Promise<Response>;
  calls: UpstreamCall[];
}

interface SetupOptions {
  /** Answers a provider request instead of the default stub, when it returns a response. */
  upstream?: (body: Record<string, unknown> | null) => Response | undefined;
}

function setup(options: SetupOptions = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-app-'));
  dirs.push(dir);
  const { calls, fetchStub } = stubFetch(options.upstream);
  const webDistDir = path.join(dir, 'web');
  const db = openGatewayDatabase(dir);
  const app = createApp({
    db, webDistDir, fetch: fetchStub, now: () => NOW,
    connector: (id) => (id === connector.id ? connector : null),
    connectors: () => [connector],
    adminToken: ADMIN,
  });
  apps.push(app);
  const providers = new ProviderStore(db);
  const models = new ModelStore(db);
  const keys = new KeyStore(db);
  const provider = providers.create({
    name: 'stub provider', connector: 'stub', baseUrl: null, credential: null, autoPublish: false,
  }, NOW);
  const model = models.create({
    name: 'stub-model',
    price: { input: 1, output: 2, cacheRead: null, cacheWrite: null },
  }, NOW);
  models.addRoute(model.id, { providerId: provider.id, upstreamModel: 'upstream-model' });
  const key = keys.create({ name: 'client key' }, NOW).token;
  return {
    dir, app, webDistDir, key, modelId: model.id, calls,
    request: (pathname, init) => app.handle(new Request(`http://gateway${pathname}`, init)),
  };
}

function authorized(f: Fixture, pathname: string, init: RequestInit = {}): Promise<Response> {
  return f.request(pathname, { ...init, headers: { ...ADMIN_HEADER, ...init.headers } });
}

function withKey(f: Fixture, pathname: string, init: RequestInit = {}): Promise<Response> {
  return f.request(pathname, {
    ...init, headers: { authorization: `Bearer ${f.key}`, ...init.headers },
  });
}

function post(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

/** Waits for an observable event; the poll interval is only how often it looks. */
async function until(what: string, condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

test('GET /healthz answers 200 JSON without an administrator credential', async () => {
  const f = setup();
  const response = await f.request('/healthz');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('login, session and logout are the gateway session routes and need no credential', async () => {
  const f = setup();
  const before = await f.request('/api/gateway/session');
  expect(await before.json()).toEqual({ authRequired: true, authenticated: false });

  const login = await f.request('/api/gateway/login', post({ token: ADMIN }));
  expect(login.status).toBe(204);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  expect((await f.request('/api/gateway/session', { headers: { cookie } })).status).toBe(200);
  expect(await (await f.request('/api/gateway/session', { headers: { cookie } })).json())
    .toEqual({ authRequired: true, authenticated: true });

  const logout = await f.request('/api/gateway/logout', { method: 'POST' });
  expect(logout.status).toBe(204);
  expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
});

test('every other /api path requires the administrator before any handler runs', async () => {
  const f = setup();
  const denied = await f.request('/api/gateway/providers');
  expect(denied.status).toBe(401);
  expect(await denied.json()).toEqual({ error: '未登录' });
  expect((await authorized(f, '/api/gateway/providers')).status).toBe(200);
  const cookie = issueCookie(ADMIN).split(';')[0];
  expect((await f.request('/api/gateway/providers', { headers: { cookie } })).status).toBe(200);
});

test('an /api path no management handler serves is 404 with an error string', async () => {
  const f = setup();
  for (const pathname of ['/api/gateway/nothing', '/api/other']) {
    const response = await authorized(f, pathname);
    expect([pathname, response.status]).toEqual([pathname, 404]);
    expect(await response.json()).toEqual({ error: '未找到' });
  }
});

test('OPTIONS /v1 answers 204 with CORS headers for the Anthropic headers too', async () => {
  const f = setup();
  const response = await f.request('/v1/chat/completions', { method: 'OPTIONS' });
  expect(response.status).toBe(204);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  const allowed = response.headers.get('access-control-allow-headers');
  expect(allowed).toContain('Authorization');
  expect(allowed).toContain('x-api-key');
  expect(allowed).toContain('anthropic-version');
  expect(allowed).toContain('anthropic-beta');
});

test('POST /v1/chat/completions is answered by the inference handler', async () => {
  const f = setup();
  const response = await withKey(f, '/v1/chat/completions', post({ model: 'stub-model' }));
  expect(response.status).toBe(200);
  const body = await response.json() as { choices: Array<{ message: { content: string } }> };
  expect(body.choices[0].message.content).toBe('stub answer');
  expect(f.calls[0].url).toBe('http://upstream.test/chat/completions');
});

test('POST /v1/messages is answered by the inference handler in the Messages shape', async () => {
  const f = setup();
  const response = await withKey(f, '/v1/messages', post({
    model: 'stub-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }],
  }));
  expect(response.status).toBe(200);
  const body = await response.json() as { type: string; content: Array<{ type: string; text: string }> };
  expect(body.type).toBe('message');
  expect(body.content[0]).toEqual({ type: 'text', text: 'stub answer' });
});

test('GET /v1/models lists the model and GET /v1/models/<name> finds it', async () => {
  const f = setup();
  const list = await withKey(f, '/v1/models');
  expect((await list.json() as { data: Array<{ id: string }> }).data.map((model) => model.id))
    .toEqual(['stub-model']);
  const one = await withKey(f, '/v1/models/stub-model');
  expect(one.status).toBe(200);
  expect((await one.json() as { id: string }).id).toBe('stub-model');
  expect((await withKey(f, '/v1/models/missing-model')).status).toBe(404);
});

test('a model name is percent-decoded exactly once', async () => {
  const f = setup();
  const created = await authorized(f, '/api/gateway/models', post({ name: 'stub model' }));
  const { model } = await created.json() as { model: { id: string } };
  const { providers } = await (await authorized(f, '/api/gateway/providers')).json() as {
    providers: Array<{ id: string }>;
  };
  await authorized(f, `/api/gateway/models/${model.id}/routes`, post({
    providerId: providers[0].id, upstreamModel: 'upstream-model',
  }));
  expect((await withKey(f, '/v1/models/stub%20model')).status).toBe(200);
  // `%2520` decodes to the literal `stub%20model`, which is not a model.
  expect((await withKey(f, '/v1/models/stub%2520model')).status).toBe(404);
});

test('a malformed percent escape is the protocol 404, not a server error', async () => {
  const f = setup();
  const openai = await withKey(f, '/v1/models/%E0%A4%A');
  expect(openai.status).toBe(404);
  const openaiBody = await openai.json() as { error: { message: string } };
  expect(openaiBody.error.message).toBeString();

  const anthropic = await withKey(f, '/v1/models/%E0%A4%A', {
    headers: { 'anthropic-version': '2026-10-21' },
  });
  expect(anthropic.status).toBe(404);
  const anthropicBody = await anthropic.json() as { type: string; error: { message: string } };
  expect(anthropicBody.type).toBe('error');
  expect(anthropicBody.error.message).toBeString();
});

test('an unhandled /v1 path or method is 404 in the client protocol error shape', async () => {
  const f = setup();
  for (const [pathname, init] of [
    ['/v1/completions', post({ model: 'stub-model', prompt: 'hi' })],
    ['/v1/chat/completions', undefined],
    ['/v1/nowhere', undefined],
  ] as const) {
    const response = await withKey(f, pathname, init);
    expect([pathname, response.status]).toEqual([pathname, 404]);
    const body = await response.json() as { error: { message: string; type: string } };
    expect(body.error.message).toBeString();
    expect(body.error.type).toBeString();
  }
  const anthropic = await withKey(f, '/v1/nowhere', { headers: { 'anthropic-version': '2026-10-21' } });
  const anthropicBody = await anthropic.json() as { type: string; error: { message: string } };
  expect(anthropicBody.type).toBe('error');
});

test('every /v1 response carries CORS, including errors and streams; no /api response does', async () => {
  const f = setup();
  const ok = await withKey(f, '/v1/chat/completions', post({ model: 'stub-model' }));
  expect(ok.headers.get('access-control-allow-origin')).toBe('*');
  const unauthorized = await f.request('/v1/models');
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get('access-control-allow-origin')).toBe('*');
  const notFound = await withKey(f, '/v1/nowhere');
  expect(notFound.headers.get('access-control-allow-origin')).toBe('*');
  const stream = await withKey(f, '/v1/chat/completions', post({ model: 'stub-model', stream: true }));
  expect(stream.headers.get('access-control-allow-origin')).toBe('*');
  expect(await stream.text()).toContain('"content":"hi"');

  for (const response of [
    await authorized(f, '/api/gateway/providers'),
    await f.request('/api/gateway/providers'),
  ]) {
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  }
});

test('a /v1 JSON answer keeps its content-type through the CORS header', async () => {
  const f = setup();
  const response = await withKey(f, '/v1/chat/completions', post({ model: 'stub-model' }));
  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('content-type')).toContain('application/json');
});

test('a /v1 stream answer keeps its content-type through the CORS header', async () => {
  const f = setup();
  const response = await withKey(f, '/v1/chat/completions', post({ model: 'stub-model', stream: true }));
  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(await response.text()).toContain('"content":"hi"');
});

test('a 429 from the handler keeps its retry-after through the CORS header', async () => {
  const f = setup({
    upstream: () => new Response('{"error":{"message":"busy"}}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '2' },
    }),
  });
  const response = await withKey(f, '/v1/chat/completions', post({ model: 'stub-model' }));
  expect(response.status).toBe(429);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('retry-after')).toBe('2');
  expect(response.headers.get('content-type')).toContain('application/json');
});

test('/v1 never accepts the administrator bearer token or cookie as an API key', async () => {
  const f = setup();
  expect((await f.request('/v1/models', { headers: ADMIN_HEADER })).status).toBe(401);
  expect((await f.request('/v1/models', { headers: { 'x-api-key': ADMIN } })).status).toBe(401);
  const cookie = { cookie: issueCookie(ADMIN).split(';')[0] };
  expect((await f.request('/v1/models', { headers: cookie })).status).toBe(401);
});

test('anything else is the console asset for GET and HEAD only, and a missing console is 404', async () => {
  const f = setup();
  expect((await f.request('/providers')).status).toBe(404);
  fs.mkdirSync(f.webDistDir, { recursive: true });
  fs.writeFileSync(path.join(f.webDistDir, 'gateway.html'), '<!doctype html>console');
  const response = await f.request('/providers');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(await response.text()).toContain('console');
  const head = await f.request('/providers', { method: 'HEAD' });
  expect(head.status).toBe(200);
  const posted = await f.request('/providers', { method: 'POST' });
  expect(posted.status).toBe(404);
  expect(await posted.json()).toEqual({ error: '未找到' });
});

test('the server disables Bun idle timeout so a slow model is not cut at 255 s', () => {
  expect(GATEWAY_IDLE_TIMEOUT).toBe(0);
});

/** One timer armed while a test watches `setTimeout`. */
interface ArmedTimer {
  ms: number;
  run: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs `body` with `setTimeout` and `clearTimeout` recording their calls, then restores both.
 * Only the queue deadline arms a timer on these paths, so one call arrives per queue wait.
 */
async function withTimers<T>(
  body: (timers: ArmedTimer[], cleared: unknown[]) => Promise<T>,
): Promise<T> {
  const timers: ArmedTimer[] = [];
  const cleared: unknown[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((run: () => void, ms?: number) => {
    const timer = realSetTimeout(run, ms);
    timers.push({ ms: ms ?? 0, run, timer });
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    cleared.push(timer);
    realClearTimeout(timer);
  }) as unknown as typeof clearTimeout;
  try {
    return await body(timers, cleared);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

test('a request arms the production queue deadline and clears its timer', async () => {
  const f = setup();
  const outcome = await withTimers(async (timers, cleared) => {
    const response = await withKey(f, '/v1/chat/completions', post({ model: 'stub-model' }));
    expect(response.status).toBe(200);
    return { timers, cleared };
  });
  expect(MAX_QUEUE_WAIT_MS).toBe(120_000);
  const armed = outcome.timers.filter(({ ms }) => ms === MAX_QUEUE_WAIT_MS);
  expect(armed).toHaveLength(1);
  expect(outcome.cleared).toContain(armed[0].timer);
});

test('the production queue deadline aborts its signal when the timer fires', async () => {
  const outcome = await withTimers(async (timers, cleared) => {
    const deadline = queueDeadline();
    expect(timers).toHaveLength(1);
    expect(deadline.signal.aborted).toBe(false);
    timers[0].run();
    expect(deadline.signal.aborted).toBe(true);
    deadline.cancel();
    return { timer: timers[0].timer, cleared };
  });
  expect(outcome.cleared).toEqual([outcome.timer]);
});

test('closing the app closes the one database', async () => {
  const f = setup();
  const files = () => fs.readdirSync(f.dir);
  expect(files()).toContain('gateway.sqlite-wal');
  await f.app.close();
  await f.app.close();
  expect(files().filter((name) => name.endsWith('-wal') || name.endsWith('-shm'))).toEqual([]);
});

test('closing the app ends the connection to a registered node', async () => {
  const daemon = new FakeDaemon();
  daemon.start();
  try {
    const f = setup();
    const registered = await authorized(f, '/api/gateway/nodes', post({ name: 'machine', url: daemon.url }));
    expect(registered.status).toBe(201);
    await until('the node to be online', () => daemon.openStreams === 1);
    // Registration and the link's own handshake both asked for the identity.
    const handshakes = daemon.identityRequests.length;
    await f.app.close();
    // The stub daemon sees its event-stream response cancelled, and the handshake does not run
    // again: NodeLink.stop() awaits the connection loop, so no retry can start after close().
    await until('the node stream to end', () => daemon.openStreams === 0);
    expect(daemon.identityRequests).toHaveLength(handshakes);
  } finally {
    await daemon.stop();
  }
});
