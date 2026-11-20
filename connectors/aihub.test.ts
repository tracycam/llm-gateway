// The AI-Hub daemon pool: discovery, aggregation, per-replica concurrency and failover.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { deriveWorkerToken, type DaemonEvent, type ServiceInstance } from './dgp';
import { ModelStore } from '../modelStore';
import { migrate } from '../schema';
import { ProviderStore } from '../providerStore';
import { AihubPool } from './aihubPool';
import { aihub, createAihubConnector } from './aihub';
import { UpstreamFailure, type Connector, type ProviderAccess } from './connector';
import { emptySnapshot, FakeDaemon } from '../testing/fakeDaemon';

const TOKEN = 'daemon-admin-token-0123456789';

function service(patch: Partial<ServiceInstance> = {}): ServiceInstance {
  return {
    id: 'svc-1',
    status: 'READY',
    modelName: 'local-model',
    port: 18_101,
    maxConcurrency: 1,
    contextLength: 32_768,
    maxOutputTokens: 4_096,
    protocols: ['chat'],
    ...patch,
  };
}

async function until(what: string, condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

interface Fixture {
  db: Database;
  providers: ProviderStore;
  models: ModelStore;
  daemon: FakeDaemon;
  pool: AihubPool;
  providerId: string;
  connector: Connector;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function fixture(services: ServiceInstance[], credential: string | null = JSON.stringify({ apiKey: TOKEN })): Fixture {
  const db = new Database(':memory:');
  migrate(db);
  const providers = new ProviderStore(db);
  const models = new ModelStore(db);
  const daemon = new FakeDaemon();
  daemon.token = TOKEN;
  daemon.opening = { type: 'snapshot', data: emptySnapshot({ services }) };
  daemon.start();
  const provider = providers.create({
    name: 'daemon', connector: 'aihub', baseUrl: daemon.url, credential, autoPublish: true,
  }, new Date('2024-01-01T00:00:00.000Z'));
  const pool = new AihubPool({ providers, models, now: () => new Date() });
  pool.start();
  const connector = createAihubConnector(pool);
  cleanups.push(async () => {
    await pool.close();
    await daemon.stop();
    db.close();
  });
  return { db, providers, models, daemon, pool, providerId: provider.id, connector };
}

function state(services: ServiceInstance[]): DaemonEvent {
  return { type: 'state', data: { services } };
}

describe('discovery', () => {
  test('one ready replica exposes one model and auto-publishes a route', async () => {
    const f = fixture([service()]);
    await until('model discovered', () => f.providers.models(f.providerId).length === 1);
    expect(f.providers.models(f.providerId)).toEqual([{
      upstreamId: 'local-model',
      contextLength: 32_768,
      maxOutputTokens: 4_096,
      price: { input: null, output: null, cacheRead: null },
      protocols: ['chat'],
      fetchedAt: expect.any(String),
    }]);
    const models = f.models.list();
    expect(models).toHaveLength(1);
    expect(models[0].routes).toHaveLength(1);
    expect(models[0].routes[0]).toMatchObject({
      providerId: f.providerId, upstreamModel: 'local-model', enabled: true,
    });
    expect(f.pool.available(f.providerId, 'local-model')).toBe(true);
    expect(f.pool.limit(f.providerId, 'local-model')).toBe(1);
  });

  test('replicas of one model aggregate into one discovered model', async () => {
    const f = fixture([
      service({ id: 'svc-a', port: 18_101, maxConcurrency: 2, contextLength: 32_768, maxOutputTokens: 4_096, protocols: ['chat', 'messages'] }),
      service({ id: 'svc-b', port: 18_102, maxConcurrency: 1, contextLength: 16_384, maxOutputTokens: 2_048, protocols: ['chat'] }),
    ]);
    await until('model discovered', () => f.providers.models(f.providerId).length === 1);
    expect(f.providers.models(f.providerId)[0]).toMatchObject({
      upstreamId: 'local-model',
      contextLength: 16_384,
      maxOutputTokens: 2_048,
      protocols: ['chat'],
    });
    expect(f.models.list()[0].routes).toHaveLength(1);
    expect(f.models.list()[0].routes[0].upstreamModel).toBe('local-model');
    expect(f.pool.limit(f.providerId, 'local-model')).toBe(3);
  });

  test('a model whose replicas speak different interfaces exposes their union', async () => {
    const f = fixture([
      service({ id: 'svc-a', port: 18_101, protocols: ['chat'] }),
      service({ id: 'svc-b', port: 18_102, protocols: ['responses'] }),
    ]);
    await until('model discovered', () => f.providers.models(f.providerId).length === 1);
    expect(f.providers.models(f.providerId)[0].protocols).toEqual(['chat', 'responses']);
  });

  test('a stopped service disappears from discovery while its route stays', async () => {
    const f = fixture([service()]);
    await until('model discovered', () => f.providers.models(f.providerId).length === 1);
    const routeId = f.models.list()[0].routes[0].id;
    f.daemon.send(state([service({ status: 'STOPPED', port: null })]));
    await until('model gone', () => f.providers.models(f.providerId).length === 0);
    expect(f.pool.available(f.providerId, 'local-model')).toBe(false);
    expect(f.models.list()[0].routes.map((route) => route.id)).toEqual([routeId]);
    f.daemon.send(state([service()]));
    await until('model back', () => f.pool.available(f.providerId, 'local-model'));
    expect(f.providers.models(f.providerId)).toHaveLength(1);
  });
});

describe('worker targets', () => {
  test('a worker is reached directly with the derived token, never the daemon token', async () => {
    const f = fixture([service()]);
    await until('model discovered', () => f.pool.available(f.providerId, 'local-model'));
    const acquired = await f.pool.acquire(f.providerId, 'local-model', 'chat', new Set(), new AbortController().signal);
    expect(acquired.kind).toBe('lease');
    if (acquired.kind !== 'lease') return;
    expect(acquired.lease.target.url).toBe(`http://127.0.0.1:18101/v1/chat/completions`);
    expect(acquired.lease.target.headers.Authorization).toBe(`Bearer ${deriveWorkerToken(TOKEN)}`);
    expect(JSON.stringify(acquired.lease.target)).not.toContain(TOKEN);
    acquired.lease.release();
  });

  test('a messages request chooses the messages path when the worker speaks it', async () => {
    const f = fixture([service({ protocols: ['chat', 'messages'] })]);
    await until('model discovered', () => f.pool.available(f.providerId, 'local-model'));
    const acquired = await f.pool.acquire(f.providerId, 'local-model', 'messages', new Set(), new AbortController().signal);
    expect(acquired.kind).toBe('lease');
    if (acquired.kind !== 'lease') return;
    expect(acquired.lease.target.url).toEndWith('/v1/messages');
    expect(acquired.lease.target.protocol).toBe('messages');
    acquired.lease.release();
  });

  test('a daemon without a token sends no worker Authorization header', async () => {
    const f = fixture([service()], null);
    f.daemon.token = null;
    f.pool.reconcile(f.providerId);
    await until('model discovered', () => f.pool.available(f.providerId, 'local-model'));
    const acquired = await f.pool.acquire(f.providerId, 'local-model', 'chat', new Set(), new AbortController().signal);
    expect(acquired.kind).toBe('lease');
    if (acquired.kind !== 'lease') return;
    expect(acquired.lease.target.headers).toEqual({});
    acquired.lease.release();
  });
});

describe('replica concurrency', () => {
  test('a worker never holds more than its concurrency, and a release wakes the waiter', async () => {
    const f = fixture([service({ maxConcurrency: 1 })]);
    await until('model discovered', () => f.pool.available(f.providerId, 'local-model'));
    const signal = new AbortController().signal;
    const first = await f.pool.acquire(f.providerId, 'local-model', 'chat', new Set(), signal);
    expect(first.kind).toBe('lease');
    let granted = false;
    const pending = f.pool.acquire(f.providerId, 'local-model', 'chat', new Set(), signal)
      .then((result) => { granted = true; return result; });
    expect(f.pool.waiting(f.providerId, 'local-model')).toBe(1);
    expect(granted).toBe(false);
    if (first.kind === 'lease') first.lease.release();
    const second = await pending;
    expect(second.kind).toBe('lease');
    if (second.kind === 'lease') second.lease.release();
  });

  test('requests balance across replicas, and the busiest replica is waited on', async () => {
    const f = fixture([
      service({ id: 'svc-a', port: 18_101, maxConcurrency: 1 }),
      service({ id: 'svc-b', port: 18_102, maxConcurrency: 1 }),
    ]);
    await until('model discovered', () => f.pool.available(f.providerId, 'local-model'));
    const signal = new AbortController().signal;
    const first = await f.pool.acquire(f.providerId, 'local-model', 'chat', new Set(), signal);
    const second = await f.pool.acquire(f.providerId, 'local-model', 'chat', new Set(), signal);
    expect(first.kind).toBe('lease');
    expect(second.kind).toBe('lease');
    if (first.kind !== 'lease' || second.kind !== 'lease') return;
    expect([first.lease.key, second.lease.key]).toEqual(['svc-a:18101', 'svc-b:18102']);
    const pending = f.pool.acquire(f.providerId, 'local-model', 'chat', new Set(), signal);
    expect(f.pool.waiting(f.providerId, 'local-model')).toBe(1);
    first.lease.release();
    const third = await pending;
    expect(third.kind).toBe('lease');
    if (third.kind === 'lease') {
      expect(third.lease.key).toBe('svc-a:18101');
      third.lease.release();
    }
    second.lease.release();
  });

  test('a waiting client that leaves is not granted a place', async () => {
    const f = fixture([service()]);
    await until('model discovered', () => f.pool.available(f.providerId, 'local-model'));
    const held = await f.pool.acquire(f.providerId, 'local-model', 'chat', new Set(), new AbortController().signal);
    expect(held.kind).toBe('lease');
    const controller = new AbortController();
    const pending = f.pool.acquire(f.providerId, 'local-model', 'chat', new Set(), controller.signal);
    expect(f.pool.waiting(f.providerId, 'local-model')).toBe(1);
    controller.abort();
    expect(await pending).toEqual({ kind: 'abandoned' });
    if (held.kind === 'lease') held.lease.release();
  });

  test('a failed replica is cooled down and its retry goes to another replica', async () => {
    const f = fixture([
      service({ id: 'svc-a', port: 18_101, maxConcurrency: 1 }),
      service({ id: 'svc-b', port: 18_102, maxConcurrency: 1 }),
    ]);
    await until('model discovered', () => f.pool.available(f.providerId, 'local-model'));
    const excluded = new Set<string>();
    const first = await f.pool.acquire(f.providerId, 'local-model', 'chat', excluded, new AbortController().signal);
    expect(first.kind).toBe('lease');
    if (first.kind !== 'lease') return;
    first.lease.fail({ kind: 'unavailable' }, Date.now());
    first.lease.release();
    excluded.add(first.lease.key);
    expect(first.lease.hasMore(excluded)).toBe(true);
    const second = await f.pool.acquire(f.providerId, 'local-model', 'chat', excluded, new AbortController().signal);
    expect(second.kind).toBe('lease');
    if (second.kind !== 'lease') return;
    expect(second.lease.key).not.toBe(first.lease.key);
    second.lease.release();
    // The cooling replica is not chosen again while another is free.
    const third = await f.pool.acquire(f.providerId, 'local-model', 'chat', new Set(), new AbortController().signal);
    expect(third.kind).toBe('lease');
    if (third.kind === 'lease') {
      expect(third.lease.key).toBe(second.lease.key);
      third.lease.release();
    }
  });
});

describe('standalone connector', () => {
  function access(baseUrl: string | null, credential: string | null): ProviderAccess {
    return {
      id: 'standalone', baseUrl, credential,
      saveCredential() {}, rejectCredential() {},
      renewOnce: (renew) => renew(), model() { return null; },
    };
  }

  test('lists a daemon snapshot before its event stream has connected', async () => {
    const authorizations: Array<string | null> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(req) {
        authorizations.push(req.headers.get('authorization'));
        return Response.json(emptySnapshot({
          services: [service(), service({ id: 'svc-stopped', status: 'STOPPED', port: null })],
        }));
      },
    });
    try {
      const models = await aihub.models(access(`http://127.0.0.1:${server.port}`, JSON.stringify({ apiKey: TOKEN })));
      expect(models).toHaveLength(1);
      expect(models[0].upstreamId).toBe('local-model');
      expect(authorizations).toEqual([`Bearer ${TOKEN}`]);
    } finally {
      await server.stop(true);
    }
  });

  test('cannot route without a live link, and names no secret', async () => {
    const provider = access('http://127.0.0.1:1', JSON.stringify({ apiKey: TOKEN }));
    await expect(aihub.target(provider, 'local-model', 'chat')).rejects.toBeInstanceOf(UpstreamFailure);
    await expect(aihub.models(access(null, null))).rejects.toMatchObject({ message: 'Base URL is required' });
  });
});

describe('daemon lifecycle', () => {
  test('an offline daemon records the reason, stops being available and wakes queued requests', async () => {
    const f = fixture([service()]);
    await until('model discovered', () => f.pool.available(f.providerId, 'local-model'));
    const held = await f.pool.acquire(f.providerId, 'local-model', 'chat', new Set(), new AbortController().signal);
    expect(held.kind).toBe('lease');
    const pending = f.pool.acquire(f.providerId, 'local-model', 'chat', new Set(), new AbortController().signal);
    expect(f.pool.waiting(f.providerId, 'local-model')).toBe(1);
    await f.daemon.stop();
    await until('offline recorded', () => f.providers.get(f.providerId)?.modelsError !== null);
    expect(await pending).toEqual({ kind: 'unavailable' });
    expect(f.pool.available(f.providerId, 'local-model')).toBe(false);
    expect(f.models.list()[0].routes).toHaveLength(1);
    if (held.kind === 'lease') held.lease.release();
  });

  test('a daemon that refuses the token marks the credential rejected', async () => {
    const f = fixture([service()], JSON.stringify({ apiKey: 'wrong-token-0123456789' }));
    await until('rejected', () => f.providers.get(f.providerId)?.credentialRejected === true);
    expect(f.providers.get(f.providerId)?.modelsError).toBe('令牌被拒');
    expect(f.connector.routeAvailable?.(f.providerId, 'local-model')).toBe(false);
  });

  test('a disabled provider keeps no link and no models', async () => {
    const f = fixture([service()]);
    await until('model discovered', () => f.pool.available(f.providerId, 'local-model'));
    f.providers.update(f.providerId, { enabled: false });
    f.pool.reconcile(f.providerId);
    await until('gone', () => !f.pool.available(f.providerId, 'local-model'));
    expect(f.connector.routeAvailable?.(f.providerId, 'local-model')).toBe(false);
  });
});
