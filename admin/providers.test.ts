// Provider management uses the real SQLite stores.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { providerAccess } from '../connectors/access';
import type { Connector } from '../connectors/connector';
import { UpstreamFailure } from '../connectors/connector';
import { CONNECTORS, connectorById } from '../connectors/registry';
import { CredentialRenewals } from '../connectors/tokens';
import { KeyStore } from '../keyStore';
import { LoginSessions } from '../login';
import { ModelStore } from '../modelStore';
import { ProviderStore } from '../providerStore';
import { migrate } from '../schema';
import { UsageStore } from '../usageStore';
import type { AdminDeps } from './deps';
import { handleProviderRoute } from './providers';
import { fixture, request, upstreamFailure } from './testing';

test('credentials, refresh failure, publication and input validation', async () => {
  const db = new Database(':memory:');
  migrate(db);
  let fail = false;
  const connector: Connector = {
    id: 'fake',
    name: 'Fake',
    defaultBaseUrl: 'https://example.com',
    credential: 'api-key',
    async target() { throw new Error('unused'); },
    async models() {
      if (fail) throw new UpstreamFailure('上游拒绝了凭证', 401);
      return [{
        upstreamId: 'upstream',
        contextLength: null,
        maxOutputTokens: null,
        price: { input: null, output: null, cacheRead: null },
        protocols: null,
      }];
    },
  };
  const providers = new ProviderStore(db);
  const find = (id: string) => id === connector.id ? connector : null;
  const now = () => new Date('2026-01-01T00:00:00Z');
  const deps: AdminDeps = {
    providers,
    models: new ModelStore(db),
    keys: new KeyStore(db),
    usage: new UsageStore(db),
    logins: new LoginSessions({
      providers, connector: find, fetch, now, wait: () => new Promise<void>(() => {}),
    }),
    renewals: new CredentialRenewals(),
    connector: find,
    connectors: () => [connector],
    now,
  };
  const call = (path: string, method = 'GET', body?: unknown) => handleProviderRoute(new Request(
    `http://localhost/api/gateway${path}`,
    { method, body: body === undefined ? undefined : JSON.stringify(body) }
  ), deps);
  expect((await call('/providers', 'POST', { name: 'a', connector: 'fake' }))?.status).toBe(400);
  const unknown = await call('/providers', 'POST', { name: 'a', connector: 'unknown', apiKey: 'x' });
  expect(unknown?.status).toBe(400);
  expect((await call('/providers', 'POST', {
    name: 'a', connector: 'fake', apiKey: 'x', baseUrl: 'https://u:p@example.com',
  }))?.status).toBe(400);
  const created = await call('/providers', 'POST', {
    name: 'a', connector: 'fake', apiKey: 'secret-key', autoPublish: true,
  });
  expect(created?.status).toBe(201);
  expect(await created?.text()).not.toContain('secret-key');
  const id = deps.providers.list()[0].id;
  for (const response of [await call('/providers'), await call(`/providers/${id}`, 'PATCH', { name: 'b' }),
    await call(`/providers/${id}/models`), await call(`/providers/${id}/refresh`, 'POST')]) {
    expect(await response?.text()).not.toContain('secret-key');
  }
  expect(deps.models.list()[0].routes[0].upstreamModel).toBe('upstream');
  fail = true;
  const failure = await call(`/providers/${id}/refresh`, 'POST');
  expect(failure?.status).toBe(502);
  expect(await failure?.text()).not.toContain('secret-key');
  expect(deps.providers.models(id)).toHaveLength(1);
  expect((await call('/providers', 'POST', { name: 'b', connector: 'fake', apiKey: 'x' }))?.status).toBe(409);
  expect((await call(`/providers/${id}`, 'PATCH', { enabled: 'true' }))?.status).toBe(400);
  expect(deps.providers.get(id)?.enabled).toBe(true);
  expect((await call('/providers', 'PUT'))?.status).toBe(405);
  expect(await call('/other')).toBeNull();
  db.close();
});

const providerCases: Array<[string, unknown, string]> = [
  ['name', undefined, 'name'],
  ['name', 12, 'name'],
  ['name', '', 'name'],
  ['connector', undefined, 'connector'],
  ['connector', 12, 'connector'],
  ['connector', 'unknown', 'connector'],
  ['baseUrl', 12, 'baseUrl'],
  ['baseUrl', 'ftp://example.com', 'baseUrl'],
  ['baseUrl', 'https://user:pass@example.com', 'baseUrl'],
  ['apiKey', undefined, 'apiKey'],
  ['apiKey', 12, 'apiKey'],
  ['apiKey', '', 'apiKey'],
  ['autoPublish', 'true', 'autoPublish'],
];

for (const [field, value, errorField] of providerCases) {
  test(`POST providers rule 2: ${field} ${String(value)} rejected before store mutation`, async () => {
    const { deps, db } = fixture();
    const input = { name: 'p', connector: 'fake', apiKey: 'secret', [field]: value };
    const response = await handleProviderRoute(request('/providers', 'POST', input), deps);
    expect(response?.status).toBe(400);
    expect((await response?.json()).error).toContain(errorField);
    expect(deps.providers.list()).toHaveLength(0);
    db.close();
  });
}

for (const [field, value] of [
  ['name', 1], ['baseUrl', 1], ['apiKey', 1], ['enabled', 1], ['autoPublish', 1],
] as const) {
  test(`PATCH providers rule 2: wrong ${field} rejected`, async () => {
    const { deps, db } = fixture();
    const provider = deps.providers.create({
      name: 'p', connector: 'fake', baseUrl: null, credential: 'secret', autoPublish: false,
    }, deps.now());
    const req = request(`/providers/${provider.id}`, 'PATCH', { [field]: value });
    const response = await handleProviderRoute(req, deps);
    expect(response?.status).toBe(400);
    expect((await response?.json()).error).toContain(field);
    expect(deps.providers.get(provider.id)).toEqual(provider);
    db.close();
  });
}

test('PATCH providers baseUrl null uses default and is rejected without default', async () => {
  const { deps, connector, db } = fixture();
  const provider = deps.providers.create({
    name: 'p', connector: 'fake', baseUrl: 'https://local', credential: null, autoPublish: false,
  }, deps.now());
  const path = `/providers/${provider.id}`;
  expect((await handleProviderRoute(request(path, 'PATCH', { baseUrl: null }), deps))?.status).toBe(200);
  expect(deps.providers.get(provider.id)?.baseUrl).toBeNull();
  connector.defaultBaseUrl = null;
  const setUrl = await handleProviderRoute(request(path, 'PATCH', { baseUrl: 'https://local' }), deps);
  expect(setUrl?.status).toBe(200);
  const response = await handleProviderRoute(request(path, 'PATCH', { baseUrl: null }), deps);
  expect(response?.status).toBe(400);
  expect(deps.providers.get(provider.id)?.baseUrl).toBe('https://local');
  db.close();
});

test('refresh propagates unexpected exceptions without replacing models', async () => {
  const { deps, state, db } = fixture();
  const provider = deps.providers.create({
    name: 'p', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
  }, deps.now());
  await handleProviderRoute(request(`/providers/${provider.id}/refresh`, 'POST'), deps);
  state.failure = new Error('bug');
  const refreshRequest = request(`/providers/${provider.id}/refresh`, 'POST');
  await expect(handleProviderRoute(refreshRequest, deps)).rejects.toThrow('bug');
  expect(deps.providers.models(provider.id)).toHaveLength(1);
  state.failure = upstreamFailure();
  const response = await handleProviderRoute(request(`/providers/${provider.id}/refresh`, 'POST'), deps);
  expect(response?.status).toBe(502);
  expect(deps.providers.models(provider.id)).toHaveLength(1);
  db.close();
});

for (const [path, method] of [
  ['/connectors', 'POST'], ['/providers', 'PUT'], ['/providers/x', 'GET'],
  ['/providers/x/models', 'POST'], ['/providers/x/refresh', 'GET'], ['/providers/x/publish', 'GET'],
]) {
  test(`${method} ${path}: rule 5 wrong method is 405`, async () => {
    const { deps, db } = fixture();
    expect((await handleProviderRoute(request(path, method), deps))?.status).toBe(405);
    db.close();
  });
}

test('GET connectors returns only form fields', async () => {
  const { deps, db } = fixture();
  const response = await handleProviderRoute(request('/connectors'), deps);
  expect(await response?.json()).toEqual({ connectors: [{
    id: 'fake', name: 'Fake', defaultBaseUrl: 'https://example.com', credential: 'api-key',
  }] });
  expect(deps.providers.list()).toHaveLength(0);
  db.close();
});

/** The fixture's stores with the gateway's own connector registry. */
function registryFixture(): { db: Database; deps: AdminDeps } {
  const { db, deps } = fixture();
  return { db, deps: { ...deps, connector: connectorById, connectors: () => CONNECTORS } };
}

test('GET connectors lists the seven connectors in administrator order', async () => {
  const { deps, db } = registryFixture();
  try {
    const response = await handleProviderRoute(request('/connectors'), deps);
    expect(await response?.json()).toEqual({ connectors: [
      { id: 'openai-compatible', name: 'OpenAI-compatible',
        defaultBaseUrl: 'https://api.openai.com/v1', credential: 'optional-api-key' },
      { id: 'anthropic-compatible', name: 'Anthropic-compatible',
        defaultBaseUrl: 'https://api.anthropic.com', credential: 'optional-api-key' },
      { id: 'grok', name: 'Grok',
        defaultBaseUrl: 'https://cli-chat-proxy.grok.com/v1', credential: 'login' },
      { id: 'opencode', name: 'OpenCode Zen',
        defaultBaseUrl: 'https://opencode.ai/inference', credential: 'api-key' },
      { id: 'opencode-go', name: 'OpenCode Go',
        defaultBaseUrl: 'https://opencode.ai/inference/go', credential: 'api-key' },
      { id: 'copilot', name: 'GitHub Copilot',
        defaultBaseUrl: 'https://api.githubcopilot.com', credential: 'login' },
      { id: 'openrouter', name: 'OpenRouter',
        defaultBaseUrl: 'https://openrouter.ai/api/v1', credential: 'api-key' },
    ] });
    expect(deps.providers.list()).toHaveLength(0);
  } finally {
    db.close();
  }
});

test('a provider on a retired connector id is refused', async () => {
  const { deps, db } = registryFixture();
  try {
    for (const connector of ['openai', 'anthropic']) {
      const response = await handleProviderRoute(request('/providers', 'POST', {
        name: `p-${connector}`, connector, apiKey: 'key',
      }), deps);
      expect(response?.status).toBe(400);
      expect(await response?.json()).toEqual({ error: 'connector 无效' });
    }
    expect(deps.providers.list()).toHaveLength(0);
  } finally {
    db.close();
  }
});

test('a keyless provider with no address resolves to the connector default', async () => {
  const { deps, db } = registryFixture();
  try {
    const response = await handleProviderRoute(request('/providers', 'POST', {
      name: 'official', connector: 'openai-compatible',
    }), deps);
    expect(response?.status).toBe(201);
    const { provider } = await response!.json();
    expect(provider).toMatchObject({
      connector: 'openai-compatible', baseUrl: null, hasCredential: false,
    });
    const stored = deps.providers.get(provider.id)!;
    const connector = connectorById(stored.connector)!;
    const access = providerAccess(deps.providers, stored, deps.renewals);
    const target = await connector.target(access, 'gpt', 'chat');
    expect(target.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(target.headers).toEqual({});
  } finally {
    db.close();
  }
});

test('POST publish creates a route and GET models marks it published', async () => {
  const { deps, db } = fixture();
  const provider = deps.providers.create({
    name: 'p', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
  }, deps.now());
  const path = `/providers/${provider.id}`;
  await handleProviderRoute(request(`${path}/refresh`, 'POST'), deps);
  const req = request(`${path}/publish`, 'POST', { upstreamId: 'upstream' });
  const response = await handleProviderRoute(req, deps);
  expect(response?.status).toBe(201);
  expect((await response?.json()).route.upstreamModel).toBe('upstream');
  const listing = await handleProviderRoute(request(`${path}/models`), deps);
  expect((await listing?.json()).models[0].published).toBe(true);
  expect(deps.models.list()[0].routes).toHaveLength(1);
  db.close();
});

for (const [path, method, body] of [
  ['/providers/missing', 'PATCH', {}], ['/providers/missing', 'DELETE', undefined],
  ['/providers/missing/models', 'GET', undefined], ['/providers/missing/refresh', 'POST', undefined],
  ['/providers/missing/publish', 'POST', { upstreamId: 'x' }],
] as const) {
  test(`${method} ${path}: unknown provider is 404`, async () => {
    const { deps, db } = fixture();
    const response = await handleProviderRoute(request(path, method, body), deps);
    expect(response?.status).toBe(404);
    expect(deps.providers.list()).toHaveLength(0);
    db.close();
  });
}

test('DELETE provider removes it and its discovered models', async () => {
  const { deps, db } = fixture();
  const provider = deps.providers.create({
    name: 'p', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
  }, deps.now());
  await handleProviderRoute(request(`/providers/${provider.id}/refresh`, 'POST'), deps);
  expect((await handleProviderRoute(request(`/providers/${provider.id}`, 'DELETE'), deps))?.status).toBe(204);
  expect(deps.providers.get(provider.id)).toBeNull();
  expect(deps.providers.models(provider.id)).toHaveLength(0);
  db.close();
});

test('providerAccess reads discovered models lazily once', async () => {
  const { deps, db } = fixture();
  const provider = deps.providers.create({
    name: 'p', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
  }, deps.now());
  const { providerAccess } = await import('../connectors/access');
  const access = providerAccess(deps.providers, provider, deps.renewals);
  await handleProviderRoute(request(`/providers/${provider.id}/refresh`, 'POST'), deps);
  expect(access.model('upstream')?.upstreamId).toBe('upstream');
  deps.providers.replaceModels(provider.id, [], deps.now());
  expect(access.model('upstream')?.upstreamId).toBe('upstream');
  db.close();
});

test('POST provider without default URL requires baseUrl', async () => {
  const { deps, connector, db } = fixture();
  connector.defaultBaseUrl = null;
  const response = await handleProviderRoute(request('/providers', 'POST', {
    name: 'p', connector: 'fake', apiKey: 'key',
  }), deps);
  expect(response?.status).toBe(400);
  expect((await response?.json()).error).toContain('baseUrl');
  expect(deps.providers.list()).toHaveLength(0);
  db.close();
});

test('PATCH provider required apiKey cannot be removed', async () => {
  const { deps, db } = fixture();
  const provider = deps.providers.create({
    name: 'p', connector: 'fake', baseUrl: null, credential: 'stored', autoPublish: false,
  }, deps.now());
  const req = request(`/providers/${provider.id}`, 'PATCH', { apiKey: null });
  const response = await handleProviderRoute(req, deps);
  expect(response?.status).toBe(400);
  expect((await response?.json()).error).toContain('apiKey');
  expect(deps.providers.credential(provider.id)).toBe('stored');
  db.close();
});

test('POST publish rejects unknown upstream model with 404', async () => {
  const { deps, db } = fixture();
  const provider = deps.providers.create({
    name: 'p', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
  }, deps.now());
  const response = await handleProviderRoute(request(`/providers/${provider.id}/publish`, 'POST', {
    upstreamId: 'missing',
  }), deps);
  expect(response?.status).toBe(404);
  expect(deps.models.list()).toHaveLength(0);
  db.close();
});

test('rule 6 provider path rejects encoded slash', async () => {
  const { deps, db } = fixture();
  expect(await handleProviderRoute(request('/providers/a%2Fb', 'DELETE'), deps)).toBeNull();
  expect(deps.providers.list()).toHaveLength(0);
  db.close();
});

test('PATCH apiKey stores JSON credential text', async () => {
  const { deps, db } = fixture();
  const provider = deps.providers.create({
    name: 'p', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
  }, deps.now());
  const req = request(`/providers/${provider.id}`, 'PATCH', { apiKey: 'new' });
  const response = await handleProviderRoute(req, deps);
  expect(response?.status).toBe(200);
  expect(deps.providers.credential(provider.id)).toBe('{"apiKey":"new"}');
  db.close();
});

test('PATCH without apiKey preserves credential', async () => {
  const { deps, db } = fixture();
  const provider = deps.providers.create({
    name: 'p', connector: 'fake', baseUrl: null, credential: '{"apiKey":"old"}', autoPublish: false,
  }, deps.now());
  const req = request(`/providers/${provider.id}`, 'PATCH', { name: 'new' });
  const response = await handleProviderRoute(req, deps);
  expect(response?.status).toBe(200);
  expect(deps.providers.credential(provider.id)).toBe('{"apiKey":"old"}');
  db.close();
});

test('published requires the same provider as well as upstream id', async () => {
  const { deps, db } = fixture();
  const one = deps.providers.create({
    name: 'one', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
  }, deps.now());
  const two = deps.providers.create({
    name: 'two', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
  }, deps.now());
  await handleProviderRoute(request(`/providers/${one.id}/refresh`, 'POST'), deps);
  await handleProviderRoute(request(`/providers/${two.id}/refresh`, 'POST'), deps);
  deps.models.publish(one.id, 'upstream', deps.now());
  const response = await handleProviderRoute(request(`/providers/${two.id}/models`), deps);
  expect((await response?.json()).models[0].published).toBe(false);
  expect(deps.models.list()[0].routes[0].providerId).toBe(one.id);
  db.close();
});

test('publish distinguishes unknown provider and upstream model', async () => {
  const { deps, db } = fixture();
  const provider = deps.providers.create({
    name: 'p', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
  }, deps.now());
  const body = { upstreamId: 'missing' };
  const providerRequest = request('/providers/missing/publish', 'POST', body);
  const modelRequest = request(`/providers/${provider.id}/publish`, 'POST', body);
  const missingProvider = await handleProviderRoute(providerRequest, deps);
  const missingModel = await handleProviderRoute(modelRequest, deps);
  expect(missingProvider?.status).toBe(404);
  expect(await missingProvider?.json()).toEqual({ error: '未找到提供商' });
  expect(missingModel?.status).toBe(404);
  expect(await missingModel?.json()).toEqual({ error: '未找到提供商模型' });
  expect(deps.models.list()).toHaveLength(0);
  db.close();
});

test('the provider model list carries the protocols the provider said', async () => {
  const { db, deps } = fixture();
  try {
    const created = deps.providers.create({
      name: 'protocols', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
    }, deps.now());
    deps.providers.replaceModels(created.id, [{
      upstreamId: 'upstream', contextLength: null, maxOutputTokens: null,
      price: { input: null, output: null, cacheRead: null }, protocols: ['responses', 'chat'],
    }], deps.now());
    const response = await handleProviderRoute(request(`/providers/${created.id}/models`), deps);
    const body = JSON.parse(await response!.text());
    expect(body.models).toHaveLength(1);
    expect(body.models[0].protocols).toEqual(['responses', 'chat']);
  } finally {
    db.close();
  }
});
