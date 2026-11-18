import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { HubSseEvent, ServiceInstance } from '../server/types';
import { NodeLink, NodeLinkOptions, NodeLinkState } from './nodeLink';
import { emptySnapshot, FakeDaemon } from './testing/fakeDaemon';

const WATCHDOG_MS = 200;
const RETRY_MIN_MS = 20;
const RETRY_MAX_MS = 80;

let daemon: FakeDaemon;
let link: NodeLink | null;
let changes: NodeLinkState[];
let events: HubSseEvent[];

beforeEach(() => {
  daemon = new FakeDaemon();
  daemon.start();
  link = null;
  changes = [];
  events = [];
});

afterEach(async () => {
  await link?.stop();
  await daemon.stop();
});

function connect(options: Partial<NodeLinkOptions> = {}): NodeLink {
  link = new NodeLink({
    url: daemon.url,
    token: daemon.token,
    expectedNodeId: daemon.identity.nodeId,
    onChange: (state) => changes.push(state),
    onEvent: (event) => events.push(event),
    watchdogMs: WATCHDOG_MS,
    retryMinMs: RETRY_MIN_MS,
    retryMaxMs: RETRY_MAX_MS,
    ...options,
  });
  link.start();
  return link;
}

async function until(what: string, condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const online = () => until('online', () => link!.state.online);
const offline = () => until('offline', () => changes.some((state) => !state.online));
const lastReason = () => changes.filter((state) => !state.online).at(-1)?.reason;

const service = { id: 'svc-1', status: 'READY' } as unknown as ServiceInstance;
const stateEvent: HubSseEvent = {
  type: 'state',
  data: { cards: [], services: [service], apps: [], hardware: emptySnapshot().hardware, operations: [] },
};

describe('connecting', () => {
  test('a link is not online before the daemon has answered', () => {
    const state = connect().state;
    expect(state).toEqual({ online: false, reason: '正在连接', identity: null, snapshot: null });
  });

  test('the node is online once the daemon has sent its full state', async () => {
    daemon.opening = { type: 'snapshot', data: emptySnapshot({ services: [service] }) };
    connect();
    await online();
    expect(changes).toEqual([
      { online: true, reason: null, identity: daemon.identity, snapshot: emptySnapshot({ services: [service] }) },
    ]);
  });

  test('a stream that is open but has sent nothing is not online', async () => {
    daemon.opening = null;
    connect();
    await until('stream open', () => daemon.openStreams === 1);
    expect(link!.state.online).toBe(false);
  });

  test('the token is sent with the identity request and with the stream', async () => {
    daemon.token = 'node-token-0123456789';
    connect();
    await online();
    expect(daemon.authorizations).toEqual(['Bearer node-token-0123456789', 'Bearer node-token-0123456789']);
  });

  test('a daemon without a token gets no Authorization header', async () => {
    connect();
    await online();
    expect(daemon.authorizations).toEqual([null, null]);
  });
});

describe('a node is offline, with the reason, when', () => {
  test('nothing listens at its address', async () => {
    await daemon.stop();
    connect();
    await offline();
    expect(lastReason()).toStartWith('连接失败：');
  });

  test('the daemon refuses the token', async () => {
    daemon.token = 'node-token-0123456789';
    connect({ token: 'another-token-0123456789' });
    await offline();
    expect(lastReason()).toBe('令牌被拒');
  });

  test('the daemon answers with an error', async () => {
    daemon.failWith = 500;
    connect();
    await offline();
    expect(lastReason()).toBe('节点返回 500');
  });

  test('the daemon speaks another API version', async () => {
    daemon.identityBody = { ...daemon.identity, apiVersion: 2 };
    connect();
    await offline();
    expect(lastReason()).toBe('接口版本不兼容（节点为 2，网关为 1）');
  });

  test('the identity is not what a daemon sends', async () => {
    daemon.identityBody = { nodeId: 7 };
    connect();
    await offline();
    expect(lastReason()).toBe('节点身份格式无法识别');
  });

  test('another daemon answers at the registered address', async () => {
    connect({ expectedNodeId: 'node-registered' });
    await offline();
    expect(lastReason()).toBe('节点号与登记时不符');
    expect(daemon.openStreams).toBe(0);
  });

  test('the daemon does not answer the identity request in time', async () => {
    const silent = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => undefined) });
    try {
      connect({ url: `http://127.0.0.1:${silent.port}`, handshakeTimeoutMs: 60 });
      await offline();
      expect(lastReason()).toBe('连接失败：握手超时');
    } finally {
      await silent.stop(true);
    }
  });

  test('the stream does not open with the full state', async () => {
    daemon.opening = stateEvent;
    connect();
    await offline();
    expect(lastReason()).toBe('事件流未以完整状态开头');
  });

  test('the daemon closes the stream', async () => {
    connect();
    await online();
    daemon.opening = null;
    daemon.closeStreams();
    await offline();
    expect(lastReason()).toBe('事件流断开');
  });

  test('the daemon is killed', async () => {
    connect();
    await online();
    await daemon.stop();
    await offline();
    expect(link!.state.online).toBe(false);
  });

  test('an event cannot be parsed', async () => {
    connect();
    await online();
    daemon.opening = null;
    daemon.write('data: {not json\n\n');
    await offline();
    expect(lastReason()).toBe('事件无法解析');
    await until('the stream to be closed', () => daemon.openStreams === 0);
  });

  test('an event is of a kind the gateway does not know', async () => {
    connect();
    await online();
    daemon.opening = null;
    daemon.write('data: {"type":"mystery","data":{}}\n\n');
    await offline();
    expect(lastReason()).toBe('事件无法解析');
  });
});

describe('heartbeat', () => {
  test('a stream that goes silent without closing is dropped after the watchdog time', async () => {
    connect();
    await online();
    daemon.opening = null;
    const silentSince = performance.now();
    await offline();
    const elapsed = performance.now() - silentSince;
    expect(lastReason()).toBe('心跳超时');
    expect(elapsed).toBeGreaterThanOrEqual(WATCHDOG_MS - 10);
    expect(elapsed).toBeLessThan(WATCHDOG_MS + 150);
  });

  test('a stream that sends its response headers and then nothing is dropped after the watchdog time', async () => {
    // Raw sockets: an HTTP server would hold the headers back until the first body byte.
    const identity = JSON.stringify(daemon.identity);
    const headersOnly = net.createServer((socket) => {
      socket.on('error', () => undefined);
      socket.once('data', (request) => {
        if (request.toString().startsWith('GET /api/v1/node')) {
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${identity.length}\r\n` +
              `Connection: close\r\n\r\n${identity}`
          );
        } else {
          socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => headersOnly.listen(0, '127.0.0.1', resolve));
    try {
      connect({ url: `http://127.0.0.1:${(headersOnly.address() as net.AddressInfo).port}` });
      await offline();
      expect(lastReason()).toBe('心跳超时');
    } finally {
      headersOnly.close();
    }
  });

  test('keepalives alone keep the node online', async () => {
    connect();
    await online();
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(WATCHDOG_MS / 2);
      daemon.keepalive();
    }
    expect(changes.filter((state) => !state.online)).toEqual([]);
  });

  test('a keepalive is not passed on as an event', async () => {
    connect();
    await online();
    daemon.keepalive();
    daemon.send(stateEvent);
    await until('event', () => events.length > 0);
    expect(events).toEqual([stateEvent]);
  });
});

describe('while online', () => {
  test('an event moves the snapshot forward and is passed on', async () => {
    connect();
    await online();
    daemon.send(stateEvent);
    await until('event', () => events.length === 1);
    expect(link!.state.snapshot!.services).toEqual([service]);
    expect(events).toEqual([stateEvent]);
  });

  test('an event is not a change of the node itself', async () => {
    connect();
    await online();
    daemon.send(stateEvent);
    await until('event', () => events.length === 1);
    expect(changes).toHaveLength(1);
  });

  test('an event that arrives in two pieces is received once, whole', async () => {
    connect();
    await online();
    const frame = `data: ${JSON.stringify(stateEvent)}\n\n`;
    daemon.write(frame.slice(0, 40));
    await Bun.sleep(30);
    expect(events).toEqual([]);
    daemon.write(frame.slice(40));
    await until('event', () => events.length === 1);
    expect(events).toEqual([stateEvent]);
  });

  test('a character cut in the middle between two pieces is received intact', async () => {
    connect();
    await online();
    const event: HubSseEvent = { type: 'log', data: { engineId: 'eng', line: '加载权重' } };
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    const cut = bytes.length - 7;
    daemon.write(bytes.subarray(0, cut));
    await Bun.sleep(30);
    daemon.write(bytes.subarray(cut));
    await until('event', () => events.length === 1);
    expect(link!.state.snapshot!.engineLogs).toEqual({ eng: ['加载权重'] });
  });

  test('two events in one piece are both received, in order', async () => {
    connect();
    await online();
    const first: HubSseEvent = { type: 'log', data: { engineId: 'eng', line: '1' } };
    const second: HubSseEvent = { type: 'log', data: { engineId: 'eng', line: '2' } };
    daemon.write(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(second)}\n\n`);
    await until('events', () => events.length === 2);
    expect(link!.state.snapshot!.engineLogs).toEqual({ eng: ['1', '2'] });
  });
});

describe('going offline', () => {
  test('drops the snapshot and keeps the identity', async () => {
    connect();
    await online();
    await daemon.stop();
    await offline();
    expect(link!.state.snapshot).toBeNull();
    expect(link!.state.identity).toEqual(daemon.identity);
  });
});

describe('reconnecting', () => {
  test('a daemon that comes back is online again with its new state', async () => {
    connect();
    await online();
    await daemon.stop();
    await offline();
    daemon.opening = { type: 'snapshot', data: emptySnapshot({ services: [service] }) };
    daemon.start();
    await online();
    expect(link!.state.snapshot!.services).toEqual([service]);
    expect(changes.map((state) => state.online)).toEqual([true, false, true]);
  });

  test('the same failure again is not reported again', async () => {
    daemon.failWith = 500;
    connect();
    await until('four attempts', () => daemon.authorizations.length >= 4);
    expect(changes).toHaveLength(1);
  });

  test('the gaps between attempts are 1x, 2x, 4x the minimum and then stay at the maximum', async () => {
    const times: number[] = [];
    const failing = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        times.push(performance.now());
        return new Response('failed', { status: 500 });
      },
    });
    try {
      connect({ url: `http://127.0.0.1:${failing.port}` });
      await until('six attempts', () => times.length >= 6);
      const gaps = times.slice(1).map((time, i) => time - times[i]);
      const expected = [20, 40, 80, 80, 80];
      gaps.slice(0, 5).forEach((gap, i) => {
        expect(gap).toBeGreaterThanOrEqual(expected[i] - 3);
        expect(gap).toBeLessThan(expected[i] + 35);
      });
    } finally {
      await failing.stop(true);
    }
  });

  test('the backoff starts over after the node has been online', async () => {
    daemon.failWith = 500;
    connect();
    await until('backoff at its maximum', () => daemon.authorizations.length >= 5);
    daemon.failWith = null;
    await online();

    await daemon.stop();
    const down = performance.now();
    await offline();
    const before = daemon.identityRequests.length;
    daemon.start();
    await until('next attempt', () => daemon.identityRequests.length > before, 1_000);
    // One minimum delay after the drop, not the maximum reached earlier.
    expect(daemon.identityRequests.at(-1)! - down).toBeLessThan(RETRY_MAX_MS);
  });
});

describe('stop', () => {
  test('closes the stream at the daemon', async () => {
    connect();
    await online();
    await link!.stop();
    await until('stream closed', () => daemon.openStreams === 0);
  });

  test('reports nothing afterwards', async () => {
    connect();
    await online();
    await link!.stop();
    const reported = changes.length;
    await Bun.sleep(RETRY_MAX_MS * 2);
    expect(changes).toHaveLength(reported);
    expect(daemon.identityRequests).toHaveLength(1);
  });

  test('returns at once while waiting to retry', async () => {
    await daemon.stop();
    connect({ retryMinMs: 5_000, retryMaxMs: 5_000 });
    await offline();
    const started = performance.now();
    await link!.stop();
    expect(performance.now() - started).toBeLessThan(200);
  });

  test('returns at once while the daemon is not answering', async () => {
    const silent = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => undefined) });
    try {
      connect({ url: `http://127.0.0.1:${silent.port}` });
      await Bun.sleep(30);
      const started = performance.now();
      await link!.stop();
      expect(performance.now() - started).toBeLessThan(200);
      expect(changes).toEqual([]);
    } finally {
      await silent.stop(true);
    }
  });

  test('called while an event is handled, later events of the same piece are not passed on', async () => {
    const first: HubSseEvent = { type: 'log', data: { engineId: 'eng', line: '1' } };
    const second: HubSseEvent = { type: 'log', data: { engineId: 'eng', line: '2' } };
    let stopping: Promise<void> | undefined;
    connect({
      onEvent: (event) => {
        events.push(event);
        stopping ??= link!.stop();
      },
    });
    await online();
    daemon.write(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(second)}\n\n`);
    await until('stop', () => stopping !== undefined);
    await stopping;
    expect(events).toEqual([first]);
  });

  test('called while the daemon is closing the stream, it does not wait for a retry', async () => {
    let stopping: Promise<void> | undefined;
    connect({
      retryMinMs: 5_000,
      retryMaxMs: 5_000,
      onEvent: () => {
        stopping ??= link!.stop();
      },
    });
    await online();
    daemon.opening = null;
    daemon.send(stateEvent);
    daemon.closeStreams();
    await until('stop', () => stopping !== undefined);
    const started = performance.now();
    await stopping;
    expect(performance.now() - started).toBeLessThan(200);
    expect(changes.filter((state) => !state.online)).toEqual([]);
  });

  test('a link cannot be started twice', () => {
    expect(() => connect().start()).toThrow('already started');
  });
});
