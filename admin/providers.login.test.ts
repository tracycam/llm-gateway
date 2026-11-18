// The three login routes: starting a device-code login, reporting it, and signing out.
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Connector } from '../connectors/connector';
import { CredentialRenewals } from '../connectors/tokens';
import { KeyStore } from '../keyStore';
import { LoginSessions } from '../login';
import { ModelStore } from '../modelStore';
import { ProviderStore, type ProviderRecord } from '../providerStore';
import { migrate } from '../schema';
import { AuthorizationServer } from '../testing/authorizationServer';
import { fakeKeyConnector, fakeLoginConnector } from '../testing/loginConnector';
import { UsageStore } from '../usageStore';
import type { AdminDeps } from './deps';
import { handleProviderRoute } from './providers';
import { request } from './testing';

const NOW = new Date('2026-01-01T00:00:00Z');

const servers: AuthorizationServer[] = [];
const databases: Database[] = [];
const sessions: LoginSessions[] = [];
afterEach(() => {
  for (const logins of sessions.splice(0)) logins.close();
  for (const server of servers.splice(0)) server.close();
  for (const db of databases.splice(0)) db.close();
});

interface Fixture {
  deps: AdminDeps;
  providers: ProviderStore;
  server: AuthorizationServer;
  loginConnector: Connector;
  call(path: string, method?: string, body?: unknown): Promise<Response | null>;
}

/** A login that never polls: the routes are asserted while the session is pending. */
function setup(): Fixture {
  const server = new AuthorizationServer({ steps: ['pending'] });
  servers.push(server);
  const failed = new AuthorizationServer();
  servers.push(failed);
  const db = new Database(':memory:');
  databases.push(db);
  migrate(db);
  const providers = new ProviderStore(db);
  const keyConnector = fakeKeyConnector();
  const loginConnector = fakeLoginConnector({
    deviceEndpoint: server.deviceEndpoint,
    tokenEndpoint: server.tokenEndpoint,
    upstream: 'http://upstream.test',
    now: () => NOW,
  }).connector;
  const brokenConnector = fakeLoginConnector({
    id: 'broken-login',
    deviceEndpoint: `${failed.base}/nowhere`,
    tokenEndpoint: failed.tokenEndpoint,
    upstream: 'http://upstream.test',
    now: () => NOW,
  }).connector;
  const connectors = [loginConnector, brokenConnector, keyConnector];
  const find = (id: string) => connectors.find((connector) => connector.id === id) ?? null;
  const logins = new LoginSessions({
    providers, connector: find, fetch, now: () => NOW, wait: () => new Promise<void>(() => {}),
  });
  sessions.push(logins);
  const deps: AdminDeps = {
    providers,
    models: new ModelStore(db),
    keys: new KeyStore(db),
    usage: new UsageStore(db),
    logins,
    renewals: new CredentialRenewals(),
    connector: find,
    connectors: () => connectors,
    now: () => NOW,
  };
  return {
    deps, providers, server, loginConnector,
    call: (path, method = 'GET', body) => handleProviderRoute(request(path, method, body), deps),
  };
}

function addProvider(f: Fixture, connector = 'fake-login'): string {
  return f.providers.create({
    name: `provider ${connector}`, connector, baseUrl: null, credential: null, autoPublish: false,
  }, NOW).id;
}

test('rule A4: POST starts a login and answers 201 with the pending code', async () => {
  const f = setup();
  const id = addProvider(f);
  const response = await f.call(`/providers/${id}/login`, 'POST');
  expect(response?.status).toBe(201);
  const body = await response!.json();
  expect(body).toEqual({
    login: expect.objectContaining({
      state: 'pending', userCode: 'TEST-CODE', verificationUri: 'https://example.test/device',
      interval: 0,
    }),
  });
  expect(JSON.stringify(body)).not.toContain(f.server.deviceCode);
  const shown = await f.call(`/providers/${id}/login`);
  expect(shown?.status).toBe(200);
  expect(await shown!.json()).toEqual(body);
});

test('rule A4: a connector that does not log in is refused with 400', async () => {
  const f = setup();
  const id = addProvider(f, 'fake-key');
  const response = await f.call(`/providers/${id}/login`, 'POST');
  expect(response?.status).toBe(400);
  expect(await response!.json()).toEqual({ error: '该提供商不使用登录' });
  expect((await f.call(`/providers/${id}/login`))?.status).toBe(200);
  expect(await (await f.call(`/providers/${id}/login`))!.json()).toEqual({ login: { state: 'none' } });
});

test('rule A4: an unknown provider is 404 on all three routes', async () => {
  const f = setup();
  for (const method of ['POST', 'GET', 'DELETE']) {
    const response = await f.call('/providers/missing/login', method);
    expect([method, response?.status]).toEqual([method, 404]);
    expect(await response!.json()).toEqual({ error: '未找到提供商' });
  }
});

test('rule A4: a login the authorization server cannot start is 502 and leaves no session', async () => {
  const f = setup();
  const id = addProvider(f, 'broken-login');
  const response = await f.call(`/providers/${id}/login`, 'POST');
  expect(response?.status).toBe(502);
  expect(await response!.json()).toEqual({ error: 'not_found' });
  expect(await (await f.call(`/providers/${id}/login`))!.json()).toEqual({ login: { state: 'none' } });
});

test('rule A4: DELETE cancels the session and removes the credential', async () => {
  const f = setup();
  const id = addProvider(f);
  expect((await f.call(`/providers/${id}/login`, 'POST'))?.status).toBe(201);
  f.providers.setCredential(id, '{"accessToken":"a","refreshToken":"r","expiresAt":null}');
  const response = await f.call(`/providers/${id}/login`, 'DELETE');
  expect(response?.status).toBe(204);
  expect(f.providers.credential(id)).toBeNull();
  expect(f.providers.get(id)?.hasCredential).toBe(false);
  expect(await (await f.call(`/providers/${id}/login`))!.json()).toEqual({ login: { state: 'none' } });
});

test('rule A4: an unknown method on the login path is 405', async () => {
  const f = setup();
  const id = addProvider(f);
  expect((await f.call(`/providers/${id}/login`, 'PUT'))?.status).toBe(405);
  expect((await f.call(`/providers/${id}/login`, 'PATCH'))?.status).toBe(405);
});

test('rule A4: a provider on a login connector is created without a credential', async () => {
  const f = setup();
  const refused = await f.call('/providers', 'POST', {
    name: 'with key', connector: 'fake-login', apiKey: 'secret',
  });
  expect(refused?.status).toBe(400);
  expect(await refused!.json()).toEqual({ error: 'apiKey 无效' });
  const created = await f.call('/providers', 'POST', { name: 'without key', connector: 'fake-login' });
  expect(created?.status).toBe(201);
  const provider = (await created!.json() as { provider: ProviderRecord }).provider;
  expect(provider).toMatchObject({
    connector: 'fake-login', hasCredential: false, credentialRejected: false,
  });
  expect(await (await f.call(`/providers/${provider.id}/login`))!.json())
    .toEqual({ login: { state: 'none' } });
});

test('rule A4: DELETE on a provider that does not log in keeps its API key', async () => {
  const f = setup();
  const id = addProvider(f, 'fake-key');
  f.providers.setCredential(id, '{"apiKey":"secret"}');
  const response = await f.call(`/providers/${id}/login`, 'DELETE');
  expect(response?.status).toBe(400);
  expect(await response!.json()).toEqual({ error: '该提供商不使用登录' });
  expect(f.providers.credential(id)).toBe('{"apiKey":"secret"}');
  expect(f.providers.get(id)?.hasCredential).toBe(true);
});
