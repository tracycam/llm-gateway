// Provider and connector management routes.
import { UpstreamFailure, type ProviderAccess } from '../connectors/connector';
import { errorResponse, jsonResponse } from '../http';
import type { ProviderModel, ProviderModelInput, ProviderRecord } from '../providerStore';
import type { AdminDeps } from './deps';
import { dispatch, type AdminRoute } from './dispatch';
import { boolean, InputError, optionalString, readBody, string } from './input';

/** Build the connector's access to a provider and its stored credentials. */
export function providerAccess(deps: AdminDeps, provider: ProviderRecord): ProviderAccess {
  let models: ProviderModel[] | undefined;
  return {
    id: provider.id,
    baseUrl: provider.baseUrl,
    credential: deps.providers.credential(provider.id),
    saveCredential: (credential) => { deps.providers.setCredential(provider.id, credential); },
    model: (id) => {
      models ??= deps.providers.models(provider.id);
      return models.find((model) => model.upstreamId === id) ?? null;
    },
  };
}

function baseUrl(value: unknown): string {
  const text = string(value, 'baseUrl');
  if (!URL.canParse(text)) throw new InputError('baseUrl 无效');
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new InputError('baseUrl 无效');
  }
  return text;
}

function existing(deps: AdminDeps, id: string): ProviderRecord {
  const provider = deps.providers.get(id);
  if (!provider) throw new InputError('未找到提供商', 404);
  return provider;
}

function discovered(deps: AdminDeps, id: string): Array<ProviderModel & { published: boolean }> {
  const routes = deps.models.list().flatMap((model) => model.routes);
  return deps.providers.models(id).map((model) => ({
    ...model,
    published: routes.some((route) => route.providerId === id && route.upstreamModel === model.upstreamId),
  }));
}

async function create(req: Request, deps: AdminDeps): Promise<Response> {
  const body = await readBody(req);
  const name = string(body.name, 'name');
  const connectorId = string(body.connector, 'connector');
  const url = body.baseUrl === undefined ? null : baseUrl(body.baseUrl);
  const apiKey = optionalString(body.apiKey, 'apiKey');
  const autoPublish = boolean(body.autoPublish, 'autoPublish') ?? false;
  const connector = deps.connector(connectorId);
  if (!connector) throw new InputError('connector 无效');
  if (connector.defaultBaseUrl === null && url === null) throw new InputError('baseUrl 无效');
  if (connector.credential === 'api-key' && !apiKey) throw new InputError('apiKey 无效');
  if (connector.credential === 'login' && apiKey !== undefined) throw new InputError('apiKey 无效');
  const provider = deps.providers.create({
    name,
    connector: connectorId,
    baseUrl: url,
    credential: apiKey === undefined ? null : JSON.stringify({ apiKey }),
    autoPublish,
  }, deps.now());
  return jsonResponse({ provider }, 201);
}

async function update(req: Request, deps: AdminDeps, id: string): Promise<Response> {
  const body = await readBody(req);
  const name = optionalString(body.name, 'name');
  const url = body.baseUrl === undefined || body.baseUrl === null ? body.baseUrl : baseUrl(body.baseUrl);
  const apiKey = body.apiKey === null ? null : optionalString(body.apiKey, 'apiKey');
  const enabled = boolean(body.enabled, 'enabled');
  const autoPublish = boolean(body.autoPublish, 'autoPublish');
  const before = existing(deps, id);
  const connector = deps.connector(before.connector);
  if (!connector) throw new InputError('connector 无效');
  if (url === null && connector.defaultBaseUrl === null) throw new InputError('baseUrl 无效');
  if (apiKey === null && connector.credential === 'api-key') throw new InputError('apiKey 无效');
  if (apiKey !== undefined && connector.credential === 'login') throw new InputError('apiKey 无效');
  deps.providers.update(id, { name, baseUrl: url, enabled, autoPublish });
  if (apiKey !== undefined) {
    deps.providers.setCredential(id, apiKey === null ? null : JSON.stringify({ apiKey }));
  }
  return jsonResponse({ provider: deps.providers.get(id) });
}

async function refresh(deps: AdminDeps, id: string): Promise<Response> {
  const provider = existing(deps, id);
  const connector = deps.connector(provider.connector);
  if (!connector) throw new InputError('connector 无效');
  const access = providerAccess(deps, provider);
  let models: ProviderModelInput[];
  try {
    models = await connector.models(access);
  } catch (error) {
    if (error instanceof UpstreamFailure) return errorResponse(error.message, 502);
    throw error;
  }
  deps.providers.replaceModels(id, models, deps.now());
  if (provider.autoPublish) {
    for (const model of discovered(deps, id)) {
      if (!model.published) deps.models.publish(id, model.upstreamId, deps.now());
    }
  }
  return jsonResponse({ models: discovered(deps, id) });
}

async function publish(req: Request, deps: AdminDeps, id: string): Promise<Response> {
  const body = await readBody(req);
  const upstreamId = string(body.upstreamId, 'upstreamId');
  existing(deps, id);
  return jsonResponse({ route: deps.models.publish(id, upstreamId, deps.now()) }, 201);
}

function connectors(_req: Request, deps: AdminDeps): Response {
  return jsonResponse({ connectors: deps.connectors().map(({ id, name, defaultBaseUrl, credential }) => ({
    id, name, defaultBaseUrl, credential,
  })) });
}

function list(_req: Request, deps: AdminDeps): Response {
  return jsonResponse({ providers: deps.providers.list().map((provider) => ({
    ...provider, modelCount: deps.providers.models(provider.id).length,
  })) });
}

function remove(_req: Request, deps: AdminDeps, [id]: string[]): Response {
  if (!deps.providers.delete(id)) throw new InputError('未找到提供商', 404);
  return new Response(null, { status: 204 });
}

function listModels(_req: Request, deps: AdminDeps, [id]: string[]): Response {
  existing(deps, id);
  return jsonResponse({ models: discovered(deps, id) });
}

const routes: readonly AdminRoute[] = [
  ['GET', /^\/api\/gateway\/connectors$/, connectors],
  ['GET', /^\/api\/gateway\/providers$/, list],
  ['POST', /^\/api\/gateway\/providers$/, create],
  ['PATCH', /^\/api\/gateway\/providers\/([^/]+)$/, (req, deps, [id]) => update(req, deps, id)],
  ['DELETE', /^\/api\/gateway\/providers\/([^/]+)$/, remove],
  ['GET', /^\/api\/gateway\/providers\/([^/]+)\/models$/, listModels],
  ['POST', /^\/api\/gateway\/providers\/([^/]+)\/refresh$/, (_req, deps, [id]) => refresh(deps, id)],
  ['POST', /^\/api\/gateway\/providers\/([^/]+)\/publish$/, (req, deps, [id]) => publish(req, deps, id)],
];

/** Handle provider and connector paths; return null for other paths. */
export function handleProviderRoute(req: Request, deps: AdminDeps): Promise<Response | null> {
  return dispatch(req, deps, routes);
}
