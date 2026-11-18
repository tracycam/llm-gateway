// The acceptance run of S7.2: the real gateway process in front of stub upstreams. The tests are
// one scenario and run in order; each is named after the criterion it decides.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { freePort, stopDaemon, tempDir } from '../server/testing/fixtures';
import { until } from '../server/testing/stubDaemon';
import { LEGACY_TOKEN, writeLegacyDatabase } from './testing/legacy';

const ADMIN_TOKEN = 'gateway-admin-integration-0123456789';
const PROVIDER_KEY = 'anthropic-provider-key-0123456789';
const PRICE = { input: 1.5, output: 3, cacheRead: null };

interface StubCall {
  method: string;
  pathname: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

/** An OpenAI-compatible upstream that records every call and answers with one fixed text. */
function openaiStub(answer: string) {
  const calls: StubCall[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const text = req.method === 'POST' ? await req.text() : '';
      const body = text ? JSON.parse(text) as Record<string, unknown> : null;
      calls.push({ method: req.method, pathname, headers: req.headers, body });
      if (pathname === '/models') {
        return Response.json({
          object: 'list',
          data: ['upstream-chat', 'upstream-reject', 'fail-500', 'dual-a', 'dual-b', 'backup-model',
            'upstream-responses'].map((id) => ({ id, object: 'model' })),
        });
      }
      if (pathname === '/responses') {
        if (body?.stream === true) {
          return new Response(RESPONSES_STREAM, { headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response(RESPONSES_ANSWER, { headers: { 'content-type': 'application/json' } });
      }
      if (pathname !== '/chat/completions') return new Response('not found', { status: 404 });
      if (body?.model === 'fail-500') {
        return new Response('{"error":{"message":"upstream failed"}}', {
          status: 500, headers: { 'content-type': 'application/json' },
        });
      }
      if (body?.model === 'upstream-reject') {
        return new Response('{"error":{"message":"bad request","type":"invalid_request_error"}}', {
          status: 400, headers: { 'content-type': 'application/json' },
        });
      }
      if (body?.stream === true) {
        const base = { id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1_700_000_000, model: body.model };
        const frames: unknown[] = [
          { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: { content: answer.slice(0, 5) }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: { content: answer.slice(5) }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ];
        const options = body.stream_options as Record<string, unknown> | undefined;
        if (options?.include_usage === true) {
          frames.push({ ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } });
        }
        const sse = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: body?.model ?? 'upstream-model',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

const ANTHROPIC_MESSAGE_BODY = JSON.stringify({
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  model: 'upstream-messages',
  content: [{ type: 'text', text: 'messages answer' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 7, output_tokens: 3 },
});

/** An Anthropic Messages upstream. */
function anthropicStub() {
  const calls: StubCall[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const text = req.method === 'POST' ? await req.text() : '';
      const body = text ? JSON.parse(text) as Record<string, unknown> : null;
      calls.push({ method: req.method, pathname, headers: req.headers, body });
      if (pathname === '/v1/models') {
        return Response.json({
          data: [{ id: 'upstream-messages', type: 'model', display_name: 'Messages' }],
          has_more: false,
          first_id: 'upstream-messages',
          last_id: 'upstream-messages',
        });
      }
      if (pathname !== '/v1/messages') return new Response('not found', { status: 404 });
      return new Response(ANTHROPIC_MESSAGE_BODY, {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

/** One gateway process and everything it wrote to stdout and stderr. */
interface RunningGateway {
  child: ChildProcess;
  output(): string;
}

let dataDir: string;
let port: number;
let base: string;
let gateway: RunningGateway;
let openai: ReturnType<typeof openaiStub>;
let backup: ReturnType<typeof openaiStub>;
let anthropic: ReturnType<typeof anthropicStub>;
let cookie: string;
/** Bodies of management GET responses, for the secrets criterion. */
let managementBodies = '';
/** stdout and stderr of every gateway run. */
let gatewayOutput = '';

let chatProviderId: string;
let chatModelId: string;
let messagesProviderId: string;
let messagesModelId: string;
let keyToken: string;
let keyId: string;

/** The body an OpenAI-compatible upstream answers a non-streaming Responses request with. */
const RESPONSES_ANSWER = JSON.stringify({
  id: 'resp_stub',
  object: 'response',
  status: 'completed',
  model: 'upstream-responses',
  output: [{
    id: 'msg_stub', type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'responses answer', annotations: [] }],
  }],
  usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3 },
});

/** The same upstream's Responses stream: created, one delta, then the terminal event. */
const RESPONSES_STREAM = [
  { type: 'response.created', response: { id: 'resp_stub', status: 'in_progress' } },
  { type: 'response.output_text.delta', item_id: 'msg_stub', delta: 'responses answer' },
  {
    type: 'response.completed',
    response: {
      id: 'resp_stub', status: 'completed',
      usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3 },
    },
  },
].map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');

function startGateway(directory: string, listenPort: number): RunningGateway {
  const state = { text: '' };
  const child = spawn(process.execPath, ['run', 'gateway/main.ts'], {
    cwd: path.resolve(import.meta.dir, '..'),
    env: {
      ...process.env,
      AIHUB_GATEWAY_PORT: String(listenPort),
      AIHUB_GATEWAY_DATA_DIR: directory,
      AIHUB_ADMIN_TOKEN: ADMIN_TOKEN,
      // A data directory of its own: the retired app directory must not be picked up here.
      AIHUB_VOL1_PATH: path.join(directory, 'vol1'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer) => {
    state.text += chunk.toString();
    gatewayOutput += chunk.toString();
  };
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  return { child, output: () => state.text };
}

async function waitUp(address: string, child: ChildProcess): Promise<void> {
  await until(`gateway at ${address}`, async () => {
    if (child.exitCode !== null) throw new Error(`gateway exited: ${child.exitCode}`);
    try {
      return (await fetch(`${address}/healthz`)).ok ? true : undefined;
    } catch (error) {
      if (error instanceof Error) return undefined;
      throw error;
    }
  }, 20_000);
}

interface Answer {
  status: number;
  text: string;
}

async function admin(pathname: string, method = 'GET', body?: unknown): Promise<Answer> {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (method === 'GET') managementBodies += text;
  return { status: response.status, text };
}

async function adminJson<T>(pathname: string, method = 'GET', body?: unknown): Promise<T> {
  const answer = await admin(pathname, method, body);
  if (answer.status >= 400) throw new Error(`${method} ${pathname}: ${answer.status} ${answer.text}`);
  return JSON.parse(answer.text) as T;
}

async function createProvider(connector: string, baseUrl: string, name: string, apiKey?: string):
  Promise<string> {
  const answer = await admin('/api/gateway/providers', 'POST', {
    name, connector, baseUrl, ...(apiKey === undefined ? {} : { apiKey }),
  });
  if (answer.status !== 201) throw new Error(`provider ${name}: ${answer.status} ${answer.text}`);
  return (JSON.parse(answer.text) as { provider: { id: string } }).provider.id;
}

async function publishModel(providerId: string, upstreamId: string): Promise<string> {
  const answer = await admin(`/api/gateway/providers/${providerId}/publish`, 'POST', { upstreamId });
  if (answer.status !== 201) throw new Error(`publish ${upstreamId}: ${answer.status} ${answer.text}`);
  return (JSON.parse(answer.text) as { route: { modelId: string } }).route.modelId;
}

async function createModel(name: string, price = PRICE): Promise<string> {
  const answer = await admin('/api/gateway/models', 'POST', { name, price });
  if (answer.status !== 201) throw new Error(`model ${name}: ${answer.status} ${answer.text}`);
  return (JSON.parse(answer.text) as { model: { id: string } }).model.id;
}

async function addRoute(modelId: string, providerId: string, upstreamModel: string, weight = 1): Promise<void> {
  const answer = await admin(`/api/gateway/models/${modelId}/routes`, 'POST', {
    providerId, upstreamModel, weight,
  });
  if (answer.status !== 201) throw new Error(`route ${upstreamModel}: ${answer.status} ${answer.text}`);
}

function client(pathname: string, init: RequestInit = {}, token = keyToken): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  });
}

function post(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

beforeAll(async () => {
  dataDir = tempDir();
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  openai = openaiStub('stub answer');
  backup = openaiStub('backup answer');
  anthropic = anthropicStub();
  gateway = startGateway(dataDir, port);
  await waitUp(base, gateway.child);
}, 30_000);

afterAll(async () => {
  if (gateway) await stopDaemon(gateway.child);
  for (const stub of [openai, backup, anthropic]) stub?.stop();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}, 30_000);

test('1. an administrator adds a provider, publishes a priced model and creates a key', async () => {
  const login = await fetch(`${base}/api/gateway/login`, post({ token: ADMIN_TOKEN }));
  expect(login.status).toBe(204);
  const setCookie = login.headers.get('set-cookie');
  if (!setCookie) throw new Error('login returned no cookie');
  cookie = setCookie.split(';')[0];

  chatProviderId = await createProvider('openai-compatible', openai.url, 'chat upstream');
  const refreshed = await adminJson<{ models: Array<{ upstreamId: string }> }>(
    `/api/gateway/providers/${chatProviderId}/refresh`, 'POST'
  );
  expect(refreshed.models.map((model) => model.upstreamId)).toContain('upstream-chat');
  chatModelId = await publishModel(chatProviderId, 'upstream-chat');
  const priced = await adminJson<{ model: { price: { input: number; output: number } } }>(
    `/api/gateway/models/${chatModelId}`, 'PATCH', { price: PRICE }
  );
  expect(priced.model.price).toEqual(PRICE);

  const created = await admin(`/api/gateway/keys`, 'POST', { name: 'client key' });
  expect(created.status).toBe(201);
  const body = JSON.parse(created.text) as { key: Record<string, unknown>; token: string };
  keyToken = body.token;
  keyId = String(body.key.id);
  expect(keyToken.startsWith('sk-gw-')).toBe(true);
  expect(body.key).not.toHaveProperty('token');
}, 20_000);

test('2. /v1/models lists the published model for the key, and only for the key', async () => {
  const listed = await client('/v1/models');
  expect(listed.status).toBe(200);
  const body = await listed.json() as { data: Array<{ id: string }> };
  expect(body.data.map((model) => model.id)).toContain('upstream-chat');

  expect((await fetch(`${base}/v1/models`)).status).toBe(401);
  expect((await client('/v1/models', {}, ADMIN_TOKEN)).status).toBe(401);
  expect((await fetch(`${base}/v1/models`, { headers: { cookie } })).status).toBe(401);
}, 20_000);

test('3. Chat Completions passes the upstream answer through, and a usage chunk only when asked', async () => {
  const complete = await client('/v1/chat/completions', post({
    model: 'upstream-chat', messages: [{ role: 'user', content: 'hi' }],
  }));
  expect(complete.status).toBe(200);
  const body = await complete.json() as { choices: Array<{ message: { content: string } }> };
  expect(body.choices[0].message.content).toBe('stub answer');

  const plain = await client('/v1/chat/completions', post({
    model: 'upstream-chat', stream: true, messages: [{ role: 'user', content: 'hi' }],
  }));
  expect(plain.status).toBe(200);
  const plainText = await plain.text();
  expect(plainText).toContain('"content":"stub "');
  expect(plainText).toContain('[DONE]');
  expect(plainText).not.toContain('"usage"');

  const asked = await client('/v1/chat/completions', post({
    model: 'upstream-chat', stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'hi' }],
  }));
  const askedText = await asked.text();
  expect(askedText).toContain('"usage"');
  expect(askedText).toContain('"completion_tokens":4');
  // Every streaming request reached the upstream with include_usage, whether the client asked or not.
  const upstream = openai.calls.filter((call) => call.pathname === '/chat/completions' && call.body?.stream === true);
  expect(upstream.every((call) =>
    (call.body?.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true)).toBe(true);
}, 20_000);

test('4. a Messages stream with a tool is translated to a well-formed Messages stream over Chat', async () => {
  const response = await client('/v1/messages', post({
    model: 'upstream-chat',
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [{
      name: 'get_weather',
      description: 'Look up the weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    }],
  }));
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain('event: message_start');
  expect(text).toContain('event: content_block_delta');
  expect(text).toContain('event: message_stop');

  const sent = openai.calls.filter((call) => call.pathname === '/chat/completions').at(-1)!;
  const tools = sent.body?.tools as Array<{ type: string; function: { name: string; parameters: { type: string } } }>;
  expect(tools[0].type).toBe('function');
  expect(tools[0].function.name).toBe('get_weather');
  expect(tools[0].function.parameters.type).toBe('object');
  expect(sent.body?.stream).toBe(true);
  expect(sent.body).not.toHaveProperty('input_schema');
}, 20_000);

test('5. an Anthropic provider passes Messages through byte for byte and serves Chat by translation', async () => {
  messagesProviderId = await createProvider(
    'anthropic-compatible', anthropic.url, 'messages upstream', PROVIDER_KEY);
  await adminJson(`/api/gateway/providers/${messagesProviderId}/refresh`, 'POST');
  messagesModelId = await publishModel(messagesProviderId, 'upstream-messages');

  const request = {
    model: 'upstream-messages', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }],
  };
  const passed = await client('/v1/messages', post(request));
  expect(passed.status).toBe(200);
  expect(await passed.text()).toBe(ANTHROPIC_MESSAGE_BODY);
  const sent = anthropic.calls.filter((call) => call.pathname === '/v1/messages').at(-1)!;
  expect(sent.headers.get('x-api-key')).toBe(PROVIDER_KEY);
  expect(sent.body).toEqual(request);

  const translated = await client('/v1/chat/completions', post(request));
  expect(translated.status).toBe(200);
  const body = await translated.json() as { choices: Array<{ message: { content: string } }> };
  expect(body.choices[0].message.content).toBe('messages answer');
  const chatSent = anthropic.calls.filter((call) => call.pathname === '/v1/messages').at(-1)!;
  expect(chatSent.body?.messages).toEqual([{ role: 'user', content: 'hi' }]);
  expect(chatSent.body?.max_tokens).toBe(32);
}, 20_000);

test('6. usage counts requests, token sums and cost, and splits by provider', async () => {
  const expected = {
    requests: 4,
    inputTokens: 10 + 11 + 11 + 11,
    outputTokens: 5 + 4 + 4 + 4,
  };
  const cost = (expected.inputTokens * PRICE.input + expected.outputTokens * PRICE.output) / 1_000_000;

  const row = await until('usage for upstream-chat', async () => {
    const answer = await adminJson<{ rows: Array<Record<string, number | string>> }>(
      '/api/gateway/usage?by=model'
    );
    const found = answer.rows.find((item) => item.modelName === 'upstream-chat');
    return found?.requests === expected.requests ? found : undefined;
  });
  expect(row.inputTokens).toBe(expected.inputTokens);
  expect(row.outputTokens).toBe(expected.outputTokens);
  expect(row.cost as number).toBeCloseTo(cost, 12);

  // The same model served by two providers, with the first disabled between the two requests.
  const dualA = await createProvider('openai-compatible', openai.url, 'dual-a');
  const dualB = await createProvider('openai-compatible', backup.url, 'dual-b');
  const dualModel = await createModel('dual-model');
  await addRoute(dualModel, dualA, 'dual-a', 10);
  await addRoute(dualModel, dualB, 'dual-b', 1);
  const first = await client('/v1/chat/completions', post({
    model: 'dual-model', messages: [{ role: 'user', content: 'hi' }],
  }));
  expect((await first.json() as { choices: Array<{ message: { content: string } }> }).choices[0].message.content)
    .toBe('stub answer');
  await adminJson(`/api/gateway/providers/${dualA}`, 'PATCH', { enabled: false });
  const second = await client('/v1/chat/completions', post({
    model: 'dual-model', messages: [{ role: 'user', content: 'hi' }],
  }));
  expect((await second.json() as { choices: Array<{ message: { content: string } }> }).choices[0].message.content)
    .toBe('backup answer');

  const split = await until('usage split by provider', async () => {
    const answer = await adminJson<{ rows: Array<{ providerName: string; requests: number; cost: number }> }>(
      `/api/gateway/usage?by=provider&model=${dualModel}`
    );
    return answer.rows.length === 2 ? answer.rows : undefined;
  });
  expect(split.map((item) => [item.providerName, item.requests]).sort())
    .toEqual([['dual-a', 1], ['dual-b', 1]]);
  const perRequest = (10 * PRICE.input + 5 * PRICE.output) / 1_000_000;
  for (const item of split) expect(item.cost).toBeCloseTo(perRequest, 12);
}, 20_000);

test('7. a 5xx on the first route fails over to the second provider, which answers once', async () => {
  const failing = await createProvider('openai-compatible', openai.url, 'failing');
  const second = await createProvider('openai-compatible', backup.url, 'second');
  const model = await createModel('failover-model');
  await addRoute(model, failing, 'fail-500', 10);
  await addRoute(model, second, 'backup-model', 1);
  const failingBefore = openai.calls.filter((call) => call.body?.model === 'fail-500').length;

  const response = await client('/v1/chat/completions', post({
    model: 'failover-model', messages: [{ role: 'user', content: 'hi' }],
  }));
  expect(response.status).toBe(200);
  const body = await response.json() as { choices: Array<{ message: { content: string } }> };
  expect(body.choices[0].message.content).toBe('backup answer');
  expect(openai.calls.filter((call) => call.body?.model === 'fail-500').length).toBe(failingBefore + 1);
}, 20_000);

test('8. an upstream 400 is the client\'s answer and the second route is not tried', async () => {
  const rejecting = await createProvider('openai-compatible', openai.url, 'rejecting');
  const fallback = await createProvider('openai-compatible', backup.url, 'fallback');
  const model = await createModel('reject-model');
  await addRoute(model, rejecting, 'upstream-reject', 10);
  await addRoute(model, fallback, 'backup-model', 1);
  const backupBefore = backup.calls.filter((call) => call.body?.model === 'backup-model').length;

  const response = await client('/v1/chat/completions', post({
    model: 'reject-model', messages: [{ role: 'user', content: 'hi' }],
  }));
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toBe('bad request');
  expect(backup.calls.filter((call) => call.body?.model === 'backup-model').length).toBe(backupBefore);
}, 20_000);

test('9. a key below its cost limit is refused 429 on the next request; resetting its usage lets it through',
  async () => {
    const created = await adminJson<{ key: { id: string }; token: string }>(
      '/api/gateway/keys', 'POST', { name: 'limited', costLimit: 0.00002 }
    );
    const token = created.token;
    const request = () => client('/v1/chat/completions', post({
      model: 'upstream-chat', messages: [{ role: 'user', content: 'hi' }],
    }), token);
    expect((await request()).status).toBe(200);
    const refused = await request();
    expect(refused.status).toBe(429);
    expect((await refused.json() as { error: { message: string } }).error.message).toBe('Key cost limit reached');

    const reset = await admin(`/api/gateway/keys/${created.key.id}/reset`, 'POST');
    expect(reset.status).toBe(200);
    expect((await request()).status).toBe(200);
  }, 20_000);

test('10. after a restart the key still works and the model is still listed', async () => {
  await stopDaemon(gateway.child);
  gateway = startGateway(dataDir, port);
  await waitUp(base, gateway.child);
  const listed = await client('/v1/models');
  expect(listed.status).toBe(200);
  const body = await listed.json() as { data: Array<{ id: string }> };
  expect(body.data.map((model) => model.id)).toContain('upstream-chat');
}, 30_000);

test('11. neither credential appears in a management response or in the gateway output', async () => {
  for (const pathname of [
    '/api/gateway/providers', '/api/gateway/models', '/api/gateway/keys',
    '/api/gateway/usage?by=model', '/api/gateway/logs', '/api/gateway/nodes',
  ]) {
    await admin(pathname);
  }
  expect(managementBodies.length).toBeGreaterThan(0);
  expect(gatewayOutput).toContain('Listening');
  for (const secret of [PROVIDER_KEY, keyToken]) {
    expect(managementBodies).not.toContain(secret);
    expect(gatewayOutput).not.toContain(secret);
  }
}, 20_000);

test('12. an existing version-2 database starts and its old key authenticates on /v1/models', async () => {
  const legacyDir = tempDir();
  const legacyPort = await freePort();
  const legacyBase = `http://127.0.0.1:${legacyPort}`;
  const token = writeLegacyDatabase(legacyDir);
  const legacy = startGateway(legacyDir, legacyPort);
  try {
    await waitUp(legacyBase, legacy.child);
    const response = await fetch(`${legacyBase}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: 'list', data: [] });
    expect(token).toBe(LEGACY_TOKEN);
  } finally {
    await stopDaemon(legacy.child);
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
}, 30_000);

test('13. a Responses client is passed through to an upstream that speaks Responses', async () => {
  const providerId = await createProvider('openai-compatible', openai.url, 'responses upstream');
  await adminJson(`/api/gateway/providers/${providerId}/refresh`, 'POST');
  await publishModel(providerId, 'upstream-responses');

  const complete = await client('/v1/responses', post({
    model: 'upstream-responses', input: 'hi',
  }));
  expect(complete.status).toBe(200);
  expect(await complete.text()).toBe(RESPONSES_ANSWER);

  const stream = await client('/v1/responses', post({
    model: 'upstream-responses', input: 'hi', stream: true,
  }));
  expect(stream.status).toBe(200);
  expect(stream.headers.get('content-type')).toBe('text/event-stream');
  expect(await stream.text()).toBe(RESPONSES_STREAM);

  const row = await until('usage for upstream-responses', async () => {
    const answer = await adminJson<{ rows: Array<Record<string, number | string>> }>(
      '/api/gateway/usage?by=model'
    );
    const found = answer.rows.find((item) => item.modelName === 'upstream-responses');
    return found?.requests === 2 ? found : undefined;
  });
  // Each request reported 12 input tokens of which 2 were cache reads, and 3 output tokens.
  expect(row.inputTokens).toBe(20);
  expect(row.cacheReadTokens).toBe(4);
  expect(row.outputTokens).toBe(6);
}, 20_000);

test('14. the real registry lists seven connectors and holds two login providers without a key', async () => {
  const listed = await adminJson<{
    connectors: Array<{ id: string; credential: string; defaultBaseUrl: string | null }>;
  }>('/api/gateway/connectors');
  expect(listed.connectors.map((connector) => connector.id)).toEqual([
    'openai-compatible', 'anthropic-compatible', 'grok', 'opencode', 'opencode-go', 'copilot',
    'openrouter',
  ]);
  expect(listed.connectors.filter((connector) => connector.credential === 'login')
    .map((connector) => [connector.id, connector.defaultBaseUrl])).toEqual([
    ['grok', 'https://cli-chat-proxy.grok.com/v1'],
    ['copilot', 'https://api.githubcopilot.com'],
  ]);

  for (const connector of ['grok', 'copilot']) {
    const created = await admin('/api/gateway/providers', 'POST', {
      name: `login ${connector}`, connector,
    });
    expect([connector, created.status]).toEqual([connector, 201]);
    const { provider } = JSON.parse(created.text) as {
      provider: { id: string; hasCredential: boolean };
    };
    expect(provider.hasCredential).toBe(false);
    // Signing in is the administrator's next step. Asking where it stands must not start it, and
    // no POST to /login is sent here: it would reach the connector's real authorization server.
    expect(await adminJson(`/api/gateway/providers/${provider.id}/login`))
      .toEqual({ login: { state: 'none' } });
  }
}, 20_000);
