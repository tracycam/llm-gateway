// Stub-backed tests for the Anthropic connector.
import { afterEach, expect, test } from 'bun:test';
import type { ProviderAccess } from './connector';
import { anthropic } from './anthropic';

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { server?.stop(true); server = null; });

function stub(handler: (req: Request) => Response): string {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  return `http://127.0.0.1:${server.port}`;
}

function provider(baseUrl: string, credential: string | null = '{"apiKey":"secret"}'): ProviderAccess {
  return { id: 'test', baseUrl, credential, saveCredential() {}, model() { return null; } };
}

test('Anthropic target uses Messages, version and API key with a trimmed base', async () => {
  const base = stub(() => new Response());
  expect(await anthropic.target(provider(`${base}/`), 'm', 'chat')).toEqual({
    url: `${base}/v1/messages`,
    headers: { 'x-api-key': 'secret', 'anthropic-version': '2026-10-21' },
    protocol: 'messages',
  });
});

test('Anthropic pagination requests after_id and parses model limits without prices', async () => {
  const requests: Request[] = [];
  const base = stub((req) => {
    requests.push(new Request(req.url, req));
    return requests.length === 1
      ? Response.json({ data: [{ id: 'one', max_input_tokens: 200000, max_tokens: 8192 }],
        has_more: true, last_id: 'one' })
      : Response.json({ data: [{ id: 'two' }, { id: 1 }], has_more: false, last_id: 'two' });
  });
  const models = await anthropic.models(provider(base));
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

test('Anthropic rejects a model list exceeding 20 pages', async () => {
  let count = 0;
  const base = stub(() => Response.json({ data: [], has_more: true, last_id: `${++count}` }));
  await expect(anthropic.models(provider(base))).rejects.toThrow('20 pages');
  expect(count).toBe(20);
});

test('Anthropic rejects missing and malformed credentials', async () => {
  const base = stub(() => new Response());
  for (const credential of [null, 'bad', '{}']) {
    await expect(anthropic.target(provider(base, credential), 'm', 'messages')).rejects.toMatchObject({
      status: null,
    });
    await expect(anthropic.models(provider(base, credential))).rejects.toMatchObject({ status: null });
  }
});

test('Anthropic rejects has_more without last_id', async () => {
  const base = stub(() => Response.json({ data: [], has_more: true }));
  await expect(anthropic.models(provider(base))).rejects.toThrow('pagination cursor');
});

test('Anthropic model request sends limit=1000', async () => {
  const queries: string[] = [];
  const base = stub((req) => {
    queries.push(new URL(req.url).searchParams.get('limit') ?? '');
    return Response.json({ data: [], has_more: false });
  });
  await anthropic.models(provider(base));
  expect(queries).toEqual(['1000']);
});

test('Anthropic model request sends anthropic-version', async () => {
  const versions: (string | null)[] = [];
  const base = stub((req) => {
    versions.push(req.headers.get('anthropic-version'));
    return Response.json({ data: [], has_more: false });
  });
  await anthropic.models(provider(base));
  expect(versions).toEqual(['2026-10-21']);
});

test('Anthropic target sends anthropic-version', async () => {
  const base = stub(() => new Response());
  const target = await anthropic.target(provider(base), 'm', 'chat');
  expect(target.headers['anthropic-version']).toBe('2026-10-21');
});

test('Anthropic target sends x-api-key', async () => {
  const base = stub(() => new Response());
  const target = await anthropic.target(provider(base), 'm', 'chat');
  expect(target.headers['x-api-key']).toBe('secret');
});
