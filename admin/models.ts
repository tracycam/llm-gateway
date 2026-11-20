// Model and routing management routes.
import type {
  ModelCreateBody,
  ModelPatchBody,
  ModelResponse,
  ModelsResponse,
  Price,
  RouteCreateBody,
  RoutePatchBody,
  RouteResponse,
} from '../shared/api';
import { jsonResponse } from '../http';
import type { AdminDeps } from './deps';
import { dispatch, type AdminRoute } from './dispatch';
import {
  boolean, InputError, integerAtLeast, optionalString, price, readBody, string,
} from './input';

function contextLength(value: unknown): number | null | undefined {
  return value === null ? null : integerAtLeast(value, 'contextLength', 1);
}

/** Undefined leaves the price unchanged; null inherits; an object overrides with input and output. */
function routePrice(value: unknown): Price | null | undefined {
  if (value === undefined || value === null) return value;
  const result = price(value);
  // A route override requires both input and output prices.
  if (result.input === null) throw new InputError('price.input 无效');
  if (result.output === null) throw new InputError('price.output 无效');
  return result;
}

async function createModel(req: Request, deps: AdminDeps): Promise<Response> {
  const body = await readBody(req);
  const input: ModelCreateBody = {
    name: string(body.name, 'name'),
    price: body.price === undefined ? undefined : price(body.price),
    contextLength: contextLength(body.contextLength),
  };
  const model = deps.models.create(input, deps.now());
  return jsonResponse({ model } satisfies ModelResponse, 201);
}

async function updateModel(req: Request, deps: AdminDeps, [id]: string[]): Promise<Response> {
  const body = await readBody(req);
  const patch: ModelPatchBody = {
    name: optionalString(body.name, 'name'),
    price: body.price === undefined ? undefined : price(body.price),
    contextLength: contextLength(body.contextLength),
    enabled: boolean(body.enabled, 'enabled'),
  };
  const model = deps.models.update(id, patch);
  if (!model) throw new InputError('未找到模型', 404);
  return jsonResponse({ model } satisfies ModelResponse);
}

async function createRoute(req: Request, deps: AdminDeps, [id]: string[]): Promise<Response> {
  const body = await readBody(req);
  const input: RouteCreateBody = {
    providerId: string(body.providerId, 'providerId'),
    upstreamModel: string(body.upstreamModel, 'upstreamModel'),
    weight: integerAtLeast(body.weight, 'weight', 1),
    price: routePrice(body.price),
  };
  if (!deps.models.get(id)) throw new InputError('未找到模型', 404);
  if (!deps.providers.get(input.providerId)) throw new InputError('providerId 无效');
  const route = deps.models.addRoute(id, input);
  return jsonResponse({ route } satisfies RouteResponse, 201);
}

async function updateRoute(req: Request, deps: AdminDeps, [id]: string[]): Promise<Response> {
  const body = await readBody(req);
  const patch: RoutePatchBody = {
    weight: integerAtLeast(body.weight, 'weight', 1),
    enabled: boolean(body.enabled, 'enabled'),
    price: routePrice(body.price),
  };
  const route = deps.models.updateRoute(id, patch);
  if (!route) throw new InputError('未找到路由', 404);
  return jsonResponse({ route } satisfies RouteResponse);
}

function listModels(_req: Request, deps: AdminDeps): Response {
  return jsonResponse({ models: deps.models.list() } satisfies ModelsResponse);
}

function getModel(_req: Request, deps: AdminDeps, [id]: string[]): Response {
  const model = deps.models.get(id);
  if (!model) throw new InputError('未找到模型', 404);
  return jsonResponse({ model } satisfies ModelResponse);
}

function deleteModel(_req: Request, deps: AdminDeps, [id]: string[]): Response {
  if (!deps.models.delete(id)) throw new InputError('未找到模型', 404);
  return new Response(null, { status: 204 });
}

function deleteRoute(_req: Request, deps: AdminDeps, [id]: string[]): Response {
  if (!deps.models.removeRoute(id)) throw new InputError('未找到路由', 404);
  return new Response(null, { status: 204 });
}

const routes: readonly AdminRoute[] = [
  ['GET', /^\/api\/gateway\/models$/, listModels],
  ['POST', /^\/api\/gateway\/models$/, createModel],
  ['GET', /^\/api\/gateway\/models\/([^/]+)$/, getModel],
  ['PATCH', /^\/api\/gateway\/models\/([^/]+)$/, updateModel],
  ['DELETE', /^\/api\/gateway\/models\/([^/]+)$/, deleteModel],
  ['POST', /^\/api\/gateway\/models\/([^/]+)\/routes$/, createRoute],
  ['PATCH', /^\/api\/gateway\/routes\/([^/]+)$/, updateRoute],
  ['DELETE', /^\/api\/gateway\/routes\/([^/]+)$/, deleteRoute],
];

/** Handle model and route paths; return null for other paths. */
export function handleModelRoute(req: Request, deps: AdminDeps): Promise<Response | null> {
  return dispatch(req, deps, routes);
}
