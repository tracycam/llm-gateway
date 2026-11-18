// Which protocols a route can serve: the Responses API is passed through, never translated.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Admission } from '../admission';
import { providerAccess } from '../connectors/access';
import type { Connector, ProviderAccess } from '../connectors/connector';
import type { CredentialRenewals } from '../connectors/tokens';
import { CredentialRenewals as Renewals } from '../connectors/tokens';
import { KeyStore } from '../keyStore';
import { ModelStore } from '../modelStore';
import type { Usage } from '../pricing';
import type { JsonObject } from '../protocols/json';
import { protocolModule, type Protocol } from '../protocols/protocol';
import { ProviderStore } from '../providerStore';
import { Router } from '../router';
import { migrate } from '../schema';
import { UsageStore } from '../usageStore';
import { attempt } from './attempt';
import { handleInference, type InferenceDeps } from './handler';

const NOW = new Date('2025-01-01T00:00:00Z');
const PRICE = { input: 1, output: 2, cacheRead: null };
const USAGE = {
  input_tokens: 5,
  input_tokens_details: { cached_tokens: 2 },
  output_tokens: 3,
};
const RESPONSES_BODY = JSON.stringify({
  id: 'resp_1',
  object: 'response',
  status: 'completed',
  model: 'upstream',
  output: [{
    id: 'msg_1', type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'responses answer', annotations: [] }],
  }],
  usage: USAGE,
});
const USAGE_EXPECTED: Usage = { inputTokens: 3, outputTokens: 3, cacheReadTokens: 2 };
/** (3 input × 1 + 3 output × 2 + 2 cache reads at the input price 1) per 1M tokens. */
const COST = 11 / 1_000_000;

function responsesEvent(type: string, fields: object = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

const RESPONSES_STREAM = [
  responsesEvent('response.created', { response: { id: 'resp_1', status: 'in_progress' } }),
  responsesEvent('response.output_item.added', {
    output_index: 0, item: { id: 'msg_1', type: 'message' },
  }),
  responsesEvent('response.output_text.delta', { item_id: 'msg_1', delta: 'responses answer' }),
  responsesEvent('response.completed', {
    response: { id: 'resp_1', status: 'completed', usage: USAGE },
  }),
].join('');
const RESPONSES_FAILED = responsesEvent('response.failed', {
  response: { id: 'resp_1', status: 'failed', error: { code: 'server_error', message: 'boom' } },
});

interface RouteSpec {
  protocol: Protocol;
  upstreamModel: string;
  weight?: number;
}

interface UpstreamCall {
  url: string;
  body: JsonObject;
}

/** Answers like the protocol its URL names, unless the test overrides the answer. */
function defaultUpstream(call: UpstreamCall): Response {
  const path = new URL(call.url).pathname.slice(1);
  if (path === 'responses') return new Response(RESPONSES_BODY);
  if (path === 'messages') {
    return Response.json({
      id: 'msg_1', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'messages answer' }],
      usage: { input_tokens: 4, output_tokens: 2 },
    });
  }
  return Response.json({
    id: 'chatcmpl_1', object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'chat answer' } }],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  });
}

function fixture(routes: RouteSpec[], overrides: {
  upstream?: (call: UpstreamCall) => Response | undefined;
} = {}) {
  const db = new Database(':memory:');
  migrate(db);
  const keys = new KeyStore(db);
  const models = new ModelStore(db);
  const providers = new ProviderStore(db);
  const usage = new UsageStore(db);
  const router = new Router();
  const admission = new Admission();
  const calls: UpstreamCall[] = [];
  /** Every connector target call: a route the gateway decided to skip never appears here. */
  const targets: Protocol[] = [];
  function connectorOf(protocol: Protocol): Connector {
    return {
      id: protocol, name: protocol, defaultBaseUrl: null, credential: 'api-key',
      async target() {
        targets.push(protocol);
        return { url: `http://upstream.test/${protocol}`, protocol, headers: {} };
      },
      async models() { return []; },
    };
  }
  const connectors = new Map<string, Connector>(
    (['chat', 'messages', 'responses'] as const).map((protocol) => [protocol, connectorOf(protocol)]),
  );
  const model = models.create({ name: 'model', price: PRICE }, NOW);
  const created = routes.map((route, index) => {
    const provider = providers.create({
      name: `${route.protocol} provider ${index}`, connector: route.protocol, baseUrl: null,
      credential: null, autoPublish: false,
    }, NOW);
    return models.addRoute(model.id, {
      providerId: provider.id,
      upstreamModel: route.upstreamModel,
      weight: route.weight ?? 1,
    });
  });
  const key = keys.create({ name: 'key name' }, NOW);
  const renewals: CredentialRenewals = new Renewals();
  const fetchStub = Object.assign(async (
    input: string | URL | Request, init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as JsonObject : {};
    const call = { url, body };
    calls.push(call);
    return overrides.upstream?.(call) ?? defaultUpstream(call);
  }, { preconnect: () => undefined });
  const deps: InferenceDeps = {
    keys, models, providers, usage, router, admission,
    connector: (id) => connectors.get(id) ?? null,
    renewals,
    attempt,
    fetch: fetchStub,
    now: () => NOW,
    queueDeadline: () => ({ signal: new AbortController().signal, cancel: () => {} }),
  };
  function request(inbound: Protocol, body: unknown = { model: 'model' }): Request {
    return new Request(`http://localhost/v1/${inbound}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${key.token}` },
    });
  }
  function answer(inbound: Protocol, body?: unknown): Promise<Response> {
    return handleInference(request(inbound, body), inbound, deps);
  }
  return { db, model, routes: created, key, usage, router, calls, targets, answer };
}

function errorBody(protocol: Protocol, status: number, message: string, param?: string): string {
  return JSON.stringify(protocolModule(protocol).errorBody(status, message, param));
}

const CHAT_MESSAGE = 'Model "model" is not available on /v1/chat/completions; use /v1/responses';
const RESPONSES_MESSAGE = 'Model "model" is not available on /v1/responses; use /v1/chat/completions';
const MESSAGES_MESSAGE = 'Model "model" is not available on /v1/messages; use /v1/responses';

test('rule 3: a Chat client on a Responses-only model is 400 and names the usable entry', async () => {
  const f = fixture([{ protocol: 'responses', upstreamModel: 'upstream' }]);
  const response = await f.answer('chat');
  expect(response.status).toBe(400);
  expect(await response.text()).toBe(errorBody('chat', 400, CHAT_MESSAGE));
  expect(f.calls).toHaveLength(0);
  expect(f.usage.logs()).toEqual([]);
  f.db.close();
});

test('rule 3: a skipped route is never reported to the router', async () => {
  const f = fixture([{ protocol: 'responses', upstreamModel: 'upstream' }]);
  const route = f.routes[0]!;
  for (let i = 0; i < 4; i++) {
    const response = await f.answer('chat');
    expect(response.status).toBe(400);
    expect(f.router.cooldownUntil(route.id, NOW.getTime())).toBeNull();
  }
  // The route was offered to the gateway on every request, so no failure was counted.
  expect(f.targets).toEqual(['responses', 'responses', 'responses', 'responses']);
  expect(f.calls).toHaveLength(0);
  f.db.close();
});

test('rule 3: a Responses client on a Chat-only model is 400', async () => {
  const f = fixture([{ protocol: 'chat', upstreamModel: 'upstream' }]);
  const response = await f.answer('responses');
  expect(response.status).toBe(400);
  expect(await response.text()).toBe(errorBody('responses', 400, RESPONSES_MESSAGE));
  expect(f.calls).toHaveLength(0);
  f.db.close();
});

test('rule 3: a Responses client is 503, not 400, when its route is only cooling', async () => {
  const f = fixture([
    { protocol: 'chat', upstreamModel: 'chat route' },
    { protocol: 'responses', upstreamModel: 'responses route' },
  ]);
  f.router.report(f.routes[1]!.id, { kind: 'route' }, NOW.getTime());
  const response = await f.answer('responses');
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBeNull();
  expect(await response.text()).toBe(errorBody('responses', 503, 'No route available'));
  expect(f.calls).toHaveLength(0);
  f.db.close();
});

test('rule 3: a Chat client is 503, not 400, when its route is only cooling', async () => {
  const f = fixture([
    { protocol: 'chat', upstreamModel: 'chat route' },
    { protocol: 'responses', upstreamModel: 'responses route' },
  ]);
  f.router.report(f.routes[0]!.id, { kind: 'route' }, NOW.getTime());
  const response = await f.answer('chat');
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBeNull();
  expect(await response.text()).toBe(errorBody('chat', 503, 'No route available'));
  expect(f.calls).toHaveLength(0);
  f.db.close();
});

for (const [order, weights] of [
  [['messages', 'responses'], [10, 1]],
  [['responses', 'messages'], [1, 10]],
] as const) {
  test(`rule 3: a Responses client is served by the Responses route (${order.join(' then ')})`, async () => {
    const f = fixture([
      { protocol: order[0], upstreamModel: 'first', weight: weights[0] },
      { protocol: order[1], upstreamModel: 'second', weight: weights[1] },
    ]);
    const response = await f.answer('responses');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(RESPONSES_BODY);
    expect(f.calls.map((call) => new URL(call.url).pathname)).toEqual(['/responses']);
    expect(f.targets).toContain('messages');
    f.db.close();
  });
}

test('rule 3: some routes skipped and the rest failed gives the upstream failure', async () => {
  const f = fixture([
    { protocol: 'responses', upstreamModel: 'first', weight: 10 },
    { protocol: 'chat', upstreamModel: 'second', weight: 1 },
  ], {
    upstream: (call) => new URL(call.url).pathname === '/chat'
      ? Response.json({ error: { message: 'upstream failed' } }, { status: 500 })
      : undefined,
  });
  const response = await f.answer('chat');
  expect(response.status).toBe(502);
  expect(await response.text()).toBe(errorBody('chat', 502, 'upstream failed'));
  expect(f.calls.map((call) => new URL(call.url).pathname)).toEqual(['/chat']);
  f.db.close();
});

test('rule 3: a Messages client is refused in the Messages error shape', async () => {
  const f = fixture([{ protocol: 'responses', upstreamModel: 'upstream' }]);
  const response = await f.answer('messages');
  expect(response.status).toBe(400);
  const text = await response.text();
  expect(text).toBe(errorBody('messages', 400, MESSAGES_MESSAGE));
  expect(JSON.parse(text)).toMatchObject({ type: 'error' });
  expect(f.calls).toHaveLength(0);
  f.db.close();
});

test('a Responses answer is passed through and recorded with usage and cost', async () => {
  const f = fixture([{ protocol: 'responses', upstreamModel: 'upstream' }]);
  const response = await f.answer('responses', { model: 'model', input: 'hello' });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(RESPONSES_BODY);
  expect(f.usage.logs()).toEqual([expect.objectContaining({
    protocol: 'responses',
    status: 200,
    inputTokens: 3,
    outputTokens: 3,
    cacheReadTokens: 2,
    cost: COST,
  })]);
  f.db.close();
});

test('a Responses stream is passed through in order and recorded once it ends', async () => {
  const f = fixture([{ protocol: 'responses', upstreamModel: 'upstream' }], {
    upstream: (call) => call.body.stream === true
      ? new Response(RESPONSES_STREAM, { headers: { 'content-type': 'text/event-stream' } })
      : undefined,
  });
  const response = await f.answer('responses', { model: 'model', input: 'hello', stream: true });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(await response.text()).toBe(RESPONSES_STREAM);
  const deadline = Date.now() + 2_000;
  while (f.usage.logs().length === 0) {
    if (Date.now() > deadline) throw new Error('no usage row was recorded');
    await Bun.sleep(5);
  }
  expect(f.usage.logs()).toEqual([expect.objectContaining({
    protocol: 'responses',
    status: 200,
    inputTokens: 3,
    outputTokens: 3,
    cacheReadTokens: 2,
    cost: COST,
    ttftMs: 0,
  })]);
  f.db.close();
});

test('an upstream failure before content fails over to a second Responses route', async () => {
  const f = fixture([
    { protocol: 'responses', upstreamModel: 'first', weight: 10 },
    { protocol: 'responses', upstreamModel: 'second', weight: 1 },
  ], {
    upstream: (call) => {
      if (call.body.stream !== true) return undefined;
      const text = call.body.model === 'first' ? RESPONSES_FAILED : RESPONSES_STREAM;
      return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await f.answer('responses', { model: 'model', input: 'hello', stream: true });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(RESPONSES_STREAM);
  expect(f.calls.map((call) => call.body.model)).toEqual(['first', 'second']);
  f.db.close();
});
