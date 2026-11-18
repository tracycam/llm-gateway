// Stub-backed tests for Chat Completions connectors.
import { afterEach, expect, test } from 'bun:test';
import type { ProviderAccess } from './connector';
import { UpstreamFailure } from './connector';
import { openaiCompatible, openrouter } from './openai';
import { anthropicCompatible } from './anthropic';
import { CONNECTORS } from './registry';

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { server?.stop(true); server = null; });

function stub(handler: (req: Request) => Response): string {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  return `http://127.0.0.1:${server.port}`;
}

function provider(
  baseUrl: string | null, credential: string | null = '{"apiKey":"secret-key"}'
): ProviderAccess {
  return {
    id: 'test', baseUrl, credential, saveCredential() {}, rejectCredential() {},
    renewOnce: (renew) => renew(), model() { return null; },
  };
}

/** The URLs a call asks the global fetch for, answered without network access. */
async function intercepted(call: () => Promise<unknown>): Promise<string[]> {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return Response.json({ data: [] });
  }) as typeof fetch;
  try {
    await call();
  } finally {
    globalThis.fetch = original;
  }
  return urls;
}

test('a provider without an address uses the default address for inference', async () => {
  expect(await openaiCompatible.target(provider(null), 'm', 'chat')).toEqual({
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { Authorization: 'Bearer secret-key' },
    protocol: 'chat',
  });
});

test('a Responses client goes to the Responses route of openai-compatible', async () => {
  expect(await openaiCompatible.target(provider(null), 'm', 'responses')).toEqual({
    url: 'https://api.openai.com/v1/responses',
    headers: { Authorization: 'Bearer secret-key' },
    protocol: 'responses',
  });
  const base = stub(() => Response.json({ data: [] }));
  expect(await openaiCompatible.target(provider(base), 'm', 'responses')).toEqual({
    url: `${base}/responses`,
    headers: { Authorization: 'Bearer secret-key' },
    protocol: 'responses',
  });
});

test('openrouter keeps a Responses client on Chat Completions', async () => {
  expect(await openrouter.target(provider(null), 'm', 'responses')).toEqual({
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { Authorization: 'Bearer secret-key' },
    protocol: 'chat',
  });
});

test('anthropic-compatible keeps a Responses client on Messages', async () => {
  expect(await anthropicCompatible.target(provider(null), 'm', 'responses')).toEqual({
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'anthropic-version': '2026-10-21', 'x-api-key': 'secret-key' },
    protocol: 'messages',
  });
});

test('model discovery uses the default address when the provider has none', async () => {
  const urls = await intercepted(() => openaiCompatible.models(provider(null)));
  expect(urls).toEqual(['https://api.openai.com/v1/models']);
});

test('a custom address overrides the default and trailing slashes are stripped', async () => {
  const requests: Request[] = [];
  const base = stub((req) => {
    requests.push(new Request(req.url, req));
    return Response.json({ data: [] });
  });
  expect(await openaiCompatible.target(provider(`${base}///`), 'm', 'chat')).toEqual({
    url: `${base}/chat/completions`,
    headers: { Authorization: 'Bearer secret-key' },
    protocol: 'chat',
  });
  await openaiCompatible.models(provider(base));
  expect(requests[0]?.method).toBe('GET');
  expect(new URL(requests[0]!.url).pathname).toBe('/models');
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer secret-key');
});

test('without a key no Authorization header is sent', async () => {
  const auth: (string | null)[] = [];
  const base = stub((req) => {
    auth.push(req.headers.get('authorization'));
    return Response.json({ data: [] });
  });
  const access = provider(base, null);
  expect((await openaiCompatible.target(access, 'm', 'chat')).headers).toEqual({});
  await openaiCompatible.models(access);
  expect(auth).toEqual([null]);
});

test('with a key discovery sends Authorization', async () => {
  const auth: (string | null)[] = [];
  const base = stub((req) => {
    auth.push(req.headers.get('authorization'));
    return Response.json({ data: [] });
  });
  await openaiCompatible.models(provider(base));
  expect(auth[0]).toBe('Bearer secret-key');
});

test('context aliases are parsed and invalid ids skipped', async () => {
  const base = stub(() => Response.json({ data: [
    { id: 'a', context_length: 100 }, { id: 'b', context_window: 200 },
    { id: 'c', max_model_len: 300 }, { id: 'd', context_length: -1 }, { id: 1 },
  ] }));
  const models = await openaiCompatible.models(provider(base));
  expect(models.map((m) => m.contextLength)).toEqual([100, 200, 300, null]);
  expect(models[0]).toEqual({
    upstreamId: 'a', contextLength: 100, maxOutputTokens: null,
    price: { input: null, output: null, cacheRead: null }, protocols: null,
  });
});

test('OpenRouter converts per-token prices, including free, dynamic and invalid prices', async () => {
  const base = stub(() => Response.json({ data: [
    { id: 'model', context_length: 128000, top_provider: { max_completion_tokens: 4096 },
      pricing: { prompt: '0.000008', completion: '0.0000025',
        input_cache_read: '0', input_cache_write: '-1' } },
    { id: 'other', pricing: { prompt: 'not-a-number' } },
  ] }));
  const models = await openrouter.models(provider(base));
  expect(models[0]).toEqual({
    upstreamId: 'model', contextLength: 128000, maxOutputTokens: 4096,
    price: { input: 8, output: 2.5, cacheRead: 0 }, protocols: null,
  });
  expect(models[1]?.price).toEqual({ input: null, output: null, cacheRead: null });
});

test('401 carries upstream message and status without leaking the credential', async () => {
  const base = stub(() => Response.json({ error: { message: 'denied' } }, { status: 401 }));
  try {
    await openaiCompatible.models(provider(base));
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamFailure);
    expect((error as UpstreamFailure).status).toBe(401);
    expect((error as Error).message).toContain('denied');
    expect((error as Error).message).not.toContain('secret-key');
  }
});

test('upstream error text cannot echo the credential', async () => {
  const base = stub(() => Response.json({ error: { message: 'secret-key rejected' } }, { status: 401 }));
  await expect(openaiCompatible.models(provider(base))).rejects.toThrow('[redacted] rejected');
});

test('500 without a body is a status-bearing failure', async () => {
  const base = stub(() => new Response(null, { status: 500 }));
  await expect(openaiCompatible.models(provider(base))).rejects.toMatchObject({ status: 500 });
});

test('302 is not followed', async () => {
  let redirected = 0;
  const base = stub((req) => {
    if (new URL(req.url).pathname === '/destination') redirected++;
    return new Response(null, { status: 302, headers: { Location: '/destination' } });
  });
  await expect(openaiCompatible.models(provider(base))).rejects.toMatchObject({ status: 302 });
  expect(redirected).toBe(0);
});

test('connection refused is an upstream failure with null status', async () => {
  const base = stub(() => new Response());
  server!.stop(true);
  server = null;
  await expect(openaiCompatible.models(provider(base))).rejects.toMatchObject({ status: null });
});

test('invalid JSON and missing data are rejected', async () => {
  let invalidJson = true;
  const base = stub(() => invalidJson ? new Response('not json') : Response.json({ models: [] }));
  await expect(openaiCompatible.models(provider(base))).rejects.toBeInstanceOf(UpstreamFailure);
  invalidJson = false;
  await expect(openaiCompatible.models(provider(base))).rejects.toBeInstanceOf(UpstreamFailure);
});

test('a malformed credential rejects both operations', async () => {
  const base = stub(() => Response.json({ data: [] }));
  for (const credential of ['not json', '{}', '{"apiKey":42}', '{"apiKey":""}']) {
    const access = provider(base, credential);
    await expect(openaiCompatible.target(access, 'm', 'chat')).rejects.toMatchObject({ status: null });
    await expect(openaiCompatible.models(access)).rejects.toMatchObject({ status: null });
  }
});

// Where a Chat client's request lands, for the connectors whose base is not a Chat root.
const CHAT_CLIENT_PATH: Record<string, string> = {
  'anthropic-compatible': '/v1/messages',
  opencode: '/openai/v1/chat/completions',
  'opencode-go': '/openai/v1/chat/completions',
};

// The API-key connectors; a login connector's target needs a signed-in credential.
const KEY_CONNECTORS = CONNECTORS.filter((connector) => connector.credential !== 'login');

for (const connector of KEY_CONNECTORS) {
  test(`${connector.id} target uses the overridden URL`, async () => {
    const base = stub(() => Response.json({ data: [] }));
    const path = CHAT_CLIENT_PATH[connector.id] ?? '/chat/completions';
    expect((await connector.target(provider(`${base}/`), 'm', 'chat')).url).toBe(`${base}${path}`);
  });
  test(`${connector.id} target sends its authentication header`, async () => {
    const base = stub(() => Response.json({ data: [] }));
    const target = await connector.target(provider(base), 'm', 'chat');
    if (connector.id === 'anthropic-compatible') expect(target.headers['x-api-key']).toBe('secret-key');
    else expect(target.headers.Authorization).toBe('Bearer secret-key');
  });
  test(`${connector.id} model discovery sends its authentication header`, async () => {
    const auth: (string | null)[] = [];
    const base = stub((req) => {
      auth.push(req.headers.get(connector.id === 'anthropic-compatible' ? 'x-api-key' : 'authorization'));
      return Response.json({ data: [], has_more: false });
    });
    await connector.models(provider(base));
    expect(auth[0]).toBe(connector.id === 'anthropic-compatible' ? 'secret-key' : 'Bearer secret-key');
  });
}

for (const [text, expected] of [
  ['0.000008', 8], ['0.0000025', 2.5], ['0', 0], ['-1', null], ['abc', null], [null, null],
] as const) {
  test(`OpenRouter USD per token ${String(text)} converts to ${String(expected)}`, async () => {
    const pricing = text === null ? {} : { prompt: text };
    const base = stub(() => Response.json({ data: [{ id: 'model', pricing }] }));
    expect((await openrouter.models(provider(base)))[0]?.price.input).toBe(expected);
  });
}

test('vLLM max_model_len is the context length', async () => {
  const base = stub(() => Response.json({ data: [{ id: 'vllm', max_model_len: 32768 }] }));
  expect((await openaiCompatible.models(provider(base)))[0]?.contextLength).toBe(32768);
});

test('OpenRouter per-token prices are rounded to exact-looking USD per million', async () => {
  const base = stub(() => Response.json({ data: [{
    id: 'model',
    pricing: { prompt: '0.000000013', completion: '0.000000025', input_cache_read: '0.000000050' },
  }] }));
  const price = (await openrouter.models(provider(base)))[0]!.price;
  expect(price.input).toBe(0.013);
  expect(price.output).toBe(0.025);
  expect(price.cacheRead).toBe(0.05);
});

for (const connector of [openaiCompatible, openrouter, anthropicCompatible]) {
  test(`${connector.id} skips entries without a string id`, async () => {
    const base = stub(() => Response.json({ data: [{ id: 'valid' }, { id: 7 }, {}, null], has_more: false }));
    expect((await connector.models(provider(base))).map((model) => model.upstreamId)).toEqual(['valid']);
  });
}

test('a realistic model list is parsed', async () => {
  const base = stub(() => Response.json({
    object: 'list',
    data: [{ id: 'model', object: 'model', owned_by: 'provider', context_window: 8192 }],
  }));
  expect(await openaiCompatible.models(provider(base))).toEqual([{
    upstreamId: 'model',
    contextLength: 8192,
    maxOutputTokens: null,
    price: { input: null, output: null, cacheRead: null },
    protocols: null,
  }]);
});

for (const connector of [openaiCompatible, anthropicCompatible]) {
  test(`${connector.id} 401 carries upstream message and status`, async () => {
    const base = stub(() => Response.json({ error: { message: 'denied' } }, { status: 401 }));
    await expect(connector.models(provider(base))).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('denied'),
    });
  });
  test(`${connector.id} 500 without body fails`, async () => {
    const base = stub(() => new Response(null, { status: 500 }));
    await expect(connector.models(provider(base))).rejects.toMatchObject({ status: 500 });
  });
  test(`${connector.id} redirect is not followed`, async () => {
    let destination = 0;
    const base = stub((req) => {
      if (new URL(req.url).pathname === '/destination') destination++;
      return new Response(null, { status: 302, headers: { Location: '/destination' } });
    });
    await expect(connector.models(provider(base))).rejects.toMatchObject({
      status: 302, message: expect.stringContaining('redirected'),
    });
    expect(destination).toBe(0);
  });
  test(`${connector.id} refused connection fails`, async () => {
    const base = stub(() => new Response());
    server!.stop(true);
    server = null;
    await expect(connector.models(provider(base))).rejects.toMatchObject({ status: null });
  });
  test(`${connector.id} invalid JSON fails`, async () => {
    const base = stub(() => new Response('not json'));
    await expect(connector.models(provider(base))).rejects.toMatchObject({
      message: 'Invalid upstream JSON', status: null,
    });
  });
  test(`${connector.id} JSON without a list fails`, async () => {
    const base = stub(() => Response.json({ data: {} }));
    await expect(connector.models(provider(base))).rejects.toMatchObject({
      message: 'Invalid model list', status: null,
    });
  });
  test(`${connector.id} malformed credential fails target and models`, async () => {
    const base = stub(() => new Response());
    await expect(connector.target(provider(base, 'bad'), 'm', 'chat'))
      .rejects.toMatchObject({ status: null });
    await expect(connector.models(provider(base, 'bad'))).rejects.toMatchObject({ status: null });
  });
  test(`${connector.id} redacts an upstream echo of its credential`, async () => {
    const base = stub(() => Response.json({ error: { message: 'secret-key rejected' } }, { status: 401 }));
    try {
      await connector.models(provider(base));
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamFailure);
      expect((error as Error).message).not.toContain('secret-key');
      expect((error as Error).message).toContain('[redacted]');
    }
  });
}

for (const connector of [openaiCompatible, openrouter]) {
  test(`${connector.id} does not say which protocols its models speak`, async () => {
    const base = stub(() => Response.json({ data: [{ id: 'model' }] }));
    expect((await connector.models(provider(base)))[0]?.protocols).toBeNull();
  });
}
