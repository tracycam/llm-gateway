// The login machinery at the process boundary: a rejected login provider fails over to a second
// provider on the same model, the console is told, and no token reaches a response or a log.
import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type GatewayApp } from './app';
import type { Connector } from './connectors/connector';
import { openGatewayDatabase } from './database';
import { KeyStore } from './keyStore';
import { ModelStore } from './modelStore';
import type { ProviderRecord } from './providerStore';
import { ProviderStore } from './providerStore';
import { AuthorizationServer } from './testing/authorizationServer';
import { fakeLoginConnector } from './testing/loginConnector';

const ADMIN = 'admin-token-0123456789';
const ADMIN_HEADER = { authorization: `Bearer ${ADMIN}` };
const NOW = new Date('2026-01-01T00:00:00Z');

const dirs: string[] = [];
const apps: GatewayApp[] = [];
const servers: AuthorizationServer[] = [];
const upstreams: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const server of servers.splice(0)) server.close();
  for (const upstream of upstreams.splice(0)) upstream.stop(true);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function until(what: string, condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1);
  }
}

/** An OpenAI-compatible upstream that answers one sentence and remembers what it was sent. */
function upstreamStub(): { url: string; authorization: () => string | undefined } {
  let sent: string | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      sent = req.headers.get('authorization') ?? undefined;
      await req.text();
      return Response.json({
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 0,
        model: 'upstream-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'served' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  upstreams.push(server);
  return { url: `http://127.0.0.1:${server.port}`, authorization: () => sent };
}

interface Fixture {
  app: GatewayApp;
  providers: ProviderStore;
  key: string;
  login: ProviderRecord;
  keyed: ProviderRecord;
  authorization: AuthorizationServer;
  model: string;
  call(pathname: string, init?: RequestInit): Promise<Response>;
  admin(pathname: string, init?: RequestInit): Promise<Response>;
}

function setup(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-login-'));
  dirs.push(dir);
  const authorization = new AuthorizationServer({ interval: 0, tokenLifetime: 0, steps: ['grant'] });
  servers.push(authorization);
  const upstream = upstreamStub();
  const { connector: loginConnector } = fakeLoginConnector({
    deviceEndpoint: authorization.deviceEndpoint,
    tokenEndpoint: authorization.tokenEndpoint,
    upstream: upstream.url,
    now: () => NOW,
  });
  const keyedConnector: Connector = {
    id: 'stub-key',
    name: 'Stub key',
    defaultBaseUrl: upstream.url,
    credential: 'api-key',
    async target() {
      return { url: `${upstream.url}/chat/completions`, headers: {}, protocol: 'chat' };
    },
    async models() { return []; },
  };
  const connectors = [loginConnector, keyedConnector];
  const find = (id: string) => connectors.find((connector) => connector.id === id) ?? null;
  const db = openGatewayDatabase(dir);
  const app = createApp({
    db, webDistDir: path.join(dir, 'web'), fetch, now: () => NOW,
    connector: find, connectors: () => connectors, adminToken: ADMIN,
  });
  apps.push(app);
  const providers = new ProviderStore(db);
  const models = new ModelStore(db);
  const login = providers.create({
    name: 'login provider', connector: loginConnector.id, baseUrl: null, credential: null,
    autoPublish: false,
  }, NOW);
  const keyed = providers.create({
    name: 'key provider', connector: keyedConnector.id, baseUrl: null, credential: null,
    autoPublish: false,
  }, NOW);
  const model = models.create({ name: 'shared-model' }, NOW);
  models.addRoute(model.id, { providerId: login.id, upstreamModel: 'login-upstream' });
  models.addRoute(model.id, { providerId: keyed.id, upstreamModel: 'key-upstream' });
  const key = new KeyStore(db).create({ name: 'client' }, NOW).token;
  return {
    app, providers, key, login, keyed, authorization, model: model.name,
    call: (pathname, init) => app.handle(new Request(`http://gateway${pathname}`, init)),
    admin: (pathname, init = {}) => app.handle(new Request(`http://gateway${pathname}`, {
      ...init, headers: { ...ADMIN_HEADER, ...init.headers },
    })),
  };
}

function chatRequest(f: Fixture): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${f.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: f.model, messages: [{ role: 'user', content: 'hi' }] }),
  };
}

test('rule B2: a rejected login provider fails over to the second provider on the model', async () => {
  const f = setup();
  f.providers.rejectCredential(f.login.id);
  const response = await f.call('/v1/chat/completions', chatRequest(f));
  expect(response.status).toBe(200);
  expect((await response.json() as { choices: Array<{ message: { content: string } }> })
    .choices[0].message.content).toBe('served');
  const listed = await f.admin('/api/gateway/providers');
  const providers = (await listed.json() as { providers: ProviderRecord[] }).providers;
  expect(providers.find((provider) => provider.id === f.login.id)?.credentialRejected).toBe(true);
  expect(providers.find((provider) => provider.id === f.keyed.id)?.credentialRejected).toBe(false);
});

test('rule B2: a model whose only usable route is rejected answers as it does today', async () => {
  const f = setup();
  f.providers.rejectCredential(f.login.id);
  f.providers.update(f.keyed.id, { enabled: false });
  const response = await f.call('/v1/chat/completions', chatRequest(f));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: { message: 'No route available', type: 'api_error', code: null, param: null },
  });
  const list = await f.call('/v1/models', { headers: { authorization: `Bearer ${f.key}` } });
  expect((await list.json() as { data: unknown[] }).data).toEqual([]);
});

test('rule A4: the login routes need the administrator', async () => {
  const f = setup();
  for (const method of ['POST', 'GET', 'DELETE']) {
    const response = await f.call(`/api/gateway/providers/${f.login.id}/login`, {
      method,
      body: method === 'POST' ? JSON.stringify({}) : undefined,
    });
    expect([method, response.status]).toEqual([method, 401]);
    expect(await response.json()).toEqual({ error: '未登录' });
  }
});

test('rule B5: a full login, a renewal and a refused renewal leak nothing', async () => {
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
    const started = await read(await f.admin(`/api/gateway/providers/${f.login.id}/login`, {
      method: 'POST',
    }));
    expect(started.status).toBe(201);
    await until('the login to store a credential', () => f.providers.credential(f.login.id) !== null);
    const status = await read(await f.admin(`/api/gateway/providers/${f.login.id}/login`));
    expect(await status.json()).toEqual({ login: { state: 'done' } });

    // The granted token is already due: the first request spends the first refresh token.
    const refreshed = await read(await f.call('/v1/chat/completions', chatRequest(f)));
    expect(refreshed.status).toBe(200);
    expect(f.authorization.refreshes).toBe(1);

    // The next renewal presents a token the server has already spent: the login is gone.
    f.providers.setCredential(f.login.id, JSON.stringify({
      accessToken: 'stale-access', refreshToken: 'refresh-token-0001',
      expiresAt: NOW.toISOString(),
    }));
    const refused = await read(await f.call('/v1/chat/completions', chatRequest(f)));
    expect(refused.status).toBe(200);
    expect(f.providers.get(f.login.id)?.credentialRejected).toBe(true);

    const providers = await read(await f.admin('/api/gateway/providers'));
    expect(await providers.json()).toBeDefined();
    const everything = [...bodies, ...logged].join('\n');
    const secrets = [
      f.authorization.deviceCode,
      'access-token-0001', 'access-token-0002', 'refresh-token-0001', 'refresh-token-0002',
    ];
    for (const secret of secrets) expect([secret, everything.includes(secret)]).toEqual([secret, false]);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
