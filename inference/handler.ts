// Authenticate, route and account for one client inference request.
import { Abandoned, QueueFull, type Admission } from '../admission';
import { randomBytes } from 'node:crypto';
import { providerAccess } from '../connectors/access';
import type { Connector, ProviderAccess, UpstreamLease } from '../connectors/connector';
import type { CredentialRenewals } from '../connectors/tokens';
import type { KeyRecord, KeyStore } from '../keyStore';
import { priceOf, type ModelRecord, type ModelStore } from '../modelStore';
import { costOf, type Price, type Usage } from '../pricing';
import { isObject, parseJson, type JsonObject } from '../protocols/json';
import { protocolModule, type Protocol } from '../protocols/protocol';
import { SseParser, type SseFrame } from '../protocols/sse';
import type { ProviderStore } from '../providerStore';
import type { Candidate, Router } from '../router';
import type { UsageStore } from '../usageStore';
import type { attempt, AttemptResult } from './attempt';
import { authenticate } from './auth';
import { providerRoutes, routingControls, type ProviderPreferences } from './controls';
import { usableRoutes, type UsableRoute } from './routes';

/**
 * Policy, not measured: the most requests of one key that may wait for a place at once. A
 * request that would become the next waiter of its key is refused at once.
 */
export const MAX_WAITING_PER_KEY = 64;

/** Policy, not measured: how long one request waits for a place before it is refused. */
export const MAX_QUEUE_WAIT_MS = 120_000;

/** Policy, not measured: the seconds a queue refusal asks the client to wait. */
export const QUEUE_RETRY_AFTER_S = 5;

const QUEUE_FULL_MESSAGE = 'Queue is full for this key';
const QUEUE_TIMEOUT_MESSAGE = 'Queue wait timed out';

/** Dependencies for a single inference request. */
export interface InferenceDeps {
  keys: KeyStore;
  models: ModelStore;
  providers: ProviderStore;
  usage: UsageStore;
  router: Router;
  admission: Admission;
  /** The connector with this id, or null. */
  connector(id: string): Connector | null;
  /** The gateway's one renewal registry, shared by every request on a provider. */
  renewals: CredentialRenewals;
  /** One attempt on one route. */
  attempt: typeof attempt;
  fetch: typeof fetch;
  now(): Date;
  /**
   * Starts the clock on one queue wait: `signal` fires when the wait has lasted too long;
   * `cancel` stops the clock.
   */
  queueDeadline(): { signal: AbortSignal; cancel(): void };
  /**
   * Resolves when a route's capacity may have changed: a replica freed a place, a service
   * stopped, or a daemon went offline. Absent when no connector limits concurrency.
   */
  waitForCapacity?(signal: AbortSignal): Promise<void>;
  /** Wakes the requests waiting for capacity; called after a route's request ends. */
  capacityChanged?(): void;
}

/** Validated request and its per-request dependencies. */
interface Context {
  /** Original request and its cancellation signal. */
  req: Request;
  /** Client protocol. */
  inbound: Protocol;
  /** Services and clock. */
  deps: InferenceDeps;
  /** Entry time in milliseconds. */
  start: number;
  /** Verified key. */
  key: KeyRecord;
  /** Enabled model. */
  model: ModelRecord;
  /** Parsed request body, with `models` and `provider` already removed. */
  body: JsonObject;
  /** Eligible routes in store order (or provider-preference order). */
  routes: UsableRoute[];
  /** The id this request is answered and logged under. */
  requestId: string;
  /** A Chat client asked for `usage.include`: add `cost` to its usage object. */
  costWanted: boolean;
  /** Provider preferences ordered the routes; pick in list order. */
  sequential: boolean;
}

type Failed = Extract<AttemptResult, { kind: 'failed' }>;
type Refused = Extract<AttemptResult, { kind: 'refused' }>;
type Complete = Extract<AttemptResult, { kind: 'complete' }>;
type Rejected = Extract<AttemptResult, { kind: 'rejected' }>;
type Stream = Extract<AttemptResult, { kind: 'stream' }>;

/** A response and the completion of its request. */
interface Served {
  /** The response returned to the client. */
  response: Response;
  /** Resolves when the request is over: at once, or when a stream has finished. */
  over: Promise<void>;
}

function errorResponse(inbound: Protocol, status: number, message: string, param?: string): Response {
  return Response.json(protocolModule(inbound).errorBody(status, message, param), { status });
}

/** A place in the key's concurrency, or the refusal that ends the request before one is granted. */
type Place = { release: () => void } | { response: Response };

/** One signal that fires when either source does, and that can be detached from both. */
interface Combined {
  /** Fires when the client leaves or the clock runs out. */
  signal: AbortSignal;
  /** Removes this signal's listeners from both sources. */
  dispose(): void;
}

function combinedSignal(first: AbortSignal, second: AbortSignal): Combined {
  const controller = new AbortController();
  const sources = [first, second];
  const fire = () => controller.abort();
  for (const source of sources) source.addEventListener('abort', fire);
  if (sources.some((source) => source.aborted)) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      for (const source of sources) source.removeEventListener('abort', fire);
    },
  };
}

/** The 429 that ends a queue wait, telling the client when to try again. */
function queueRefusal(inbound: Protocol, message: string): Response {
  const response = errorResponse(inbound, 429, message);
  response.headers.set('retry-after', String(QUEUE_RETRY_AFTER_S));
  return response;
}

/**
 * Take a place for this request, waiting in the key's queue when its concurrency is used up.
 * The wait ends by a grant, by the client leaving, by a full queue or by its deadline.
 */
async function waitForPlace(
  req: Request, inbound: Protocol, deps: InferenceDeps, key: KeyRecord,
): Promise<Place> {
  const deadline = deps.queueDeadline();
  const wait = combinedSignal(req.signal, deadline.signal);
  try {
    const release = await deps.admission.enter(
      key.id, key.maxConcurrency, wait.signal, MAX_WAITING_PER_KEY,
    );
    return { release };
  } catch (error) {
    if (error instanceof QueueFull) {
      return { response: queueRefusal(inbound, QUEUE_FULL_MESSAGE) };
    }
    // Admission rejects with Abandoned when the client left or the deadline fired.
    if (!(error instanceof Abandoned)) throw error;
    if (req.signal.aborted) {
      return { response: errorResponse(inbound, 499, 'Client disconnected') };
    }
    if (deadline.signal.aborted) return { response: queueRefusal(inbound, QUEUE_TIMEOUT_MESSAGE) };
    // The wait signal fires only from the client's request or this deadline.
    throw error;
  } finally {
    // Every path above ends the wait, so the clock stops here exactly once.
    deadline.cancel();
    wait.dispose();
  }
}

function refusalResponse(ctx: Context): Response | null {
  const prices = ctx.routes.map(({ route }) => priceOf(route, ctx.model));
  const refusal = ctx.deps.keys.refusalFor(ctx.key, ctx.model, prices);
  if (refusal === 'forbidden-model') return errorResponse(ctx.inbound, 403, 'Key cannot use this model');
  if (refusal === 'unpriced-model') {
    return errorResponse(ctx.inbound, 403, 'Key has a cost limit and the model has no price');
  }
  if (refusal === 'over-limit') return errorResponse(ctx.inbound, 429, 'Key cost limit reached');
  return null;
}

function record(
  ctx: Context,
  route: UsableRoute,
  status: number,
  error: string | null,
  usage: Usage | null,
  ttftMs: number | null,
): void {
  const now = ctx.deps.now();
  ctx.deps.usage.record({
    protocol: ctx.inbound,
    requestId: ctx.requestId,
    key: { id: ctx.key.id, name: ctx.key.name },
    model: { id: ctx.model.id, name: ctx.model.name },
    provider: { id: route.provider.id, name: route.provider.name },
    upstreamModel: route.route.upstreamModel,
    status,
    usage,
    cost: costOf(usage, priceOf(route.route, ctx.model)),
    ttftMs,
    latencyMs: now.getTime() - ctx.start,
    error,
  }, now);
}

/**
 * Cost of a Chat usage object: `prompt_tokens` includes the cached input, which has its own
 * price. Null when the price or the token counts are unknown.
 */
function chatCost(usage: JsonObject, price: Price): number | null {
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;
  if (prompt === null || output === null) return null;
  const details = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const cacheRead = typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0;
  return costOf({
    inputTokens: Math.max(0, prompt - cacheRead),
    outputTokens: output,
    cacheReadTokens: cacheRead,
  }, price);
}

/** A Chat body with the cost added to its usage object; unchanged when it has none. */
function withBodyCost(body: string, price: Price): string {
  const parsed = parseJson(body);
  if (!isObject(parsed) || !isObject(parsed.usage)) return body;
  return JSON.stringify({ ...parsed, usage: { ...parsed.usage, cost: chatCost(parsed.usage, price) } });
}

/** A Chat stream frame with the cost added to its final usage chunk; other frames untouched. */
function withFrameCost(frame: SseFrame, price: Price): string {
  if (frame.event !== null || frame.data === null) return frame.raw;
  const body = parseJson(frame.data);
  if (!isObject(body) || !Array.isArray(body.choices) || body.choices.length !== 0
    || !isObject(body.usage)) {
    return frame.raw;
  }
  return `data: ${JSON.stringify({ ...body, usage: { ...body.usage, cost: chatCost(body.usage, price) } })}\n\n`;
}

/** Rewrite a Chat SSE stream's final usage chunk to carry the cost; everything else is unchanged. */
function withStreamCost(body: ReadableStream<Uint8Array>, price: Price): ReadableStream<Uint8Array> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const frame of parser.push(decoder.decode(chunk, { stream: true }))) {
        controller.enqueue(encoder.encode(withFrameCost(frame, price)));
      }
    },
    flush(controller) {
      for (const frame of parser.end()) controller.enqueue(encoder.encode(withFrameCost(frame, price)));
    },
  }));
}

/** Name the model that answered and the provider behind it. */
function withRouteHeaders(response: Response, ctx: Context, route: UsableRoute): Response {
  response.headers.set('x-gateway-provider', route.provider.name);
  response.headers.set('x-gateway-model', ctx.model.name);
  return response;
}

/** Serve and account for a streaming response. */
function serveStream(ctx: Context, route: UsableRoute, result: Stream): Served {
  const ttftMs = ctx.deps.now().getTime() - ctx.start;
  const body = ctx.costWanted && ctx.inbound === 'chat'
    ? withStreamCost(result.body, priceOf(route.route, ctx.model))
    : result.body;
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
  withRouteHeaders(response, ctx, route);
  const over = result.finished.then((finished) => {
    let status = 200;
    let error = finished.error;
    if (finished.cancelled) {
      status = 499;
      error = 'client disconnected';
    } else if (error !== null) {
      status = 502;
    }
    try {
      record(ctx, route, status, error, finished.usage, ttftMs);
    } catch (cause) {
      // A store failure occurs after the streaming response has already been returned.
      console.error(`Failed to record stream for model ${ctx.model.name}, key ${ctx.key.name}`, cause);
    }
  });
  // A streaming route stays in flight until its finished result has been handled.
  return {
    response,
    over: over.finally(() => {
      ctx.deps.router.end(route.route.id);
      ctx.deps.capacityChanged?.();
    }),
  };
}

function jsonAnswer(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function served(response: Response): Served {
  return { response, over: Promise.resolve() };
}

/** Serve and account for a completed response. */
function serveComplete(ctx: Context, route: UsableRoute, result: Complete): Served {
  record(ctx, route, 200, null, result.usage, null);
  const body = ctx.costWanted && ctx.inbound === 'chat'
    ? withBodyCost(result.body, priceOf(route.route, ctx.model))
    : result.body;
  return served(withRouteHeaders(jsonAnswer(body, 200), ctx, route));
}

/** Serve and account for an upstream rejection. */
function serveRejected(ctx: Context, route: UsableRoute, result: Rejected): Served {
  record(ctx, route, result.status, `Upstream rejected the request with ${result.status}`, null, null);
  return served(withRouteHeaders(jsonAnswer(result.body, result.status), ctx, route));
}

/** The inference entry a protocol's clients call, as the 400 of an untranslatable route names it. */
function entryPath(protocol: Protocol): string {
  if (protocol === 'chat') return '/v1/chat/completions';
  if (protocol === 'messages') return '/v1/messages';
  return '/v1/responses';
}

/**
 * The 400 for a request its model's routes cannot serve: a model that says it speaks none of the
 * gateway's interfaces names none. Names the interfaces its provider said it speaks otherwise.
 */
function incompatibleResponse(ctx: Context, skipped: Protocol[][]): Response {
  const entries = [...new Set(skipped.flat())].map(entryPath);
  const message = entries.length === 0
    ? `Model "${ctx.model.name}" is not available on this gateway's interfaces`
    : `Model "${ctx.model.name}" is not available on ${entryPath(ctx.inbound)};` +
      ` use ${entries.join(' or ')}`;
  return errorResponse(ctx.inbound, 400, message);
}

/** Serve the last failure or refusal when no more routes can be tried. */
function serveExhausted(
  ctx: Context,
  failure: { result: Failed; route: UsableRoute } | null,
  refusal: Refused | null,
  skipped: Protocol[][],
): Served {
  if (failure) {
    const { result, route } = failure;
    const outcome = result.outcome;
    const status = outcome.kind === 'rate-limited' ? 429 : 502;
    record(ctx, route, status, result.reason, null, null);
    const response = errorResponse(ctx.inbound, status, result.reason);
    if (outcome.kind === 'rate-limited' && outcome.retryAfterMs !== null) {
      response.headers.set('retry-after', String(Math.ceil(outcome.retryAfterMs / 1000)));
    }
    return served(response);
  }
  if (refusal) return served(errorResponse(ctx.inbound, 400, refusal.message, refusal.param));
  if (skipped.length) return served(incompatibleResponse(ctx, skipped));
  return served(errorResponse(ctx.inbound, 503, 'No route available'));
}

/** Why every route of one candidate model was left untried or failed. */
interface Exhaustion {
  /** The last upstream failure, if any route was reached. */
  failure: { result: Failed; route: UsableRoute } | null;
  /** The last translator refusal, which nothing was sent for. */
  refusal: Refused | null;
  /** Interfaces of skipped routes, when every route was tried. */
  skipped: Protocol[][];
}

/**
 * One candidate's outcome: a final response, or an exhaustion another candidate may succeed
 * where this one could not. `retry` is true only for the outcomes a fallback model may answer:
 * no usable route, every route failed or cooled down, or a 503. A translator refusal and a
 * model that speaks no interface are final 400s.
 */
type TryResult = { kind: 'served'; served: Served } | ({ kind: 'exhausted'; retry: boolean } & Exhaustion);

/** One attempt on a route's connector, optionally already pointed at an acquired replica. */
async function runAttempt(
  ctx: Context,
  route: UsableRoute,
  connector: Connector,
  access: ProviderAccess,
  target: UpstreamLease['target'] | null,
): Promise<AttemptResult> {
  return ctx.deps.attempt({
    connector,
    provider: access,
    upstreamModel: route.route.upstreamModel,
    inbound: ctx.inbound,
    body: ctx.body,
    clientHeaders: ctx.req.headers,
    signal: ctx.req.signal,
    fetch: ctx.deps.fetch,
    now: () => ctx.deps.now().getTime(),
    ...(target === null ? {} : { target }),
  });
}

/**
 * Take one replica's place, and keep trying other replicas of the same daemon while a failure
 * occurred before the first content frame. A stream's lease is returned to be released by the
 * caller when the stream ends; every other outcome releases its place here.
 */
async function attemptWithLeases(
  ctx: Context,
  route: UsableRoute,
  connector: Connector,
  access: ProviderAccess,
): Promise<{ result: AttemptResult; lease: UpstreamLease | null }> {
  const acquire = connector.acquire!;
  const excluded = new Set<string>();
  for (;;) {
    const acquired = await acquire(
      route.provider.id, route.route.upstreamModel, ctx.inbound, excluded, ctx.req.signal,
    );
    if (acquired.kind === 'abandoned') return { result: { kind: 'abandoned' }, lease: null };
    if (acquired.kind === 'unavailable') {
      return {
        result: { kind: 'failed', outcome: { kind: 'unavailable' }, status: null, reason: 'No ready replica for this model' },
        lease: null,
      };
    }
    const lease = acquired.lease;
    let result: AttemptResult;
    try {
      result = await runAttempt(ctx, route, connector, access, lease.target);
    } catch (error) {
      lease.release();
      throw error;
    }
    if (result.kind !== 'failed') {
      if (result.kind === 'stream') return { result, lease };
      lease.release();
      return { result, lease: null };
    }
    lease.fail(result.outcome, ctx.deps.now().getTime());
    lease.release();
    excluded.add(lease.key);
    if (lease.hasMore(excluded)) continue;
    return { result, lease: null };
  }
}

async function attemptOn(ctx: Context, route: UsableRoute): Promise<AttemptResult> {
  const id = route.route.id;
  ctx.deps.router.begin(id);
  let completed: AttemptResult | undefined;
  try {
    const access = providerAccess(ctx.deps.providers, route.provider, ctx.deps.renewals);
    let result: AttemptResult;
    let streamLease: UpstreamLease | null = null;
    if (route.connector.acquire) {
      const leased = await attemptWithLeases(ctx, route, route.connector, access);
      result = leased.result;
      streamLease = leased.lease;
    } else {
      result = await runAttempt(ctx, route, route.connector, access, null);
    }
    if (result.kind === 'failed') ctx.deps.router.report(id, result.outcome, ctx.deps.now().getTime());
    if (result.kind === 'rejected') ctx.deps.router.report(id, { kind: 'client' }, ctx.deps.now().getTime());
    if (result.kind === 'complete' || result.kind === 'stream') {
      ctx.deps.router.report(id, { kind: 'ok' }, ctx.deps.now().getTime());
    }
    if (result.kind === 'stream' && streamLease !== null) {
      // The place belongs to the stream: it is given back when the stream finishes or aborts.
      const lease = streamLease;
      void result.finished.finally(() => lease.release());
    }
    completed = result;
    return result;
  } finally {
    if (completed?.kind !== 'stream') {
      ctx.deps.router.end(id);
      ctx.deps.capacityChanged?.();
    }
  }
}

function routeById(routes: UsableRoute[], id: string): UsableRoute {
  const route = routes.find((item) => item.route.id === id);
  if (!route) throw new Error(`Router selected unknown route ${id}`);
  return route;
}

/** Whether a route's provider says this model natively speaks the client's protocol. */
function passthrough(ctx: Context, route: UsableRoute): boolean {
  const protocols = ctx.deps.providers.models(route.provider.id)
    .find((model) => model.upstreamId === route.route.upstreamModel)?.protocols ?? null;
  return protocols?.includes(ctx.inbound) ?? false;
}

async function tryRoutes(ctx: Context): Promise<TryResult> {
  const tried = new Set<string>();
  let failure: { result: Failed; route: UsableRoute } | null = null;
  let refusal: Refused | null = null;
  /**
   * Interfaces of each route skipped because the request cannot be passed through to it: what
   * its provider said the model speaks, or empty when the model speaks none.
   */
  const skipped: Protocol[][] = [];
  const candidates: Candidate[] = ctx.routes.map((usable, order) => ({
    id: usable.route.id,
    weight: usable.route.weight,
    order,
    limit: usable.connector.routeLimit?.(usable.provider.id, usable.route.upstreamModel) ?? null,
    native: passthrough(ctx, usable),
  }));
  // A request waits at the slowest queue once: for a key's concurrency, and again for a place
  // on a daemon replica. The clock is armed only if the replica wait actually happens.
  let deadline: { signal: AbortSignal; cancel(): void } | null = null;
  try {
    while (true) {
      const picked = ctx.deps.router.pick(
        candidates, tried, ctx.deps.now().getTime(), ctx.sequential,
      );
      if ('none' in picked) {
        if (picked.none === 'all-busy' && ctx.deps.waitForCapacity) {
          deadline ??= ctx.deps.queueDeadline();
          const wait = combinedSignal(ctx.req.signal, deadline.signal);
          try {
            await ctx.deps.waitForCapacity(wait.signal);
          } catch (error) {
            if (!(error instanceof Abandoned)) throw error;
            if (ctx.req.signal.aborted) {
              return { kind: 'served', served: served(errorResponse(ctx.inbound, 499, 'Client disconnected')) };
            }
            return {
              kind: 'served',
              served: served(queueRefusal(ctx.inbound, QUEUE_TIMEOUT_MESSAGE)),
            };
          } finally {
            wait.dispose();
          }
          continue;
        }
        // The 400 for an interface the model lacks is true only when every usable route was
        // tried. A route still cooling down may serve this interface, and answering 400 would
        // both deny it and send the client to another interface: keep the 503 that a missing
        // route gives today.
        const everyRouteTried = tried.size === ctx.routes.length;
        const skippedForAnswer = everyRouteTried ? skipped : [];
        const retry = failure !== null || (refusal === null && skippedForAnswer.length === 0);
        return { kind: 'exhausted', retry, failure, refusal, skipped: skippedForAnswer };
      }
      const route = routeById(ctx.routes, picked.route.id);
      const result = await attemptOn(ctx, route);
      tried.add(route.route.id);
      if (result.kind === 'abandoned') {
        return {
          kind: 'served',
          served: served(errorResponse(ctx.inbound, 499, 'Client disconnected')),
        };
      }
      if (result.kind === 'incompatible') {
        skipped.push(result.protocols);
        continue;
      }
      if (result.kind === 'refused') {
        refusal = result;
        continue;
      }
      if (result.kind === 'failed') {
        failure = { result, route };
        continue;
      }
      if (result.kind === 'rejected') {
        return { kind: 'served', served: serveRejected(ctx, route, result) };
      }
      if (result.kind === 'complete') {
        return { kind: 'served', served: serveComplete(ctx, route, result) };
      }
      return { kind: 'served', served: serveStream(ctx, route, result) };
    }
  } finally {
    deadline?.cancel();
  }
}

/**
 * Serve one candidate model, then the next when a fallback is allowed. A candidate the key may
 * not use is skipped; if every candidate is refused, the first refusal is the answer. Nothing
 * is recorded for a candidate another model serves instead: usage, logs and the response headers
 * name the model that actually answered.
 */
async function serveCandidates(
  req: Request,
  inbound: Protocol,
  deps: InferenceDeps,
  start: number,
  key: KeyRecord,
  body: JsonObject,
  requestId: string,
  costWanted: boolean,
  candidates: string[],
  preferences: ProviderPreferences | null,
): Promise<Response> {
  const contexts: Context[] = [];
  let firstNotFound: Response | null = null;
  for (const name of candidates) {
    const model = deps.models.byName(name);
    if (!model?.enabled) {
      firstNotFound ??= errorResponse(inbound, 404, 'Model not found');
      continue;
    }
    const filtered = providerRoutes(
      usableRoutes(model, deps.providers, deps.connector), preferences, model,
    );
    contexts.push({
      req, inbound, deps, start, key, model, body, routes: filtered.routes,
      requestId, costWanted, sequential: filtered.sequential,
    });
  }
  const allowed: Context[] = [];
  let firstRefusal: Response | null = null;
  for (const ctx of contexts) {
    const refusal = refusalResponse(ctx);
    if (refusal !== null) {
      firstRefusal ??= refusal;
      continue;
    }
    allowed.push(ctx);
  }
  if (allowed.length === 0) {
    return firstRefusal ?? firstNotFound ?? errorResponse(inbound, 404, 'Model not found');
  }
  const place = await waitForPlace(req, inbound, deps, key);
  if ('response' in place) return place.response;
  const release = place.release;
  let last: { ctx: Context; outcome: Exhaustion } | null = null;
  try {
    for (const ctx of allowed) {
      const result = await tryRoutes(ctx);
      if (result.kind === 'served') {
        void result.served.over.finally(release);
        return result.served.response;
      }
      if (!result.retry) {
        const final = serveExhausted(ctx, result.failure, result.refusal, result.skipped);
        void final.over.finally(release);
        return final.response;
      }
      last = { ctx, outcome: result };
    }
    // `allowed` is non-empty, and every retryable exhaustion assigned `last`.
    const { ctx, outcome } = last!;
    const final = serveExhausted(ctx, outcome.failure, outcome.refusal, outcome.skipped);
    void final.over.finally(release);
    return final.response;
  } catch (error) {
    // A serving or accounting bug before the response propagates after releasing admission.
    release();
    throw error;
  }
}

/** `gen-` and 24 hex characters: the id every inference request is answered and logged under. */
export function newRequestId(): string {
  return `gen-${randomBytes(12).toString('hex')}`;
}

/** Answers Chat Completions, Messages and Responses inference requests. */
export async function handleInference(
  req: Request, inbound: Protocol, deps: InferenceDeps,
): Promise<Response> {
  const requestId = newRequestId();
  const start = deps.now().getTime();
  const key = authenticate(req, deps.keys, deps.now());
  if (!key) return withRequestId(errorResponse(inbound, 401, 'Invalid API key'), requestId);
  const body = parseJson(await req.text());
  if (!isObject(body)) return withRequestId(errorResponse(inbound, 400, 'Expected a JSON object'), requestId);
  const parsed = routingControls(body);
  if ('refusal' in parsed) {
    return withRequestId(
      errorResponse(inbound, 400, parsed.refusal.message, parsed.refusal.param), requestId,
    );
  }
  // Neither control belongs to any upstream protocol: the first upstream must never see them.
  delete body.models;
  delete body.provider;
  // `usage.include` is OpenRouter's cost extension, not part of any protocol.
  const costWanted = inbound === 'chat' && isObject(body.usage) && body.usage.include === true;
  if (costWanted) delete body.usage;
  const response = await serveCandidates(
    req, inbound, deps, start, key, body, requestId, costWanted,
    parsed.controls.candidates, parsed.controls.provider,
  );
  return withRequestId(response, requestId);
}

function withRequestId(response: Response, requestId: string): Response {
  response.headers.set('x-request-id', requestId);
  return response;
}
