// Stub-backed tests for the OpenCode Zen and OpenCode Go connectors.
import { afterEach, expect, test } from 'bun:test';
import pkg from '../../package.json';
import type { Protocol } from '../protocols/protocol';
import { attempt, type AttemptInput } from '../inference/attempt';
import { anthropicCompatible } from './anthropic';
import { UpstreamFailure } from './connector';
import type { Connector, ProviderAccess } from './connector';
import { opencode, opencodeGo } from './opencode';

const KEY = 'oc_sk_secret';
// The user agent carries the version the repository declares, not a copy of it.
const USER_AGENT = `aihub-gateway/${pkg.version}`;

interface Preset {
  connector: Connector;
  id: string;
  name: string;
  defaultBase: string;
}

const presets: Preset[] = [
  { connector: opencode, id: 'opencode', name: 'OpenCode Zen', defaultBase: 'https://opencode.ai/inference' },
  { connector: opencodeGo, id: 'opencode-go', name: 'OpenCode Go',
    defaultBase: 'https://opencode.ai/inference/go' },
];

interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: Headers;
  body: string;
}

interface Stub {
  base: string;
  requests: RecordedRequest[];
}

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { server?.stop(true); server = null; });

function stub(handler: (req: Request) => Response | Promise<Response>): Stub {
  const requests: RecordedRequest[] = [];
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        path: url.pathname,
        query: url.search,
        headers: req.headers,
        body: await req.clone().text(),
      });
      return handler(req);
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, requests };
}

function access(
  preset: Preset, baseUrl: string | null, credential: string | null = JSON.stringify({ apiKey: KEY }),
): ProviderAccess {
  return {
    id: preset.id, baseUrl, credential, saveCredential() {}, rejectCredential() {},
    renewOnce: (renew) => renew(), model() { return null; },
  };
}

const chatAnswer = JSON.stringify({
  id: 'chat-1',
  object: 'chat.completion',
  model: 'glm-5.3',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

const messagesAnswer = JSON.stringify({
  id: 'msg-1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 2 },
});

const chatStream = [
  'data: {"id":"chat-1","model":"glm-5.3","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
  'data: {"id":"chat-1","model":"glm-5.3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

const messagesStream = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","model":"claude-haiku-5-5",',
  '"usage":{"input_tokens":3}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,',
  '"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,',
  '"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},',
  '"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

const chatBody = {
  model: 'client-model',
  messages: [{ role: 'user', content: 'hello' }],
  temperature: 0.25,
};

const messagesBody = {
  model: 'client-model',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'hello' }],
};

function attemptInput(
  preset: Preset, base: string, inbound: Protocol, body: unknown, headers = new Headers(),
): AttemptInput {
  return {
    connector: preset.connector,
    provider: access(preset, base),
    upstreamModel: 'glm-5.3',
    inbound,
    body,
    clientHeaders: headers,
    signal: new AbortController().signal,
    fetch,
    now: () => 123000,
  };
}

for (const preset of presets) {
  test(`${preset.id} names itself, its base, its credential kind and its client header`, () => {
    expect(preset.connector).toMatchObject({
      id: preset.id,
      name: preset.name,
      defaultBaseUrl: preset.defaultBase,
      credential: 'api-key',
      clientHeaders: ['x-opencode-session'],
    });
  });

  test(`${preset.id} Chat target is the Chat root with bearer, session and user agent`, async () => {
    const s = stub(() => new Response());
    const target = await preset.connector.target(access(preset, s.base), 'glm-5.3', 'chat');
    expect(target.url).toBe(`${s.base}/openai/v1/chat/completions`);
    expect(target.protocol).toBe('chat');
    expect(target.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'User-Agent': USER_AGENT,
      'x-opencode-session': `aihub-gateway-${preset.id}`,
    });
  });

  test(`${preset.id} Responses target is the Responses root with the same headers`, async () => {
    const s = stub(() => new Response());
    const target = await preset.connector.target(access(preset, s.base), 'gpt-6.2-sol', 'responses');
    expect(target.url).toBe(`${s.base}/openai/v1/responses`);
    expect(target.protocol).toBe('responses');
    expect(target.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'User-Agent': USER_AGENT,
      'x-opencode-session': `aihub-gateway-${preset.id}`,
    });
  });

  test(`${preset.id} Messages target is the Messages root with anthropic-version`, async () => {
    const s = stub(() => new Response());
    const target = await preset.connector.target(access(preset, s.base), 'claude-haiku-5-5', 'messages');
    expect(target.url).toBe(`${s.base}/anthropic/v1/messages`);
    expect(target.protocol).toBe('messages');
    expect(target.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'User-Agent': USER_AGENT,
      'x-opencode-session': `aihub-gateway-${preset.id}`,
      'anthropic-version': '2026-10-21',
    });
  });

  test(`${preset.id} Messages target sends the anthropic-compatible connector's version`, async () => {
    const s = stub(() => new Response());
    const direct = await anthropicCompatible.target(access(preset, s.base), 'm', 'messages');
    const target = await preset.connector.target(access(preset, s.base), 'm', 'messages');
    expect(target.headers['anthropic-version']).toBe(direct.headers['anthropic-version']);
  });

  test(`${preset.id} base override is used and trailing slashes are removed`, async () => {
    const s = stub(() => Response.json({ data: [] }));
    const base = `${s.base}///`;
    expect((await preset.connector.target(access(preset, base), 'm', 'chat')).url)
      .toBe(`${s.base}/openai/v1/chat/completions`);
    expect((await preset.connector.target(access(preset, base), 'm', 'messages')).url)
      .toBe(`${s.base}/anthropic/v1/messages`);
    await preset.connector.models(access(preset, base));
    expect(s.requests[0]?.path).toBe('/v1/models');
  });

  test(`${preset.id} missing credential fails target and models`, async () => {
    const s = stub(() => new Response());
    await expect(preset.connector.target(access(preset, s.base, null), 'm', 'chat'))
      .rejects.toBeInstanceOf(UpstreamFailure);
    await expect(preset.connector.models(access(preset, s.base, null)))
      .rejects.toBeInstanceOf(UpstreamFailure);
  });

  test(`${preset.id} malformed credential fails target and models`, async () => {
    const s = stub(() => new Response());
    for (const credential of ['not json', '{}', '{"apiKey":42}', '{"apiKey":""}']) {
      await expect(preset.connector.target(access(preset, s.base, credential), 'm', 'messages'))
        .rejects.toBeInstanceOf(UpstreamFailure);
      await expect(preset.connector.models(access(preset, s.base, credential)))
        .rejects.toBeInstanceOf(UpstreamFailure);
    }
  });

  test(`${preset.id} model list sends the bearer key and the gateway user agent`, async () => {
    const s = stub(() => Response.json({ data: [] }));
    await preset.connector.models(access(preset, s.base));
    expect(s.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models', query: '' });
    expect(s.requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(s.requests[0]?.headers.get('user-agent')).toBe(USER_AGENT);
  });
}

test('fallback session id names the provider, is stable, and differs per provider', async () => {
  const s = stub(() => new Response());
  const sessionOf = async (preset: Preset): Promise<string | null> => {
    const chat = await preset.connector.target(access(preset, s.base), 'm', 'chat');
    const messages = await preset.connector.target(access(preset, s.base), 'm', 'messages');
    expect(chat.headers['x-opencode-session']).toBe(messages.headers['x-opencode-session']);
    return chat.headers['x-opencode-session'] ?? null;
  };
  const zen = await sessionOf(presets[0]!);
  const go = await sessionOf(presets[1]!);
  expect(zen).toBe('aihub-gateway-opencode');
  expect(go).toBe('aihub-gateway-opencode-go');
});

const modelList = {
  object: 'list',
  data: [
    {
      id: 'glm-5.3',
      object: 'model',
      type: 'chat',
      limit: { context: 204800, output: 131072 },
      cost: {
        text: {
          input: {
            price: 0.6,
            cache: { read: 0.06, write: 0.75 },
            overrides: [{ when: { context: { gt: 100000 } }, price: 0.9 }],
          },
          output: { price: 2.2 },
        },
      },
      api: { 'chat-completions': { base_url: 'https://opencode.ai/inference/openai/v1' } },
    },
    {
      id: 'free-model',
      object: 'model',
      type: 'chat',
      limit: { context: 16384, output: 4096 },
      cost: { text: { input: { price: 0 }, output: { price: 0 } } },
      go: { monthly_usage: null },
    },
    {
      id: 'go-model',
      object: 'model',
      type: 'chat',
      limit: { context: 128000, output: 16384 },
      cost: { text: { input: { price: 0.3, cache: { read: 0.03, write: 0.3 } }, output: { price: 1.2 } } },
      go: { monthly_usage: { go: 15, 'go-plus': 60, 'go-teams': 20 } },
    },
  ],
};

const expectedModels = [
  { upstreamId: 'glm-5.3', contextLength: 204800, maxOutputTokens: 131072,
    price: { input: 0.6, output: 2.2, cacheRead: 0.06 } },
  { upstreamId: 'free-model', contextLength: 16384, maxOutputTokens: 4096,
    price: { input: 0, output: 0, cacheRead: null } },
  { upstreamId: 'go-model', contextLength: 128000, maxOutputTokens: 16384,
    price: { input: 0.3, output: 1.2, cacheRead: 0.03 } },
];

for (const preset of presets) {
  test(`${preset.id} reads limits and prices in USD per 1M tokens without conversion`, async () => {
    const s = stub(() => Response.json(modelList));
    expect(await preset.connector.models(access(preset, s.base))).toEqual(expectedModels);
  });

  test(`${preset.id} skips an entry whose type is not chat`, async () => {
    const s = stub(() => Response.json({ data: [
      { id: 'text', type: 'chat' },
      { id: 'image', type: 'image' },
    ] }));
    const models = await preset.connector.models(access(preset, s.base));
    expect(models.map((model) => model.upstreamId)).toEqual(['text']);
  });

  test(`${preset.id} skips an entry without a string id`, async () => {
    const s = stub(() => Response.json({ data: [
      { id: 'valid', type: 'chat' }, { type: 'chat' }, { id: 7, type: 'chat' }, null,
    ] }));
    const models = await preset.connector.models(access(preset, s.base));
    expect(models.map((model) => model.upstreamId)).toEqual(['valid']);
  });

  test(`${preset.id} leaves a missing limit and cost unknown`, async () => {
    const s = stub(() => Response.json({ data: [{ id: 'bare', type: 'chat' }] }));
    expect(await preset.connector.models(access(preset, s.base))).toEqual([{
      upstreamId: 'bare',
      contextLength: null,
      maxOutputTokens: null,
      price: { input: null, output: null, cacheRead: null },
    }]);
  });

  test(`${preset.id} turns a negative or non-numeric price into unknown`, async () => {
    const s = stub(() => Response.json({ data: [{
      id: 'odd',
      type: 'chat',
      limit: { context: -1, output: 'big' },
      cost: { text: { input: { price: -1, cache: { read: '-2' } }, output: { price: '0.5' } } },
    }] }));
    expect(await preset.connector.models(access(preset, s.base))).toEqual([{
      upstreamId: 'odd',
      contextLength: null,
      maxOutputTokens: null,
      price: { input: null, output: null, cacheRead: null },
    }]);
  });

  test(`${preset.id} 401 carries the upstream message and status without the key`, async () => {
    const s = stub(() => Response.json({
      error: { type: 'AuthError', message: 'Invalid API key' },
    }, { status: 401 }));
    try {
      await preset.connector.models(access(preset, s.base));
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamFailure);
      expect((error as UpstreamFailure).status).toBe(401);
      expect((error as Error).message).toContain('Invalid API key');
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  test(`${preset.id} does not follow a redirect`, async () => {
    let destination = 0;
    const s = stub((req) => {
      if (new URL(req.url).pathname === '/destination') destination++;
      return new Response(null, { status: 302, headers: { Location: '/destination' } });
    });
    await expect(preset.connector.models(access(preset, s.base)))
      .rejects.toMatchObject({ status: 302 });
    expect(destination).toBe(0);
  });

  test(`${preset.id} rejects a body that is not JSON`, async () => {
    const s = stub(() => new Response('not json'));
    await expect(preset.connector.models(access(preset, s.base))).rejects.toMatchObject({
      message: 'Invalid upstream JSON', status: null,
    });
  });

  test(`${preset.id} rejects JSON that is not a model list`, async () => {
    const s = stub(() => Response.json({ data: {} }));
    await expect(preset.connector.models(access(preset, s.base))).rejects.toMatchObject({
      message: 'Invalid model list', status: null,
    });
  });

  test(`${preset.id} Chat request reaches the Chat root and returns its answer`, async () => {
    const s = stub(() => new Response(chatAnswer));
    const result = await attempt(attemptInput(preset, s.base, 'chat', chatBody));
    expect(result).toEqual({
      kind: 'complete',
      body: chatAnswer,
      usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 },
    });
    expect(s.requests[0]).toMatchObject({ method: 'POST', path: '/openai/v1/chat/completions' });
  });

  test(`${preset.id} forwards a Chat body unchanged apart from the model`, async () => {
    const s = stub(() => new Response(chatAnswer));
    await attempt(attemptInput(preset, s.base, 'chat', chatBody));
    expect(JSON.parse(s.requests[0]!.body)).toEqual({ ...chatBody, model: 'glm-5.3' });
  });

  test(`${preset.id} streaming Chat request streams its answer from the Chat root`, async () => {
    const s = stub(() => new Response(chatStream, { headers: { 'content-type': 'text/event-stream' } }));
    const result = await attempt(attemptInput(preset, s.base, 'chat', { ...chatBody, stream: true }));
    if (result.kind !== 'stream') throw new Error(JSON.stringify(result));
    expect(await new Response(result.body).text()).toBe(chatStream);
    expect((await result.finished).error).toBeNull();
    expect(s.requests[0]).toMatchObject({ path: '/openai/v1/chat/completions' });
    expect(s.requests[0]?.headers.get('accept')).toBe('text/event-stream');
  });

  test(`${preset.id} streaming Chat body asks the upstream for a usage chunk`, async () => {
    const s = stub(() => new Response(chatStream, { headers: { 'content-type': 'text/event-stream' } }));
    const result = await attempt(attemptInput(preset, s.base, 'chat', { ...chatBody, stream: true }));
    if (result.kind !== 'stream') throw new Error(JSON.stringify(result));
    await new Response(result.body).text();
    expect(JSON.parse(s.requests[0]!.body).stream_options).toEqual({ include_usage: true });
  });

  test(`${preset.id} Messages request reaches the Messages root and returns its answer`, async () => {
    const s = stub(() => new Response(messagesAnswer));
    const result = await attempt(attemptInput(preset, s.base, 'messages', messagesBody));
    expect(result).toEqual({
      kind: 'complete',
      body: messagesAnswer,
      usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 },
    });
    expect(s.requests[0]).toMatchObject({ method: 'POST', path: '/anthropic/v1/messages' });
    expect(s.requests[0]?.headers.get('anthropic-version')).toBe('2026-10-21');
  });

  test(`${preset.id} forwards a Messages body unchanged apart from the model`, async () => {
    const s = stub(() => new Response(messagesAnswer));
    await attempt(attemptInput(preset, s.base, 'messages', messagesBody));
    expect(JSON.parse(s.requests[0]!.body)).toEqual({ ...messagesBody, model: 'glm-5.3' });
  });

  test(`${preset.id} streaming Messages request streams its answer from the Messages root`, async () => {
    const s = stub(() => new Response(messagesStream, {
      headers: { 'content-type': 'text/event-stream' },
    }));
    const result = await attempt(attemptInput(preset, s.base, 'messages', {
      ...messagesBody, stream: true,
    }));
    if (result.kind !== 'stream') throw new Error(JSON.stringify(result));
    expect(await new Response(result.body).text()).toBe(messagesStream);
    expect((await result.finished).error).toBeNull();
    expect(s.requests[0]).toMatchObject({ path: '/anthropic/v1/messages' });
  });

  test(`${preset.id} passes the client's session header on`, async () => {
    const s = stub(() => new Response(chatAnswer));
    const headers = new Headers({ 'x-opencode-session': 'conversation-7' });
    await attempt(attemptInput(preset, s.base, 'chat', chatBody, headers));
    expect(s.requests[0]?.headers.get('x-opencode-session')).toBe('conversation-7');
  });

  test(`${preset.id} sends the fallback session when the client sends none`, async () => {
    const s = stub(() => new Response(chatAnswer));
    await attempt(attemptInput(preset, s.base, 'chat', chatBody));
    expect(s.requests[0]?.headers.get('x-opencode-session')).toBe(`aihub-gateway-${preset.id}`);
  });

  test(`${preset.id} never forwards the client's authorization`, async () => {
    const s = stub(() => new Response(chatAnswer));
    const headers = new Headers({ authorization: 'Bearer client-secret', cookie: 'private' });
    await attempt(attemptInput(preset, s.base, 'chat', chatBody, headers));
    expect(s.requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(s.requests[0]?.headers.get('cookie')).toBeNull();
  });
}
