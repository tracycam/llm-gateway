// Stub-backed tests for the Anthropic Messages connector.
import { afterEach, expect, test } from 'bun:test';
import type { ProviderAccess } from './connector';
import { anthropicCompatible } from './anthropic';

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { server?.stop(true); server = null; });

function stub(handler: (req: Request) => Response): string {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  return `http://127.0.0.1:${server.port}`;
}

function provider(
  baseUrl: string | null, credential: string | null = '{"apiKey":"secret"}'
): ProviderAccess {
  return { id: 'test', baseUrl, credential, saveCredential() {}, model() { return null; } };
}

/** The URLs a call asks the global fetch for, answered without network access. */
async function intercepted(call: () => Promise<unknown>): Promise<string[]> {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return Response.json({ data: [], has_more: false });
  }) as typeof fetch;
  try {
    await call();
  } finally {
    globalThis.fetch = original;
  }
  return urls;
}

test('a provider without an address uses the default address for inference', async () => {
  expect(await anthropicCompatible.target(provider(null), 'm', 'chat')).toEqual({
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': 'secret', 'anthropic-version': '2026-10-21' },
    protocol: 'messages',
  });
});

test('model discovery uses the default address when the provider has none', async () => {
  const urls = await intercepted(() => anthropicCompatible.models(provider(null)));
  expect(urls).toEqual(['https://api.anthropic.com/v1/models?limit=1000']);
});

test('a custom address is used for inference and for the model list', async () => {
  const paths: string[] = [];
  const base = stub((req) => {
    paths.push(new URL(req.url).pathname);
    return Response.json({ data: [], has_more: false });
  });
  expect((await anthropicCompatible.target(provider(base), 'm', 'chat')).url).toBe(`${base}/v1/messages`);
  expect(await anthropicCompatible.models(provider(base))).toEqual([]);
  expect(paths).toEqual(['/v1/models']);
});

test('the target sends Messages, version and API key with a trimmed base', async () => {
  const base = stub(() => new Response());
  expect(await anthropicCompatible.target(provider(`${base}/`), 'm', 'chat')).toEqual({
    url: `${base}/v1/messages`,
    headers: { 'x-api-key': 'secret', 'anthropic-version': '2026-10-21' },
    protocol: 'messages',
  });
});

test('without a key no x-api-key header is sent', async () => {
  const sent: Array<Record<string, string | null>> = [];
  const base = stub((req) => {
    sent.push({
      'x-api-key': req.headers.get('x-api-key'),
      'anthropic-version': req.headers.get('anthropic-version'),
    });
    return Response.json({ data: [], has_more: false });
  });
  const access = provider(base, null);
  const target = await anthropicCompatible.target(access, 'm', 'chat');
  expect(target.headers).toEqual({ 'anthropic-version': '2026-10-21' });
  await anthropicCompatible.models(access);
  expect(sent).toEqual([{ 'x-api-key': null, 'anthropic-version': '2026-10-21' }]);
});

test('pagination requests after_id and parses model limits without prices', async () => {
  const requests: Request[] = [];
  const base = stub((req) => {
    requests.push(new Request(req.url, req));
    return requests.length === 1
      ? Response.json({ data: [{ id: 'one', max_input_tokens: 200000, max_tokens: 8192 }],
        has_more: true, last_id: 'one' })
      : Response.json({ data: [{ id: 'two' }, { id: 1 }], has_more: false, last_id: 'two' });
  });
  const models = await anthropicCompatible.models(provider(base));
  expect(models).toEqual([
    { upstreamId: 'one', contextLength: 200000, maxOutputTokens: 8192,
      price: { input: null, output: null, cacheRead: null } },
    { upstreamId: 'two', contextLength: null, maxOutputTokens: null,
      price: { input: null, output: null, cacheRead: null } },
  ]);
  expect(requests.length).toBe(2);
  expect(requests[0]?.method).toBe('GET');
  expect(new URL(requests[0]!.url).pathname).toBe('/v1/models');
  expect(new URL(requests[0]!.url).searchParams.get('limit')).toBe('1000');
  expect(new URL(requests[1]!.url).searchParams.get('after_id')).toBe('one');
  expect(requests[0]?.headers.get('x-api-key')).toBe('secret');
  expect(requests[0]?.headers.get('anthropic-version')).toBe('2026-10-21');
});

test('a model list exceeding 20 pages is rejected', async () => {
  let count = 0;
  const base = stub(() => Response.json({ data: [], has_more: true, last_id: `${++count}` }));
  await expect(anthropicCompatible.models(provider(base))).rejects.toThrow('20 pages');
  expect(count).toBe(20);
});

test('a malformed credential rejects both operations', async () => {
  const base = stub(() => new Response());
  for (const credential of ['bad', '{}', '{"apiKey":42}', '{"apiKey":""}']) {
    await expect(anthropicCompatible.target(provider(base, credential), 'm', 'messages'))
      .rejects.toMatchObject({ status: null });
    await expect(anthropicCompatible.models(provider(base, credential)))
      .rejects.toMatchObject({ status: null });
  }
});

test('has_more without last_id is rejected', async () => {
  const base = stub(() => Response.json({ data: [], has_more: true }));
  await expect(anthropicCompatible.models(provider(base))).rejects.toThrow('pagination cursor');
});

test('the model request sends limit=1000', async () => {
  const queries: string[] = [];
  const base = stub((req) => {
    queries.push(new URL(req.url).searchParams.get('limit') ?? '');
    return Response.json({ data: [], has_more: false });
  });
  await anthropicCompatible.models(provider(base));
  expect(queries).toEqual(['1000']);
});

test('the model request sends anthropic-version', async () => {
  const versions: (string | null)[] = [];
  const base = stub((req) => {
    versions.push(req.headers.get('anthropic-version'));
    return Response.json({ data: [], has_more: false });
  });
  await anthropicCompatible.models(provider(base));
  expect(versions).toEqual(['2026-10-21']);
});

test('the target sends anthropic-version', async () => {
  const base = stub(() => new Response());
  const target = await anthropicCompatible.target(provider(base), 'm', 'chat');
  expect(target.headers['anthropic-version']).toBe('2026-10-21');
});

test('the target sends x-api-key', async () => {
  const base = stub(() => new Response());
  const target = await anthropicCompatible.target(provider(base), 'm', 'chat');
  expect(target.headers['x-api-key']).toBe('secret');
});
