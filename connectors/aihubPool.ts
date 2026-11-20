// The AI-Hub daemon pool: one live control-plane link per `aihub` provider, its ready service
// replicas, and the per-replica concurrency gate that fronts them.
import { Notifier } from '../admission';
import type { DaemonEvent, ServiceInstance } from './dgp';
import { deriveWorkerToken } from './dgp';
import type { ModelStore } from '../modelStore';
import { NodeLink, type NodeLinkOptions, type NodeLinkState } from '../nodeLink';
import type { Protocol } from '../protocols/protocol';
import type { ProviderModelInput, ProviderStore } from '../providerStore';
import type { Outcome } from '../router';
import { protocolFor, type LeaseResult, type UpstreamLease, type UpstreamTarget } from './connector';
import { apiKeyOf } from './http';

/** One ready worker of one daemon, and the concurrency it accepts. */
export interface Replica {
  /** `${serviceId}:${port}`; a restarted worker on a new port is a new replica. */
  key: string;
  serviceId: string;
  port: number;
  modelName: string;
  maxConcurrency: number;
  protocols: Protocol[];
  contextLength: number;
  maxOutputTokens: number | null;
  inflight: number;
  /** When this replica may be tried again; 0 when it is not cooling down. */
  cooldownUntil: number;
}

/** A place a request waits for, in arrival order per provider and model. */
interface Waiter {
  providerId: string;
  upstreamModel: string;
  inbound: Protocol;
  exclude: ReadonlySet<string>;
  signal: AbortSignal;
  settled: boolean;
  abort: () => void;
  settle(result: LeaseResult): void;
}

/** What the pool reads and writes; the tests give it a clock of their own. */
export interface AihubPoolDeps {
  providers: ProviderStore;
  models: ModelStore;
  now(): Date;
  nodeTiming?: Pick<NodeLinkOptions, 'watchdogMs' | 'handshakeTimeoutMs' | 'retryMinMs' | 'retryMaxMs'>;
}

interface ProviderState {
  providerId: string;
  /** Base URL without a trailing slash. */
  url: string;
  /** The daemon's admin token; never sent to a worker. */
  token: string | null;
  link: NodeLink | null;
  replicas: Replica[];
}

/** The order protocols are listed in, and the order aggregation returns them in. */
const PROTOCOLS: readonly Protocol[] = ['chat', 'messages', 'responses'];
/** A replica that just failed is left alone this long, unless the outcome says otherwise. */
const UNAVAILABLE_COOLDOWN_MS = 30_000;
const ROUTE_COOLDOWN_MS = 300_000;

/** A service that can be routed now, as a replica; null when it cannot. */
function replicaOf(service: ServiceInstance): Replica | null {
  if (service.status !== 'READY') return null;
  const port = service.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const modelName = typeof service.modelName === 'string' ? service.modelName.trim() : '';
  if (modelName === '') return null;
  const protocols: Protocol[] = Array.isArray(service.protocols)
    ? PROTOCOLS.filter((protocol) => service.protocols!.includes(protocol))
    : ['chat'];
  const contextLength = Number.isFinite(service.contextLength) ? service.contextLength : 0;
  const maxOutputTokens = typeof service.maxOutputTokens === 'number'
    && Number.isFinite(service.maxOutputTokens) && service.maxOutputTokens > 0
    ? service.maxOutputTokens : null;
  const concurrency = Number.isFinite(service.maxConcurrency) ? Math.floor(service.maxConcurrency) : 1;
  return {
    key: `${service.id}:${port}`,
    serviceId: service.id,
    port,
    modelName,
    maxConcurrency: Math.max(1, concurrency),
    protocols,
    contextLength,
    maxOutputTokens,
    inflight: 0,
    cooldownUntil: 0,
  };
}

/** The smallest positive value, or null when none is positive. */
function minPositive(values: readonly number[]): number | null {
  let smallest: number | null = null;
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) continue;
    if (smallest === null || value < smallest) smallest = value;
  }
  return smallest;
}

/** The interfaces every replica speaks, else the ones any of them speaks. */
function aggregatedProtocols(replicas: readonly Replica[]): Protocol[] {
  const lists = replicas.map((replica) => replica.protocols);
  const shared = PROTOCOLS.filter((protocol) => lists.every((list) => list.includes(protocol)));
  const spoken = shared.length > 0 ? shared : PROTOCOLS.filter((protocol) => lists.some((list) => list.includes(protocol)));
  return [...spoken];
}

/** The models a daemon's ready services expose, one per `modelName`. */
export function discoverModels(services: readonly ServiceInstance[]): ProviderModelInput[] {
  const byModel = new Map<string, Replica[]>();
  for (const service of services) {
    const replica = replicaOf(service);
    if (!replica) continue;
    const group = byModel.get(replica.modelName);
    if (group) group.push(replica);
    else byModel.set(replica.modelName, [replica]);
  }
  return [...byModel].map(([upstreamId, replicas]) => ({
    upstreamId,
    contextLength: minPositive(replicas.map((replica) => replica.contextLength)),
    maxOutputTokens: minPositive(replicas.map((replica) => replica.maxOutputTokens ?? 0)),
    price: { input: null, output: null, cacheRead: null },
    protocols: aggregatedProtocols(replicas),
  }));
}

/** The ready replicas of one daemon, keeping the inflight and cooldown of a replica that stayed. */
function replicasOf(services: readonly ServiceInstance[], previous: readonly Replica[]): Replica[] {
  const before = new Map(previous.map((replica) => [replica.key, replica]));
  const replicas: Replica[] = [];
  for (const service of services) {
    const replica = replicaOf(service);
    if (!replica) continue;
    const old = before.get(replica.key);
    replicas.push(old ? { ...old, ...replica, inflight: old.inflight, cooldownUntil: old.cooldownUntil } : replica);
  }
  return replicas;
}

/**
 * The `aihub` providers' live daemons. One link per provider, one replica per ready service,
 * and one queue per model that wakes waiting requests when a place, a replica or the daemon
 * changes.
 */
export class AihubPool {
  private readonly states = new Map<string, ProviderState>();
  private readonly queues = new Map<string, Waiter[]>();
  private readonly capacity = new Notifier();
  private closed = false;

  constructor(private readonly deps: AihubPoolDeps) {}

  /** Starts a link for every enabled `aihub` provider. */
  public start(): void {
    for (const provider of this.deps.providers.list()) this.reconcile(provider.id);
  }

  /** Starts, restarts or stops one provider's link to match its stored row. */
  public reconcile(providerId: string): void {
    if (this.closed) return;
    const provider = this.deps.providers.get(providerId);
    const existing = this.states.get(providerId);
    if (!provider || provider.connector !== 'aihub' || !provider.enabled) {
      if (existing) this.stopProvider(providerId);
      return;
    }
    const url = (provider.baseUrl ?? '').replace(/\/+$/, '');
    if (url === '') {
      this.stopProvider(providerId);
      this.deps.providers.recordModelsError(providerId, 'Base URL is required');
      return;
    }
    let token: string | null;
    try {
      token = apiKeyOf(this.deps.providers.credential(providerId));
    } catch {
      this.stopProvider(providerId);
      this.deps.providers.recordModelsError(providerId, 'Invalid API key credential');
      return;
    }
    if (existing && existing.url === url && existing.token === token) return;
    if (existing) void existing.link?.stop();

    const state: ProviderState = { providerId, url, token, link: null, replicas: [] };
    this.states.set(providerId, state);
    const link = new NodeLink({
      ...this.deps.nodeTiming,
      url,
      token,
      expectedNodeId: null,
      onChange: (next) => this.changed(state, next),
      onEvent: (event) => this.received(state, event),
    });
    state.link = link;
    link.start();
  }

  /** Ends every link; no callback fires after this resolves. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const links = [...this.states.values()].flatMap((state) => state.link ? [state.link.stop()] : []);
    this.states.clear();
    for (const key of [...this.queues.keys()]) this.drain(key);
    this.capacity.notify();
    await Promise.all(links);
  }

  /** The models a live daemon exposes now; null when this provider has no online link. */
  public liveModels(providerId: string): ProviderModelInput[] | null {
    const state = this.states.get(providerId);
    if (!state || !state.link?.state.online) return null;
    return discoverModels(state.link.state.snapshot?.services ?? []);
  }

  /** Whether requests for this model can go to a ready replica now. */
  public available(providerId: string, upstreamModel: string): boolean {
    return (this.states.get(providerId)?.replicas ?? [])
      .some((replica) => replica.modelName === upstreamModel);
  }

  /** The concurrent requests all ready replicas of this model accept together. */
  public limit(providerId: string, upstreamModel: string): number {
    return (this.states.get(providerId)?.replicas ?? [])
      .filter((replica) => replica.modelName === upstreamModel)
      .reduce((sum, replica) => sum + replica.maxConcurrency, 0);
  }

  /** Resolves when a place, a replica or a daemon's state may have changed. */
  public waitForCapacity(signal: AbortSignal): Promise<void> {
    return this.capacity.wait(signal);
  }

  /** Wakes every request waiting for capacity. */
  public notifyCapacity(): void {
    this.capacity.notify();
  }

  /** How many requests wait for a place on this model now. */
  public waiting(providerId: string, upstreamModel: string): number {
    return this.queues.get(`${providerId}\n${upstreamModel}`)?.length ?? 0;
  }

  /** Waits for a free place on a ready, non-cooling replica of this model. */
  public acquire(
    providerId: string,
    upstreamModel: string,
    inbound: Protocol,
    exclude: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<LeaseResult> {
    if (signal.aborted) return Promise.resolve({ kind: 'abandoned' });
    const key = `${providerId}\n${upstreamModel}`;
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) {
      const direct = this.tryAcquire(providerId, upstreamModel, inbound, exclude);
      if (direct.kind !== 'wait') return Promise.resolve(direct);
    }
    const { promise, resolve } = Promise.withResolvers<LeaseResult>();
    const waiting = this.queues.get(key);
    const line = waiting ?? [];
    if (!waiting) this.queues.set(key, line);
    const waiter: Waiter = {
      providerId, upstreamModel, inbound, exclude, signal, settled: false,
      abort: () => { waiter.settle({ kind: 'abandoned' }); },
      settle: (result) => {
        if (waiter.settled) return;
        waiter.settled = true;
        signal.removeEventListener('abort', waiter.abort);
        const current = this.queues.get(key);
        if (current) {
          const index = current.indexOf(waiter);
          if (index !== -1) current.splice(index, 1);
          if (current.length === 0) this.queues.delete(key);
        }
        resolve(result);
      },
    };
    line.push(waiter);
    signal.addEventListener('abort', waiter.abort, { once: true });
    this.drain(key);
    return promise;
  }

  /** A target for a direct call outside the lease path; null when no replica is ready. */
  public target(providerId: string, upstreamModel: string, inbound: Protocol): UpstreamTarget | null {
    const state = this.states.get(providerId);
    const replica = state?.replicas.find((item) => item.modelName === upstreamModel);
    return state && replica ? this.targetOf(state, replica, inbound) : null;
  }

  /** A target for one replica: the worker's own address and the derived worker token. */
  private targetOf(state: ProviderState, replica: Replica, inbound: Protocol): UpstreamTarget {
    const base = new URL(state.url);
    const protocol = protocolFor(replica.protocols, inbound, 'chat');
    const path = protocol === 'chat' ? '/v1/chat/completions'
      : protocol === 'messages' ? '/v1/messages' : '/v1/responses';
    const headers: Record<string, string> = {};
    if (state.token !== null) headers.Authorization = `Bearer ${deriveWorkerToken(state.token)}`;
    return { url: `${base.protocol}//${base.hostname}:${replica.port}${path}`, headers, protocol };
  }

  /** The replica to try now: free, not cooling, lowest load; 'wait' when all are at capacity. */
  private tryAcquire(
    providerId: string,
    upstreamModel: string,
    inbound: Protocol,
    exclude: ReadonlySet<string>,
  ): LeaseResult | { kind: 'wait' } {
    const state = this.states.get(providerId);
    const now = this.deps.now().getTime();
    const replicas = (state?.replicas ?? []).filter((replica) =>
      replica.modelName === upstreamModel &&
      !exclude.has(replica.key) &&
      replica.cooldownUntil <= now
    );
    if (replicas.length === 0) return { kind: 'unavailable' };
    const free = replicas.filter((replica) => replica.inflight < replica.maxConcurrency);
    if (free.length === 0) return { kind: 'wait' };
    free.sort((a, b) =>
      (a.inflight + 1) / a.maxConcurrency - (b.inflight + 1) / b.maxConcurrency ||
      (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0)
    );
    const replica = free[0];
    replica.inflight += 1;
    let released = false;
    const key = `${providerId}\n${upstreamModel}`;
    const lease: UpstreamLease = {
      target: this.targetOf(state!, replica, inbound),
      key: replica.key,
      release: () => {
        if (released) return;
        released = true;
        replica.inflight -= 1;
        this.drain(key);
        this.capacity.notify();
      },
      hasMore: (excluded) => {
        const at = this.deps.now().getTime();
        return (this.states.get(providerId)?.replicas ?? []).some((other) =>
          other.modelName === upstreamModel &&
          !excluded.has(other.key) &&
          other.cooldownUntil <= at
        );
      },
      fail: (outcome, at) => {
        if (outcome.kind === 'ok' || outcome.kind === 'client') return;
        const cooldown = outcome.kind === 'route' ? ROUTE_COOLDOWN_MS
          : outcome.kind === 'rate-limited' ? (outcome.retryAfterMs ?? UNAVAILABLE_COOLDOWN_MS)
            : UNAVAILABLE_COOLDOWN_MS;
        replica.cooldownUntil = Math.max(replica.cooldownUntil, at + cooldown);
      },
    };
    return { kind: 'lease', lease };
  }

  /** Grants the head of one queue while it can be served, then stops at its first wait. */
  private drain(key: string): void {
    const line = this.queues.get(key);
    if (!line) return;
    while (line.length > 0) {
      const head = line[0];
      if (head.signal.aborted) {
        head.settle({ kind: 'abandoned' });
        continue;
      }
      const result = this.tryAcquire(head.providerId, head.upstreamModel, head.inbound, head.exclude);
      if (result.kind === 'wait') return;
      head.settle(result);
    }
  }

  /** Wakes every queue of one provider, or every queue once the gateway closes. */
  private drainProvider(providerId: string | null): void {
    for (const key of [...this.queues.keys()]) {
      if (providerId !== null && !key.startsWith(`${providerId}\n`)) continue;
      this.drain(key);
    }
  }

  private changed(state: ProviderState, next: NodeLinkState): void {
    if (this.closed || this.states.get(state.providerId) !== state) return;
    if (next.online) {
      this.refresh(state);
    } else {
      state.replicas = [];
      this.deps.providers.recordModelsError(state.providerId, next.reason ?? '节点离线');
      if (next.reason === '令牌被拒') this.deps.providers.rejectCredential(state.providerId);
    }
    this.drainProvider(state.providerId);
    this.capacity.notify();
  }

  private received(state: ProviderState, event: DaemonEvent): void {
    if (this.closed || this.states.get(state.providerId) !== state) return;
    if (event.type !== 'snapshot' && event.type !== 'state') return;
    this.refresh(state);
    this.drainProvider(state.providerId);
    this.capacity.notify();
  }

  /** Rebuilds the replicas from the link's mirror and stores the models they expose. */
  private refresh(state: ProviderState): void {
    const services = state.link?.state.snapshot?.services ?? [];
    state.replicas = replicasOf(services, state.replicas);
    const now = this.deps.now();
    this.deps.providers.replaceModels(state.providerId, discoverModels(services), now);
    this.deps.providers.recordModelsSynced(state.providerId, now);
    if (this.deps.providers.get(state.providerId)?.autoPublish) this.publishNew(state.providerId, now);
  }

  /** Publishes this provider's discovered models that have no route here yet. */
  private publishNew(providerId: string, now: Date): void {
    const published = new Set<string>();
    for (const model of this.deps.models.list()) {
      for (const route of model.routes) {
        if (route.providerId === providerId) published.add(route.upstreamModel);
      }
    }
    for (const model of this.deps.providers.models(providerId)) {
      if (model.protocols?.length === 0) continue;
      if (published.has(model.upstreamId)) continue;
      this.deps.models.publish(providerId, model.upstreamId, now);
    }
  }

  private stopProvider(providerId: string): void {
    const state = this.states.get(providerId);
    if (state) {
      this.states.delete(providerId);
      void state.link?.stop();
    }
    this.drainProvider(providerId);
    this.capacity.notify();
  }
}
