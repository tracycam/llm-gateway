// OpenAI Chat Completions connectors and vendor-specific model discovery.
import { isObject } from '../protocols/json';
import type { JsonObject } from '../protocols/json';
import type { Price } from '../pricing';
import { protocolFor, UpstreamFailure } from './connector';
import type { Connector, ProviderAccess } from './connector';
import type { ProviderModelInput } from '../providerStore';
import type { Protocol } from '../protocols/protocol';
import { endpoint, fetchModels, optionalApiKey, positiveNumber, requiredApiKey } from './http';

interface Vendor {
  id: string;
  name: string;
  defaultBaseUrl: string | null;
  keyRequired: boolean;
  /** Whether the vendor serves the Responses API next to Chat Completions. */
  responses: boolean;
  /** One entry of this vendor's model list as the gateway records it. */
  model(item: JsonObject): Omit<ProviderModelInput, 'upstreamId'>;
}

interface ModelRequest {
  url: string;
  headers: Record<string, string>;
  key: string | null;
}

const NO_PRICE: Price = { input: null, output: null, cacheRead: null };

/** USD per token text to USD per 1M tokens; docs/connectors.md §4. */
function usdPerTokenText(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Number((number * 1_000_000).toPrecision(9)) : null;
}

function openaiModel(item: JsonObject): Omit<ProviderModelInput, 'upstreamId'> {
  return {
    contextLength: positiveNumber(item.context_length) ?? positiveNumber(item.context_window)
      ?? positiveNumber(item.max_model_len),
    maxOutputTokens: null,
    price: { ...NO_PRICE },
    protocols: null,
  };
}

function openrouterModel(item: JsonObject): Omit<ProviderModelInput, 'upstreamId'> {
  const pricing = isObject(item.pricing) ? item.pricing : {};
  const top = isObject(item.top_provider) ? item.top_provider : {};
  return {
    contextLength: positiveNumber(item.context_length),
    maxOutputTokens: positiveNumber(top.max_completion_tokens),
    price: {
      input: usdPerTokenText(pricing.prompt),
      output: usdPerTokenText(pricing.completion),
      cacheRead: usdPerTokenText(pricing.input_cache_read),
    },
    protocols: null,
  };
}

function connector(vendor: Vendor): Connector {
  function request(provider: ProviderAccess, path: string): ModelRequest {
    const key = vendor.keyRequired ? requiredApiKey(provider) : optionalApiKey(provider);
    const headers: Record<string, string> = {};
    if (key !== null) headers.Authorization = `Bearer ${key}`;
    return { url: endpoint(provider, vendor.defaultBaseUrl, path), headers, key };
  }
  return {
    id: vendor.id,
    name: vendor.name,
    defaultBaseUrl: vendor.defaultBaseUrl,
    credential: vendor.keyRequired ? 'api-key' : 'optional-api-key',
    async target(provider, upstreamModel, inbound) {
      // The provider's own answer wins when it named the model's interfaces; otherwise a
      // Responses client is passed through to the vendor's Responses route and a Chat or
      // Messages client goes to Chat Completions, which the gateway translates to.
      const protocols = provider.model(upstreamModel)?.protocols ?? null;
      const fallback: Protocol = inbound === 'responses' && vendor.responses ? 'responses' : 'chat';
      const protocol = vendor.responses ? protocolFor(protocols, inbound, fallback) : 'chat';
      const { url, headers } = request(
        provider, protocol === 'responses' ? '/responses' : '/chat/completions',
      );
      return { url, headers, protocol };
    },
    async models(provider) {
      const { url, headers, key } = request(provider, '/models');
      const body = await fetchModels(url, headers, key);
      if (!isObject(body) || !Array.isArray(body.data)) throw new UpstreamFailure('Invalid model list', null);
      const models: ProviderModelInput[] = [];
      for (const item of body.data) {
        if (!isObject(item) || typeof item.id !== 'string') continue;
        models.push({ upstreamId: item.id, ...vendor.model(item) });
      }
      return models;
    },
  };
}

/** OpenRouter's Chat Completions API. */
export const openrouter = connector({
  id: 'openrouter',
  name: 'OpenRouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  keyRequired: true,
  responses: false,
  model: openrouterModel,
});
/**
 * The OpenAI API and every server that speaks its Chat Completions protocol. The address is the
 * official one until the administrator gives another; the key is optional because a server on
 * the local network may need none, and no key means no `Authorization` header at all. The
 * Responses API is served at `/responses` when the administrator's server has it.
 *
 * An xAI API key is a provider of this kind at `https://api.x.ai/v1`; only the per-model price
 * discovery the retired `xai` connector did is lost with it.
 */
export const openaiCompatible = connector({
  id: 'openai-compatible',
  name: 'OpenAI-compatible',
  defaultBaseUrl: 'https://api.openai.com/v1',
  keyRequired: false,
  responses: true,
  model: openaiModel,
});
