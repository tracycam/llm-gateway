// What GET /v1/models and GET /v1/models/:id answer for an authenticated key: the public models
// that key can call now, in OpenAI's or Anthropic's list shape.

import type { Connector } from '../connectors/connector';
import type { KeyRecord, KeyStore } from '../keyStore';
import { priceOf, type ModelRecord, type ModelStore } from '../modelStore';
import { protocolModule, type Protocol } from '../protocols/protocol';
import type { ProviderStore } from '../providerStore';
import { authenticate } from './auth';
import { usableRoutes } from './routes';

/** The list shape the client's protocol uses. */
export type ListShape = 'openai' | 'anthropic';

/** What a list answer reads to decide which models to show. */
export interface ModelListDeps {
  models: ModelStore;
  providers: ProviderStore;
  keys: KeyStore;
  connector(id: string): Connector | null;
}

/** A list answer read from a request, which needs a clock to verify the key. */
export interface ModelListRequestDeps extends ModelListDeps {
  now(): Date;
}

const NOT_FOUND = 'Model not found';

/** Anthropic's shape when the request carries an `anthropic-version` header, else OpenAI's. */
export function listShape(req: Request): ListShape {
  return req.headers.has('anthropic-version') ? 'anthropic' : 'openai';
}

function protocolOf(shape: ListShape): Protocol {
  return shape === 'anthropic' ? 'messages' : 'chat';
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function notFound(shape: ListShape): Response {
  return json(protocolModule(protocolOf(shape)).errorBody(404, NOT_FOUND), 404);
}

function listed(key: KeyRecord, model: ModelRecord, deps: ModelListDeps): boolean {
  if (!model.enabled) return false;
  const routes = usableRoutes(model, deps.providers, deps.connector);
  if (routes.length === 0) return false;
  const prices = routes.map(({ route }) => priceOf(route, model));
  const refusal = deps.keys.refusalFor(key, model, prices);
  return refusal !== 'forbidden-model' && refusal !== 'unpriced-model';
}

function listedModels(key: KeyRecord, deps: ModelListDeps): ModelRecord[] {
  return deps.models.list().filter((model) => listed(key, model, deps));
}

interface OpenaiModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

interface AnthropicModel {
  type: 'model';
  id: string;
  display_name: string;
  created_at: string;
}

function openaiModel(model: ModelRecord): OpenaiModel {
  return {
    id: model.name,
    object: 'model',
    created: Math.floor(Date.parse(model.createdAt) / 1000),
    owned_by: 'aihub-gateway',
  };
}

function anthropicModel(model: ModelRecord): AnthropicModel {
  return {
    type: 'model',
    id: model.name,
    display_name: model.name,
    created_at: model.createdAt,
  };
}

/** The models this key can call now. */
export function modelListResponse(key: KeyRecord, shape: ListShape, deps: ModelListDeps): Response {
  const models = listedModels(key, deps);
  if (shape === 'anthropic') {
    const data = models.map(anthropicModel);
    return json({
      data,
      has_more: false,
      first_id: data.length === 0 ? null : data[0].id,
      last_id: data.length === 0 ? null : data[data.length - 1].id,
    });
  }
  return json({ object: 'list', data: models.map(openaiModel) });
}

/** One model by its public name, or the protocol's 404. */
export function modelResponse(
  key: KeyRecord,
  name: string,
  shape: ListShape,
  deps: ModelListDeps,
): Response {
  const model = listedModels(key, deps).find((item) => item.name === name);
  if (!model) return notFound(shape);
  return json(shape === 'anthropic' ? anthropicModel(model) : openaiModel(model));
}

function unauthorized(shape: ListShape): Response {
  return json(protocolModule(protocolOf(shape)).errorBody(401, 'Invalid API key'), 401);
}

/** GET /v1/models */
export function handleModelList(req: Request, deps: ModelListRequestDeps): Response {
  const shape = listShape(req);
  const key = authenticate(req, deps.keys, deps.now());
  if (!key) return unauthorized(shape);
  return modelListResponse(key, shape, deps);
}

/** GET /v1/models/:name — `name` is the path segment, already percent-decoded by the caller. */
export function handleModel(req: Request, name: string, deps: ModelListRequestDeps): Response {
  const shape = listShape(req);
  const key = authenticate(req, deps.keys, deps.now());
  if (!key) return unauthorized(shape);
  return modelResponse(key, name, shape, deps);
}
