// A daemon as the gateway sees it: the node identity route and an event stream the test drives.
import { type DaemonEvent, type DaemonSnapshot, type NodeIdentity } from '../connectors/dgp';

export function emptySnapshot(patch: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return { services: [], ...patch };
}

interface Stream {
  controller: ReadableStreamDefaultController<Uint8Array>;
}

export class FakeDaemon {
  public identity: NodeIdentity = { nodeId: 'node-a', hostname: 'host-a', version: '0', apiVersion: 1 };
  /** What the identity route answers instead of the identity, when set. */
  public identityBody: unknown = undefined;
  /** Identity requests are answered only once this resolves, when set. */
  public identityGate: Promise<void> | null = null;
  public token: string | null = null;
  /** HTTP status forced on both routes, when set. */
  public failWith: number | null = null;
  /** First event of every new stream; null opens the stream and sends nothing. */
  public opening: DaemonEvent | null = { type: 'snapshot', data: emptySnapshot() };
  /** When each identity request arrived (ms). */
  public identityRequests: number[] = [];
  public authorizations: Array<string | null> = [];

  private server: ReturnType<typeof Bun.serve> | null = null;
  private streams = new Set<Stream>();
  private readonly encoder = new TextEncoder();
  private port = 0;

  public get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  public get openStreams(): number {
    return this.streams.size;
  }

  /** Starts listening; after stop() it comes back on the same port. */
  public start(): void {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: this.port,
      idleTimeout: 0,
      fetch: (req) => this.handle(req),
    });
    this.port = this.server.port!;
  }

  /** Like a killed daemon: connections are cut and the port refuses new ones. */
  public async stop(): Promise<void> {
    this.closeStreams();
    await this.server?.stop(true);
    this.server = null;
  }

  public send(event: DaemonEvent): void {
    this.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  public keepalive(): void {
    this.write(': keepalive\n\n');
  }

  /** Raw bytes to every open stream. */
  public write(chunk: string | Uint8Array): void {
    const bytes = typeof chunk === 'string' ? this.encoder.encode(chunk) : chunk;
    for (const stream of this.streams) stream.controller.enqueue(bytes);
  }

  /** The daemon ends its streams; it keeps listening. */
  public closeStreams(): void {
    for (const stream of this.streams) stream.controller.close();
    this.streams.clear();
  }

  private handle(req: Request): Response | Promise<Response> {
    const { pathname } = new URL(req.url);
    const authorization = req.headers.get('authorization');
    this.authorizations.push(authorization);
    if (this.failWith !== null) return new Response('failed', { status: this.failWith });
    if (this.token !== null && authorization !== `Bearer ${this.token}`) {
      return new Response('unauthorized', { status: 401 });
    }

    if (pathname === '/api/v1/node') {
      this.identityRequests.push(performance.now());
      const answer = () => Response.json(this.identityBody === undefined ? this.identity : this.identityBody);
      return this.identityGate === null ? answer() : this.identityGate.then(answer);
    }
    if (pathname === '/api/v1/events') {
      const stream = {} as Stream;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          stream.controller = controller;
          this.streams.add(stream);
          if (this.opening) {
            controller.enqueue(this.encoder.encode(`data: ${JSON.stringify(this.opening)}\n\n`));
          }
        },
        cancel: () => {
          this.streams.delete(stream);
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  }
}
