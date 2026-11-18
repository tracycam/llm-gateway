import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Cluster, NodeRecord } from './cluster';
import { openNodeEvents } from './nodeEvents';

const node: NodeRecord = {
  id: 'node-1',
  name: 'machine',
  // Nothing listens here: the node stays offline, which is all these tests need.
  url: 'http://127.0.0.1:1',
  token: 'node-token-0123456789',
  nodeId: 'daemon-1',
  createdAt: '2026-11-18T00:00:00.000Z',
};

let cluster: Cluster;
let subscriptions: number;
let abort: AbortController;

beforeEach(() => {
  cluster = new Cluster([]);
  subscriptions = 0;
  const subscribe = cluster.subscribe.bind(cluster);
  cluster.subscribe = (listener) => {
    subscriptions += 1;
    const unsubscribe = subscribe(listener);
    return () => {
      subscriptions -= 1;
      unsubscribe();
    };
  };
  abort = new AbortController();
});

afterEach(() => cluster.close());

function open(keepaliveMs?: number) {
  const request = new Request('http://localhost/api/gateway/events', { signal: abort.signal });
  const reader = openNodeEvents(request, cluster, keepaliveMs).body!.getReader();
  const decoder = new TextDecoder();
  return {
    reader,
    next: async () => decoder.decode((await reader.read()).value),
  };
}

test('the stream opens with the list of nodes', async () => {
  cluster.add(node);
  const stream = open();
  const first = JSON.parse((await stream.next()).slice('data: '.length));
  expect(first.type).toBe('cluster');
  expect(first.data.nodes.map((entry: { id: string }) => entry.id)).toEqual(['node-1']);
});

test('a cluster event follows as one frame', async () => {
  const stream = open();
  await stream.next();
  cluster.add(node);
  const frame = await stream.next();
  expect(frame).toStartWith('data: {"type":"node",');
  expect(frame).toEndWith('\n\n');
});

test('no frame contains the node token', async () => {
  cluster.add(node);
  const stream = open();
  const frames = (await stream.next()) + (cluster.remove('node-1'), await stream.next());
  expect(frames).not.toContain(node.token!);
});

test('a keepalive comment is sent at the keepalive interval', async () => {
  const stream = open(20);
  await stream.next();
  expect(await stream.next()).toBe(': keepalive\n\n');
});

test('a reader that cancels ends the subscription', async () => {
  const stream = open();
  await stream.next();
  expect(subscriptions).toBe(1);
  await stream.reader.cancel();
  expect(subscriptions).toBe(0);
});

test('a request that was already aborted leaves no subscription', async () => {
  abort.abort();
  open();
  expect(subscriptions).toBe(0);
});

test('a client that disconnects ends the subscription', async () => {
  const stream = open();
  await stream.next();
  abort.abort();
  expect(subscriptions).toBe(0);
});
