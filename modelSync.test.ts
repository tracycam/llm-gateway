// The gateway syncing provider model lists by itself: one rule per test, with a stub connector
// or a stub upstream on 127.0.0.1 and an injected wait, so no test sleeps.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Connector, LoginConnector, ProviderAccess } from './connectors/connector';
import { UpstreamFailure } from './connectors/connector';
import { CONNECTORS, connectorById } from './connectors/registry';
import { CredentialRenewals } from './connectors/tokens';
import { openGatewayDatabase } from './database';
import { KeyStore } from './keyStore';
import { LoginSessions } from './login';
import { ModelStore } from './modelStore';
import { MODEL_SYNC_INTERVAL_MS, ModelSync, type SyncWait } from './modelSync';
import { ProviderStore, type ProviderModelInput } from './providerStore';
import { migrate } from './schema';
import { UsageStore } from './usageStore';
import { createApp, type GatewayApp } from './app';
import type { AdminDeps } from './admin/deps';
import { handleProviderRoute } from './admin/providers';
import { request, fixture } from './admin/testing';

const NOW = new Date('2026-01-01T00:00:00Z');
const ADMIN = 'admin-token-0123456789';
const NO_PRICE = { input: null, output: null, cacheRead: null };

const databases: Database[] = [];
const syncs: ModelSync[] = [];
const apps: GatewayApp[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const sync of syncs.splice(0)) sync.close();
  for (const app of apps.splice(0)) await app.close();
  for (const server of servers.splice(0)) server.stop(true);
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Let every queued continuation run; no timer is waited on. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Yield until `predicate` holds; the loop only yields, it never sleeps. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000 && !predicate(); i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!predicate()) throw new Error('condition not reached');
}

function routeCount(db: Database): number {
  return db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM routes').get()!.n;
}

function newDatabase(): Database {
  const db = new Database(':memory:');
  databases.push(db);
  migrate(db);
  return db;
}

function discovered(upstreamId: string, protocols: ProviderModelInput['protocols'] = null) {
  return {
    upstreamId, contextLength: null, maxOutputTokens: null, price: { ...NO_PRICE }, protocols,
  } satisfies ProviderModelInput;
}

interface RecordingConnector {
  connector: Connector;
  calls: string[];
}

/** A key connector whose model list the test decides, and which records who was asked. */
function recordingConnector(
  respond: (provider: ProviderAccess) => Promise<ProviderModelInput[]>,
): RecordingConnector {
  const calls: string[] = [];
  const connector: Connector = {
    id: 'fake',
    name: 'Fake',
    defaultBaseUrl: 'https://example.com',
    credential: 'api-key',
    async target() { throw new Error('unused'); },
    async models(provider) {
      calls.push(provider.id);
      return respond(provider);
    },
  };
  return { connector, calls };
}

/** A login connector that records who was asked for models and grants its one poll. */
function recordingLoginConnector(): RecordingConnector & { connector: LoginConnector } {
  const calls: string[] = [];
  const connector: LoginConnector = {
    id: 'login',
    name: 'Login',
    defaultBaseUrl: 'https://example.com',
    credential: 'login',
    async target() { throw new Error('unused'); },
    async models(provider) {
      calls.push(provider.id);
      return [discovered('m')];
    },
    login: {
      async start() {
        return {
          userCode: 'CODE', verificationUri: 'https://example.com', verificationUriComplete: null,
          expiresAt: new Date('2026-01-01T00:01:00Z'), interval: 0, secret: 'secret',
        };
      },
      async poll() { return { status: 'granted', credential: '{"token":"t"}' }; },
    },
  };
  return { connector, calls };
}

interface ControlledWait {
  wait: SyncWait;
  calls: Array<{ ms: number; resolve(): void }>;
}

/** A wait the test releases by hand; an abort rejects it, as `close` does. */
function controlledWait(): ControlledWait {
  const calls: Array<{ ms: number; resolve(): void }> = [];
  const wait: SyncWait = (ms, signal) => new Promise<void>((resolve, reject) => {
    calls.push({ ms, resolve });
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  return { wait, calls };
}

interface Harness {
  db: Database;
  providers: ProviderStore;
  models: ModelStore;
  sync: ModelSync;
  calls: string[];
}

function harness(respond: (provider: ProviderAccess) => Promise<ProviderModelInput[]>,
  wait?: SyncWait): Harness {
  const db = newDatabase();
  const providers = new ProviderStore(db);
  const models = new ModelStore(db);
  const { connector, calls } = recordingConnector(respond);
  const sync = new ModelSync({
    providers, models, renewals: new CredentialRenewals(),
    connector: (id) => id === connector.id ? connector : null,
    now: () => NOW,
    wait: wait ?? (() => new Promise<void>(() => {})),
  });
  syncs.push(sync);
  return { db, providers, models, sync, calls };
}

function addProvider(
  providers: ProviderStore, name: string, credential: string | null = '{"apiKey":"k"}',
  connector = 'fake',
) {
  return providers.create({
    name, connector, baseUrl: null, credential, autoPublish: true,
  }, NOW);
}

test('start syncs every askable provider and skips a disabled one, ' +
  'a login provider without credential and a rejected one', async () => {
  const db = newDatabase();
  const providers = new ProviderStore(db);
  const models = new ModelStore(db);
  const key = recordingConnector(async () => [discovered('m')]);
  const login = recordingLoginConnector();
  const connectors = [key.connector, login.connector];
  const find = (id: string) => connectors.find((connector) => connector.id === id) ?? null;
  const wait = controlledWait();
  const sync = new ModelSync({
    providers, models, renewals: new CredentialRenewals(), connector: find,
    now: () => NOW, wait: wait.wait,
  });
  syncs.push(sync);
  const enabled = addProvider(providers, 'enabled');
  const disabled = addProvider(providers, 'disabled');
  providers.update(disabled.id, { enabled: false });
  addProvider(providers, 'no credential', null, 'login');
  const rejected = addProvider(providers, 'rejected', '{"token":"t"}', 'login');
  providers.rejectCredential(rejected.id);
  const signedIn = addProvider(providers, 'signed in', '{"token":"t"}', 'login');

  sync.start();
  await flush();

  expect(key.calls).toEqual([enabled.id]);
  expect(login.calls).toEqual([signedIn.id]);
  expect(wait.calls).toHaveLength(1);
});

test('the six-hour timer syncs again and close stops it', async () => {
  const wait = controlledWait();
  const h = harness(async () => [discovered('m')], wait.wait);
  const provider = addProvider(h.providers, 'p');

  h.sync.start();
  await flush();
  expect(h.calls).toHaveLength(1);
  expect(wait.calls).toHaveLength(1);
  expect(wait.calls[0].ms).toBe(MODEL_SYNC_INTERVAL_MS);

  wait.calls[0].resolve();
  await flush();
  expect(h.calls).toHaveLength(2);
  expect(wait.calls).toHaveLength(2);

  h.sync.close();
  await flush();
  expect(wait.calls).toHaveLength(2);
  expect(h.calls).toHaveLength(2);
  // A wait that `close` did not abort would still be able to run the loop again.
  wait.calls[1]?.resolve();
  await flush();
  expect(h.calls).toHaveLength(2);
  h.sync.trigger(provider.id);
  await flush();
  expect(h.calls).toHaveLength(2);
});

test('create, PATCH key, PATCH address, PATCH enabled to true and a granted login ' +
  'each start one sync, and no response waits for it', async () => {
  const db = newDatabase();
  const providers = new ProviderStore(db);
  const models = new ModelStore(db);
  const pend = recordingConnector(() => new Promise<ProviderModelInput[]>(() => {}));
  const renewals = new CredentialRenewals();
  const sync = new ModelSync({
    providers, models, renewals, connector: (id) => id === 'fake' ? pend.connector : null,
    now: () => NOW,
  });
  syncs.push(sync);
  const deps: AdminDeps = {
    providers, models,
    keys: new KeyStore(db),
    usage: new UsageStore(db),
    logins: new LoginSessions({
      providers, connector: () => null, fetch, now: () => NOW,
      wait: () => new Promise<void>(() => {}),
    }),
    sync,
    renewals,
    connector: (id) => id === 'fake' ? pend.connector : null,
    connectors: () => [pend.connector],
    now: () => NOW,
  };
  const call = (path: string, method: string, body?: unknown) =>
    handleProviderRoute(request(path, method, body), deps);

  // The connector never answers, so a response that returned proves it did not wait.
  const created = await call('/providers', 'POST', { name: 'created', connector: 'fake', apiKey: 'k' });
  expect(created?.status).toBe(201);
  expect(pend.calls).toHaveLength(1);

  const keyed = addProvider(providers, 'keyed', '{"apiKey":"old"}');
  const patchedKey = await call(`/providers/${keyed.id}`, 'PATCH', { apiKey: 'new' });
  expect(patchedKey?.status).toBe(200);
  expect(pend.calls).toHaveLength(2);

  const addressed = addProvider(providers, 'addressed');
  const patchedAddress = await call(`/providers/${addressed.id}`, 'PATCH', {
    baseUrl: 'https://other.example/v1',
  });
  expect(patchedAddress?.status).toBe(200);
  expect(pend.calls).toHaveLength(3);

  const switched = addProvider(providers, 'switched');
  providers.update(switched.id, { enabled: false });
  const patchedEnabled = await call(`/providers/${switched.id}`, 'PATCH', { enabled: true });
  expect(patchedEnabled?.status).toBe(200);
  expect(pend.calls).toHaveLength(4);

  const renamed = addProvider(providers, 'renamed');
  const patchedName = await call(`/providers/${renamed.id}`, 'PATCH', { name: 'renamed again' });
  expect(patchedName?.status).toBe(200);
  expect(pend.calls).toHaveLength(4);
});

test('a granted login starts one sync for the provider', async () => {
  const db = newDatabase();
  const providers = new ProviderStore(db);
  const models = new ModelStore(db);
  const login = recordingLoginConnector();
  const renewals = new CredentialRenewals();
  const sync = new ModelSync({
    providers, models, renewals, connector: (id) => id === 'login' ? login.connector : null,
    now: () => NOW,
  });
  syncs.push(sync);
  const logins = new LoginSessions({
    providers, connector: (id) => id === 'login' ? login.connector : null,
    fetch, now: () => NOW, wait: async () => {},
    onGranted: (providerId) => sync.trigger(providerId),
  });
  const provider = addProvider(providers, 'login provider', null, 'login');

  await logins.start(provider.id);
  await flush();

  expect(logins.status(provider.id)).toEqual({ state: 'done' });
  expect(login.calls).toEqual([provider.id]);
  logins.close();
});

test('concurrent syncs of one provider make one fetch', async () => {
  let release: (models: ProviderModelInput[]) => void = () => undefined;
  const held = new Promise<ProviderModelInput[]>((resolve) => { release = resolve; });
  const h = harness(() => held);
  const provider = addProvider(h.providers, 'p');

  const first = h.sync.refresh(provider.id);
  const second = h.sync.refresh(provider.id);
  expect(h.calls).toHaveLength(1);
  release([discovered('one')]);
  expect(await first).toEqual({ ok: true });
  expect(await second).toEqual({ ok: true });
  expect(h.calls).toHaveLength(1);
  expect(h.providers.models(provider.id).map(({ upstreamId }) => upstreamId)).toEqual(['one']);
});

test('a provider deleted while its list is being fetched stores nothing', async () => {
  let release: (models: ProviderModelInput[]) => void = () => undefined;
  const held = new Promise<ProviderModelInput[]>((resolve) => { release = resolve; });
  const h = harness(() => held);
  const provider = addProvider(h.providers, 'p');

  const running = h.sync.refresh(provider.id);
  h.providers.delete(provider.id);
  release([discovered('one')]);
  expect(await running).toEqual({ ok: true });
  expect(h.db.query<{ n: number }, [string]>(
    'SELECT COUNT(*) AS n FROM provider_models WHERE provider_id = ?'
  ).get(provider.id)).toEqual({ n: 0 });
});

test('a provider disabled while its list is being fetched stores nothing', async () => {
  let release: (models: ProviderModelInput[]) => void = () => undefined;
  const held = new Promise<ProviderModelInput[]>((resolve) => { release = resolve; });
  const h = harness(() => held);
  const provider = addProvider(h.providers, 'p');

  const running = h.sync.refresh(provider.id);
  h.providers.update(provider.id, { enabled: false });
  release([discovered('one')]);
  expect(await running).toEqual({ ok: true });
  expect(h.providers.models(provider.id)).toHaveLength(0);
  expect(h.providers.get(provider.id)?.modelsRefreshedAt).toBeNull();
});

test('a failure records modelsError, keeps the stored list and the published models, ' +
  'and a later success clears it', async () => {
  const clock = { now: new Date('2026-01-01T00:00:00Z') };
  let fail: Error | null = null;
  const db = newDatabase();
  const providers = new ProviderStore(db);
  const models = new ModelStore(db);
  const { connector } = recordingConnector(async () => {
    if (fail) throw fail;
    return [discovered('one')];
  });
  const sync = new ModelSync({
    providers, models, renewals: new CredentialRenewals(),
    connector: (id) => id === 'fake' ? connector : null,
    now: () => clock.now,
  });
  syncs.push(sync);
  const provider = addProvider(providers, 'p');

  clock.now = new Date('2026-01-01T01:00:00Z');
  expect(await sync.refresh(provider.id)).toEqual({ ok: true });
  const published = models.list().flatMap((model) => model.routes);
  expect(published).toHaveLength(1);

  fail = new UpstreamFailure('上游拒绝了凭证', 401);
  clock.now = new Date('2026-01-01T02:00:00Z');
  expect(await sync.refresh(provider.id)).toEqual({ ok: false, error: fail });
  const failed = providers.get(provider.id)!;
  expect(failed.modelsError).toBe('上游拒绝了凭证');
  expect(failed.modelsRefreshedAt).toBe('2026-01-01T01:00:00.000Z');
  expect(providers.models(provider.id).map(({ upstreamId }) => upstreamId)).toEqual(['one']);
  expect(models.list().flatMap((model) => model.routes)).toEqual(published);

  fail = null;
  clock.now = new Date('2026-01-01T03:00:00Z');
  expect(await sync.refresh(provider.id)).toEqual({ ok: true });
  const recovered = providers.get(provider.id)!;
  expect(recovered.modelsError).toBeNull();
  expect(recovered.modelsRefreshedAt).toBe('2026-01-01T03:00:00.000Z');
});

test('a failure that is not an UpstreamFailure records the fixed text and logs no token', async () => {
  const h = harness(async () => { throw new Error('upstream said secret-key-123'); });
  const provider = addProvider(h.providers, 'p');
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const outcome = await h.sync.refresh(provider.id);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : String(outcome.error)).toContain('secret-key-123');
    expect(h.providers.get(provider.id)?.modelsError).toBe('Model list refresh failed');
    const logged = errors.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('secret-key-123');
  } finally {
    errors.mockRestore();
  }
});

test('auto-publish skips a model that speaks none of the gateway interfaces', async () => {
  const h = harness(async () => [discovered('chatty', null), discovered('silent', [])]);
  const provider = addProvider(h.providers, 'p');

  expect(await h.sync.refresh(provider.id)).toEqual({ ok: true });
  expect(h.models.list().flatMap((model) => model.routes).map(({ upstreamModel }) => upstreamModel))
    .toEqual(['chatty']);
  expect(h.models.byName('silent')).toBeNull();
});

test('a new provider defaults to autoPublish and an explicit false is respected', async () => {
  const { db, deps } = fixture();
  try {
    const created = await handleProviderRoute(request('/providers', 'POST', {
      name: 'default', connector: 'fake', apiKey: 'k',
    }), deps);
    expect(created?.status).toBe(201);
    expect((await created!.json()).provider.autoPublish).toBe(true);

    const explicit = await handleProviderRoute(request('/providers', 'POST', {
      name: 'explicit', connector: 'fake', apiKey: 'k', autoPublish: false,
    }), deps);
    expect(explicit?.status).toBe(201);
    expect((await explicit!.json()).provider.autoPublish).toBe(false);
    await flush();
  } finally {
    db.close();
  }
});

test('criterion 4: a model added upstream appears in /v1/models after the timer ' +
  'and a chat request for it is answered', async () => {
  let upstreamModels = ['alpha'];
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === '/v1/models') {
        return Response.json({ object: 'list', data: upstreamModels.map((id) => ({ id })) });
      }
      if (pathname === '/v1/chat/completions') {
        return new Response(JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          created: 0,
          model: 'beta',
          choices: [{
            index: 0, message: { role: 'assistant', content: 'answer from beta' }, finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(upstream);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-model-sync-'));
  dirs.push(dir);
  const db = openGatewayDatabase(dir);
  const wait = controlledWait();
  const app = createApp({
    db, webDistDir: path.join(dir, 'web'), fetch, now: () => NOW,
    connector: connectorById, connectors: () => CONNECTORS, adminToken: ADMIN, syncWait: wait.wait,
  });
  apps.push(app);
  const key = new KeyStore(db).create({ name: 'client' }, NOW).token;

  await flush();
  expect(wait.calls).toHaveLength(1);
  const created = await app.handle(new Request('http://gateway/api/gateway/providers', {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'stub', connector: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: 'upstream-key',
    }),
  }));
  expect(created.status).toBe(201);
  await until(() => routeCount(db) === 1);
  expect(wait.calls).toHaveLength(1);

  upstreamModels = ['alpha', 'beta'];
  wait.calls[0].resolve();
  await until(() => routeCount(db) === 2);
  expect(wait.calls).toHaveLength(2);

  const listed = await app.handle(new Request('http://gateway/v1/models', {
    headers: { authorization: `Bearer ${key}` },
  }));
  expect(listed.status).toBe(200);
  const body = await listed.json() as { data: Array<{ id: string }> };
  expect(body.data.map(({ id }) => id)).toContain('beta');

  const answered = await app.handle(new Request('http://gateway/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'beta', messages: [{ role: 'user', content: 'hi' }] }),
  }));
  expect(answered.status).toBe(200);
  expect((await answered.json() as { choices: Array<{ message: { content: string } }> })
    .choices[0].message.content).toBe('answer from beta');
});
