// Authenticate, route and account for one client inference request.
import { Abandoned, type Admission } from '../admission';
import { providerAccess } from '../connectors/access';
import type { Connector } from '../connectors/connector';
import type { KeyRecord, KeyStore } from '../keyStore';
import { priceOf, type ModelRecord, type ModelStore, type RouteRecord } from '../modelStore';
import { costOf, type Usage } from '../pricing';
import { isObject, parseJson, type JsonObject } from '../protocols/json';
import { protocolModule, type Protocol } from '../protocols/protocol';
import type { ProviderRecord, ProviderStore } from '../providerStore';
import type { Candidate, Router } from '../router';
import type { UsageStore } from '../usageStore';
import type { attempt, AttemptResult } from './attempt';

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
  /** One attempt on one route. */
  attempt: typeof attempt;
  fetch: typeof fetch;
  now(): Date;
}

/** An eligible route and the dependencies needed to invoke it. */
interface Route {
  /** Router-facing weight, order and limit. */
  candidate: Candidate;
  /** Saved model route. */
  route: RouteRecord;
  /** Provider that owns the route. */
  provider: ProviderRecord;
  /** Connector for that provider. */
  connector: Connector;
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
  /** Parsed request body. */
  body: JsonObject;
  /** Eligible routes in store order. */
  routes: Route[];
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

function authenticate(req: Request, deps: InferenceDeps): KeyRecord | null {
  const authorization = req.headers.get('authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i);
  const token = bearer?.[1] ?? req.headers.get('x-api-key');
  if (!token) return null;
  const result = deps.keys.verify(token, deps.now());
  return 'key' in result ? result.key : null;
}

function candidatesOf(model: ModelRecord, deps: InferenceDeps): Route[] {
  const routes: Route[] = [];
  model.routes.forEach((route, order) => {
    if (!route.enabled) return;
    const provider = deps.providers.get(route.providerId);
    if (!provider?.enabled) return;
    const connector = deps.connector(provider.connector);
    if (!connector) return;
    routes.push({
      candidate: { id: route.id, weight: route.weight, order, limit: null },
      route,
      provider,
      connector,
    });
  });
  return routes;
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
  route: Route,
  status: number,
  error: string | null,
  usage: Usage | null,
  ttftMs: number | null,
): void {
  const now = ctx.deps.now();
  ctx.deps.usage.record({
    protocol: ctx.inbound,
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

/** Serve and account for a streaming response. */
function serveStream(ctx: Context, route: Route, result: Stream): Served {
  const ttftMs = ctx.deps.now().getTime() - ctx.start;
  const response = new Response(result.body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
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
  return { response, over: over.finally(() => ctx.deps.router.end(route.route.id)) };
}

function jsonAnswer(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function served(response: Response): Served {
  return { response, over: Promise.resolve() };
}

/** Serve and account for a completed response. */
function serveComplete(ctx: Context, route: Route, result: Complete): Served {
  record(ctx, route, 200, null, result.usage, null);
  return served(jsonAnswer(result.body, 200));
}

/** Serve and account for an upstream rejection. */
function serveRejected(ctx: Context, route: Route, result: Rejected): Served {
  record(ctx, route, result.status, `Upstream rejected the request with ${result.status}`, null, null);
  return served(jsonAnswer(result.body, result.status));
}

/** Serve the last failure or refusal when no more routes can be tried. */
function serveExhausted(
  ctx: Context,
  failure: { result: Failed; route: Route } | null,
  refusal: Refused | null,
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
  return served(errorResponse(ctx.inbound, 503, 'No route available'));
}

async function attemptOn(ctx: Context, route: Route): Promise<AttemptResult> {
  const id = route.route.id;
  ctx.deps.router.begin(id);
  let completed: AttemptResult | undefined;
  try {
    const result = await ctx.deps.attempt({
      connector: route.connector,
      provider: providerAccess(ctx.deps.providers, route.provider),
      upstreamModel: route.route.upstreamModel,
      inbound: ctx.inbound,
      body: ctx.body,
      clientHeaders: ctx.req.headers,
      signal: ctx.req.signal,
      fetch: ctx.deps.fetch,
      now: () => ctx.deps.now().getTime(),
    });
    if (result.kind === 'failed') ctx.deps.router.report(id, result.outcome, ctx.deps.now().getTime());
    if (result.kind === 'rejected') ctx.deps.router.report(id, { kind: 'client' }, ctx.deps.now().getTime());
    if (result.kind === 'complete' || result.kind === 'stream') {
      ctx.deps.router.report(id, { kind: 'ok' }, ctx.deps.now().getTime());
    }
    completed = result;
    return result;
  } finally {
    if (completed?.kind !== 'stream') ctx.deps.router.end(id);
  }
}

function routeById(routes: Route[], id: string): Route {
  const route = routes.find((item) => item.route.id === id);
  if (!route) throw new Error(`Router selected unknown route ${id}`);
  return route;
}

async function tryRoutes(ctx: Context): Promise<Served> {
  const tried = new Set<string>();
  let failure: { result: Failed; route: Route } | null = null;
  let refusal: Refused | null = null;
  while (true) {
    const picked = ctx.deps.router.pick(ctx.routes.map(({ candidate }) => candidate), tried,
      ctx.deps.now().getTime());
    if ('none' in picked) return serveExhausted(ctx, failure, refusal);
    const route = routeById(ctx.routes, picked.route.id);
    const result = await attemptOn(ctx, route);
    tried.add(route.route.id);
    if (result.kind === 'abandoned') return served(errorResponse(ctx.inbound, 499, 'Client disconnected'));
    if (result.kind === 'refused') {
      refusal = result;
      continue;
    }
    if (result.kind === 'failed') {
      failure = { result, route };
      continue;
    }
    if (result.kind === 'rejected') return serveRejected(ctx, route, result);
    if (result.kind === 'complete') return serveComplete(ctx, route, result);
    return serveStream(ctx, route, result);
  }
}

/** Answers Chat Completions and Messages inference requests. */
export async function handleInference(
  req: Request, inbound: Protocol, deps: InferenceDeps,
): Promise<Response> {
  const start = deps.now().getTime();
  const key = authenticate(req, deps);
  if (!key) return errorResponse(inbound, 401, 'Invalid API key');
  const body = parseJson(await req.text());
  if (!isObject(body)) return errorResponse(inbound, 400, 'Expected a JSON object');
  if (typeof body.model !== 'string' || !body.model.trim()) {
    return errorResponse(inbound, 400, 'Expected a non-empty model', 'model');
  }
  const model = deps.models.byName(body.model);
  if (!model?.enabled) return errorResponse(inbound, 404, 'Model not found');
  const routes = candidatesOf(model, deps);
  const ctx: Context = { req, inbound, deps, start, key, model, body, routes };
  const refusal = refusalResponse(ctx);
  if (refusal) return refusal;
  let release: () => void;
  try {
    release = await deps.admission.enter(key.id, key.maxConcurrency, req.signal);
  } catch (error) {
    // Admission rejects with Abandoned when the queued client disconnects.
    if (error instanceof Abandoned) return errorResponse(inbound, 499, 'Client disconnected');
    throw error;
  }
  try {
    const result = await tryRoutes(ctx);
    void result.over.finally(release);
    return result.response;
  } catch (error) {
    // A serving or accounting bug before the response propagates after releasing admission.
    release();
    throw error;
  }
}
