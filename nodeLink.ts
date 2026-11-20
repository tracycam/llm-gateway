import {
  applyDaemonEvent,
  DAEMON_API_VERSION,
  type DaemonEvent,
  type DaemonSnapshot,
  type NodeIdentity,
} from './connectors/dgp';

export interface NodeLinkState {
  online: boolean;
  /** Why the node is not online; null while it is. */
  reason: string | null;
  identity: NodeIdentity | null;
  /** The daemon's state, moved forward by its events. Null whenever the node is not online. */
  snapshot: DaemonSnapshot | null;
}

export interface NodeLinkOptions {
  /** Base URL of the daemon, without a trailing slash. */
  url: string;
  /** The daemon's admin token; null for a daemon that has none. */
  token: string | null;
  /**
   * Node id recorded when the node was registered; a daemon that answers with another id is
   * refused. Null for a provider whose identity is learned on the first handshake: that id is
   * latched then, and every later connection must still report it.
   */
  expectedNodeId: string | null;
  /** Called on every change of `online` or `reason`. */
  onChange: (state: NodeLinkState) => void;
  /** Called for every daemon event received while online, after it was applied to the snapshot. */
  onEvent: (event: DaemonEvent) => void;
  /** Without a byte from the daemon for this long, the connection is dropped. */
  watchdogMs?: number;
  handshakeTimeoutMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
}

// The daemon sends a keepalive every 15 s: two missed ones plus slack.
const WATCHDOG_MS = 35_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;

const EVENT_TYPES: Record<string, true> = {
  snapshot: true,
  state: true,
  log: true,
  logs_cleared: true,
  app_log: true,
  app_logs_cleared: true,
};

/** Why one connection ended. */
class Disconnected extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseNodeIdentity(value: unknown): NodeIdentity {
  if (
    !isRecord(value) ||
    typeof value.nodeId !== 'string' ||
    typeof value.hostname !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.apiVersion !== 'number'
  ) {
    throw new Disconnected('节点身份格式无法识别');
  }
  if (value.apiVersion !== DAEMON_API_VERSION) {
    throw new Disconnected(`接口版本不兼容（节点为 ${value.apiVersion}，网关为 ${DAEMON_API_VERSION}）`);
  }
  const identity: NodeIdentity = {
    nodeId: value.nodeId,
    hostname: value.hostname,
    version: value.version,
    apiVersion: DAEMON_API_VERSION,
  };
  if (value.workerPortRange !== undefined) {
    const range = value.workerPortRange;
    if (!Array.isArray(range) || range.length !== 2) throw new Disconnected('节点身份格式无法识别');
    const [min, max] = range;
    if (!isPort(min) || !isPort(max) || min > max) throw new Disconnected('节点身份格式无法识别');
    identity.workerPortRange = [min, max];
  }
  if (value.capabilities !== undefined) {
    const capabilities = value.capabilities;
    if (!isRecord(capabilities) || typeof capabilities.workerProtocols !== 'boolean') {
      throw new Disconnected('节点身份格式无法识别');
    }
    identity.capabilities = { workerProtocols: capabilities.workerProtocols };
  }
  return identity;
}

/** An inclusive TCP port a worker may listen on. */
function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function parseEvent(text: string): DaemonEvent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Disconnected('事件无法解析');
  }
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.data)) {
    throw new Disconnected('事件无法解析');
  }
  if (EVENT_TYPES[value.type] !== true) throw new Disconnected('事件无法解析');
  // Both carrier events must carry the service list: it is the only state the gateway mirrors.
  if ((value.type === 'snapshot' || value.type === 'state') && !Array.isArray(value.data.services)) {
    throw new Disconnected('事件无法解析');
  }
  return value as unknown as DaemonEvent;
}

/** Fetches the daemon's identity; throws with the reason shown to the administrator. */
export async function fetchNodeIdentity(
  url: string,
  token: string | null,
  signal: AbortSignal
): Promise<NodeIdentity> {
  const response = await request(`${url}/api/v1/node`, token, signal);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Disconnected('节点身份格式无法识别');
  }
  return parseNodeIdentity(body);
}

async function request(url: string, token: string | null, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Disconnected(`连接失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (response.status === 401) throw new Disconnected('令牌被拒');
  if (!response.ok) throw new Disconnected(`节点返回 ${response.status}`);
  return response;
}

/**
 * One gateway-to-daemon connection: checks who answers, then follows the daemon's event
 * stream, which is both the source of the node's state and the proof that it is alive.
 * Reconnects by itself until stop(). A change of URL or token means a new NodeLink.
 */
export class NodeLink {
  private current: NodeLinkState = { online: false, reason: '正在连接', identity: null, snapshot: null };
  private stopped = false;
  /** The id the first successful handshake reported, for an `expectedNodeId` of null. */
  private latchedNodeId: string | null = null;
  private attempt: AbortController | null = null;
  private wakeRetry: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  constructor(private readonly options: NodeLinkOptions) {}

  public get state(): NodeLinkState {
    return this.current;
  }

  public start(): void {
    if (this.loop) throw new Error('NodeLink already started');
    this.loop = this.run();
  }

  /** Ends the connection. No callback fires after this is called. */
  public async stop(): Promise<void> {
    this.stopped = true;
    this.attempt?.abort();
    this.wakeRetry?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    const retryMin = this.options.retryMinMs ?? RETRY_MIN_MS;
    const retryMax = this.options.retryMaxMs ?? RETRY_MAX_MS;
    let delay = retryMin;

    while (!this.stopped) {
      const attempt = new AbortController();
      this.attempt = attempt;
      let reason: string;
      try {
        await this.connect(attempt, () => {
          delay = retryMin;
        });
        reason = '事件流断开';
      } catch (err) {
        if (err instanceof Disconnected) {
          reason = err.message;
        } else {
          reason = `连接失败：${err instanceof Error ? err.message : String(err)}`;
        }
      } finally {
        attempt.abort();
      }
      if (this.stopped) return;

      this.change({ online: false, reason, identity: this.current.identity, snapshot: null });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wakeRetry = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeRetry = null;
      delay = Math.min(delay * 2, retryMax);
    }
  }

  /** One connection, from identity check to the end of the event stream. */
  private async connect(attempt: AbortController, onOnline: () => void): Promise<void> {
    const { url, token, expectedNodeId } = this.options;

    const handshake = setTimeout(() => attempt.abort(), this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    let identity: NodeIdentity;
    let response: Response;
    try {
      identity = await fetchNodeIdentity(url, token, attempt.signal);
      const expected = expectedNodeId ?? this.latchedNodeId;
      if (expected !== null && identity.nodeId !== expected) throw new Disconnected('节点号与登记时不符');
      this.latchedNodeId ??= identity.nodeId;
      response = await request(`${url}/api/v1/events`, token, attempt.signal);
    } catch (err) {
      if (attempt.signal.aborted && !this.stopped) throw new Disconnected('连接失败：握手超时');
      throw err;
    } finally {
      clearTimeout(handshake);
    }
    if (!response.body) throw new Disconnected('事件流断开');

    const watchdogMs = this.options.watchdogMs ?? WATCHDOG_MS;
    let timedOut = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const feedWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        timedOut = true;
        attempt.abort();
      }, watchdogMs);
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    feedWatchdog();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        feedWatchdog();
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end === -1) break;
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          // Keepalives are comment frames: they feed the watchdog and carry nothing.
          if (!frame.startsWith('data: ')) continue;
          this.receive(parseEvent(frame.slice(6)), identity, onOnline);
        }
      }
    } catch (err) {
      if (timedOut) throw new Disconnected('心跳超时');
      throw err;
    } finally {
      clearTimeout(watchdog);
    }
  }

  private receive(event: DaemonEvent, identity: NodeIdentity, onOnline: () => void): void {
    if (this.stopped) return;
    if (!this.current.online) {
      // The daemon opens every stream with its full state; the node is online from then on.
      if (event.type !== 'snapshot') throw new Disconnected('事件流未以完整状态开头');
      onOnline();
      this.change({ online: true, reason: null, identity, snapshot: event.data });
      return;
    }
    this.current = { ...this.current, snapshot: applyDaemonEvent(this.current.snapshot!, event) };
    this.options.onEvent(event);
  }

  private change(next: NodeLinkState): void {
    const same = next.online === this.current.online && next.reason === this.current.reason;
    this.current = next;
    if (!same) this.options.onChange(next);
  }
}
