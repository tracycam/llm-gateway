// The acceptance run of S6.2: the real gateway process against two real daemons. The tests
// are one scenario and run in order; each is named after the criterion it decides.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { freePort, stopDaemon, tempDir } from '../server/testing/fixtures';
import { removeVolume, StubDaemon, stubVolume, until } from '../server/testing/stubDaemon';
import type { NodeIdentity } from '../server/types';
import type { ClusterEvent, NodeView } from './cluster';
import { emptySnapshot, FakeDaemon } from './testing/fakeDaemon';

const ADMIN_TOKEN = 'gateway-admin-node-test';
const TOKEN_A = 'daemon-a-secret-node-test';
const TOKEN_B = 'daemon-b-secret-node-test';
// Longer than the 5 s between a real daemon's state events, so the real daemons stay online
// here without waiting for their 15 s keepalive; short enough to wait for in criterion 4.
const WATCHDOG_MS = 8_000;
const ADMIN = { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' };

let dataDir: string;
let volumeA: string;
let volumeB: string;
let a: StubDaemon;
let b: StubDaemon;
let gateway: ChildProcess;
let base: string;
let idA: string;
let idB: string;
let nodeIdA: string;

/** Everything the gateway wrote to stdout and stderr, over all its runs. */
let gatewayOutput = '';
/** Every response body received through request(). */
let responseBodies = '';
/** Every byte received on /api/gateway/events. */
let eventBytes = '';
let events: ClusterEvent[] = [];
let eventStream: AbortController;

async function startGateway(): Promise<void> {
  gateway = spawn(process.execPath, ['run', 'gateway/main.ts'], {
    env: {
      ...process.env,
      AIHUB_GATEWAY_PORT: new URL(base).port,
      AIHUB_GATEWAY_DATA_DIR: dataDir,
      AIHUB_ADMIN_TOKEN: ADMIN_TOKEN,
      AIHUB_GATEWAY_NODE_WATCHDOG_MS: String(WATCHDOG_MS),
      AIHUB_GATEWAY_NODE_RETRY_MIN_MS: '100',
      AIHUB_GATEWAY_NODE_RETRY_MAX_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer) => {
    gatewayOutput += chunk.toString();
  };
  gateway.stdout!.on('data', collect);
  gateway.stderr!.on('data', collect);
  await until('gateway up', async () => {
    if (gateway.exitCode !== null) throw new Error(`gateway exited: ${gatewayOutput}`);
    try {
      return (await fetch(`${base}/healthz`)).ok ? true : undefined;
    } catch (err) {
      if (err instanceof Error) return undefined;
      throw err;
    }
  });
}

async function request(pathname: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...ADMIN, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  responseBodies += text;
  const isJson = response.headers.get('content-type')?.includes('json') ?? false;
  return { status: response.status, text, body: isJson ? JSON.parse(text) : null };
}

/** The status of a request whose path is sent as written; fetch would resolve `..` first. */
function rawStatus(pathAsWritten: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(new URL(base).port), '127.0.0.1');
    let received = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      received += chunk.toString();
    });
    socket.on('close', () => resolve(Number(received.split(' ')[1])));
    socket.write(
      `GET ${pathAsWritten} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        `Authorization: Bearer ${ADMIN_TOKEN}\r\nConnection: close\r\n\r\n`
    );
  });
}

async function nodes(): Promise<NodeView[]> {
  return (await request('/api/gateway/nodes')).body.nodes;
}

function waitNode(id: string, state: 'online' | 'offline'): Promise<NodeView> {
  return until(
    `node ${id} ${state}`,
    async () => {
      const node = (await nodes()).find((entry) => entry.id === id);
      return node?.online === (state === 'online') ? node : undefined;
    },
    15_000
  );
}

function register(name: string, url: string, token?: string) {
  return request('/api/gateway/nodes', 'POST', { name, url, token });
}

const remove = (id: string) => request(`/api/gateway/nodes/${id}`, 'DELETE');

/** Whether the event stream has reported the node offline since event number `since`. */
function wentOffline(id: string, since: number): boolean {
  return events.slice(since).some((event) => event.type === 'node' && event.data.id === id && !event.data.online);
}

/** Follows /api/gateway/events for the rest of the run, into `events` and `eventBytes`. */
async function followEvents(): Promise<void> {
  const abort = new AbortController();
  eventStream = abort;
  const response = await fetch(`${base}/api/gateway/events`, { headers: ADMIN, signal: abort.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const read = async () => {
    for (;;) {
      const part = await reader.read();
      if (part.done) return;
      const text = decoder.decode(part.value, { stream: true });
      eventBytes += text;
      pending += text;
      for (let end = pending.indexOf('\n\n'); end !== -1; end = pending.indexOf('\n\n')) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice('data: '.length)));
      }
    }
  };
  read().catch((err) => {
    if (!abort.signal.aborted) throw err;
  });
}

interface Recorded {
  method: string;
  path: string;
  body: string;
  cookie: string | null;
  authorization: string | null;
  contentType: string | null;
}

/** A daemon without a token that comes online and records every management call it gets. */
function recordingDaemon() {
  const calls: Recorded[] = [];
  const opening = `data: ${JSON.stringify({ type: 'snapshot', data: emptySnapshot() })}\n\n`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const { pathname, search } = new URL(req.url);
      if (pathname === '/api/v1/node') {
        return Response.json({ nodeId: 'recording-node', hostname: 'recording', version: '0', apiVersion: 1 });
      }
      if (pathname === '/api/v1/events') {
        const stream = new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode(opening)),
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      calls.push({
        method: req.method,
        path: pathname + search,
        body: await req.text(),
        cookie: req.headers.get('cookie'),
        authorization: req.headers.get('authorization'),
        contentType: req.headers.get('content-type'),
      });
      if (pathname === '/api/v1/services/moved') {
        return new Response('moved', { status: 307, headers: { Location: '/api/v1/services/elsewhere' } });
      }
      if (pathname === '/api/v1/services/refused') {
        return new Response('{"error":"no"}', { status: 409, headers: { 'Content-Type': 'application/json' } });
      }
      return Response.json({ ok: true });
    },
  });
  return { calls, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** Registers a recording daemon, runs `use` with its node id once it is online, removes it. */
async function withRecordingNode(use: (id: string, calls: Recorded[]) => Promise<void>): Promise<void> {
  const daemon = recordingDaemon();
  try {
    const id: string = (await register('recording', daemon.url)).body.node.id;
    await waitNode(id, 'online');
    await use(id, daemon.calls);
    await remove(id);
  } finally {
    await daemon.stop();
  }
}

beforeAll(async () => {
  dataDir = tempDir();
  volumeA = stubVolume();
  volumeB = stubVolume();
  a = await StubDaemon.start(volumeA, { AIHUB_LISTEN: '0.0.0.0', AIHUB_ADMIN_TOKEN: TOKEN_A });
  b = await StubDaemon.start(volumeB, { AIHUB_LISTEN: '0.0.0.0', AIHUB_ADMIN_TOKEN: TOKEN_B });
  base = `http://127.0.0.1:${await freePort()}`;
  await startGateway();
  await followEvents();
}, 30_000);

afterAll(async () => {
  eventStream?.abort();
  if (gateway) await stopDaemon(gateway);
  if (a) await a.stop();
  if (b) await b.stop();
  for (const volume of [volumeA, volumeB]) if (volume) removeVolume(volume);
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}, 30_000);

test('1. two registered daemons are both online, each with its own identity and state', async () => {
  const registeredA = await register('A', a.base, TOKEN_A);
  // Written with a trailing slash; stored without.
  const registeredB = await register('B', `${b.base}/`, TOKEN_B);
  expect([registeredA.status, registeredB.status]).toEqual([201, 201]);
  expect(registeredB.body.node.url).toBe(b.base);
  idA = registeredA.body.node.id;
  idB = registeredB.body.node.id;

  const identity = async (daemon: StubDaemon): Promise<NodeIdentity> =>
    (await fetch(`${daemon.base}/api/v1/node`, { headers: daemon.headers() })).json();
  nodeIdA = (await identity(a)).nodeId;
  const nodeA = await waitNode(idA, 'online');
  const nodeB = await waitNode(idB, 'online');
  expect(nodeA.identity!.nodeId).toBe(nodeIdA);
  expect(nodeB.identity!.nodeId).toBe((await identity(b)).nodeId);
  expect(nodeA.identity!.nodeId).not.toBe(nodeB.identity!.nodeId);
  expect(nodeA.snapshot!.models.map((model) => model.name)).toContain('stub-model');
  expect(nodeB.snapshot!.models.map((model) => model.name)).toContain('stub-model');
}, 25_000);

test('2. a killed daemon is offline with a reason and the other one stays online', async () => {
  const since = events.length;
  await a.kill();
  const nodeA = await waitNode(idA, 'offline');
  expect(nodeA.reason).toBeString();
  expect(nodeA.snapshot).toBeNull();
  expect((await waitNode(idB, 'online')).snapshot).not.toBeNull();
  expect(wentOffline(idB, since)).toBe(false);
}, 20_000);

test('3. the daemon started again at the same address is online again as the same node', async () => {
  a = await StubDaemon.start(volumeA, { AIHUB_LISTEN: '0.0.0.0', AIHUB_ADMIN_TOKEN: TOKEN_A }, Number(new URL(a.base).port));
  expect((await waitNode(idA, 'online')).identity!.nodeId).toBe(nodeIdA);
}, 25_000);

test('4. a daemon whose stream is open but silent goes offline as a heartbeat timeout', async () => {
  const silent = new FakeDaemon();
  silent.start();
  try {
    const since = events.length;
    const id: string = (await register('silent', silent.url)).body.node.id;
    await waitNode(id, 'online');
    const connectedAt = performance.now();
    const node = await waitNode(id, 'offline');
    expect(node.reason).toBe('心跳超时');
    expect(performance.now() - connectedAt).toBeGreaterThan(WATCHDOG_MS - 1_000);
    expect(wentOffline(idA, since) || wentOffline(idB, since)).toBe(false);
    await remove(id);
  } finally {
    await silent.stop();
  }
}, 25_000);

test('5. a management call through the gateway reaches the daemon of the node it names, and only that one', async () => {
  const model = (await b.snapshot()).models.find((item) => item.name === 'stub-model')!;
  const since = events.length;
  const created = await request(`/api/gateway/nodes/${idB}/daemon/services`, 'POST', { modelId: model.id });
  expect(created.status).toBe(201);
  const serviceId: string = created.body.service.id;
  await b.waitForStatus(serviceId, 'READY');
  expect(await a.service(serviceId)).toBeUndefined();

  // The gateway learns of it from daemon B's event stream, without asking.
  await until('the service in node B on the gateway event stream', async () =>
    events.slice(since).some(
      (event) =>
        event.type === 'daemon' &&
        event.data.id === idB &&
        event.data.event.type === 'state' &&
        event.data.event.data.services.some((service) => service.id === serviceId)
    )
      ? true
      : undefined
  );

  // A call without a body.
  expect((await request(`/api/gateway/nodes/${idB}/daemon/services/${serviceId}/stop`, 'POST')).status).toBe(200);
  await b.waitForStatus(serviceId, 'STOPPED');
}, 25_000);

test('5a. the daemon receives the method, path, query and body, the node token, and nothing of the browser', async () => {
  await withRecordingNode(async (id, calls) => {
    const sent = await request(`/api/gateway/nodes/${id}/daemon/settings?dry=1`, 'PATCH', { autoStart: false }, {
      Cookie: 'aihub_session=browser-cookie',
    });
    expect(sent.status).toBe(200);
    expect(calls).toEqual([
      {
        method: 'PATCH',
        path: '/api/v1/settings?dry=1',
        body: '{"autoStart":false}',
        cookie: null,
        // This daemon has no token; the administrator's own must not be passed on in its place.
        authorization: null,
        contentType: 'application/json',
      },
    ]);
  });
  // With a token: daemon A answers 401 to anything else.
  expect((await request(`/api/gateway/nodes/${idA}/daemon/operations`, 'DELETE')).status).toBe(200);
}, 20_000);

test("5b. the daemon's answer is returned as it is: status, body, and a redirect not followed", async () => {
  await withRecordingNode(async (id, calls) => {
    const refused = await request(`/api/gateway/nodes/${id}/daemon/services/refused`);
    expect([refused.status, refused.body]).toEqual([409, { error: 'no' }]);
    const moved = await request(`/api/gateway/nodes/${id}/daemon/services/moved`);
    expect([moved.status, moved.text]).toEqual([307, 'moved']);
    expect(calls.map((call) => call.path)).toEqual(['/api/v1/services/refused', '/api/v1/services/moved']);
  });
}, 20_000);

test('6. only what a daemon owns is forwarded', async () => {
  await withRecordingNode(async (id, calls) => {
    const daemon = `/api/gateway/nodes/${id}/daemon`;
    for (const rest of ['events', 'login', 'session', 'internal/chat/completions', 'internal/models', 'apps', 'snapshot', 'node']) {
      expect([rest, (await request(`${daemon}/${rest}`)).status]).toEqual([rest, 404]);
    }
    // Climbing out of an allowed resource, sent as written.
    expect(await rawStatus(`${daemon}/services/../internal/models`)).toBe(404);
    expect(await rawStatus(`${daemon}/services/%2e%2e/internal/models`)).toBe(404);
    expect(calls).toEqual([]);

    expect((await request(`/api/gateway/nodes/node-00000000/daemon/services`)).status).toBe(404);
  });
}, 20_000);

test('6a. a call to an offline node is answered 502 with the reason, without waiting', async () => {
  const daemon = new FakeDaemon();
  daemon.start();
  const id: string = (await register('gone', daemon.url)).body.node.id;
  await waitNode(id, 'online');
  await daemon.stop();
  const node = await waitNode(id, 'offline');
  const answer = await request(`/api/gateway/nodes/${id}/daemon/services`);
  expect([answer.status, answer.body]).toEqual([502, { error: node.reason }]);
  await remove(id);
}, 20_000);

test('7. a registration that cannot be verified is refused with the reason and stores nothing', async () => {
  const before = (await nodes()).map((node) => node.id);
  const refused = async (name: unknown, url: unknown, token?: unknown) => {
    const answer = await request('/api/gateway/nodes', 'POST', { name, url, token });
    return [answer.status, answer.body.error];
  };

  expect(await refused('x', a.base, 'wrong-token-0123456789')).toEqual([400, '令牌被拒']);
  expect(await refused('x', a.base)).toEqual([400, '令牌被拒']);
  expect((await refused('x', `http://127.0.0.1:${await freePort()}`))[1]).toStartWith('连接失败：');
  // The same daemon under another spelling of its address.
  expect(await refused('x', a.base.replace('127.0.0.1', 'localhost'), TOKEN_A)).toEqual([409, '该节点已登记为「A」']);
  expect(await refused('x', 'file:///tmp')).toEqual([400, '地址无效']);
  expect(await refused('x', 'ftp://127.0.0.1')).toEqual([400, '地址无效']);
  expect(await refused('x', `${a.base}/api/v1`, TOKEN_A)).toEqual([400, '地址无效']);
  expect(await refused('x', `${a.base}?x=1`, TOKEN_A)).toEqual([400, '地址无效']);
  expect(await refused('x', 'not a url')).toEqual([400, '地址无效']);
  expect(await refused('  ', a.base, TOKEN_A)).toEqual([400, '名称不能为空']);
  expect(await refused('x', a.base, 7)).toEqual([400, '令牌必须是字符串']);
  expect((await request('/api/gateway/nodes', 'POST', [])).body.error).toBe('请求体无效');

  expect((await nodes()).map((node) => node.id)).toEqual(before);
}, 20_000);

test('8. a rename keeps the node online; a change that cannot be verified is refused and changes nothing', async () => {
  const since = events.length;
  const change = (body: unknown) => request(`/api/gateway/nodes/${idA}`, 'PATCH', body);

  const renamed = await change({ name: 'renamed' });
  expect([renamed.status, renamed.body.node.name, renamed.body.node.online]).toEqual([200, 'renamed', true]);

  const wrongToken = await change({ token: 'wrong-token-0123456789' });
  expect([wrongToken.status, wrongToken.body.error]).toEqual([400, '令牌被拒']);
  const otherDaemon = await change({ url: b.base, token: TOKEN_B });
  expect([otherDaemon.status, otherDaemon.body.error]).toEqual([400, '该地址上是另一个节点；请删除后重新登记']);
  expect((await change({ name: '' })).status).toBe(400);
  expect((await request('/api/gateway/nodes/node-00000000', 'PATCH', { name: 'x' })).status).toBe(404);

  // The same daemon at another spelling of its address: accepted, and it comes online there.
  const moved = await change({ url: a.base.replace('127.0.0.1', 'localhost') });
  expect([moved.status, moved.body.node.url]).toEqual([200, a.base.replace('127.0.0.1', 'localhost')]);
  const nodeA = await waitNode(idA, 'online');
  expect([nodeA.name, nodeA.identity!.nodeId]).toEqual(['renamed', nodeIdA]);
  // The rename and the refused changes did not cost the connection; the move replaced it.
  expect(events.slice(since).filter((event) => event.type === 'node' && event.data.id === idA && !event.data.online)).toHaveLength(1);
}, 20_000);

test('9. after a gateway restart the registered nodes are there and online, without registering again', async () => {
  eventStream.abort();
  await stopDaemon(gateway);
  await startGateway();
  await followEvents();
  expect((await nodes()).map((node) => [node.id, node.name])).toEqual([
    [idA, 'renamed'],
    [idB, 'B'],
  ]);
  // Online needs the stored token: both daemons refuse anything else.
  expect((await waitNode(idA, 'online')).identity!.nodeId).toBe(nodeIdA);
  await waitNode(idB, 'online');
}, 25_000);

test('10. a node token is in the gateway database and nowhere the gateway speaks', async () => {
  for (const node of await nodes()) expect(Object.keys(node)).not.toContain('token');
  expect(responseBodies).not.toContain('"token"');
  const occurrences = (text: string, token: string) => text.split(token).length - 1;
  for (const token of [TOKEN_A, TOKEN_B]) {
    expect(occurrences(responseBodies, token)).toBe(0);
    expect(occurrences(eventBytes, token)).toBe(0);
    expect(occurrences(gatewayOutput, token)).toBe(0);
  }
  // Not vacuous: the three were collected.
  expect(responseBodies).toContain(nodeIdA);
  expect(eventBytes).toContain(nodeIdA);
  expect(gatewayOutput).toContain('Listening');

  expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
  for (const name of fs.readdirSync(dataDir)) {
    expect([name, fs.statSync(path.join(dataDir, name)).mode & 0o777]).toEqual([name, 0o600]);
  }
  const db = new Database(path.join(dataDir, 'gateway.sqlite'), { readonly: true });
  const stored = db.query('SELECT token FROM nodes ORDER BY created_at').all() as Array<{ token: string }>;
  db.close();
  expect(stored.map((row) => row.token)).toEqual([TOKEN_A, TOKEN_B]);
});

test('11. every node route answers 401 without the administrator credential', async () => {
  const routes = [
    ['GET', '/api/gateway/nodes'],
    ['POST', '/api/gateway/nodes'],
    ['PATCH', `/api/gateway/nodes/${idA}`],
    ['DELETE', `/api/gateway/nodes/${idA}`],
    ['GET', '/api/gateway/events'],
    ['GET', `/api/gateway/nodes/${idA}/daemon/services`],
    ['POST', `/api/gateway/nodes/${idA}/daemon/services`],
  ];
  for (const [method, route] of routes) {
    const status = (await fetch(`${base}${route}`, { method })).status;
    expect([method, route, status]).toEqual([method, route, 401]);
  }
  // A node token is not an administrator credential at the gateway.
  const withNodeToken = await fetch(`${base}/api/gateway/nodes`, { headers: { Authorization: `Bearer ${TOKEN_A}` } });
  expect(withNodeToken.status).toBe(401);
  expect((await nodes()).map((node) => node.id)).toEqual([idA, idB]);
});
