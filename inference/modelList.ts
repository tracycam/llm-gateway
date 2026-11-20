// What GET /v1/models and GET /v1/models/:id answer for an authenticated key: the public models
// that key can call now, in OpenAI's or Anthropic's list shape.

import type { Connector } from '../connectors/connector';
import type { KeyRecord, KeyStore } from '../keyStore';
import { priceOf, type ModelRecord, type ModelStore } from '../modelStore';
import { protocolModule, type Protocol } from '../protocols/protocol';
import type { ProviderModel, ProviderStore } from '../providerStore';
import { authenticate } from './auth';
import { usableRoutes, type UsableRoute } from './routes';

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

interface OpenaiPricing {
  prompt: string | null;
  completion: string | null;
  input_cache_read: string | null;
}

interface OpenaiModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  name: string;
  context_length: number | null;
  pricing: OpenaiPricing;
  top_provider: {
    context_length: number | null;
    max_completion_tokens: number | null;
  };
  supported_protocols: Protocol[];
}

interface AnthropicModel {
  type: 'model';
  id: string;
  display_name: string;
  created_at: string;
}

/** The order the three interfaces are reported in, whatever order routes list them. */
const PROTOCOLS: Protocol[] = ['chat', 'messages', 'responses'];

/** USD per 1M tokens as the USD-per-token decimal string OpenRouter reports, never an exponent. */
function usdPerToken(perMillion: number | null): string | null {
  if (perMillion === null) return null;
  const text = (perMillion / 1_000_000).toFixed(18);
  return text === '0.000000000000000000' ? '0' : text.replace(/\.?0+$/, '');
}

/** The discovered model behind a route, when its provider listed it. */
function discovered(route: UsableRoute, providers: ProviderStore): ProviderModel | null {
  return providers.models(route.provider.id)
    .find((model) => model.upstreamId === route.route.upstreamModel) ?? null;
}

function openaiModel(model: ModelRecord, deps: ModelListDeps): OpenaiModel {
  const routes = usableRoutes(model, deps.providers, deps.connector);
  const protocols = new Set<Protocol>();
  const completions = new Set<number>();
  for (const route of routes) {
    const found = discovered(route, deps.providers);
    for (const protocol of found?.protocols ?? []) protocols.add(protocol);
    if (found?.maxOutputTokens != null) completions.add(found.maxOutputTokens);
  }
  return {
    id: model.name,
    object: 'model',
    created: Math.floor(Date.parse(model.createdAt) / 1000),
    // One provider behind the model names itself; several make the gateway the owner.
    owned_by: routes.length === 1 ? routes[0]!.provider.name : 'gateway',
    name: model.name,
    context_length: model.contextLength,
    pricing: {
      prompt: usdPerToken(model.price.input),
      completion: usdPerToken(model.price.output),
      input_cache_read: usdPerToken(model.price.cacheRead),
    },
    top_provider: {
      context_length: model.contextLength,
      // One discovered answer names the limit; disagreeing providers leave it unknown.
      max_completion_tokens: completions.size === 1 ? [...completions][0]! : null,
    },
    supported_protocols: PROTOCOLS.filter((protocol) => protocols.has(protocol)),
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
  return json({ object: 'list', data: models.map((model) => openaiModel(model, deps)) });
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
  return json(shape === 'anthropic' ? anthropicModel(model) : openaiModel(model, deps));
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
