import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { HubSseEvent, ServiceInstance } from '../protocol/types';
import { Cluster, ClusterEvent, NodeRecord } from './cluster';
import { emptySnapshot, FakeDaemon } from './testing/fakeDaemon';

// The fake daemon sends no keepalives by itself, so the watchdog is long unless a test is about it.
const TIMING = { watchdogMs: 10_000, retryMinMs: 20, retryMaxMs: 80 };

let a: FakeDaemon;
let b: FakeDaemon;
let cluster: Cluster;
let events: ClusterEvent[];

function record(daemon: FakeDaemon, id: string, patch: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id,
    name: `machine ${id}`,
    url: daemon.url,
    token: daemon.token,
    nodeId: daemon.identity.nodeId,
    createdAt: '2026-11-18T00:00:00.000Z',
    ...patch,
  };
}

function start(records: NodeRecord[], timing = TIMING): Cluster {
  cluster = new Cluster(records, timing);
  cluster.subscribe((event) => events.push(event));
  return cluster;
}

async function until(what: string, condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const online = (id: string) => until(`${id} online`, () => cluster.get(id)?.online === true);
const offline = (id: string) => until(`${id} offline`, () => cluster.get(id)?.online === false);
const nodeEvents = (id: string) =>
  events.flatMap((event) => (event.type === 'node' && event.data.id === id ? [event.data] : []));

const service = { id: 'svc-1', status: 'READY' } as unknown as ServiceInstance;
const logEvent: HubSseEvent = { type: 'log', data: { engineId: 'eng', line: 'hello' } };

beforeEach(() => {
  a = new FakeDaemon();
  a.identity = { ...a.identity, nodeId: 'node-a', hostname: 'host-a' };
  a.start();
  b = new FakeDaemon();
  b.identity = { ...b.identity, nodeId: 'node-b', hostname: 'host-b' };
  b.opening = { type: 'snapshot', data: emptySnapshot({ services: [service] }) };
  b.start();
  events = [];
});

afterEach(async () => {
  await cluster?.close();
  await a.stop();
  await b.stop();
});

describe('two nodes', () => {
  test('each shows its own daemon state', async () => {
    start([record(a, 'a'), record(b, 'b')]);
    await online('a');
    await online('b');
    expect(cluster.get('a')!.snapshot!.services).toEqual([]);
    expect(cluster.get('b')!.snapshot!.services).toEqual([service]);
    expect(cluster.get('b')!.identity!.hostname).toBe('host-b');
  });

  test('a killed daemon takes only its own node offline', async () => {
    start([record(a, 'a'), record(b, 'b')]);
    await online('a');
    await online('b');
    await a.stop();
    await offline('a');
    expect(cluster.get('a')!.snapshot).toBeNull();
    expect(cluster.get('b')!.online).toBe(true);
    expect(nodeEvents('b').filter((node) => !node.online)).toEqual([]);
  });

  test('a daemon whose stream goes silent takes only its own node offline, as a heartbeat timeout', async () => {
    start([record(a, 'a'), record(b, 'b')], { ...TIMING, watchdogMs: 200 });
    await online('a');
    await online('b');
    b.opening = null;
    const keepAlive = setInterval(() => a.keepalive(), 50);
    try {
      await offline('b');
    } finally {
      clearInterval(keepAlive);
    }
    expect(cluster.get('b')!.reason).toBe('心跳超时');
    expect(cluster.get('a')!.online).toBe(true);
  });

  test('a daemon that comes back is online again', async () => {
    start([record(a, 'a'), record(b, 'b')]);
    await online('a');
    await a.stop();
    await offline('a');
    a.start();
    await online('a');
    expect(nodeEvents('a').map((node) => node.online)).toEqual([true, false, true]);
  });

  test("a daemon event is passed on under its node's id", async () => {
    start([record(a, 'a'), record(b, 'b')]);
    await online('a');
    await online('b');
    b.send(logEvent);
    await until('daemon event', () => events.some((event) => event.type === 'daemon'));
    expect(events.filter((event) => event.type === 'daemon')).toEqual([
      { type: 'daemon', data: { id: 'b', event: logEvent } },
    ]);
  });
});

describe('what leaves the cluster', () => {
  const secret = 'node-token-0123456789';

  test('no view, event or list contains a node token', async () => {
    a.token = secret;
    start([record(a, 'a')]);
    await online('a');
    cluster.add(record(b, 'b', { token: secret }));
    await offline('b');
    cluster.update(record(a, 'a', { name: 'renamed' }));
    cluster.remove('b');
    const everything = JSON.stringify([events, cluster.list(), cluster.get('a')]);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain('"token"');
  });

  test('the record for calling the daemon keeps its token', () => {
    a.token = secret;
    start([record(a, 'a')]);
    expect(cluster.record('a')!.token).toBe(secret);
  });
});

describe('add', () => {
  test('connects the node and announces it', async () => {
    start([]);
    cluster.add(record(a, 'a'));
    expect(nodeEvents('a')).toHaveLength(1);
    expect(nodeEvents('a')[0].online).toBe(false);
    await online('a');
  });

  test('refuses an id that exists', () => {
    start([record(a, 'a')]);
    expect(() => cluster.add(record(b, 'a'))).toThrow('already exists');
  });
});

describe('update', () => {
  test('a new name keeps the connection', async () => {
    start([record(a, 'a')]);
    await online('a');
    cluster.update(record(a, 'a', { name: 'renamed' }));
    expect(cluster.get('a')).toMatchObject({ name: 'renamed', online: true });
    expect(a.identityRequests).toHaveLength(1);
    expect(nodeEvents('a').at(-1)).toMatchObject({ name: 'renamed', online: true });
  });

  test('a new address connects there and leaves the old daemon', async () => {
    // The same daemon, reachable at another address.
    b.identity = { ...b.identity, nodeId: a.identity.nodeId };
    start([record(a, 'a')]);
    await online('a');
    cluster.update(record(b, 'a'));
    await until('old stream closed', () => a.openStreams === 0);
    await until('new daemon state', () => cluster.get('a')?.snapshot?.services.length === 1);
    expect(cluster.get('a')!.url).toBe(b.url);
  });

  test('a new token reconnects with it', async () => {
    a.token = 'node-token-0123456789';
    start([record(a, 'a', { token: 'wrong-token-0123456789' })]);
    await until('refused', () => cluster.get('a')!.reason === '令牌被拒');
    cluster.update(record(a, 'a'));
    await online('a');
  });

  test('events of the replaced connection no longer arrive', async () => {
    start([record(a, 'a')]);
    await online('a');
    cluster.update(record(b, 'a'));
    await online('a');
    events.length = 0;
    a.send(logEvent);
    await Bun.sleep(50);
    expect(events).toEqual([]);
  });

  test('the node stays in the list while its connection is replaced', async () => {
    start([record(a, 'a')]);
    await online('a');
    cluster.update(record(b, 'a'));
    expect(cluster.list().map((node) => node.id)).toEqual(['a']);
  });

  test('refuses a node that does not exist', () => {
    start([]);
    expect(() => cluster.update(record(a, 'a'))).toThrow('does not exist');
  });
});

describe('remove', () => {
  test('ends the connection and announces the removal', async () => {
    start([record(a, 'a')]);
    await online('a');
    cluster.remove('a');
    await until('stream closed', () => a.openStreams === 0);
    expect(cluster.list()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'node_removed', data: { id: 'a' } });
  });

  test('nothing about the node is reported afterwards', async () => {
    start([record(a, 'a')]);
    await online('a');
    cluster.remove('a');
    events.length = 0;
    await a.stop();
    await Bun.sleep(TIMING.retryMaxMs * 2);
    expect(events).toEqual([]);
  });
});

describe('subscribe', () => {
  test('a subscriber that throws does not take the node offline or stop other subscribers', async () => {
    cluster = new Cluster([record(a, 'a')], TIMING);
    cluster.subscribe(() => {
      throw new Error('subscriber failed');
    });
    cluster.subscribe((event) => events.push(event));
    await online('a');
    a.send(logEvent);
    await until('daemon event', () => events.some((event) => event.type === 'daemon'));
    expect(cluster.get('a')!.online).toBe(true);
  });

  test('the returned function ends the subscription', async () => {
    cluster = new Cluster([record(a, 'a')], TIMING);
    const seen: ClusterEvent[] = [];
    const unsubscribe = cluster.subscribe((event) => seen.push(event));
    await online('a');
    unsubscribe();
    const before = seen.length;
    await a.stop();
    await offline('a');
    expect(seen).toHaveLength(before);
  });
});

test('close ends every connection', async () => {
  start([record(a, 'a'), record(b, 'b')]);
  await online('a');
  await online('b');
  await cluster.close();
  await until('streams closed', () => a.openStreams === 0 && b.openStreams === 0);
});
