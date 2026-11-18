// Stub-backed tests for the Grok connector (the subscription OAuth path, docs §10). Rules, one
// per test: G1 the device login, G2 renewal with a rotating refresh token, G3 the mark a 401
// leaves, G4 the proxy header set, G5 the inference address, G6 the model list, G7 the protocol
// and path a request takes, G8 one flow through the real gateway, G9 no secret escapes.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type GatewayApp } from '../app';
import { providerAccess } from '../connectors/access';
import type { ProviderAccess, UpstreamTarget } from '../connectors/connector';
import { UpstreamFailure } from '../connectors/connector';
import {
  CLIENT_VERSION, FALLBACK_LIFETIME_S, PROXY_BASE, grokConnector, readGrokCredential,
  type GrokCredential,
} from '../connectors/grok';
import { CredentialRenewals, LoginExpired } from '../connectors/tokens';
import { openGatewayDatabase } from '../database';
import { KeyStore } from '../keyStore';
import type { Protocol } from '../protocols/protocol';
import type { ProviderModelInput, ProviderRecord } from '../providerStore';
import { ProviderStore } from '../providerStore';
import { migrate } from '../schema';
import { GrokAuthorizationServer, jwtOf } from '../testing/grokAuthorizationServer';
import type { GrokAuthorizationOptions } from '../testing/grokAuthorizationServer';
import { GrokUpstream } from '../testing/grokUpstream';
import type { GrokUpstreamOptions } from '../testing/grokUpstream';

const NOW = new Date('2026-01-01T00:00:00Z');
const ADMIN = 'admin-token-0123456789';
const ADMIN_HEADER = { authorization: `Bearer ${ADMIN}` };
const NO_PRICE = { input: null, output: null, cacheRead: null };
/** An authorization server that is never asked: a request that renews nothing contacts no host. */
const NO_AUTH = 'http://127.0.0.1:9';

const servers: Array<{ close(): void }> = [];
const databases: Database[] = [];
const dirs: string[] = [];
const apps: GatewayApp[] = [];
const realFetch = globalThis.fetch;
/** Hosts every fetch in a test reached; the guard refuses anything but the loopback stubs. */
const hosts: string[] = [];

// No test may reach the real auth.x.ai, grok.com or x.ai: the guard throws before one leaves.
beforeEach(() => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    hosts.push(url.hostname);
    if (url.hostname !== '127.0.0.1') throw new Error(`a test must not reach ${url.hostname}`);
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const server of servers.splice(0)) server.close();
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = realFetch;
  for (const host of hosts.splice(0)) expect(host).toBe('127.0.0.1');
});

function oauthServer(options: GrokAuthorizationOptions = {}): GrokAuthorizationServer {
  const server = new GrokAuthorizationServer(options);
  servers.push(server);
  return server;
}

function upstream(options: GrokUpstreamOptions = {}): GrokUpstream {
  const server = new GrokUpstream(options);
  servers.push(server);
  return server;
}

interface Clock {
  now: Date;
}

/** A connector whose authorization server is a stub, or none when the test renews nothing. */
function connector(authBase: string = NO_AUTH, clock: Clock = { now: NOW }) {
  return grokConnector({ authBase, now: () => clock.now });
}

/** The credential a stored text holds; `stored` writes one with these fields. */
function stored(overrides: Partial<GrokCredential> = {}): string {
  return JSON.stringify({
    accessToken: 'access-old',
    refreshToken: 'refresh-token-0001',
    expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
    userId: 'user-123',
    email: 'grok@example.test',
    ...overrides,
  } satisfies GrokCredential);
}

let providerCount = 0;

interface Fixture {
  providers: ProviderStore;
  provider: ProviderRecord;
  renewals: CredentialRenewals;
  /** A view of the provider as one request builds it: the credential as stored right now. */
  access(): ProviderAccess;
}

function fixture(
  credential: string | null,
  options: {
    baseUrl?: string | null;
    models?: Array<Pick<ProviderModelInput, 'upstreamId' | 'protocols'>>;
  } = {},
): Fixture {
  const db = new Database(':memory:');
  databases.push(db);
  migrate(db);
  const providers = new ProviderStore(db);
  const renewals = new CredentialRenewals();
  providerCount += 1;
  const provider = providers.create({
    name: `grok-${providerCount}`,
    connector: 'grok',
    baseUrl: options.baseUrl === undefined ? null : options.baseUrl,
    credential,
    autoPublish: false,
  }, NOW);
  if (options.models !== undefined) {
    providers.replaceModels(provider.id, options.models.map((model) => ({
      upstreamId: model.upstreamId,
      contextLength: null,
      maxOutputTokens: null,
      price: { ...NO_PRICE },
      protocols: model.protocols,
    })), NOW);
  }
  return {
    providers,
    provider,
    renewals,
    access: () => providerAccess(providers, providers.get(provider.id)!, renewals),
  };
}

/** The stored credential text of a fixture's provider. */
function credentialOf(f: Fixture): GrokCredential | null {
  return readGrokCredential(f.providers.credential(f.provider.id));
}

// G1: the device login.

test('rule G1: the device request carries the client id, the scope and the gateway referrer', async () => {
  const server = oauthServer();
  await connector(server.base).login.start(fetch);
  const request = server.requests.find((entry) => entry.path === '/device');
  expect(request?.form).toEqual({
    client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
    scope: 'openid profile email offline_access grok-cli:access api:access',
    referrer: 'aihub-gateway',
  });
});

test('rule G1: a pending poll becomes a granted credential', async () => {
  const server = oauthServer({ steps: ['pending', 'grant'], identity: { sub: 'user-123' } });
  const login = connector(server.base).login;
  const code = await login.start(fetch);
  expect(await login.poll(code, fetch)).toEqual({ status: 'pending' });
  const polled = await login.poll(code, fetch);
  expect(polled.status).toBe('granted');
});

test('rule G1: the stored credential holds both tokens, the expiry and the user id', async () => {
  const server = oauthServer({
    steps: ['grant'], tokenLifetime: 3600,
    identity: { sub: 'user-123', email: 'grok@example.test' },
  });
  const login = connector(server.base).login;
  const polled = await login.poll(await login.start(fetch), fetch);
  if (polled.status !== 'granted') throw new Error(polled.status);
  expect(readGrokCredential(polled.credential)).toEqual({
    accessToken: server.accessToken,
    refreshToken: server.refreshToken,
    expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
    userId: 'user-123',
    email: 'grok@example.test',
  });
});

test('rule G1: expires_in fixes the access token expiry', async () => {
  const server = oauthServer({ steps: ['grant'], tokenLifetime: 900 });
  const login = connector(server.base).login;
  const polled = await login.poll(await login.start(fetch), fetch);
  if (polled.status !== 'granted') throw new Error(polled.status);
  expect(readGrokCredential(polled.credential)?.expiresAt)
    .toBe(new Date(NOW.getTime() + 900_000).toISOString());
  expect(server.tokenRequests()).toHaveLength(1);
});

test('rule G1: without expires_in the expiry is the access token exp claim', async () => {
  const exp = Math.floor(NOW.getTime() / 1000) + 1800;
  const server = oauthServer({
    steps: ['grant'], omitExpiresIn: true, accessToken: jwtOf({ sub: 'user-9', exp }),
  });
  const login = connector(server.base).login;
  const polled = await login.poll(await login.start(fetch), fetch);
  if (polled.status !== 'granted') throw new Error(polled.status);
  const credential = readGrokCredential(polled.credential);
  expect(credential?.expiresAt).toBe(new Date(exp * 1000).toISOString());
  expect(credential?.userId).toBe('user-9');
});

test('rule G1: without expires_in and without a JWT exp the one-hour fallback applies', async () => {
  const server = oauthServer({ steps: ['grant'], omitExpiresIn: true, accessToken: 'opaque-token' });
  const login = connector(server.base).login;
  const polled = await login.poll(await login.start(fetch), fetch);
  if (polled.status !== 'granted') throw new Error(polled.status);
  expect(readGrokCredential(polled.credential)?.expiresAt)
    .toBe(new Date(NOW.getTime() + FALLBACK_LIFETIME_S * 1000).toISOString());
});

// G2: renewal.

test('rule G2: a credential outside its last five minutes spends no refresh token', async () => {
  const f = fixture(stored({ expiresAt: new Date(NOW.getTime() + 301_000).toISOString() }));
  const target = await connector().target(f.access(), 'grok-4.6', 'chat');
  expect(hosts).toEqual([]);
  expect(target.headers.Authorization).toBe('Bearer access-old');
});

test('rule G2: a due credential is renewed once and the renewed token is used', async () => {
  const server = oauthServer({ tokenLifetime: 3600 });
  const f = fixture(stored({ expiresAt: NOW.toISOString() }));
  const target = await connector(server.base).target(f.access(), 'grok-4.6', 'chat');
  expect(server.tokenRequests().map((request) => request.form.grant_type)).toEqual(['refresh_token']);
  expect(target.headers.Authorization).toBe(`Bearer ${server.accessToken}`);
  expect(credentialOf(f)).toMatchObject({
    accessToken: server.accessToken,
    refreshToken: server.refreshToken,
  });
});

test('rule G2: the next renewal sends the token the previous one stored', async () => {
  const clock: Clock = { now: NOW };
  const server = oauthServer({ tokenLifetime: 3600 });
  const f = fixture(stored({ expiresAt: NOW.toISOString() }));
  const grok = connector(server.base, clock);
  await grok.target(f.access(), 'grok-4.6', 'chat');
  clock.now = new Date(NOW.getTime() + 3600_000 + 1_000);
  await grok.target(f.access(), 'grok-4.6', 'chat');
  expect(server.tokenRequests().map((request) => request.form.refresh_token))
    .toEqual(['refresh-token-0001', 'refresh-token-0002']);
});

test('rule G2: a refresh answer without a refresh token keeps the old one', async () => {
  const server = oauthServer({ tokenLifetime: 3600, omitRefreshToken: true });
  const f = fixture(stored({ expiresAt: NOW.toISOString() }));
  const target = await connector(server.base).target(f.access(), 'grok-4.6', 'chat');
  expect(target.headers.Authorization).toBe(`Bearer ${server.accessToken}`);
  expect(credentialOf(f)).toMatchObject({
    accessToken: server.accessToken,
    refreshToken: 'refresh-token-0001',
  });
});

test('rule G2: invalid_grant means the login is gone', async () => {
  const server = oauthServer();
  const f = fixture(stored({ refreshToken: 'never-issued', expiresAt: NOW.toISOString() }));
  await expect(connector(server.base).target(f.access(), 'grok-4.6', 'chat'))
    .rejects.toBeInstanceOf(LoginExpired);
});

test('rule G2: a 5xx refresh rejects the route and changes no credential', async () => {
  const server = oauthServer({ refreshStatus: 503 });
  const original = stored({ expiresAt: NOW.toISOString() });
  const f = fixture(original);
  await expect(connector(server.base).target(f.access(), 'grok-4.6', 'chat'))
    .rejects.toMatchObject({ status: 503 });
  expect(f.providers.credential(f.provider.id)).toBe(original);
});

test('rule G2: twenty concurrent requests spend one refresh token', async () => {
  const server = oauthServer({ tokenLifetime: 0 });
  const f = fixture(stored({ expiresAt: NOW.toISOString() }));
  const grok = connector(server.base);
  const targets = await Promise.all(Array.from({ length: 20 }, () =>
    grok.target(f.access(), 'grok-4.6', 'chat')));
  expect(server.refreshes).toBe(1);
  expect(server.tokenRequests().map((request) => request.form.grant_type)).toEqual(['refresh_token']);
  expect(new Set(targets.map((target) => target.headers.Authorization)).size).toBe(1);
  expect(credentialOf(f)).toMatchObject({
    accessToken: server.accessToken,
    refreshToken: server.refreshToken,
  });
});

// G3: the mark a 401 leaves.

test('rule G3: the first 401 makes the next request renew', async () => {
  const server = oauthServer({ tokenLifetime: 3600 });
  const f = fixture(stored());
  const grok = connector(server.base);
  const a = f.access();
  grok.rejected?.(a, await grok.target(a, 'grok-4.6', 'chat'));
  expect(f.providers.get(f.provider.id)?.credentialRejected).toBe(false);
  const target = await grok.target(f.access(), 'grok-4.6', 'chat');
  expect(server.refreshes).toBe(1);
  expect(target.headers.Authorization).toBe(`Bearer ${server.accessToken}`);
});

test('rule G3: a 401 for an older token changes nothing', async () => {
  const f = fixture(stored({ accessToken: 'access-new', refreshToken: 'refresh-token-0002' }));
  const before = f.providers.credential(f.provider.id);
  const older: UpstreamTarget = {
    url: `${PROXY_BASE}/chat/completions`,
    headers: { Authorization: 'Bearer access-old' },
    protocol: 'chat',
  };
  connector().rejected?.(f.access(), older);
  expect(f.providers.credential(f.provider.id)).toBe(before);
  expect(f.providers.get(f.provider.id)?.credentialRejected).toBe(false);
});

test('rule G3: a credential with no refresh token is marked rejected', async () => {
  const f = fixture('{"accessToken":"only-a-token"}');
  const refused: UpstreamTarget = {
    url: `${PROXY_BASE}/chat/completions`,
    headers: { Authorization: 'Bearer only-a-token' },
    protocol: 'chat',
  };
  connector().rejected?.(f.access(), refused);
  expect(f.providers.get(f.provider.id)?.credentialRejected).toBe(true);
});

test('rule G3: a 401 on a token from a forced renewal rejects it and asks for no refresh', async () => {
  const server = oauthServer({ tokenLifetime: 3600 });
  const f = fixture(stored({ renewal: 'forced' }));
  const grok = connector(server.base);
  const a = f.access();
  grok.rejected?.(a, await grok.target(a, 'grok-4.6', 'chat'));
  expect(f.providers.get(f.provider.id)?.credentialRejected).toBe(true);
  expect(server.tokenRequests()).toEqual([]);
  expect(credentialOf(f)?.renewal).toBe('forced');
});

test('rule G3: a forced renewal the proxy refuses too rejects instead of renewing forever', async () => {
  const server = oauthServer({ tokenLifetime: 3600 });
  const f = fixture(stored());
  const grok = connector(server.base);
  // The first 401 marks the stored token; the next request renews because of that mark.
  const a = f.access();
  grok.rejected?.(a, await grok.target(a, 'grok-4.6', 'chat'));
  const b = f.access();
  const renewed = await grok.target(b, 'grok-4.6', 'chat');
  expect(server.refreshes).toBe(1);
  expect(credentialOf(f)?.renewal).toBe('forced');
  // The proxy refuses the token that renewal minted: another renewal would just mint another.
  grok.rejected?.(b, renewed);
  expect(f.providers.get(f.provider.id)?.credentialRejected).toBe(true);
  expect(server.refreshes).toBe(1);
});

test('rule G3: a token a timed renewal minted renews again on a 401 instead of being rejected', async () => {
  const server = oauthServer({ tokenLifetime: 3600 });
  const f = fixture(stored({ expiresAt: NOW.toISOString() }));
  const grok = connector(server.base);
  await grok.target(f.access(), 'grok-4.6', 'chat');
  expect(server.refreshes).toBe(1);
  expect(credentialOf(f)?.renewal).toBeUndefined();
  const b = f.access();
  grok.rejected?.(b, await grok.target(b, 'grok-4.6', 'chat'));
  expect(f.providers.get(f.provider.id)?.credentialRejected).toBe(false);
  expect(credentialOf(f)?.renewal).toBe('refused');
  await grok.target(f.access(), 'grok-4.6', 'chat');
  expect(server.refreshes).toBe(2);
});

test('rule G3: twenty concurrent 401s for one token are followed by one renewal', async () => {
  const server = oauthServer({ tokenLifetime: 3600 });
  const f = fixture(stored());
  const grok = connector(server.base);
  const views = Array.from({ length: 20 }, () => f.access());
  const targets = await Promise.all(views.map((view) => grok.target(view, 'grok-4.6', 'chat')));
  for (const [index, view] of views.entries()) grok.rejected?.(view, targets[index]!);
  const renewed = await Promise.all(views.map(() => grok.target(f.access(), 'grok-4.6', 'chat')));
  expect(server.refreshes).toBe(1);
  expect(new Set(renewed.map((target) => target.headers.Authorization)).size).toBe(1);
});

test('rule G3: a late 401 for a token another request already renewed leaves the login intact', async () => {
  const server = oauthServer({ tokenLifetime: 3600 });
  const f = fixture(stored());
  const grok = connector(server.base);
  // A and B are both sent with the stored pair; each request read the credential when it began.
  const a = f.access();
  const b = f.access();
  const targetA = await grok.target(a, 'grok-4.6', 'chat');
  const targetB = await grok.target(b, 'grok-4.6', 'chat');
  // A's 401 makes the stored token count as expired.
  grok.rejected?.(a, targetA);
  // C arrives, finds it due and renews: the store now holds a new pair and the old refresh token
  // has been spent by the authorization server.
  await grok.target(f.access(), 'grok-4.6', 'chat');
  expect(server.refreshes).toBe(1);
  // B's 401 arrives late, for the token A's 401 already replaced.
  grok.rejected?.(b, targetB);
  expect(credentialOf(f)?.refreshToken).toBe(server.refreshToken);
  // The next request still has a working login: no invalid_grant, no sign-in prompt.
  const next = await grok.target(f.access(), 'grok-4.6', 'chat');
  expect(next.headers.Authorization).toBe(`Bearer ${server.accessToken}`);
});

// G4: the proxy header set.

const BASE_HEADERS = {
  'X-XAI-Token-Auth': 'xai-grok-cli',
  'x-grok-client-version': CLIENT_VERSION,
  'x-grok-client-identifier': 'grok-shell',
  'x-authenticateresponse': 'authenticate-response',
  'x-grok-client-mode': 'interactive',
  'User-Agent': `xai-grok-workspace/${CLIENT_VERSION}`,
};

/**
 * The model list's headers, exactly what Grok Build sends there (remote/model_source/oai.rs):
 * no client-identifier and no authenticate-response marker. Lower case, as the wire reports them.
 */
const MODEL_LIST_HEADERS: Record<string, string> = {
  authorization: 'Bearer access-old',
  'x-xai-token-auth': 'xai-grok-cli',
  'x-grok-client-version': CLIENT_VERSION,
  'x-grok-client-mode': 'interactive',
  'user-agent': `xai-grok-workspace/${CLIENT_VERSION}`,
  'x-userid': 'user-123',
  'x-email': 'grok@example.test',
};

/** What fetch adds itself; every other header on the wire is the connector's. */
const TRANSPORT_HEADERS = new Set(['accept', 'accept-encoding', 'connection', 'host', 'content-length']);

/** The headers of a recorded request without the transport layer's own. */
function sentHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers].filter(([name]) => !TRANSPORT_HEADERS.has(name)));
}

test('rule G4: an inference target carries the header set and the token in no other header', async () => {
  const f = fixture(stored());
  const target = await connector().target(f.access(), 'grok-4.6', 'chat');
  expect(target.headers).toEqual({ Authorization: 'Bearer access-old', ...BASE_HEADERS });
  const carrying = Object.entries(target.headers)
    .filter(([, value]) => value.includes('access-old'))
    .map(([name]) => name);
  expect(carrying).toEqual(['Authorization']);
});

test('rule G4: the model list carries exactly its own header set, not the inference markers', async () => {
  const server = upstream({ models: [] });
  const f = fixture(stored(), { baseUrl: server.base });
  const grok = connector(server.base);
  const target = await grok.target(f.access(), 'grok-4.6', 'chat');
  expect(target.headers['x-userid']).toBeUndefined();
  expect(target.headers['x-email']).toBeUndefined();
  await grok.models(f.access());
  expect(sentHeaders(server.on('/models')[0]!.headers)).toEqual(MODEL_LIST_HEADERS);
});

test('rule G4: the model list sends no x-email when the credential holds none', async () => {
  const server = upstream({ models: [] });
  const f = fixture(stored({ email: null }), { baseUrl: server.base });
  await connector(server.base).models(f.access());
  const expected = { ...MODEL_LIST_HEADERS };
  delete expected['x-email'];
  expect(sentHeaders(server.on('/models')[0]!.headers)).toEqual(expected);
});

test('rule G4: the client version is at least the 1.0.13 the proxy requires', () => {
  const atLeast = (got: string, floor: string): boolean => {
    const left = got.split('.').map(Number);
    const right = floor.split('.').map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const mine = left[index] ?? 0;
      const theirs = right[index] ?? 0;
      if (mine !== theirs) return mine > theirs;
    }
    return true;
  };
  expect(atLeast(CLIENT_VERSION, '1.0.13')).toBe(true);
  // Numeric, not textual: 1.0.9 is older than 1.0.13 but sorts after it as text.
  expect(atLeast('1.0.9', '1.0.13')).toBe(false);
});

// G5: the inference address.

test('rule G5: a provider without an address uses the CLI chat proxy', async () => {
  const f = fixture(stored(), { models: [{ upstreamId: 'grok-4.6', protocols: ['responses'] }] });
  const target = await connector().target(f.access(), 'grok-4.6', 'responses');
  expect(connector().defaultBaseUrl).toBe(PROXY_BASE);
  expect(target.url).toBe(`${PROXY_BASE}/responses`);
});

test('rule G5: the address the administrator gave wins', async () => {
  const server = upstream({ models: [] });
  const f = fixture(stored(), {
    baseUrl: `${server.base}///`,
    models: [{ upstreamId: 'grok-4.6', protocols: ['messages'] }],
  });
  const grok = connector(server.base);
  expect((await grok.target(f.access(), 'grok-4.6', 'messages')).url).toBe(`${server.base}/messages`);
  await grok.models(f.access());
  expect(server.on('/models')).toHaveLength(1);
});

// G6: the model list.

const MODEL_LIST = [
  {
    id: 'grok-4.6', model: 'grok-4.6', context_window: 500000, api_backend: 'responses',
    max_completion_tokens: 64000,
  },
  { id: 'grok-4.5', model: 'grok-4.5', context_window: 500000, api_backend: 'responses' },
  {
    id: 'grok-code-fast-1', model: 'grok-code-fast-1', context_window: 256000,
    api_backend: 'chat_completions',
  },
  { id: 'grok-opus', model: 'grok-opus', context_window: 200000, api_backend: 'messages' },
];

test('rule G6: a realistic list maps ids, limits and the protocol each entry names', async () => {
  const f = fixture(stored(), { baseUrl: upstream({ models: MODEL_LIST }).base });
  expect(await connector().models(f.access())).toEqual([
    {
      upstreamId: 'grok-4.6', contextLength: 500000, maxOutputTokens: 64000,
      price: { ...NO_PRICE }, protocols: ['responses'],
    },
    {
      upstreamId: 'grok-4.5', contextLength: 500000, maxOutputTokens: null,
      price: { ...NO_PRICE }, protocols: ['responses'],
    },
    {
      upstreamId: 'grok-code-fast-1', contextLength: 256000, maxOutputTokens: null,
      price: { ...NO_PRICE }, protocols: ['chat'],
    },
    {
      upstreamId: 'grok-opus', contextLength: 200000, maxOutputTokens: null,
      price: { ...NO_PRICE }, protocols: ['messages'],
    },
  ]);
});

test('rule G6: an entry without api_backend and without limits leaves them unknown', async () => {
  const f = fixture(stored(), { baseUrl: upstream({ models: [{ id: 'grok-3', model: 'grok-3' }] }).base });
  expect(await connector().models(f.access())).toEqual([{
    upstreamId: 'grok-3', contextLength: null, maxOutputTokens: null,
    price: { ...NO_PRICE }, protocols: null,
  }]);
});

test('rule G6: an entry the official client cannot name is the only one skipped', async () => {
  const f = fixture(stored(), {
    baseUrl: upstream({ models: [
      {}, { id: 7 }, null, { model: 'from-model' }, { modelId: 'from-model-id' }, { id: 'from-id' },
      { _meta: { model: 'from-meta' } },
    ] }).base,
  });
  expect((await connector().models(f.access())).map((model) => model.upstreamId))
    .toEqual(['from-model', 'from-model-id', 'from-id', 'from-meta']);
});

test('rule G6: a 426 names the client version this gateway sent', async () => {
  const f = fixture(stored(), { baseUrl: upstream({ modelsStatus: 426 }).base });
  try {
    await connector().models(f.access());
    throw new Error('the model list should have failed');
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamFailure);
    expect((error as UpstreamFailure).status).toBe(426);
    const message = (error as Error).message;
    expect(message).toContain(CLIENT_VERSION);
    expect(message).toContain('426');
    expect(message.toLowerCase()).toContain('no longer accepts');
  }
});

test('rule G6: a 401 fails the list and its message carries no token', async () => {
  const server = upstream({
    modelsStatus: 401,
    errorBody: { error: 'Invalid or expired credentials (access-old)' },
  });
  const f = fixture(stored(), { baseUrl: server.base });
  try {
    await connector().models(f.access());
    throw new Error('the model list should have failed');
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamFailure);
    expect((error as UpstreamFailure).status).toBe(401);
    expect((error as Error).message).toContain('[redacted]');
    expect((error as Error).message).not.toContain('access-old');
  }
});

// G7: the protocol and path a request takes.

const TARGET_ROWS: Array<{
  model: string;
  protocols: Protocol[] | null;
  inbound: Protocol;
  path: string;
  protocol: Protocol;
}> = [
  { model: 'chat-model', protocols: ['chat'], inbound: 'chat', path: '/chat/completions', protocol: 'chat' },
  {
    model: 'chat-model', protocols: ['chat'], inbound: 'responses', path: '/chat/completions',
    protocol: 'chat',
  },
  {
    model: 'chat-model', protocols: ['chat'], inbound: 'messages', path: '/chat/completions',
    protocol: 'chat',
  },
  {
    model: 'responses-model', protocols: ['responses'], inbound: 'chat', path: '/responses',
    protocol: 'responses',
  },
  {
    model: 'responses-model', protocols: ['responses'], inbound: 'responses', path: '/responses',
    protocol: 'responses',
  },
  {
    model: 'responses-model', protocols: ['responses'], inbound: 'messages', path: '/responses',
    protocol: 'responses',
  },
  {
    model: 'messages-model', protocols: ['messages'], inbound: 'chat', path: '/messages',
    protocol: 'messages',
  },
  {
    model: 'messages-model', protocols: ['messages'], inbound: 'responses', path: '/messages',
    protocol: 'messages',
  },
  {
    model: 'messages-model', protocols: ['messages'], inbound: 'messages', path: '/messages',
    protocol: 'messages',
  },
  { model: 'unnamed-model', protocols: null, inbound: 'chat', path: '/chat/completions', protocol: 'chat' },
  {
    model: 'unnamed-model', protocols: null, inbound: 'responses', path: '/chat/completions',
    protocol: 'chat',
  },
  {
    model: 'unnamed-model', protocols: null, inbound: 'messages', path: '/chat/completions',
    protocol: 'chat',
  },
];

for (const row of TARGET_ROWS) {
  test(`rule G7: ${row.model} asked as ${row.inbound} goes to ${row.path} in ${row.protocol}`, async () => {
    const f = fixture(stored(), {
      models: [{ upstreamId: row.model, protocols: row.protocols }],
    });
    const target = await connector().target(f.access(), row.model, row.inbound);
    expect(target.url).toBe(`${PROXY_BASE}${row.path}`);
    expect(target.protocol).toBe(row.protocol);
  });
}

// G8 and G9: the whole flow at the process boundary.

interface Flow {
  providers: ProviderStore;
  provider: ProviderRecord;
  oauth: GrokAuthorizationServer;
  upstream: GrokUpstream;
  clock: Clock;
  key: string;
  bodies: string[];
  admin(pathname: string, init?: RequestInit): Promise<Response>;
  call(pathname: string, init?: RequestInit): Promise<Response>;
}

function setupFlow(): Flow {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-gateway-'));
  dirs.push(dir);
  const clock: Clock = { now: NOW };
  const server = oauthServer({
    steps: ['pending', 'grant'], tokenLifetime: 3600,
    identity: { sub: 'user-123', email: 'grok@example.test' },
  });
  const proxy = upstream({ models: MODEL_LIST });
  const grok = grokConnector({ authBase: server.base, now: () => clock.now });
  const db = openGatewayDatabase(dir);
  const app = createApp({
    db,
    webDistDir: path.join(dir, 'web'),
    fetch,
    now: () => clock.now,
    connector: (id) => (id === 'grok' ? grok : null),
    connectors: () => [grok],
    adminToken: ADMIN,
  });
  apps.push(app);
  const providers = new ProviderStore(db);
  const provider = providers.create({
    name: 'grok', connector: 'grok', baseUrl: proxy.base, credential: null, autoPublish: false,
  }, NOW);
  const key = new KeyStore(db).create({ name: 'client' }, NOW).token;
  return {
    providers,
    provider,
    oauth: server,
    upstream: proxy,
    clock,
    key,
    bodies: [],
    admin: (pathname, init = {}) => app.handle(new Request(`http://gateway${pathname}`, {
      ...init, headers: { ...ADMIN_HEADER, ...init.headers },
    })),
    call: (pathname, init) => app.handle(new Request(`http://gateway${pathname}`, init)),
  };
}

/** Read a response's body for the secret check while leaving it readable to the caller. */
async function read(f: Flow, response: Response): Promise<Response> {
  f.bodies.push(await response.clone().text());
  return response;
}

async function until(what: string, condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1);
  }
}

/** One Responses request through the client API. */
function responsesRequest(f: Flow): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${f.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-4.6', input: 'hi' }),
  };
}

async function runFlow(f: Flow): Promise<void> {
  const id = f.provider.id;
  const started = await read(f, await f.admin(`/api/gateway/providers/${id}/login`, { method: 'POST' }));
  expect(started.status).toBe(201);
  expect(await started.clone().json()).toMatchObject({ login: { state: 'pending', userCode: 'TEST-CODE' } });
  await until('the login to store a credential', () => f.providers.credential(id) !== null);
  expect(await (await read(f, await f.admin(`/api/gateway/providers/${id}/login`))).json())
    .toEqual({ login: { state: 'done' } });

  const refreshed = await read(f, await f.admin(`/api/gateway/providers/${id}/refresh`, { method: 'POST' }));
  expect(refreshed.status).toBe(200);
  const listed = await refreshed.clone().json() as { models: Array<Record<string, unknown>> };
  // The store lists by upstream id, so 4.5 comes before 4.6.
  expect(listed.models.map((model) => model.upstreamId))
    .toEqual(['grok-4.5', 'grok-4.6', 'grok-code-fast-1', 'grok-opus']);
  expect(listed.models[1]).toMatchObject({
    upstreamId: 'grok-4.6', protocols: ['responses'], contextLength: 500000,
  });
  expect(f.oauth.refreshes).toBe(0);

  const published = await read(f, await f.admin(`/api/gateway/providers/${id}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upstreamId: 'grok-4.6' }),
  }));
  expect(published.status).toBe(201);

  const first = await read(f, await f.call('/v1/responses', responsesRequest(f)));
  expect(first.status).toBe(200);
  const sent = f.upstream.on('/responses');
  expect(sent).toHaveLength(1);
  expect(sent[0]?.headers.get('authorization')).toBe(`Bearer ${f.oauth.accessToken}`);
  expect(sent[0]?.headers.get('x-xai-token-auth')).toBe('xai-grok-cli');
  expect(sent[0]?.headers.get('x-grok-client-version')).toBe(CLIENT_VERSION);
  expect(sent[0]?.headers.get('x-userid')).toBeNull();
  expect(JSON.parse(sent[0]!.body)).toMatchObject({ model: 'grok-4.6' });

  // Past the access token's expiry the next request renews once and sends the new token.
  f.clock.now = new Date(NOW.getTime() + 2 * 3600_000);
  const second = await read(f, await f.call('/v1/responses', responsesRequest(f)));
  expect(second.status).toBe(200);
  expect(f.oauth.refreshes).toBe(1);
  expect(f.upstream.on('/responses')[1]?.headers.get('authorization'))
    .toBe(`Bearer ${f.oauth.accessToken}`);

  // The next renewal presents a refresh token the stub has already spent: the login is gone.
  f.providers.setCredential(id, JSON.stringify({
    accessToken: 'stale-access',
    refreshToken: 'refresh-token-0001',
    expiresAt: f.clock.now.toISOString(),
    userId: 'user-123',
    email: null,
  } satisfies GrokCredential));
  const refused = await read(f, await f.call('/v1/responses', responsesRequest(f)));
  expect(refused.status).toBe(502);
  expect(await refused.clone().json()).toEqual({
    error: {
      message: 'Provider login expired; sign in again',
      type: 'api_error',
      code: null,
      param: null,
    },
  });
  expect(f.oauth.refreshes).toBe(2);
  const answer = await read(f, await f.admin('/api/gateway/providers'));
  const providers = (await answer.clone().json() as { providers: ProviderRecord[] }).providers;
  expect(providers.find((provider) => provider.id === id)?.credentialRejected).toBe(true);
}

test('rule G8: login, publish and inference through the gateway, then renewal and refusal', async () => {
  const f = setupFlow();
  await runFlow(f);
  expect(new Set(hosts)).toEqual(new Set(['127.0.0.1']));
});

test('rule G9: no management answer and no console line carries a token or the device code', async () => {
  const f = setupFlow();
  const logged: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(' '));
    }));
  try {
    await runFlow(f);
    const everything = [...f.bodies, ...logged].join('\n');
    const secrets = [
      f.oauth.deviceCode, 'access-token-0001', 'access-token-0002', 'stale-access',
      'refresh-token-0001', 'refresh-token-0002',
    ];
    for (const secret of secrets) expect([secret, everything.includes(secret)]).toEqual([secret, false]);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
