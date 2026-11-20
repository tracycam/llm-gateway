// Provider and connector management routes.
import type {
  ConnectorInfo,
  ConnectorsResponse,
  DiscoveredModel,
  LoginResponse,
  ProviderListItem,
  ProviderModelsResponse,
  ProviderPatchBody,
  ProviderResponse,
  ProvidersResponse,
  PublishBody,
  RouteResponse,
} from '../shared/api';
import { UpstreamFailure } from '../connectors/connector';
import { errorResponse, jsonResponse } from '../http';
import { LoginFailure } from '../login';
import type { ProviderRecord } from '../providerStore';
import type { AdminDeps } from './deps';
import { dispatch, type AdminRoute } from './dispatch';
import { boolean, InputError, optionalString, readBody, string } from './input';

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

/** Refuse a provider whose connector is not one the gateway signs in. */
function loginOnly(deps: AdminDeps, provider: ProviderRecord): void {
  const connector = deps.connector(provider.connector);
  if (!connector) throw new InputError('connector 无效');
  if (connector.credential !== 'login') throw new InputError('该提供商不使用登录');
}

function discovered(deps: AdminDeps, id: string): DiscoveredModel[] {
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
  const autoPublish = boolean(body.autoPublish, 'autoPublish') ?? true;
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
  // A connector with live state starts following the provider before its first model sync.
  deps.onProviderChanged?.(provider.id);
  // The response does not wait for the new provider's models; the sync records how it went.
  deps.sync.trigger(provider.id);
  return jsonResponse({ provider } satisfies ProviderResponse, 201);
}

async function update(req: Request, deps: AdminDeps, [id]: string[]): Promise<Response> {
  const body = await readBody(req);
  const patch: ProviderPatchBody = {
    name: optionalString(body.name, 'name'),
    baseUrl: body.baseUrl === undefined || body.baseUrl === null ? body.baseUrl : baseUrl(body.baseUrl),
    enabled: boolean(body.enabled, 'enabled'),
    autoPublish: boolean(body.autoPublish, 'autoPublish'),
  };
  const apiKey = body.apiKey === null ? null : optionalString(body.apiKey, 'apiKey');
  if (apiKey !== undefined) patch.apiKey = apiKey;
  const before = existing(deps, id);
  const connector = deps.connector(before.connector);
  if (!connector) throw new InputError('connector 无效');
  if (patch.baseUrl === null && connector.defaultBaseUrl === null) throw new InputError('baseUrl 无效');
  if (apiKey === null && connector.credential === 'api-key') throw new InputError('apiKey 无效');
  if (apiKey !== undefined && connector.credential === 'login') throw new InputError('apiKey 无效');
  deps.providers.update(id, patch);
  const credentialBefore = deps.providers.credential(id);
  const credentialAfter = apiKey === undefined
    ? credentialBefore
    : (apiKey === null ? null : JSON.stringify({ apiKey }));
  if (apiKey !== undefined) deps.providers.setCredential(id, credentialAfter);
  const provider = deps.providers.get(id);
  if (!provider) throw new InputError('未找到提供商', 404);
  deps.onProviderChanged?.(id);
  // A new key, a new address or a provider switched back on reaches the same upstream
  // differently; the sync runs in the background and the response does not wait for it.
  const keyChanged = apiKey !== undefined
    && (credentialAfter !== credentialBefore || before.credentialRejected);
  const addressChanged = patch.baseUrl !== undefined && patch.baseUrl !== before.baseUrl;
  const enabledNow = patch.enabled === true && !before.enabled;
  if (keyChanged || addressChanged || enabledNow) deps.sync.trigger(id);
  return jsonResponse({ provider } satisfies ProviderResponse);
}

async function refresh(_req: Request, deps: AdminDeps, [id]: string[]): Promise<Response> {
  const provider = existing(deps, id);
  const connector = deps.connector(provider.connector);
  if (!connector) throw new InputError('connector 无效');
  const outcome = await deps.sync.refresh(id);
  if (!outcome.ok) {
    if (outcome.error instanceof UpstreamFailure) {
      return errorResponse(outcome.error.message, 502);
    }
    throw outcome.error;
  }
  return jsonResponse({ models: discovered(deps, id) } satisfies ProviderModelsResponse);
}

async function publish(req: Request, deps: AdminDeps, [id]: string[]): Promise<Response> {
  const body = await readBody(req);
  const input: PublishBody = { upstreamId: string(body.upstreamId, 'upstreamId') };
  existing(deps, id);
  const route = deps.models.publish(id, input.upstreamId, deps.now());
  return jsonResponse({ route } satisfies RouteResponse, 201);
}

function connectors(_req: Request, deps: AdminDeps): Response {
  const list: ConnectorInfo[] = deps.connectors().map(({ id, name, defaultBaseUrl, credential }) => ({
    id, name, defaultBaseUrl, credential,
  }));
  return jsonResponse({ connectors: list } satisfies ConnectorsResponse);
}

function list(_req: Request, deps: AdminDeps): Response {
  const providers: ProviderListItem[] = deps.providers.list().map((provider) => ({
    ...provider, modelCount: deps.providers.models(provider.id).length,
  }));
  return jsonResponse({ providers } satisfies ProvidersResponse);
}

function remove(_req: Request, deps: AdminDeps, [id]: string[]): Response {
  if (!deps.providers.delete(id)) throw new InputError('未找到提供商', 404);
  deps.onProviderChanged?.(id);
  return new Response(null, { status: 204 });
}

function listModels(_req: Request, deps: AdminDeps, [id]: string[]): Response {
  existing(deps, id);
  return jsonResponse({ models: discovered(deps, id) } satisfies ProviderModelsResponse);
}

/** Start a device-code login; 201 with the code the administrator confirms in a browser. */
async function startLogin(_req: Request, deps: AdminDeps, [id]: string[]): Promise<Response> {
  const provider = existing(deps, id);
  loginOnly(deps, provider);
  try {
    const login = await deps.logins.start(id);
    return jsonResponse({ login } satisfies LoginResponse, 201);
  } catch (error) {
    // The provider cannot log in, or its authorization server could not be asked.
    if (error instanceof LoginFailure) return errorResponse(error.message, error.status);
    throw error;
  }
}

function loginStatus(_req: Request, deps: AdminDeps, [id]: string[]): Response {
  existing(deps, id);
  return jsonResponse({ login: deps.logins.status(id) } satisfies LoginResponse);
}

/** Cancel a pending sign-in. A credential already stored, and its refused mark, stay as they are. */
function cancelLogin(_req: Request, deps: AdminDeps, [id]: string[]): Response {
  const provider = existing(deps, id);
  loginOnly(deps, provider);
  deps.logins.cancel(id);
  return new Response(null, { status: 204 });
}

/** Sign the provider out: stop a pending sign-in and drop the credential stored for it. */
function signOut(_req: Request, deps: AdminDeps, [id]: string[]): Response {
  const provider = existing(deps, id);
  loginOnly(deps, provider);
  deps.logins.cancel(id);
  deps.providers.setCredential(id, null);
  return new Response(null, { status: 204 });
}

const routes: readonly AdminRoute[] = [
  ['GET', /^\/api\/gateway\/connectors$/, connectors],
  ['GET', /^\/api\/gateway\/providers$/, list],
  ['POST', /^\/api\/gateway\/providers$/, create],
  ['PATCH', /^\/api\/gateway\/providers\/([^/]+)$/, update],
  ['DELETE', /^\/api\/gateway\/providers\/([^/]+)$/, remove],
  ['GET', /^\/api\/gateway\/providers\/([^/]+)\/models$/, listModels],
  ['POST', /^\/api\/gateway\/providers\/([^/]+)\/refresh$/, refresh],
  ['POST', /^\/api\/gateway\/providers\/([^/]+)\/publish$/, publish],
  ['POST', /^\/api\/gateway\/providers\/([^/]+)\/login$/, startLogin],
  ['GET', /^\/api\/gateway\/providers\/([^/]+)\/login$/, loginStatus],
  ['DELETE', /^\/api\/gateway\/providers\/([^/]+)\/login$/, cancelLogin],
  ['DELETE', /^\/api\/gateway\/providers\/([^/]+)\/credential$/, signOut],
];

/** Handle provider and connector paths; return null for other paths. */
export function handleProviderRoute(req: Request, deps: AdminDeps): Promise<Response | null> {
  return dispatch(req, deps, routes);
}
