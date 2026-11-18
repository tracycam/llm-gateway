// OpenAI Chat Completions connectors and vendor-specific model discovery.
import { isObject } from '../protocols/json';
import type { JsonObject } from '../protocols/json';
import type { Price } from '../pricing';
import { UpstreamFailure } from './connector';
import type { Connector, ProviderAccess } from './connector';
import type { ProviderModelInput } from '../providerStore';
import { endpoint, fetchModels, optionalApiKey, positiveNumber, requiredApiKey } from './http';

interface Vendor {
  id: string;
  name: string;
  defaultBaseUrl: string | null;
  keyRequired: boolean;
  /** One entry of this vendor's model list as the gateway records it. */
  model(item: JsonObject): Omit<ProviderModelInput, 'upstreamId'>;
}

interface ModelRequest {
  url: string;
  headers: Record<string, string>;
  key: string | null;
}

const NO_PRICE: Price = { input: null, output: null, cacheRead: null };

/** USD per token text to USD per 1M tokens; docs/gateway-connectors.md §4. */
function usdPerTokenText(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Number((number * 1_000_000).toPrecision(9)) : null;
}

/** USD cents per 100M tokens to USD per 1M tokens; docs/gateway-connectors.md §5. */
function centsPer100M(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value / 10_000 : null;
}

function openaiModel(item: JsonObject): Omit<ProviderModelInput, 'upstreamId'> {
  return {
    contextLength: positiveNumber(item.context_length) ?? positiveNumber(item.context_window)
      ?? positiveNumber(item.max_model_len),
    maxOutputTokens: null,
    price: { ...NO_PRICE },
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
  };
}

function xaiModel(item: JsonObject): Omit<ProviderModelInput, 'upstreamId'> {
  return {
    contextLength: positiveNumber(item.context_length),
    maxOutputTokens: null,
    price: {
      input: centsPer100M(item.prompt_text_token_price),
      output: centsPer100M(item.completion_text_token_price),
      cacheRead: centsPer100M(item.cached_prompt_text_token_price),
    },
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
    async target(provider) {
      const { url, headers } = request(provider, '/chat/completions');
      return { url, headers, protocol: 'chat' };
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
  model: openrouterModel,
});
/** xAI's Chat Completions API. */
export const xai = connector({
  id: 'xai',
  name: 'xAI',
  defaultBaseUrl: 'https://api.x.ai/v1',
  keyRequired: true,
  model: xaiModel,
});
/**
 * The OpenAI API and every server that speaks its Chat Completions protocol. The address is the
 * official one until the administrator gives another; the key is optional because a server on
 * the local network may need none, and no key means no `Authorization` header at all.
 */
export const openaiCompatible = connector({
  id: 'openai-compatible',
  name: 'OpenAI-compatible',
  defaultBaseUrl: 'https://api.openai.com/v1',
  keyRequired: false,
  model: openaiModel,
});
