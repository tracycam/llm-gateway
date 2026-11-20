// Every protocol pair is served: a route in another protocol is translated, not refused.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Admission } from '../admission';
import type { Connector } from '../connectors/connector';
import { CredentialRenewals } from '../connectors/tokens';
import { KeyStore } from '../keyStore';
import { ModelStore } from '../modelStore';
import type { Usage } from '../pricing';
import type { JsonObject } from '../protocols/json';
import { protocolModule, type Protocol } from '../protocols/protocol';
import { ProviderStore } from '../providerStore';
import { Router } from '../router';
import { migrate } from '../schema';
import { UsageStore } from '../usageStore';
import type { RequestLogRow } from '../shared/api';
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
const MESSAGES_BODY = JSON.stringify({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'upstream',
  content: [{ type: 'text', text: 'messages answer' }],
  usage: { input_tokens: 4, output_tokens: 2 },
});
const CHAT_BODY = JSON.stringify({
  id: 'chatcmpl_1', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'chat answer' } }],
  usage: { prompt_tokens: 4, completion_tokens: 2 },
});

const RESPONSES_USAGE: Usage = { inputTokens: 3, outputTokens: 3, cacheReadTokens: 2 };
const CHAT_USAGE: Usage = { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0 };
/** (3 input × 1 + 3 output × 2 + 2 cache reads at the input price 1) per 1M tokens. */
const RESPONSES_COST = 11 / 1_000_000;
/** (4 input × 1 + 2 output × 2) per 1M tokens. */
const CHAT_COST = 8 / 1_000_000;

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

const CHAT_STREAM = [
  { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: 'chat answer' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } },
].map((frame) => `data: ${JSON.stringify({
  id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'upstream', ...frame,
})}\n\n`).join('') + 'data: [DONE]\n\n';

const MESSAGES_STREAM = [
  responsesEvent('message_start', {
    message: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'upstream', content: [],
      usage: { input_tokens: 4, output_tokens: 0 },
    },
  }),
  responsesEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  responsesEvent('content_block_delta', {
    index: 0, delta: { type: 'text_delta', text: 'messages answer' },
  }),
  responsesEvent('content_block_stop', { index: 0 }),
  responsesEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  responsesEvent('message_stop'),
].join('');

interface RouteSpec {
  protocol: Protocol;
  upstreamModel: string;
  weight?: number;
  /** What the provider says this model speaks; defaults to its one protocol. */
  protocols?: Protocol[] | null;
}

interface UpstreamCall {
  url: string;
  body: JsonObject;
}

/** Answers like the protocol its URL names, unless the test overrides the answer. */
function defaultUpstream(call: UpstreamCall): Response {
  const path = new URL(call.url).pathname.slice(1);
  const stream = call.body.stream === true;
  const headers = { 'content-type': 'text/event-stream' };
  if (path === 'responses') return stream
    ? new Response(RESPONSES_STREAM, { headers })
    : new Response(RESPONSES_BODY);
  if (path === 'messages') return stream
    ? new Response(MESSAGES_STREAM, { headers })
    : new Response(MESSAGES_BODY);
  return stream
    ? new Response(CHAT_STREAM, { headers })
    : new Response(CHAT_BODY);
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
    const providerName = `${route.protocol} provider ${index}`;
    const provider = providers.create({
      name: providerName, connector: route.protocol, baseUrl: null,
      credential: null, autoPublish: false,
    }, NOW);
    const routeRecord = models.addRoute(model.id, {
      providerId: provider.id,
      upstreamModel: route.upstreamModel,
      weight: route.weight ?? 1,
    });
    providers.replaceModels(provider.id, [{
      upstreamId: route.upstreamModel,
      contextLength: null,
      maxOutputTokens: null,
      price: PRICE,
      protocols: route.protocols === undefined ? [route.protocol] : route.protocols,
    }], NOW);
    return routeRecord;
  });
  const key = keys.create({ name: 'key name' }, NOW);
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
    renewals: new CredentialRenewals(),
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

async function logged(usage: UsageStore): Promise<RequestLogRow[]> {
  // The stream's recording promise settles before its body closes; drain the microtasks that
  // deliver it instead of guessing at a wall-clock delay.
  for (let i = 0; i < 100 && usage.logs().length === 0; i++) await Promise.resolve();
  const rows = usage.logs();
  if (rows.length === 0) throw new Error('no usage row was recorded');
  return rows;
}

const CHAT_REQUEST = { model: 'model', messages: [{ role: 'user', content: 'hi' }] };
const MESSAGES_REQUEST = { model: 'model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] };
const RESPONSES_REQUEST = { model: 'model', input: 'hi' };

test('a Chat client is translated onto a Responses-only route, with usage and cost recorded', async () => {
  const f = fixture([{ protocol: 'responses', upstreamModel: 'upstream' }]);
  const response = await f.answer('chat', CHAT_REQUEST);
  expect(response.status).toBe(200);
  const body = await response.json() as { choices: Array<{ message: { content: string } }> };
  expect(body.choices[0]?.message.content).toBe('responses answer');
  expect(response.headers.get('x-request-id')).toMatch(/^gen-[0-9a-f]{24}$/);
  expect(response.headers.get('x-gateway-model')).toBe('model');
  expect(response.headers.get('x-gateway-provider')).toBe('responses provider 0');
  expect(f.calls.map((call) => new URL(call.url).pathname)).toEqual(['/responses']);
  expect(f.usage.logs()).toEqual([expect.objectContaining({
    protocol: 'chat', status: 200, providerName: 'responses provider 0',
    inputTokens: 3, outputTokens: 3, cacheReadTokens: 2, cost: RESPONSES_COST,
  })]);
  const requestId = response.headers.get('x-request-id')!;
  expect(f.usage.generation(requestId, f.key.id)).toMatchObject({
    requestId, modelName: 'model', providerName: 'responses provider 0', status: 200,
  });
  f.db.close();
});

test('a Chat stream is translated from a Responses-only route and recorded once it ends', async () => {
  const f = fixture([{ protocol: 'responses', upstreamModel: 'upstream' }]);
  const response = await f.answer('chat', { ...CHAT_REQUEST, stream: true });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const text = await response.text();
  expect(text).toContain('responses answer');
  expect(text).toContain('[DONE]');
  expect(await logged(f.usage)).toEqual([expect.objectContaining({
    protocol: 'chat', status: 200, inputTokens: 3, outputTokens: 3, cacheReadTokens: 2,
    cost: RESPONSES_COST,
  })]);
  f.db.close();
});

test('a Responses client is translated onto a Chat-only route, with usage and cost recorded', async () => {
  const f = fixture([{ protocol: 'chat', upstreamModel: 'upstream' }]);
  const response = await f.answer('responses', RESPONSES_REQUEST);
  expect(response.status).toBe(200);
  const body = await response.json() as {
    object: string;
    output: Array<{ content: Array<{ text: string }> }>;
  };
  expect(body.object).toBe('response');
  expect(body.output[0]?.content[0]?.text).toBe('chat answer');
  expect(f.usage.logs()).toEqual([expect.objectContaining({
    protocol: 'responses', status: 200, inputTokens: 4, outputTokens: 2, cacheReadTokens: 0,
    cost: CHAT_COST,
  })]);
  f.db.close();
});

test('a Responses stream is translated from a Chat-only route and recorded once it ends', async () => {
  const f = fixture([{ protocol: 'chat', upstreamModel: 'upstream' }]);
  const response = await f.answer('responses', { ...RESPONSES_REQUEST, stream: true });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain('response.output_text.delta');
  expect(text).toContain('chat answer');
  expect(await logged(f.usage)).toEqual([expect.objectContaining({
    protocol: 'responses', status: 200, inputTokens: 4, outputTokens: 2, cost: CHAT_COST,
  })]);
  f.db.close();
});

test('a Messages client is translated onto a Responses-only route, with usage and cost recorded', async () => {
  const f = fixture([{ protocol: 'responses', upstreamModel: 'upstream' }]);
  const response = await f.answer('messages', MESSAGES_REQUEST);
  expect(response.status).toBe(200);
  const body = await response.json() as { type: string; content: Array<{ text: string }> };
  expect(body.type).toBe('message');
  expect(body.content[0]?.text).toBe('responses answer');
  expect(f.usage.logs()).toEqual([expect.objectContaining({
    protocol: 'messages', status: 200, inputTokens: 3, outputTokens: 3,
    cacheReadTokens: 2, cost: RESPONSES_COST,
  })]);
  f.db.close();
});

test('a Messages stream is translated from a Responses-only route and recorded once it ends', async () => {
  const f = fixture([{ protocol: 'responses', upstreamModel: 'upstream' }]);
  const response = await f.answer('messages', { ...MESSAGES_REQUEST, stream: true });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain('event: message_start');
  expect(text).toContain('responses answer');
  expect(text).toContain('event: message_stop');
  expect(await logged(f.usage)).toEqual([expect.objectContaining({
    protocol: 'messages', status: 200, inputTokens: 3, outputTokens: 3, cost: RESPONSES_COST,
  })]);
  f.db.close();
});

test('a Responses client is translated onto a Messages-only route, with usage and cost recorded', async () => {
  const f = fixture([{ protocol: 'messages', upstreamModel: 'upstream' }]);
  const response = await f.answer('responses', RESPONSES_REQUEST);
  expect(response.status).toBe(200);
  const body = await response.json() as {
    object: string;
    output: Array<{ content: Array<{ text: string }> }>;
  };
  expect(body.object).toBe('response');
  expect(body.output[0]?.content[0]?.text).toBe('messages answer');
  expect(f.usage.logs()).toEqual([expect.objectContaining({
    protocol: 'responses', status: 200, inputTokens: 4, outputTokens: 2,
    cacheReadTokens: 0, cost: CHAT_COST,
  })]);
  f.db.close();
});

test('a Responses stream is translated from a Messages-only route and recorded once it ends', async () => {
  const f = fixture([{ protocol: 'messages', upstreamModel: 'upstream' }]);
  const response = await f.answer('responses', { ...RESPONSES_REQUEST, stream: true });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain('response.output_text.delta');
  expect(text).toContain('messages answer');
  expect(await logged(f.usage)).toEqual([expect.objectContaining({
    protocol: 'responses', status: 200, inputTokens: 4, outputTokens: 2, cost: CHAT_COST,
  })]);
  f.db.close();
});

test('a model whose provider says it speaks no protocol is skipped and answered 400', async () => {
  const f = fixture([{ protocol: 'chat', upstreamModel: 'upstream', protocols: [] }]);
  const response = await f.answer('chat', CHAT_REQUEST);
  expect(response.status).toBe(400);
  expect(await response.text()).toBe(errorBody('chat', 400,
    'Model "model" is not available on this gateway\'s interfaces'));
  expect(f.calls).toHaveLength(0);
  expect(f.targets).toHaveLength(0);
  expect(f.router.cooldownUntil(f.routes[0]!.id, NOW.getTime())).toBeNull();
  expect(f.usage.logs()).toEqual([]);
  f.db.close();
});

test('a translator refusal is 400 naming the param, and nothing is sent upstream', async () => {
  const f = fixture([{ protocol: 'chat', upstreamModel: 'upstream' }]);
  const response = await f.answer('responses', {
    model: 'model', input: 'hi', previous_response_id: 'resp_1',
  });
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { param: string } };
  expect(body.error.param).toBe('previous_response_id');
  expect(f.calls).toHaveLength(0);
  f.db.close();
});

test('a route that speaks the client protocol wins over one that needs translation', async () => {
  // The translated route is listed first and both are equally idle.
  const f = fixture([
    { protocol: 'responses', upstreamModel: 'translated' },
    { protocol: 'chat', upstreamModel: 'native' },
  ]);
  const response = await f.answer('chat', CHAT_REQUEST);
  expect(response.status).toBe(200);
  const body = await response.json() as { choices: Array<{ message: { content: string } }> };
  expect(body.choices[0]?.message.content).toBe('chat answer');
  expect(f.calls.map((call) => new URL(call.url).pathname)).toEqual(['/chat']);
  expect(response.headers.get('x-gateway-provider')).toBe('chat provider 1');
  f.db.close();
});

test('a Chat client is 503, not 400, when every route is only cooling', async () => {
  const f = fixture([
    { protocol: 'chat', upstreamModel: 'chat route' },
    { protocol: 'responses', upstreamModel: 'responses route' },
  ]);
  for (const route of f.routes) f.router.report(route.id, { kind: 'route' }, NOW.getTime());
  const response = await f.answer('chat', CHAT_REQUEST);
  expect(response.status).toBe(503);
  expect(await response.text()).toBe(errorBody('chat', 503, 'No route available'));
  expect(f.calls).toHaveLength(0);
  f.db.close();
});

test('a Responses answer is passed through and recorded with usage and cost', async () => {
  const f = fixture([{ protocol: 'responses', upstreamModel: 'upstream' }]);
  const response = await f.answer('responses', RESPONSES_REQUEST);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(RESPONSES_BODY);
  expect(f.usage.logs()).toEqual([expect.objectContaining({
    protocol: 'responses', status: 200,
    inputTokens: 3, outputTokens: 3, cacheReadTokens: 2, cost: RESPONSES_COST,
  })]);
  f.db.close();
});

test('a Responses stream is passed through in order and recorded once it ends', async () => {
  const f = fixture([{ protocol: 'responses', upstreamModel: 'upstream' }]);
  const response = await f.answer('responses', { ...RESPONSES_REQUEST, stream: true });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(await response.text()).toBe(RESPONSES_STREAM);
  expect(await logged(f.usage)).toEqual([expect.objectContaining({
    protocol: 'responses', status: 200, inputTokens: 3, outputTokens: 3, cacheReadTokens: 2,
    cost: RESPONSES_COST, ttftMs: 0,
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
  const response = await f.answer('responses', { ...RESPONSES_REQUEST, stream: true });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(RESPONSES_STREAM);
  expect(f.calls.map((call) => call.body.model)).toEqual(['first', 'second']);
  f.db.close();
});
