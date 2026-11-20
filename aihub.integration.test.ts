// The acceptance run of S7.5: a real gateway app in front of a daemon's control plane and its
// workers. A worker is reached directly; no inference byte crosses the daemon.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { deriveWorkerToken, type DaemonSnapshot, type ServiceInstance } from './connectors/dgp';
import { createApp, type GatewayApp } from './app';
import { CONNECTORS, connectorById } from './connectors/registry';

const ADMIN = 'gateway-admin-aihub-0123456789';
const DAEMON_TOKEN = 'daemon-admin-token-0123456789';
const WORKER_TOKEN = deriveWorkerToken(DAEMON_TOKEN);

async function until(what: string, condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A daemon's control plane: identity, snapshot and the event stream the gateway follows. */
class TestDaemon {
  public snapshot: DaemonSnapshot;
  public inferenceRequests = 0;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly encoder = new TextEncoder();

  constructor(
    public readonly token: string | null = DAEMON_TOKEN,
    services: ServiceInstance[] = [],
    public readonly nodeId = `daemon-${crypto.randomUUID()}`,
  ) {
    this.snapshot = { services };
  }

  public start(): void {
    this.server = Bun.serve({
      hostname: '127.0.0.1', port: 0, idleTimeout: 0,
      fetch: (req) => this.handle(req),
    });
  }

  public get url(): string {
    return `http://127.0.0.1:${this.server!.port}`;
  }

  public async stop(): Promise<void> {
    for (const stream of this.streams) stream.close();
    this.streams.clear();
    await this.server?.stop(true);
    this.server = null;
  }

  public get(pathname: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.token !== null) headers.Authorization = `Bearer ${this.token}`;
    return fetch(`${this.url}${pathname}`, { headers });
  }

  /** Replaces the service list and tells every open stream, as a running daemon does. */
  public setServices(services: ServiceInstance[]): void {
    this.snapshot = { services };
    const event = { type: 'state', data: { services } };
    for (const stream of this.streams) {
      stream.enqueue(this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    }
  }

  private handle(req: Request): Response {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith('/api/v1/internal/')) {
      this.inferenceRequests += 1;
      return new Response('not found', { status: 404 });
    }
    if (pathname === '/api/v1/healthz') return Response.json({ status: 'ok' });
    if (this.token !== null && req.headers.get('authorization') !== `Bearer ${this.token}`) {
      return new Response('unauthorized', { status: 401 });
    }
    if (pathname === '/api/v1/node') {
      return Response.json({
        nodeId: this.nodeId,
        hostname: 'integration-host',
        version: '1',
        apiVersion: 1,
        workerPortRange: [18_100, 18_400],
        capabilities: { workerProtocols: true },
      });
    }
    if (pathname === '/api/v1/snapshot') return Response.json(this.snapshot);
    if (pathname === '/api/v1/events') {
      let opened: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          opened = controller;
          this.streams.add(controller);
          controller.enqueue(this.encoder.encode(
            `data: ${JSON.stringify({ type: 'snapshot', data: this.snapshot })}\n\n`,
          ));
        },
        cancel: () => {
          if (opened !== null) this.streams.delete(opened);
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  }
}

/** What the gateway's request to a worker leaves behind. */
interface WorkerCall {
  authorization: string | null;
  body: Record<string, unknown>;
}

/** A worker serving one model; it can hold requests to make concurrency observable. */
class TestWorker {
  public readonly calls: WorkerCall[] = [];
  public inflight = 0;
  public maxInflight = 0;
  public disconnected = false;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly waiters: Array<() => void> = [];

  constructor(
    public readonly answer = 'worker answer',
    private readonly expectedToken: string | null = WORKER_TOKEN,
    private readonly hold = false,
    private readonly streaming: 'finish' | 'open' = 'finish',
  ) {}

  public start(): void {
    this.server = Bun.serve({
      hostname: '127.0.0.1', port: 0, idleTimeout: 0,
      fetch: (req) => this.handle(req),
    });
  }

  public get port(): number {
    return this.server!.port!;
  }

  public async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }

  /** Releases one held request; the gateway's queue sends the next only afterwards. */
  public releaseOne(): void {
    this.waiters.shift()?.();
  }

  private async handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === '/healthz') return Response.json({ status: 'ok', ready: true });
    if (pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
    const authorization = req.headers.get('authorization');
    const body = await req.json() as Record<string, unknown>;
    this.calls.push({ authorization, body });
    if (this.expectedToken !== null && authorization !== `Bearer ${this.expectedToken}`) {
      return Response.json({ error: { message: 'Invalid worker token', type: 'authentication_error' } }, { status: 401 });
    }
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.inflight -= 1;
    };
    if (this.hold) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.waiters.push(resolve);
      await promise;
    }
    if (body.stream === true) return new Response(this.stream(req, body, finish), {
      headers: { 'content-type': 'text/event-stream' },
    });
    finish();
    return Response.json({
      id: 'chatcmpl-worker',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: this.answer }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  }

  private stream(
    req: Request,
    body: Record<string, unknown>,
    finish: () => void,
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const base = { id: 'chatcmpl-worker', object: 'chat.completion.chunk', created: 1_700_000_000, model: body.model };
    const frame = (delta: Record<string, unknown>, finishReason: string | null) =>
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
    const send = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(encoder.encode(frame({ role: 'assistant' }, null)));
      controller.enqueue(encoder.encode(frame({ content: this.answer }, null)));
      if (this.streaming === 'finish') {
        controller.enqueue(encoder.encode(frame({}, 'stop')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        finish();
      }
    };
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        req.signal.addEventListener('abort', () => {
          this.disconnected = true;
          finish();
          if (controller.desiredSize !== null) controller.close();
        }, { once: true });
        send(controller);
      },
      cancel: () => {
        this.disconnected = true;
        finish();
      },
    });
  }
}

interface Harness {
  app: GatewayApp;
  daemon: TestDaemon;
  admin(path: string, method: string, body?: unknown): Promise<Response>;
  client(path: string, body?: unknown, signal?: AbortSignal): Promise<Response>;
  createKey(): Promise<string>;
  createProvider(apiKey?: string): Promise<string>;
  modelIds(): Promise<string[]>;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close();
});

async function harness(daemon: TestDaemon, workers: TestWorker[]): Promise<Harness> {
  daemon.start();
  for (const worker of workers) worker.start();
  const app = createApp({
    db: new Database(':memory:'),
    webDistDir: '/nonexistent',
    fetch: globalThis.fetch,
    now: () => new Date(),
    connector: connectorById,
    connectors: () => CONNECTORS,
    adminToken: ADMIN,
  });
  const admin = (path: string, method: string, body?: unknown) => app.handle(new Request(
    `http://gateway${path}`,
    {
      method,
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  ));
  const key = await admin('/api/gateway/keys', 'POST', { name: 'integration key' });
  expect(key.status).toBe(201);
  const { token } = await key.json() as { token: string };
  const client = (path: string, body?: unknown, signal?: AbortSignal) => app.handle(new Request(
    `http://gateway${path}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    },
  ));
  const h: Harness = {
    app, daemon, admin, client,
    async createKey() { return token; },
    async createProvider(apiKey = DAEMON_TOKEN) {
      const response = await admin('/api/gateway/providers', 'POST', {
        name: 'AI-Hub daemon', connector: 'aihub', baseUrl: daemon.url, apiKey, autoPublish: true,
      });
      expect(response.status).toBe(201);
      const { provider } = await response.json() as { provider: { id: string } };
      return provider.id;
    },
    async modelIds() {
      const response = await client('/v1/models');
      expect(response.status).toBe(200);
      const body = await response.json() as { data: Array<{ id: string }> };
      return body.data.map((model) => model.id);
    },
    async close() {
      await app.close();
      await daemon.stop();
      for (const worker of workers) await worker.stop();
    },
  };
  harnesses.push(h);
  return h;
}

function readyService(worker: TestWorker, patch: Partial<ServiceInstance> = {}): ServiceInstance {
  return {
    id: `svc-${crypto.randomUUID()}`,
    status: 'READY',
    modelName: 'local-model',
    port: worker.port,
    maxConcurrency: 1,
    contextLength: 32_768,
    maxOutputTokens: 4_096,
    protocols: ['chat'],
    ...patch,
  };
}

function chatBody(stream = false): Record<string, unknown> {
  return { model: 'local-model', messages: [{ role: 'user', content: 'hi' }], ...(stream ? { stream } : {}) };
}

describe('AI-Hub provider', () => {
  test('a ready service becomes a model, a stopped one disappears, and a restart brings it back', async () => {
    const worker = new TestWorker('ready answer');
    const daemon = new TestDaemon(DAEMON_TOKEN, []);
    const h = await harness(daemon, [worker]);
    const service = readyService(worker);
    daemon.setServices([service]);
    await h.createProvider();
    await until('model discovered', async () => (await h.modelIds()).includes('local-model'));

    const answer = await h.client('/v1/chat/completions', chatBody());
    expect(answer.status).toBe(200);
    expect((await answer.json() as { choices: Array<{ message: { content: string } }> })
      .choices[0].message.content).toBe('ready answer');

    daemon.setServices([{ ...service, status: 'STOPPED', port: null }]);
    await until('model gone', async () => !(await h.modelIds()).includes('local-model'));
    const refused = await h.client('/v1/chat/completions', chatBody());
    expect(refused.status).toBe(503);

    daemon.setServices([service]);
    await until('model back', async () => (await h.modelIds()).includes('local-model'));
    expect((await h.client('/v1/chat/completions', chatBody())).status).toBe(200);
  });

  test('inference goes straight to the worker with the derived token, never through the daemon', async () => {
    const worker = new TestWorker('direct answer');
    const daemon = new TestDaemon(DAEMON_TOKEN, []);
    const h = await harness(daemon, [worker]);
    daemon.setServices([readyService(worker)]);
    await h.createProvider();
    await until('model discovered', async () => (await h.modelIds()).includes('local-model'));

    const answer = await h.client('/v1/chat/completions', chatBody());
    expect(answer.status).toBe(200);
    expect(worker.calls).toHaveLength(1);
    expect(worker.calls[0].authorization).toBe(`Bearer ${WORKER_TOKEN}`);
    expect(worker.calls[0].authorization).not.toContain(DAEMON_TOKEN);
    expect(daemon.inferenceRequests).toBe(0);
    expect((await daemon.get('/api/v1/internal/chat/completions')).status).toBe(404);
    expect(daemon.inferenceRequests).toBe(1);
  });

  test('a streaming answer passes through untouched', async () => {
    const worker = new TestWorker('streamed answer');
    const daemon = new TestDaemon(DAEMON_TOKEN, []);
    const h = await harness(daemon, [worker]);
    daemon.setServices([readyService(worker)]);
    await h.createProvider();
    await until('model discovered', async () => (await h.modelIds()).includes('local-model'));

    const answer = await h.client('/v1/chat/completions', chatBody(true));
    expect(answer.status).toBe(200);
    const text = await answer.text();
    expect(text).toContain('streamed answer');
    expect(text).toContain('[DONE]');
    expect(worker.maxInflight).toBe(1);
    // The stream held its place until the last frame; another request has one available now.
    expect((await h.client('/v1/chat/completions', chatBody())).status).toBe(200);
  });

  test('concurrent requests wait in the gateway and never exceed the worker concurrency', async () => {
    const worker = new TestWorker('held answer', WORKER_TOKEN, true);
    const daemon = new TestDaemon(DAEMON_TOKEN, []);
    const h = await harness(daemon, [worker]);
    daemon.setServices([readyService(worker, { maxConcurrency: 1 })]);
    await h.createProvider();
    await until('model discovered', async () => (await h.modelIds()).includes('local-model'));

    const pending = [0, 1, 2, 3].map(() => h.client('/v1/chat/completions', chatBody()));
    await until('one worker request', () => worker.calls.length === 1);
    expect(worker.inflight).toBe(1);
    for (let released = 0; released < 4; released += 1) {
      worker.releaseOne();
      if (released < 3) await until(`${released + 2} worker requests`, () => worker.calls.length === released + 2);
    }
    const answers = await Promise.all(pending);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200]);
    expect(worker.maxInflight).toBe(1);
  });

  test('two replicas of one model expose one model and share the requests', async () => {
    const first = new TestWorker('first');
    const second = new TestWorker('second');
    const daemon = new TestDaemon(DAEMON_TOKEN, []);
    const h = await harness(daemon, [first, second]);
    daemon.setServices([
      readyService(first, { id: 'svc-a', maxConcurrency: 1 }),
      readyService(second, { id: 'svc-b', maxConcurrency: 1 }),
    ]);
    await h.createProvider();
    await until('model discovered', async () => (await h.modelIds()).includes('local-model'));

    const listed = await h.modelIds();
    expect(listed.filter((id) => id === 'local-model')).toHaveLength(1);
    const answers = await Promise.all([0, 1].map(() => h.client('/v1/chat/completions', chatBody())));
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(first.calls.length + second.calls.length).toBe(2);
    expect(first.maxInflight).toBeLessThanOrEqual(1);
    expect(second.maxInflight).toBeLessThanOrEqual(1);
    expect(first.calls.length).toBe(1);
    expect(second.calls.length).toBe(1);
  });

  test('a client that leaves a streaming answer disconnects the worker', async () => {
    const worker = new TestWorker('open answer', WORKER_TOKEN, false, 'open');
    const daemon = new TestDaemon(DAEMON_TOKEN, []);
    const h = await harness(daemon, [worker]);
    daemon.setServices([readyService(worker)]);
    await h.createProvider();
    await until('model discovered', async () => (await h.modelIds()).includes('local-model'));

    const controller = new AbortController();
    const answer = await h.client('/v1/chat/completions', chatBody(true), controller.signal);
    expect(answer.status).toBe(200);
    const reader = answer.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel();
    await until('worker disconnected', () => worker.disconnected);
    expect(worker.inflight).toBe(0);
  });

  test('a daemon that refuses the token marks its credential rejected', async () => {
    const daemon = new TestDaemon(DAEMON_TOKEN, []);
    const worker = new TestWorker();
    const h = await harness(daemon, [worker]);
    const providerId = await h.createProvider('wrong-daemon-token-0123456789');
    await until('credential rejected', async () => {
      const response = await h.admin('/api/gateway/providers', 'GET');
      const body = await response.json() as { providers: Array<{ id: string; credentialRejected: boolean }> };
      return body.providers.find((provider) => provider.id === providerId)?.credentialRejected === true;
    });
    expect(await h.modelIds()).not.toContain('local-model');
  });
});
