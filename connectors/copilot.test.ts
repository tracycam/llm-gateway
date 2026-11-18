// Stub-backed tests for the GitHub Copilot connector, one test per rule. Every request the
// connector makes goes to a stub on 127.0.0.1, which is the only host it is given.
import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type GatewayApp } from '../app';
import { UpstreamFailure } from './connector';
import type { DeviceCode, ProviderAccess, UpstreamTarget } from './connector';
import { copilot, copilotConnector } from './copilot';
import { openGatewayDatabase } from '../database';
import { attempt, type AttemptInput } from '../inference/attempt';
import { KeyStore } from '../keyStore';
import type { Protocol } from '../protocols/protocol';
import type { ProviderModelInput } from '../providerStore';
import { ProviderStore } from '../providerStore';
import { CopilotStub, type CopilotStubOptions } from '../testing/copilotStub';

const TOKEN = 'gho_copilot_token_0001';
const DEVICE_CODE = 'device-code-secret-0001';
const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const NOW = new Date('2026-01-01T00:00:00Z');
const ADMIN = 'admin-token-0123456789';
const ADMIN_HEADER = { authorization: `Bearer ${ADMIN}` };

const stubs: CopilotStub[] = [];
const apps: GatewayApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const stub of stubs.splice(0)) stub.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function stub(options?: CopilotStubOptions): CopilotStub {
  const created = new CopilotStub(options);
  stubs.push(created);
  return created;
}

/** A connector whose three hosts are stubs: nothing else is reachable. */
function over(github: CopilotStub, copilotApi: CopilotStub = github): ReturnType<typeof copilotConnector> {
  return copilotConnector({
    github: github.base,
    githubApi: github.base,
    copilotApi: copilotApi.base,
  });
}

interface Access extends ProviderAccess {
  saved: string[];
  rejections: number;
  renewals: number;
}

function access(options: {
  baseUrl?: string | null;
  apiBase?: string | null;
  credential?: string | null;
  protocols?: Protocol[] | null;
} = {}): Access {
  const saved: string[] = [];
  let rejections = 0;
  let renewals = 0;
  let credential = options.credential === undefined
    ? JSON.stringify({ accessToken: TOKEN, apiBase: options.apiBase ?? null })
    : options.credential;
  const protocols = options.protocols === undefined ? null : options.protocols;
  return {
    id: 'prv-copilot',
    baseUrl: options.baseUrl ?? null,
    get credential() { return credential; },
    saveCredential(text) { credential = text; saved.push(text); },
    rejectCredential() { rejections += 1; },
    renewOnce(renew) { renewals += 1; return renew(); },
    model(): ProviderModelInput {
      return {
        upstreamId: 'upstream-model',
        contextLength: null,
        maxOutputTokens: null,
        price: { input: null, output: null, cacheRead: null },
        protocols,
      };
    },
    get saved() { return saved; },
    get rejections() { return rejections; },
    get renewals() { return renewals; },
  };
}

/** The headers the connector itself sets, by the names it sets them under. */
const CLIENT_HEADERS: Record<string, string> = {
  'copilot-integration-id': 'vscode-chat',
  'editor-version': 'vscode/1.95.0',
  'editor-plugin-version': 'copilot-chat/0.26.7',
  'user-agent': 'GitHubCopilotChat/0.26.7',
  'openai-intent': 'conversation-panel',
  'x-github-api-version': '2026-08-01',
  'x-initiator': 'user',
};

const MANAGED = [...Object.keys(CLIENT_HEADERS), 'authorization'];

/** What the connector set on a request: the identity headers and the bearer, nothing else. */
function managedHeaders(headers: Headers): Record<string, string> {
  const seen: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (MANAGED.includes(name)) seen[name] = value;
  }
  return seen;
}

/** The header names whose value carries the GitHub token. */
function tokenHeaderNames(headers: Headers): string[] {
  return [...headers.entries()]
    .filter(([, value]) => value.includes(TOKEN))
    .map(([name]) => name);
}

const CHAT_MODEL = {
  id: 'gpt-5.4',
  name: 'GPT-5.4',
  object: 'model',
  vendor: 'OpenAI',
  model_picker_enabled: true,
  policy: { state: 'enabled' },
  supported_endpoints: ['/responses', '/chat/completions'],
  capabilities: {
    type: 'chat',
    family: 'gpt-5.4',
    limits: { max_context_window_tokens: 400000, max_output_tokens: 128000 },
    supports: { tool_calls: true, streaming: true },
  },
};

// #region Login rules

test('rule login-1: the device request carries the client id and the read:user scope', async () => {
  const s = stub();
  const connector = over(s);
  const code = await connector.login.start(fetch);
  expect(code).toMatchObject({
    userCode: 'TEST-CODE',
    verificationUri: 'https://example.test/device',
    verificationUriComplete: 'https://example.test/device?user_code=TEST-CODE',
    interval: 0,
  });
  const request = s.requestsTo('/login/device/code')[0]!;
  expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
    client_id: CLIENT_ID,
    scope: 'read:user',
  });
  expect(request.headers.get('user-agent')).toBe('GitHubCopilotChat/0.26.7');
  expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
});

test('rule login-2: a pending poll becomes a grant whose credential holds the GitHub token', async () => {
  const s = stub({ steps: ['pending', 'grant'] });
  const connector = over(s);
  const code = await connector.login.start(fetch);
  expect(await connector.login.poll(code, fetch)).toEqual({ status: 'pending' });
  const polled = await connector.login.poll(code, fetch);
  if (polled.status !== 'granted') throw new Error(JSON.stringify(polled));
  expect(JSON.parse(polled.credential)).toEqual({ accessToken: TOKEN, apiBase: null });
  const request = s.requestsTo('/login/oauth/access_token')[0]!;
  expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: DEVICE_CODE,
    client_id: CLIENT_ID,
  });
});

test('rule login-3: a denied poll is refused with GitHub’s reason', async () => {
  const s = stub({ steps: ['denied'] });
  const connector = over(s);
  const code = await connector.login.start(fetch);
  expect(await connector.login.poll(code, fetch)).toEqual({
    status: 'refused',
    reason: 'The user has denied your application access.',
  });
});

// #endregion

// #region Base rules

test('rule base-1: the base the user document names serves both models and targets', async () => {
  const copilotApi = stub({ models: [CHAT_MODEL] });
  const configuredDefault = stub();
  const connector = copilotConnector({
    github: copilotApi.base,
    githubApi: copilotApi.base,
    copilotApi: configuredDefault.base,
  });
  const provider = access({ protocols: ['chat'] });
  expect((await connector.models(provider)).map((model) => model.upstreamId)).toEqual(['gpt-5.4']);
  expect(copilotApi.requestsTo('/models')).toHaveLength(1);
  expect(configuredDefault.requests).toHaveLength(0);
  expect(JSON.parse(provider.saved[0]!)).toEqual({ accessToken: TOKEN, apiBase: copilotApi.base });

  const target = await connector.target(provider, 'gpt-5.4', 'chat');
  expect(target.url).toBe(`${copilotApi.base}/chat/completions`);
  // The refresh stored the base, so the request did not ask GitHub again.
  expect(copilotApi.requestsTo('/copilot_internal/user')).toHaveLength(1);
});

test('rule base-2: the documented default serves the account whose document names no base', async () => {
  const github = stub({ apiBase: null });
  const configuredDefault = stub({ models: [CHAT_MODEL] });
  const connector = copilotConnector({
    github: github.base,
    githubApi: github.base,
    copilotApi: configuredDefault.base,
  });
  const provider = access();
  expect((await connector.models(provider)).map((model) => model.upstreamId)).toEqual(['gpt-5.4']);
  expect(configuredDefault.requestsTo('/models')).toHaveLength(1);
  expect(github.requestsTo('/models')).toHaveLength(0);
  expect(JSON.parse(provider.saved[0]!).apiBase).toBe(configuredDefault.base);
});

test('rule base-3: the administrator’s baseUrl wins over the discovered base', async () => {
  const github = stub();
  const adminBase = stub({ models: [CHAT_MODEL] });
  const connector = over(github);
  const provider = access({ baseUrl: `${adminBase.base}///`, protocols: ['responses'] });
  expect((await connector.models(provider)).map((model) => model.upstreamId)).toEqual(['gpt-5.4']);
  expect(adminBase.requestsTo('/models')).toHaveLength(1);
  expect(github.requestsTo('/copilot_internal/user')).toHaveLength(0);
  expect(provider.saved).toEqual([]);
  expect((await connector.target(provider, 'gpt-5.4', 'responses')).url)
    .toBe(`${adminBase.base}/responses`);
});

test('rule base-4: a failed base lookup fails models and target instead of guessing a host', async () => {
  const github = stub({ userStatus: 500 });
  const configuredDefault = stub();
  const connector = copilotConnector({
    github: github.base,
    githubApi: github.base,
    copilotApi: configuredDefault.base,
  });
  const provider = access();
  try {
    await connector.models(provider);
    throw new Error('expected a failure');
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamFailure);
    expect((error as UpstreamFailure).status).toBe(500);
  }
  await expect(connector.target(provider, 'gpt-5.4', 'chat'))
    .rejects.toBeInstanceOf(UpstreamFailure);
  expect(configuredDefault.requests).toHaveLength(0);
  expect(github.requestsTo('/copilot_internal/user')).toHaveLength(2);
  expect(provider.saved).toEqual([]);
});

test('rule base-5: an account without Copilot access is refused at the lookup', async () => {
  const s = stub({ chatEnabled: false });
  const connector = over(s);
  await expect(connector.models(access()))
    .rejects.toMatchObject({ message: 'This GitHub account does not have GitHub Copilot access' });
});

// #endregion

// #region Header rules

test('rule headers-1: the model list carries the identity set and the token once, as a bearer', async () => {
  const s = stub({ models: [] });
  const connector = over(s);
  await connector.models(access());
  const request = s.requestsTo('/models')[0]!;
  expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  expect(managedHeaders(request.headers)).toEqual({
    ...CLIENT_HEADERS,
    authorization: `Bearer ${TOKEN}`,
  });
  expect(tokenHeaderNames(request.headers)).toEqual(['authorization']);
});

test('rule credential-1: the GitHub token is sent directly, with no Copilot token minted', async () => {
  const s = stub({ models: [CHAT_MODEL] });
  const connector = over(s);
  const provider = access({ protocols: ['responses', 'chat'] });
  await connector.models(provider);
  const input: AttemptInput = {
    connector,
    provider,
    upstreamModel: 'gpt-5.4',
    inbound: 'chat',
    body: { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] },
    clientHeaders: new Headers(),
    signal: new AbortController().signal,
    fetch,
    now: () => 0,
  };
  expect((await attempt(input)).kind).toBe('complete');
  expect(s.requests.map((request) => request.path)).toEqual([
    '/copilot_internal/user', '/models', '/chat/completions',
  ]);
  for (const request of s.requests) {
    expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  }
});

test('rule headers-2: every target carries the identity set and the token once, as a bearer', async () => {
  const s = stub();
  const connector = over(s);
  const provider = access({ apiBase: s.base, protocols: ['chat', 'responses', 'messages'] });
  for (const inbound of ['chat', 'responses', 'messages'] as const) {
    const target = await connector.target(provider, 'gpt-5.4', inbound);
    const headers = new Headers(target.headers);
    expect(managedHeaders(headers)).toEqual({
      ...CLIENT_HEADERS,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(tokenHeaderNames(headers)).toEqual(['authorization']);
    expect(headers.get('x-api-key')).toBeNull();
    expect(target.headers['Content-Type']).toBe('application/json');
  }
});

// #endregion

// #region Model list rules

test('rule models-1: a listed model keeps its limits, has no price and its protocols in order', async () => {
  const s = stub({ models: [
    CHAT_MODEL,
    {
      id: 'claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      model_picker_enabled: true,
      policy: { state: 'enabled' },
      supported_endpoints: ['/v1/messages'],
      capabilities: {
        type: 'chat',
        family: 'claude-sonnet-4.6',
        limits: { max_context_window_tokens: 200000, max_output_tokens: 64000 },
        supports: { tool_calls: true },
      },
      billing: {
        is_premium: true,
        multiplier: 1,
        token_prices: { batch_size: 1000, default: { input_price: 3 } },
      },
    },
  ] });
  const connector = over(s);
  expect(await connector.models(access())).toEqual([
    {
      upstreamId: 'gpt-5.4',
      contextLength: 400000,
      maxOutputTokens: 128000,
      price: { input: null, output: null, cacheRead: null },
      protocols: ['responses', 'chat'],
    },
    {
      upstreamId: 'claude-sonnet-4.6',
      contextLength: 200000,
      maxOutputTokens: 64000,
      price: { input: null, output: null, cacheRead: null },
      protocols: ['messages'],
    },
  ]);
});

test('rule models-2: an entry without supported_endpoints follows the model-id rule', async () => {
  const ids = ['gpt-5.4', 'gpt-5-mini', 'gpt-4o', 'grok-4.1', 'mai-code-1', 'claude-sonnet-4.6'];
  const s = stub({ models: ids.map((id) => ({ id, capabilities: { type: 'chat' } })) });
  const connector = over(s);
  const models = await connector.models(access());
  expect(models.map((model) => [model.upstreamId, model.protocols])).toEqual([
    ['gpt-5.4', ['responses']],
    ['gpt-5-mini', ['chat']],
    ['gpt-4o', ['chat']],
    ['grok-4.1', ['responses']],
    ['mai-code-1', ['responses']],
    ['claude-sonnet-4.6', ['chat']],
  ]);
});

test('rule models-3: an entry whose capabilities.type is not chat is left out', async () => {
  const s = stub({ models: [
    { id: 'text-embedding-3-small', capabilities: { type: 'embeddings', limits: { max_inputs: 512 } } },
    { id: 'gpt-4o', capabilities: { type: 'chat' } },
  ] });
  const connector = over(s);
  expect((await connector.models(access())).map((model) => model.upstreamId)).toEqual(['gpt-4o']);
});

test('rule models-4: a disabled policy is left out while picker=false is kept', async () => {
  const s = stub({ models: [
    { id: 'gpt-4o-disabled', model_picker_enabled: true, policy: { state: 'disabled' } },
    { id: 'utility', model_picker_enabled: false, policy: { state: 'enabled' } },
  ] });
  const connector = over(s);
  expect((await connector.models(access())).map((model) => model.upstreamId)).toEqual(['utility']);
});

test('rule models-5: a model naming none of the three interfaces keeps an empty protocol list', async () => {
  const s = stub({ models: [{ id: 'images', supported_endpoints: ['/images/generations'] }] });
  const connector = over(s);
  expect((await connector.models(access()))[0]?.protocols).toEqual([]);
});

test('rule models-6: a 401 on the model list reports the status, stores nothing and no token', async () => {
  const s = stub({ modelsStatus: 401 });
  const connector = over(s);
  const provider = access();
  try {
    await connector.models(provider);
    throw new Error('expected a failure');
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamFailure);
    expect((error as UpstreamFailure).status).toBe(401);
    expect((error as Error).message).toContain('stub model list failure');
    expect((error as Error).message).not.toContain(TOKEN);
  }
  expect(provider.saved).toEqual([]);
});

// #endregion

// #region Target rules

interface TargetCase {
  label: string;
  protocols: Protocol[];
  inbound: Protocol;
  path: string;
  protocol: Protocol;
}

const TARGET_CASES: TargetCase[] = [];
for (const inbound of ['chat', 'responses', 'messages'] as const) {
  TARGET_CASES.push({
    label: 'chat-only', protocols: ['chat'], inbound, path: '/chat/completions', protocol: 'chat',
  });
  TARGET_CASES.push({
    label: 'responses-only', protocols: ['responses'], inbound, path: '/responses', protocol: 'responses',
  });
  TARGET_CASES.push({
    label: 'messages-only', protocols: ['messages'], inbound, path: '/v1/messages',
    protocol: 'messages',
  });
  TARGET_CASES.push({
    label: 'multi-protocol',
    protocols: ['responses', 'chat', 'messages'],
    inbound,
    path: { chat: '/chat/completions', responses: '/responses', messages: '/v1/messages' }[inbound],
    protocol: inbound,
  });
}

for (const row of TARGET_CASES) {
  test(`rule target: a ${row.label} model and a ${row.inbound} client go to ${row.path}`, async () => {
    const s = stub();
    const connector = over(s);
    const target = await connector.target(
      access({ apiBase: s.base, protocols: row.protocols }), 'gpt-5.4', row.inbound,
    );
    expect(target.url).toBe(`${s.base}${row.path}`);
    expect(target.protocol).toBe(row.protocol);
  });
}

test('rule target: a model the list said nothing about follows the chat fallback', async () => {
  const s = stub();
  const connector = over(s);
  expect((await connector.target(access({ apiBase: s.base }), 'gpt-5.4', 'messages')).protocol)
    .toBe('chat');
});

test('rule target: a missing credential fails instead of sending an empty bearer', async () => {
  const connector = over(stub());
  await expect(connector.target(access({ credential: null }), 'gpt-5.4', 'chat'))
    .rejects.toMatchObject({ message: 'GitHub Copilot sign-in required', status: null });
  await expect(connector.target(access({ credential: '{"accessToken":""}' }), 'gpt-5.4', 'chat'))
    .rejects.toBeInstanceOf(UpstreamFailure);
});

// #endregion

// #region Rejection rule

/** A target presenting `token`, as the request that got the 401 carried it. */
function refusedTarget(token: string): UpstreamTarget {
  return {
    url: 'https://api.githubcopilot.com/chat/completions',
    headers: { Authorization: `Bearer ${token}` },
    protocol: 'chat',
  };
}

test('rule rejected: a 401 for the stored token marks the credential and renews nothing', () => {
  const connector = over(stub());
  const provider = access();
  connector.rejected!(provider, refusedTarget(TOKEN));
  expect(provider.rejections).toBe(1);
  expect(provider.saved).toEqual([]);
  expect(provider.renewals).toBe(0);
});

test('rule rejected: a 401 for a token that is no longer stored changes nothing', () => {
  const connector = over(stub());
  const provider = access();
  // The administrator signed in again while the old token's request was in flight.
  provider.saveCredential(JSON.stringify({ accessToken: 'gho_new_token', apiBase: null }));
  connector.rejected!(provider, refusedTarget(TOKEN));
  expect(provider.rejections).toBe(0);
  expect(provider.saved).toHaveLength(1);
});

// #endregion

// #region Hosts rule

test('rule hosts-1: the default instance asks GitHub’s published endpoints', async () => {
  expect(copilot).toMatchObject({
    id: 'copilot',
    name: 'GitHub Copilot',
    credential: 'login',
    defaultBaseUrl: 'https://api.githubcopilot.com',
  });
  const seen: string[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    seen.push(String(input));
    return Response.json({ error: 'untouched' }, { status: 400 });
  }) as typeof fetch;
  await expect(copilot.login.start(fetcher)).rejects.toBeInstanceOf(Error);
  const code: DeviceCode = {
    userCode: 'TEST-CODE',
    verificationUri: 'https://github.com/login/device',
    verificationUriComplete: null,
    expiresAt: new Date(Date.now() + 600_000),
    interval: 5,
    secret: DEVICE_CODE,
  };
  await copilot.login.poll(code, fetcher);
  expect(seen).toEqual([
    'https://github.com/login/device/code',
    'https://github.com/login/oauth/access_token',
  ]);
});

// #endregion

// #region The whole path through the gateway

interface Fixture {
  app: GatewayApp;
  stub: CopilotStub;
  providers: ProviderStore;
  providerId: string;
  key: string;
  admin(pathname: string, init?: RequestInit): Promise<Response>;
  call(pathname: string, init?: RequestInit): Promise<Response>;
}

function setup(options: CopilotStubOptions = {}, outgoing: typeof fetch = fetch): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-copilot-'));
  dirs.push(dir);
  const s = stub({ models: [CHAT_MODEL], ...options });
  const connector = over(s);
  const db = openGatewayDatabase(dir);
  const app = createApp({
    db,
    webDistDir: path.join(dir, 'web'),
    fetch: outgoing,
    now: () => NOW,
    connector: (id) => (id === connector.id ? connector : null),
    connectors: () => [connector],
    adminToken: ADMIN,
  });
  apps.push(app);
  const providers = new ProviderStore(db);
  const provider = providers.create({
    name: 'Copilot',
    connector: connector.id,
    baseUrl: null,
    credential: null,
    autoPublish: false,
  }, NOW);
  const key = new KeyStore(db).create({ name: 'client' }, NOW).token;
  return {
    app,
    stub: s,
    providers,
    providerId: provider.id,
    key,
    admin: (pathname, init = {}) => app.handle(new Request(`http://gateway${pathname}`, {
      ...init,
      headers: { ...ADMIN_HEADER, ...init.headers },
    })),
    call: (pathname, init) => app.handle(new Request(`http://gateway${pathname}`, init)),
  };
}

async function until(what: string, condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1);
  }
}

/** Start a login over the management route and wait until the credential is stored. */
async function signIn(f: Fixture): Promise<void> {
  const started = await f.admin(`/api/gateway/providers/${f.providerId}/login`, { method: 'POST' });
  expect(started.status).toBe(201);
  await until('the login to store a credential', () => f.providers.credential(f.providerId) !== null);
}

/** Refresh the provider's model list and publish one of its models. */
async function refreshAndPublish(f: Fixture, upstreamId: string): Promise<void> {
  const refreshed = await f.admin(`/api/gateway/providers/${f.providerId}/refresh`, {
    method: 'POST',
  });
  expect(refreshed.status).toBe(200);
  const published = await f.admin(`/api/gateway/providers/${f.providerId}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upstreamId }),
  });
  expect(published.status).toBe(201);
}

function chatRequest(f: Fixture, model: string): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${f.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  };
}

test('rule e2e: login, refresh, publish and chat reach the stub, and a 401 rejects the credential',
  async () => {
  const hosts: string[] = [];
  const realFetch = globalThis.fetch;
  const recording = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    hosts.push(new URL(String(input)).hostname);
    return realFetch(input, init);
  }) as typeof fetch;
  const spy = spyOn(globalThis, 'fetch').mockImplementation(recording);
  const f = setup({}, recording);
  try {
    await signIn(f);
    await refreshAndPublish(f, 'gpt-5.4');

    const answered = await f.call('/v1/chat/completions', chatRequest(f, 'gpt-5.4'));
    expect(answered.status).toBe(200);
    expect((await answered.json() as { choices: Array<{ message: { content: string } }> })
      .choices[0].message.content).toBe('served');

    const sent = f.stub.requestsTo('/chat/completions');
    expect(sent).toHaveLength(1);
    expect(managedHeaders(sent[0]!.headers)).toEqual({
      ...CLIENT_HEADERS,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ model: 'gpt-5.4' });
    // Nothing left for github.com or api.githubcopilot.com: the stub is the only host given.
    expect([...new Set(hosts)]).toEqual(['127.0.0.1']);

    f.stub.inferenceStatus = 401;
    const refused = await f.call('/v1/chat/completions', chatRequest(f, 'gpt-5.4'));
    // The one route is gone after the 401; what is left is the upstream's own failure.
    expect(refused.status).toBe(502);
    const listed = await f.admin('/api/gateway/providers');
    const body = await listed.json() as {
      providers: Array<{ id: string; credentialRejected: boolean }>;
    };
    expect(body.providers.find((provider) => provider.id === f.providerId)?.credentialRejected)
      .toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test('rule e2e: no response and no console line carries the token or the device code', async () => {
  const f = setup();
  const logged: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(' '));
    }));
  const bodies: string[] = [];
  const read = async (response: Response): Promise<Response> => {
    bodies.push(await response.clone().text());
    return response;
  };
  try {
    const started = await read(await f.admin(`/api/gateway/providers/${f.providerId}/login`, {
      method: 'POST',
    }));
    expect(started.status).toBe(201);
    await until('the login to store a credential', () => f.providers.credential(f.providerId) !== null);
    await read(await f.admin(`/api/gateway/providers/${f.providerId}/login`));
    await read(await f.admin(`/api/gateway/providers/${f.providerId}/refresh`, { method: 'POST' }));
    await read(await f.admin('/api/gateway/providers'));
    await read(await f.call('/v1/chat/completions', chatRequest(f, 'gpt-5.4')));

    const everything = [...bodies, ...logged].join('\n');
    for (const secret of [TOKEN, DEVICE_CODE]) {
      expect([secret, everything.includes(secret)]).toEqual([secret, false]);
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

// #endregion
