// The gateway as one composable value: its routes over one open database. The process entry
// (main.ts) only reads configuration, opens that database and serves this handler.
import type { Database } from 'bun:sqlite';
import { Admission } from './admission';
import { isAuthorized, sessionRoute } from './adminAuth';
import { handleKeyRoute } from './admin/keys';
import { handleModelRoute } from './admin/models';
import { handleProviderRoute } from './admin/providers';
import { handleUsageRoute } from './admin/usage';
import type { AdminDeps } from './admin/deps';
import { Cluster } from './cluster';
import type { NodeLinkOptions } from './nodeLink';
import type { Connector } from './connectors/connector';
import { errorResponse, jsonResponse } from './http';
import { attempt } from './inference/attempt';
import { handleInference, MAX_QUEUE_WAIT_MS, type InferenceDeps } from './inference/handler';
import { handleModel, handleModelList, type ModelListDeps } from './inference/modelList';
import { KeyStore } from './keyStore';
import { ModelStore } from './modelStore';
import { openNodeEvents } from './nodeEvents';
import { handleNodeRoute, NODES_PATH } from './nodeRoutes';
import { NodeStore } from './nodeStore';
import type { Protocol } from './protocols/protocol';
import { protocolModule } from './protocols/protocol';
import { ProviderStore } from './providerStore';
import { Router } from './router';
import { migrate } from './schema';
import { UsageStore } from './usageStore';
import { serveWebAsset } from './webAssets';

/**
 * Bun's idle timeout, in seconds, for the gateway's server. Zero disables it: the gateway holds
 * a response until the model produces content, and a slow model must not be cut off.
 */
export const GATEWAY_IDLE_TIMEOUT = 0;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta',
};

/** Where the process's variables differ from one deployment or one test to the next. */
export interface GatewayAppOptions {
  /** The one open database; `migrate` brings it to the current version here. */
  db: Database;
  /** Directory of the built console. */
  webDistDir: string;
  /** Outgoing HTTP, for provider calls. */
  fetch: typeof fetch;
  /** The clock used for keys, periods and accounting. */
  now(): Date;
  /** The connector with this id, or null. */
  connector(id: string): Connector | null;
  /** Every connector the administrator may choose. */
  connectors(): readonly Connector[];
  /** The administrator token; undefined when authentication is disabled. */
  adminToken: string | undefined;
  /** Timeouts for the connections to registered daemons. */
  nodeTiming?: Pick<NodeLinkOptions, 'watchdogMs' | 'handshakeTimeoutMs' | 'retryMinMs' | 'retryMaxMs'>;
}

/** A gateway that can answer requests without a network listener. */
export interface GatewayApp {
  handle(req: Request): Promise<Response>;
  /** Closes the node connections and the one database. */
  close(): Promise<void>;
}

/** Add the inference API's CORS header, also to error and stream responses. */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  const body = response.status === 204 || response.status === 304 ? null : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/** The protocol whose error shape an unhandled `/v1` request is answered in. */
function clientProtocol(req: Request): Protocol {
  return req.headers.has('anthropic-version') ? 'messages' : 'chat';
}

/** The inference API's 404 for a path no handler serves. */
function notFoundV1(req: Request): Response {
  const route = `${req.method} ${new URL(req.url).pathname}`;
  return Response.json(
    protocolModule(clientProtocol(req)).errorBody(404, `Unsupported route: ${route}`),
    { status: 404 }
  );
}

/** Percent-decode one model path segment; null when it is not valid percent-encoding. */
function modelName(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    // A malformed escape names no model; callers answer the protocol's 404.
    if (error instanceof URIError) return null;
    throw error;
  }
}

/** The inference API under `/v1`: models, Chat Completions and Messages. */
async function inferenceRoute(
  req: Request,
  pathname: string,
  deps: InferenceDeps,
  models: ModelListDeps,
): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    return withCors(await handleInference(req, 'chat', deps));
  }
  if (pathname === '/v1/messages' && req.method === 'POST') {
    return withCors(await handleInference(req, 'messages', deps));
  }
  if (pathname === '/v1/models' && req.method === 'GET') {
    return withCors(handleModelList(req, { ...models, now: deps.now }));
  }
  if (pathname.startsWith('/v1/models/') && req.method === 'GET') {
    const name = modelName(pathname.slice('/v1/models/'.length));
    if (name === null) return withCors(notFoundV1(req));
    return withCors(handleModel(req, name, { ...models, now: deps.now }));
  }
  return withCors(notFoundV1(req));
}

/** The production queue deadline: one timer of `MAX_QUEUE_WAIT_MS`, stopped by `cancel`. */
export function queueDeadline(): { signal: AbortSignal; cancel(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_QUEUE_WAIT_MS);
  return {
    signal: controller.signal,
    cancel: () => { clearTimeout(timer); },
  };
}

/** Build the gateway's request handler over one database, migrated once here. */
export function createApp(options: GatewayAppOptions): GatewayApp {
  migrate(options.db);
  const providers = new ProviderStore(options.db);
  const models = new ModelStore(options.db);
  const keys = new KeyStore(options.db);
  const usage = new UsageStore(options.db);
  const nodes = new NodeStore(options.db);
  const cluster = new Cluster(nodes.list(), options.nodeTiming);
  const router = new Router();
  const admission = new Admission();
  let closed = false;

  const admin: AdminDeps = {
    providers, models, keys, usage,
    connector: options.connector,
    connectors: options.connectors,
    now: options.now,
  };
  const inference: InferenceDeps = {
    keys, models, providers, usage, router, admission,
    connector: options.connector,
    attempt,
    fetch: options.fetch,
    now: options.now,
    queueDeadline,
  };

  async function managementRoute(req: Request, pathname: string): Promise<Response> {
    if (pathname === '/api/gateway/events' && req.method === 'GET') return openNodeEvents(req, cluster);
    if (pathname === NODES_PATH || pathname.startsWith(`${NODES_PATH}/`)) {
      return handleNodeRoute(req, cluster, nodes);
    }
    for (const handle of [handleProviderRoute, handleModelRoute, handleKeyRoute, handleUsageRoute]) {
      const response = await handle(req, admin);
      if (response) return response;
    }
    return errorResponse('未找到', 404);
  }

  async function route(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === '/healthz' && req.method === 'GET') return jsonResponse({ status: 'ok' });

    const session = await sessionRoute(req, '/api/gateway', options.adminToken);
    if (session) return session;

    if (pathname.startsWith('/v1/')) {
      return inferenceRoute(req, pathname, inference, {
        models, providers, keys, connector: options.connector,
      });
    }

    if (pathname.startsWith('/api/')) {
      if (!isAuthorized(req, options.adminToken)) return errorResponse('未登录', 401);
      return managementRoute(req, pathname);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const asset = serveWebAsset(pathname, 'gateway.html', options.webDistDir);
      if (asset) return asset;
    }
    return errorResponse('未找到', 404);
  }

  return {
    handle: route,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await cluster.close();
      options.db.close();
    },
  };
}
