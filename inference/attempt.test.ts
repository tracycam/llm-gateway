// Integration tests for one upstream inference attempt.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { providerAccess } from '../connectors/access';
import {
  UpstreamFailure, type Connector, type ProviderAccess, type UpstreamTarget,
} from '../connectors/connector';
import { CredentialRenewals } from '../connectors/tokens';
import { ProviderStore } from '../providerStore';
import { migrate } from '../schema';
import { AuthorizationServer } from '../testing/authorizationServer';
import { fakeLoginConnector } from '../testing/loginConnector';
import { protocolModule, type Protocol } from '../protocols/protocol';
import { bridgeResponse, bridgeStream, type Bridge } from '../protocols/bridge';
import { attempt, type AttemptInput } from './attempt';

const provider: ProviderAccess = {
  id: 'p', baseUrl: null, credential: null, saveCredential: () => {}, rejectCredential: () => {},
  renewOnce: (renew) => renew(), model: () => null,
};
const protocols: Protocol[] = ['chat', 'messages'];
const event = (type: string, fields: object = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const chatStream = [
  `data: ${JSON.stringify({ id: 'id', model: 'm', choices: [{ delta: { content: 'hi' } }] })}\n\n`,
  `data: ${JSON.stringify({ id: 'id', model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
].join('');
const messagesStream = [
  event('message_start', { message: { id: 'id', model: 'm', usage: { input_tokens: 3 } } }),
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } }),
  event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  event('message_stop'),
].join('');
const complete = (protocol: Protocol) => protocol === 'chat'
  ? JSON.stringify({ id: 'id', model: 'm', choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 3, completion_tokens: 2 } })
  : JSON.stringify({ id: 'id', type: 'message', model: 'm', content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: 3, output_tokens: 2 } });

function stub(handler: (req: Request) => Response | Promise<Response>) {
  const requests: Array<{ method: string; path: string; headers: Headers; body: string }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      requests.push({ method: req.method, path: new URL(req.url).pathname, headers: req.headers,
        body: await req.clone().text() });
      return handler(req);
    },
  });
  return { server, requests };
}

function input(url: string, inbound: Protocol = 'chat', upstream: Protocol = inbound): AttemptInput {
  const connector: Connector = {
    id: 'test', name: 'test', defaultBaseUrl: null, credential: 'api-key', models: async () => [],
    target: async () => ({ url, protocol: upstream, headers: { authorization: 'Bearer secret-key' } }),
  };
  return {
    connector, provider, upstreamModel: 'chosen', inbound,
    body: { messages: [{ role: 'user', content: 'hello' }] },
    clientHeaders: new Headers(), signal: new AbortController().signal, fetch, now: () => 123000,
  };
}

test('rule 1: target failure is a route failure; bugs propagate', async () => {
  const req = input('http://localhost');
  req.connector.target = async () => { throw new UpstreamFailure('bad target', 401); };
  expect(await attempt(req)).toEqual({ kind: 'failed', outcome: { kind: 'route' }, status: null,
    reason: 'bad target' });
  const bug = new Error('bug');
  req.connector.target = async () => { throw bug; };
  await expect(attempt(req)).rejects.toBe(bug);
});

test('rule 2: refusal sends nothing; provider output limit is used', async () => {
  const s = stub(() => new Response('{}'));
  try {
    const req = input(s.server.url.href, 'chat', 'messages');
    req.body = null;
    expect(await attempt(req)).toEqual({ kind: 'refused', message: 'expected an object', param: 'body' });
    expect(s.requests).toHaveLength(0);
    req.body = { messages: [{ role: 'user', content: 'hi' }] };
    req.provider = { ...provider, model: () => ({ upstreamId: 'chosen', contextLength: null,
      maxOutputTokens: 73, price: { input: null, output: null, cacheRead: null }, protocols: null }) };
    await attempt(req);
    expect(JSON.parse(s.requests[0].body).max_tokens).toBe(73);
  } finally { s.server.stop(true); }
});

test('rule 3: isolate client secrets and pass Messages headers only to Messages', async () => {
  const s = stub(() => new Response('{}'));
  try {
    const req = input(`${s.server.url.href}endpoint`, 'messages', 'messages');
    req.clientHeaders = new Headers({
      authorization: 'client-auth', 'x-api-key': 'client-key', cookie: 'private',
      'anthropic-version': 'client-version', 'anthropic-beta': 'beta' });
    req.connector.target = async () => ({ url: `${s.server.url.href}endpoint`, protocol: 'messages',
      headers: { authorization: 'Bearer secret-key', 'anthropic-version': 'connector-version' } });
    await attempt(req);
    const first = s.requests[0];
    expect(first.method).toBe('POST');
    expect(first.path).toBe('/endpoint');
    expect(first.headers.get('authorization')).toBe('Bearer secret-key');
    expect(first.headers.get('x-api-key')).toBeNull();
    expect(first.headers.get('cookie')).toBeNull();
    expect(first.headers.get('anthropic-version')).toBe('client-version');
    expect(first.headers.get('anthropic-beta')).toBe('beta');
    expect(first.headers.get('content-type')).toBe('application/json');
    expect(first.headers.get('accept')).toBe('application/json');
    req.connector = input(s.server.url.href, 'messages', 'chat').connector;
    await attempt(req);
    expect(s.requests[1].headers.get('anthropic-version')).toBeNull();
    expect(s.requests[1].headers.get('anthropic-beta')).toBeNull();
  } finally { s.server.stop(true); }
});

test('rule 4: fetch failure preserves and redacts cause; aborted fetch is abandoned', async () => {
  const req = input('http://localhost');
  req.fetch = Object.assign(async () => { throw new Error('Bearer secret-key connection'); },
    { preconnect: fetch.preconnect });
  expect(await attempt(req)).toEqual({ kind: 'failed', outcome: { kind: 'unavailable' }, status: null,
    reason: 'Upstream connection failed: [redacted] connection' });
  const controller = new AbortController();
  controller.abort();
  req.signal = controller.signal;
  expect(await attempt(req)).toEqual({ kind: 'abandoned' });
});

test('rule 12: a declared client header replaces the target header', async () => {
  const s = stub(() => new Response('{}'));
  try {
    const req = input(s.server.url.href);
    req.connector.clientHeaders = ['x-opencode-session'];
    req.clientHeaders = new Headers({ 'x-opencode-session': 'from-client' });
    req.connector.target = async () => ({ url: s.server.url.href, protocol: 'chat',
      headers: { authorization: 'Bearer secret-key', 'x-opencode-session': 'fallback' } });
    await attempt(req);
    expect(s.requests[0].headers.get('x-opencode-session')).toBe('from-client');
  } finally { s.server.stop(true); }
});

test('rule 13: a declared header the client did not send keeps the target value', async () => {
  const s = stub(() => new Response('{}'));
  try {
    const req = input(s.server.url.href);
    req.connector.clientHeaders = ['x-opencode-session'];
    req.connector.target = async () => ({ url: s.server.url.href, protocol: 'chat',
      headers: { authorization: 'Bearer secret-key', 'x-opencode-session': 'fallback' } });
    await attempt(req);
    expect(s.requests[0].headers.get('x-opencode-session')).toBe('fallback');
  } finally { s.server.stop(true); }
});

test('rule 14: an undeclared client header is not passed on', async () => {
  const s = stub(() => new Response('{}'));
  try {
    const req = input(s.server.url.href);
    req.connector.clientHeaders = ['x-declared'];
    req.clientHeaders = new Headers({ 'x-opencode-session': 'from-client' });
    await attempt(req);
    expect(s.requests[0].headers.get('x-opencode-session')).toBeNull();
  } finally { s.server.stop(true); }
});

test('rule 15: a connector without clientHeaders is unchanged', async () => {
  const s = stub(() => new Response('{}'));
  try {
    const req = input(s.server.url.href);
    req.clientHeaders = new Headers({ 'x-opencode-session': 'from-client' });
    await attempt(req);
    expect(s.requests[0].headers.get('x-opencode-session')).toBeNull();
    expect(s.requests[0].headers.get('authorization')).toBe('Bearer secret-key');
  } finally { s.server.stop(true); }
});

test('rule 5: redirects fail and are not followed', async () => {
  const destination = stub(() => new Response('{}'));
  const s = stub(() => new Response(null, {
    status: 302, headers: { location: destination.server.url.href },
  }));
  try {
    expect(await attempt(input(s.server.url.href))).toEqual({ kind: 'failed', outcome: { kind: 'route' },
      status: 302, reason: 'Upstream returned a redirect' });
    expect(destination.requests).toHaveLength(0);
  } finally { s.server.stop(true); destination.server.stop(true); }
});

for (const inbound of protocols) for (const upstream of protocols) {
  test(`rule 6: ${inbound} from ${upstream} classifies and translates errors`, async () => {
    let status = 400;
    const text = upstream === 'chat' ? ' {"error":{"message":"bad request"}} '
      : ' {"type":"error","error":{"message":"bad request"}} ';
    const s = stub(() => new Response(text, { status, headers: { 'retry-after': '2' } }));
    try {
      const req = input(s.server.url.href, inbound, upstream);
      const expected = inbound === upstream ? text
        : JSON.stringify(protocolModule(inbound).errorBody(400, 'bad request'));
      expect(await attempt(req)).toEqual({ kind: 'rejected', status: 400, body: expected });
      status = 404;
      expect(await attempt(req)).toEqual({ kind: 'failed', outcome: { kind: 'route' }, status: 404,
        reason: 'bad request' });
      status = 429;
      expect(await attempt(req)).toEqual({ kind: 'failed',
        outcome: { kind: 'rate-limited', retryAfterMs: 2000 }, status: 429, reason: 'bad request' });
      status = 500;
      expect(await attempt(req)).toEqual({ kind: 'failed', outcome: { kind: 'unavailable' }, status: 500,
        reason: 'bad request' });
    } finally { s.server.stop(true); }
  });
  test(`rule 7: ${inbound} from ${upstream} complete response and 200 error`, async () => {
    let text = complete(upstream);
    const s = stub(() => new Response(text));
    try {
      const req = input(s.server.url.href, inbound, upstream);
      const bridge: Bridge = {
        inbound, upstream, upstreamModel: 'chosen', maxOutputTokens: 4096, created: 123,
      };
      const expected = bridgeResponse(text, bridge);
      if (!expected.ok) throw new Error(expected.reason);
      expect(await attempt(req)).toEqual({ kind: 'complete', body: expected.body, usage: expected.usage });
      text = upstream === 'chat' ? '{"error":{"message":"bad"}}'
        : '{"type":"error","error":{"message":"bad"}}';
      expect(await attempt(req)).toEqual({ kind: 'failed', outcome: { kind: 'unavailable' }, status: 200,
        reason: 'bad' });
    } finally { s.server.stop(true); }
  });
  test(`rule 8: ${inbound} from ${upstream} stream and early failure`, async () => {
    let text = upstream === 'chat' ? chatStream : messagesStream;
    const s = stub(() => new Response(text, { headers: { 'content-type': 'text/event-stream' } }));
    try {
      const req = input(s.server.url.href, inbound, upstream);
      req.body = { messages: [{ role: 'user', content: 'hi' }], stream: true };
      const bridge: Bridge = {
        inbound, upstream, upstreamModel: 'chosen', maxOutputTokens: 4096, created: 123,
      };
      const expected = await bridgeStream(new Response(text).body!, bridge, false);
      if (!expected.ok) throw new Error(expected.reason);
      const expectedBody = await new Response(expected.body).text();
      const expectedFinished = await expected.finished;
      const result = await attempt(req);
      if (result.kind !== 'stream') throw new Error(JSON.stringify(result));
      expect(await new Response(result.body).text()).toBe(expectedBody);
      expect(await result.finished).toEqual(expectedFinished);
      expect(s.requests[0].headers.get('accept')).toBe('text/event-stream');
      text = '';
      const failure = await attempt(req);
      expect(failure).toEqual({ kind: 'failed', outcome: { kind: 'unavailable' }, status: 200,
        reason: 'Upstream stream ended before content' });
    } finally { s.server.stop(true); }
  });
}

test('rule 8: no upstream body is unavailable', async () => {
  const req = input('http://localhost');
  req.body = { stream: true };
  req.fetch = Object.assign(async () => new Response(null, { status: 204 }),
    { preconnect: fetch.preconnect });
  expect(await attempt(req)).toEqual({ kind: 'failed', outcome: { kind: 'unavailable' }, status: 204,
    reason: 'Upstream returned no body' });
});

test('rule 9: abort while a preamble stream stalls is abandoned', async () => {
  let received!: () => void;
  const sent = new Promise<void>((resolve) => { received = resolve; });
  const s = stub(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(': preamble\n\n'));
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const controller = new AbortController();
  try {
    const req = input(s.server.url.href);
    req.signal = controller.signal;
    req.body = { stream: true };
    req.fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(url, init);
      const reader = response.body!.getReader();
      return new Response(new ReadableStream({
        async pull(stream) {
          try {
            const chunk = await reader.read();
            if (chunk.done) stream.close();
            else {
              stream.enqueue(chunk.value);
              received();
            }
          } catch (error) {
            // Abort and transport failures are passed to the bridge as body errors.
            stream.error(error);
          }
        },
        cancel: () => reader.cancel(),
      }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
    }, { preconnect: fetch.preconnect });
    const pending = attempt(req);
    await sent;
    controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('hung')), 1000);
    });
    try { expect(await Promise.race([pending, guard])).toEqual({ kind: 'abandoned' }); }
    finally { clearTimeout(timer); }
  } finally { s.server.stop(true); }
});

test('rule 10: failing response body is unavailable or abandoned on client abort', async () => {
  const req = input('http://localhost');
  const controller = new AbortController();
  let abort = false;
  req.signal = controller.signal;
  req.fetch = Object.assign(async () => new Response(new ReadableStream({
    pull(stream) {
      if (abort) controller.abort();
      stream.error(new Error('broken'));
    },
  })), { preconnect: fetch.preconnect });
  expect(await attempt(req)).toEqual({ kind: 'failed', outcome: { kind: 'unavailable' }, status: 200,
    reason: 'Failed to read upstream response' });
  abort = true;
  expect(await attempt(req)).toEqual({ kind: 'abandoned' });
});

test('rule 11: redact authentication in failures and rejections, not complete answers', async () => {
  let status = 404;
  let text = '{"error":{"message":"2026-10-21 Bearer secret-key secret-key"}}';
  const s = stub(() => new Response(text, { status }));
  try {
    const req = input(s.server.url.href);
    req.connector.target = async () => ({ url: s.server.url.href, protocol: 'chat', headers: {
      Authorization: 'Bearer secret-key', 'anthropic-version': '2026-10-21',
    } });
    expect(await attempt(req)).toEqual({ kind: 'failed', outcome: { kind: 'route' }, status: 404,
      reason: '2026-10-21 [redacted] [redacted]' });
    status = 400;
    expect(await attempt(req)).toEqual({ kind: 'rejected', status: 400,
      body: '{"error":{"message":"2026-10-21 [redacted] [redacted]"}}' });
    status = 200;
    text = '{"answer":"secret-key"}';
    expect(await attempt(req)).toEqual({ kind: 'complete', body: text, usage: null });
  } finally { s.server.stop(true); }
});

test('default output limit: Chat to Messages uses 4096 when unknown', async () => {
  const s = stub(() => new Response('{}'));
  try {
    await attempt(input(s.server.url.href, 'chat', 'messages'));
    expect(JSON.parse(s.requests[0].body).max_tokens).toBe(4096);
  } finally { s.server.stop(true); }
});

test('streaming error statuses are read as errors, never opened as streams', async () => {
  let status = 429;
  const text = '{"error":{"message":"bad request"}}';
  const s = stub(() => new Response(text, { status, headers: { 'retry-after': '2' } }));
  try {
    const req = input(s.server.url.href);
    req.body = { messages: [{ role: 'user', content: 'hi' }], stream: true };
    expect(await attempt(req)).toEqual({
      kind: 'failed', outcome: { kind: 'rate-limited', retryAfterMs: 2000 },
      status: 429, reason: 'bad request' });
    status = 400;
    expect(await attempt(req)).toEqual({ kind: 'rejected', status: 400, body: text });
  } finally { s.server.stop(true); }
});

test('x-api-key echoed in an upstream error is redacted', async () => {
  const s = stub(() => new Response('{"error":{"message":"secret-key"}}', { status: 429 }));
  try {
    const req = input(s.server.url.href);
    req.connector.target = async () => ({ url: s.server.url.href, protocol: 'chat',
      headers: { 'x-api-key': 'secret-key' } });
    expect(await attempt(req)).toEqual({
      kind: 'failed', outcome: { kind: 'rate-limited', retryAfterMs: null },
      status: 429, reason: '[redacted]' });
  } finally { s.server.stop(true); }
});

test('redirect response body is cancelled', async () => {
  let cancelled = false;
  const req = input('http://localhost');
  req.fetch = Object.assign(async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { status: 302 }), { preconnect: fetch.preconnect });
  expect(await attempt(req)).toEqual({ kind: 'failed', outcome: { kind: 'route' }, status: 302,
    reason: 'Upstream returned a redirect' });
  expect(cancelled).toBe(true);
});

test('stream finished error redacts upstream key without changing stream bytes', async () => {
  const content = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
  const error = 'data: {"error":{"message":"echo secret-key"}}\n\n';
  const s = stub(() => new Response(content + error));
  try {
    const req = input(s.server.url.href);
    req.body = { messages: [{ role: 'user', content: 'hello' }], stream: true };
    const result = await attempt(req);
    if (result.kind !== 'stream') throw new Error(JSON.stringify(result));
    expect(await new Response(result.body).text()).toBe(content + error);
    expect(await result.finished).toEqual({ usage: null, error: 'echo [redacted]', cancelled: false });
  } finally { s.server.stop(true); }
});

test("rule B4: an upstream 401 calls the connector's rejected once, with the target it built", async () => {
  const s = stub(() => new Response('{"error":{"message":"bad token"}}', { status: 401 }));
  try {
    const req = input(s.server.url.href);
    const refused: UpstreamTarget[] = [];
    req.connector.rejected = (_provider, target) => { refused.push(target); };
    expect(await attempt(req)).toEqual({
      kind: 'failed', outcome: { kind: 'route' }, status: 401, reason: 'bad token',
    });
    // The connector is told which request was refused, so it can compare its token.
    expect(refused).toHaveLength(1);
    expect(refused[0]?.url).toBe(s.server.url.href);
    expect(refused[0]?.headers.authorization).toBe('Bearer secret-key');
  } finally { s.server.stop(true); }
});

test('rule B4: a 403 does not call rejected', async () => {
  const s = stub(() => new Response('{}', { status: 403 }));
  try {
    const req = input(s.server.url.href);
    let rejected = 0;
    req.connector.rejected = () => { rejected += 1; };
    expect(await attempt(req)).toMatchObject({ kind: 'failed', outcome: { kind: 'route' }, status: 403 });
    expect(rejected).toBe(0);
  } finally { s.server.stop(true); }
});

test('rule B5: a refused renewal marks the provider and fails the route without a token', async () => {
  const authorization = new AuthorizationServer();
  const db = new Database(':memory:');
  try {
    migrate(db);
    const providers = new ProviderStore(db);
    const provider = providers.create({
      name: 'login', connector: 'fake-login', baseUrl: null, autoPublish: false,
      credential: JSON.stringify({
        accessToken: 'spent-access', refreshToken: 'spent-refresh',
        expiresAt: '2025-01-01T00:00:00.000Z',
      }),
    }, new Date('2026-01-01T00:00:00Z'));
    const { connector } = fakeLoginConnector({
      deviceEndpoint: authorization.deviceEndpoint,
      tokenEndpoint: authorization.tokenEndpoint,
      upstream: 'http://upstream.test',
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const result = await attempt({
      connector,
      provider: providerAccess(providers, provider, new CredentialRenewals()),
      upstreamModel: 'up',
      inbound: 'chat',
      body: { messages: [{ role: 'user', content: 'hello' }] },
      clientHeaders: new Headers(),
      signal: new AbortController().signal,
      fetch: Object.assign(async () => { throw new Error('not reached'); },
        { preconnect: fetch.preconnect }),
      now: () => Date.parse('2026-01-01T00:00:00Z'),
    });
    expect(result).toEqual({
      kind: 'failed', outcome: { kind: 'route' }, status: null,
      reason: 'Provider login expired; sign in again',
    });
    expect(providers.get(provider.id)?.credentialRejected).toBe(true);
    expect(JSON.stringify(result)).not.toContain('spent-refresh');
    expect(JSON.stringify(result)).not.toContain('spent-access');
  } finally {
    db.close();
    authorization.close();
  }
});

test('rule B5: another target error marks no credential', async () => {
  const req = input('http://localhost');
  req.connector.target = async () => { throw new UpstreamFailure('bad target', 401); };
  let rejected = 0;
  req.provider = { ...provider, rejectCredential: () => { rejected += 1; } };
  expect(await attempt(req)).toEqual({
    kind: 'failed', outcome: { kind: 'route' }, status: null, reason: 'bad target',
  });
  expect(rejected).toBe(0);
});

// --- Responses API: passthrough only, in both directions -----------------------------------

const RESPONSES_USAGE = {
  input_tokens: 5,
  input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
  output_tokens: 3,
};
const responsesBody = JSON.stringify({
  id: 'resp_1',
  object: 'response',
  status: 'completed',
  model: 'm',
  output: [{
    id: 'msg_1', type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  }],
  usage: RESPONSES_USAGE,
});
const responsesUsage = { inputTokens: 3, outputTokens: 3, cacheReadTokens: 2 };
const responsesStart = [
  event('response.created', { response: { id: 'resp_1', status: 'in_progress' } }),
  event('response.output_item.added', { output_index: 0, item: { id: 'msg_1', type: 'message' } }),
  event('response.output_text.delta', { item_id: 'msg_1', delta: 'hi' }),
].join('');
const responsesEnd = event('response.completed', {
  response: { id: 'resp_1', status: 'completed', usage: RESPONSES_USAGE },
});
const responsesStream = responsesStart + responsesEnd;

test('Responses passthrough: a complete body is returned unchanged with its usage', async () => {
  const s = stub(() => new Response(responsesBody));
  try {
    const req = input(s.server.url.href, 'responses', 'responses');
    req.body = { model: 'client-model', input: 'hello' };
    expect(await attempt(req)).toEqual({
      kind: 'complete', body: responsesBody, usage: responsesUsage,
    });
    expect(s.requests[0]?.path).toBe('/');
    expect(JSON.parse(s.requests[0]!.body)).toEqual({ model: 'chosen', input: 'hello' });
  } finally { s.server.stop(true); }
});

test('Responses passthrough: every stream frame arrives unchanged and in order', async () => {
  const s = stub(() => new Response(responsesStream, {
    headers: { 'content-type': 'text/event-stream' },
  }));
  try {
    const req = input(s.server.url.href, 'responses', 'responses');
    req.body = { model: 'client-model', input: 'hello', stream: true };
    const result = await attempt(req);
    if (result.kind !== 'stream') throw new Error(JSON.stringify(result));
    expect(await new Response(result.body).text()).toBe(responsesStream);
    expect(await result.finished).toEqual({ usage: responsesUsage, error: null, cancelled: false });
    expect(s.requests[0]?.headers.get('accept')).toBe('text/event-stream');
  } finally { s.server.stop(true); }
});

test('Responses passthrough: preamble is held, so a failure before content fails the route', async () => {
  const failed = event('response.failed', {
    response: { id: 'resp_1', status: 'failed', error: { code: 'server_error', message: 'boom' } },
  });
  const preamble = responsesStart.slice(0, responsesStart.indexOf('event: response.output_item'));
  const text = preamble + failed;
  const s = stub(() => new Response(text, { headers: { 'content-type': 'text/event-stream' } }));
  try {
    const req = input(s.server.url.href, 'responses', 'responses');
    req.body = { model: 'client-model', input: 'hello', stream: true };
    expect(await attempt(req)).toEqual({
      kind: 'failed', outcome: { kind: 'unavailable' }, status: 200, reason: 'boom',
    });
  } finally { s.server.stop(true); }
});

test('Responses passthrough: an in-band failure after content reaches the client untouched', async () => {
  const failed = event('response.failed', {
    response: { id: 'resp_1', status: 'failed', error: { code: 'server_error', message: 'boom' } },
  });
  const text = responsesStart + failed;
  const s = stub(() => new Response(text, { headers: { 'content-type': 'text/event-stream' } }));
  try {
    const req = input(s.server.url.href, 'responses', 'responses');
    req.body = { model: 'client-model', input: 'hello', stream: true };
    const result = await attempt(req);
    if (result.kind !== 'stream') throw new Error(JSON.stringify(result));
    expect(await new Response(result.body).text()).toBe(text);
    expect(await result.finished).toEqual({ usage: null, error: 'boom', cancelled: false });
  } finally { s.server.stop(true); }
});

test('Responses passthrough: a truncated stream gets an error frame in its own shape', async () => {
  const text = responsesStart;
  const s = stub(() => new Response(text, { headers: { 'content-type': 'text/event-stream' } }));
  try {
    const req = input(s.server.url.href, 'responses', 'responses');
    req.body = { model: 'client-model', input: 'hello', stream: true };
    const result = await attempt(req);
    if (result.kind !== 'stream') throw new Error(JSON.stringify(result));
    expect(await new Response(result.body).text()).toBe(text +
      'event: error\ndata: {"error":{"message":"Upstream stream ended before terminator",' +
      '"type":"api_error","code":null,"param":null}}\n\n');
    expect((await result.finished).error).toBe('Upstream stream ended before terminator');
  } finally { s.server.stop(true); }
});

test('a Chat request is translated onto an upstream that speaks only Responses', async () => {
  const s = stub(() => new Response(responsesBody));
  try {
    const req = input(s.server.url.href, 'chat', 'responses');
    const result = await attempt(req);
    if (result.kind !== 'complete') throw new Error(JSON.stringify(result));
    const body = JSON.parse(result.body) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]?.message.content).toBe('hi');
    expect(result.usage).toEqual(responsesUsage);
    const sent = JSON.parse(s.requests[0]!.body) as { model: string; input: unknown };
    expect(sent.model).toBe('chosen');
    expect(sent.input).toEqual([{ role: 'user', content: 'hello', type: 'message' }]);
  } finally { s.server.stop(true); }
});

test('a Responses request is translated onto an upstream that speaks only Chat', async () => {
  const s = stub(() => new Response(complete('chat')));
  try {
    const req = input(s.server.url.href, 'responses', 'chat');
    req.body = { input: 'hello' };
    const result = await attempt(req);
    if (result.kind !== 'complete') throw new Error(JSON.stringify(result));
    const body = JSON.parse(result.body) as {
      object: string;
      output: Array<{ content: Array<{ text: string }> }>;
    };
    expect(body.object).toBe('response');
    expect(body.output[0]?.content[0]?.text).toBe('hi');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 });
    const sent = JSON.parse(s.requests[0]!.body) as { model: string; messages: unknown };
    expect(sent.model).toBe('chosen');
    expect(sent.messages).toEqual([{ role: 'user', content: 'hello' }]);
  } finally { s.server.stop(true); }
});

test('a model that speaks no interface is incompatible before its connector is asked', async () => {
  const req = input('http://localhost');
  let targets = 0;
  req.connector.target = async () => {
    targets += 1;
    return { url: 'http://localhost', protocol: 'chat', headers: {} };
  };
  req.provider = { ...provider, model: () => ({ upstreamId: 'chosen', contextLength: null,
    maxOutputTokens: null, price: { input: null, output: null, cacheRead: null }, protocols: [] }) };
  expect(await attempt(req)).toEqual({ kind: 'incompatible', protocols: [] });
  expect(targets).toBe(0);
});
