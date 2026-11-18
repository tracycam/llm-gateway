// Model and routing management routes.
import { jsonResponse } from '../http';
import type { Price } from '../pricing';
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
  const name = string(body.name, 'name');
  const modelPrice = body.price === undefined ? undefined : price(body.price);
  const context = contextLength(body.contextLength);
  const model = deps.models.create({ name, price: modelPrice, contextLength: context }, deps.now());
  return jsonResponse({ model }, 201);
}

async function updateModel(req: Request, deps: AdminDeps, [id]: string[]): Promise<Response> {
  const body = await readBody(req);
  const name = optionalString(body.name, 'name');
  const modelPrice = body.price === undefined ? undefined : price(body.price);
  const context = contextLength(body.contextLength);
  const enabled = boolean(body.enabled, 'enabled');
  const model = deps.models.update(id, { name, price: modelPrice, contextLength: context, enabled });
  if (!model) throw new InputError('未找到模型', 404);
  return jsonResponse({ model });
}

async function createRoute(req: Request, deps: AdminDeps, [id]: string[]): Promise<Response> {
  const body = await readBody(req);
  const providerId = string(body.providerId, 'providerId');
  const upstreamModel = string(body.upstreamModel, 'upstreamModel');
  const weight = integerAtLeast(body.weight, 'weight', 1);
  const override = routePrice(body.price);
  if (!deps.models.get(id)) throw new InputError('未找到模型', 404);
  if (!deps.providers.get(providerId)) throw new InputError('providerId 无效');
  const route = deps.models.addRoute(id, { providerId, upstreamModel, weight, price: override });
  return jsonResponse({ route }, 201);
}

async function updateRoute(req: Request, deps: AdminDeps, [id]: string[]): Promise<Response> {
  const body = await readBody(req);
  const weight = integerAtLeast(body.weight, 'weight', 1);
  const enabled = boolean(body.enabled, 'enabled');
  const override = routePrice(body.price);
  const route = deps.models.updateRoute(id, { weight, enabled, price: override });
  if (!route) throw new InputError('未找到路由', 404);
  return jsonResponse({ route });
}

function listModels(_req: Request, deps: AdminDeps): Response {
  return jsonResponse({ models: deps.models.list() });
}

function getModel(_req: Request, deps: AdminDeps, [id]: string[]): Response {
  const model = deps.models.get(id);
  if (!model) throw new InputError('未找到模型', 404);
  return jsonResponse({ model });
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
