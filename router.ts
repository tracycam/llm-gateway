// Which route of a model a request goes to, and what an upstream answer does to a route.
// Pure state: no I/O and no clock; the time is passed in as milliseconds.

const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 300_000;
/** Cooldown after FAILURE_THRESHOLD failures in a row, and after a 429 that names no delay. */
const UNAVAILABLE_COOLDOWN_MS = 30_000;
/** Cooldown of a route that is itself at fault: credential refused, account unpaid, model gone. */
const ROUTE_COOLDOWN_MS = 300_000;
const FAILURE_THRESHOLD = 3;

export interface Candidate {
  /** Route id. */
  id: string;
  weight: number;
  /** Creation order; the lower one wins a tie. */
  order: number;
  /** Most requests the route takes at once; null = no cap. */
  limit: number | null;
  /**
   * The provider says this model speaks the client's protocol, so the request is passed through
   * rather than translated. Among otherwise equal routes, a passthrough one is preferred.
   */
  native?: boolean;
}

/** What an upstream answer means for the request and for the route. */
export type Outcome =
  | { kind: 'ok' }
  /** The request itself is at fault: another route would refuse it too. */
  | { kind: 'client' }
  /** This route is at fault; another one may work. */
  | { kind: 'route' }
  | { kind: 'rate-limited'; retryAfterMs: number | null }
  /** 5xx, or the connection failed. */
  | { kind: 'unavailable' };

export type Pick =
  | { route: Candidate }
  /** Every usable route is at its limit: the caller waits. */
  | { none: 'all-busy' }
  /** No route can be tried: the caller answers 503. */
  | { none: 'unavailable' };

/** The delay a Retry-After header asks for (seconds, or a date), within 1 s – 5 min. */
function retryAfterMs(header: string | null, now: number): number | null {
  const value = header?.trim() ?? '';
  const delay = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - now;
  if (Number.isNaN(delay)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, delay));
}

/** `status` is null when the connection failed before any answer. */
export function classify(status: number | null, retryAfter: string | null, now: number): Outcome {
  if (status === null || status >= 500) return { kind: 'unavailable' };
  if (status >= 200 && status < 300) return { kind: 'ok' };
  if (status === 429) return { kind: 'rate-limited', retryAfterMs: retryAfterMs(retryAfter, now) };
  if (status === 401 || status === 402 || status === 403 || status === 404) return { kind: 'route' };
  return { kind: 'client' };
}

interface RouteState {
  inflight: number;
  /** `unavailable` outcomes in a row. */
  failures: number;
  cooldownUntil: number;
}

export class Router {
  private readonly states = new Map<string, RouteState>();

  /**
   * The route to try next: of the routes not yet tried, not cooling down and below their
   * limit, the one whose load would be lowest with this request on it. A route whose provider
   * says this model speaks the client's protocol is preferred over one that needs translation;
   * among those, load decides, then creation order. With `sequential`, the first free route in
   * candidate order wins instead: provider preferences and price sorts are applied by ordering
   * the candidates.
   */
  public pick(
    candidates: Candidate[], tried: ReadonlySet<string>, now: number, sequential = false,
  ): Pick {
    const usable = candidates.filter((route) => !tried.has(route.id) && this.cooldownUntil(route.id, now) === null);
    const free = usable.filter((route) => route.limit === null || this.inflight(route.id) < route.limit);
    if (free.length === 0) return { none: usable.length === 0 ? 'unavailable' : 'all-busy' };
    if (sequential) return { route: free[0] };

    const native = free.filter((route) => route.native);
    const pool = native.length > 0 ? native : free;
    const load = (route: Candidate) => (this.inflight(route.id) + 1) / route.weight;
    return {
      route: pool.reduce((best, route) => (load(route) - load(best) || route.order - best.order) < 0 ? route : best),
    };
  }

  /** A request starts on the route. */
  public begin(id: string): void {
    this.state(id).inflight += 1;
  }

  /** The request is over, whatever its outcome. */
  public end(id: string): void {
    const state = this.states.get(id);
    if (!state || state.inflight === 0) throw new Error(`Route ${id} has no request in flight`);
    state.inflight -= 1;
  }

  public report(id: string, outcome: Outcome, now: number): void {
    const state = this.state(id);
    switch (outcome.kind) {
      case 'client':
        return;
      case 'ok':
        state.failures = 0;
        return;
      case 'unavailable':
        state.failures += 1;
        if (state.failures < FAILURE_THRESHOLD) return;
        state.failures = 0;
        return this.coolDown(state, now + UNAVAILABLE_COOLDOWN_MS);
      case 'rate-limited':
        return this.coolDown(state, now + (outcome.retryAfterMs ?? UNAVAILABLE_COOLDOWN_MS));
      case 'route':
        return this.coolDown(state, now + ROUTE_COOLDOWN_MS);
    }
  }

  public inflight(id: string): number {
    return this.states.get(id)?.inflight ?? 0;
  }

  /** When the route may be tried again; null when it is not cooling down. */
  public cooldownUntil(id: string, now: number): number | null {
    const until = this.states.get(id)?.cooldownUntil ?? 0;
    return until > now ? until : null;
  }

  /** The route was deleted. */
  public forget(id: string): void {
    this.states.delete(id);
  }

  /** A cooldown is never shortened by a later, shorter one. */
  private coolDown(state: RouteState, until: number): void {
    state.cooldownUntil = Math.max(state.cooldownUntil, until);
  }

  private state(id: string): RouteState {
    let state = this.states.get(id);
    if (!state) {
      state = { inflight: 0, failures: 0, cooldownUntil: 0 };
      this.states.set(id, state);
    }
    return state;
  }
}
