// Anthropic Messages connector and paginated model discovery.
import { isObject } from '../protocols/json';
import { UpstreamFailure } from './connector';
import type { Connector, DiscoveredModel, ProviderAccess } from './connector';
import { endpoint, fetchModels, positiveNumber, requiredApiKey } from './http';

/** The version in current examples, documented in docs/gateway-connectors.md §2. */
export const ANTHROPIC_VERSION = '2026-10-21';
const MAX_PAGES = 20;
const BASE = 'https://api.anthropic.com';

interface ModelRequest {
  url: string;
  headers: Record<string, string>;
  key: string;
}

function request(provider: ProviderAccess, path: string): ModelRequest {
  const key = requiredApiKey(provider);
  return {
    url: endpoint(provider, BASE, path),
    headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
    key,
  };
}

async function modelsPage(provider: ProviderAccess, after: string | null): Promise<{
  models: DiscoveredModel[];
  next: string | null;
}> {
  const query = new URLSearchParams({ limit: '1000' });
  if (after !== null) query.set('after_id', after);
  const { url, headers, key } = request(provider, `/v1/models?${query}`);
  const body = await fetchModels(url, headers, key);
  if (!isObject(body) || !Array.isArray(body.data) || typeof body.has_more !== 'boolean') {
    throw new UpstreamFailure('Invalid model list', null);
  }
  const models: DiscoveredModel[] = [];
  for (const item of body.data) {
    if (!isObject(item) || typeof item.id !== 'string') continue;
    models.push({
      upstreamId: item.id,
      contextLength: positiveNumber(item.max_input_tokens),
      maxOutputTokens: positiveNumber(item.max_tokens),
      price: { input: null, output: null, cacheRead: null, cacheWrite: null },
    });
  }
  if (!body.has_more) return { models, next: null };
  if (typeof body.last_id !== 'string' || !body.last_id || body.last_id === after) {
    throw new UpstreamFailure('Invalid model pagination cursor', null);
  }
  return { models, next: body.last_id };
}

/** Anthropic's Messages API. */
export const anthropic: Connector = {
  id: 'anthropic',
  name: 'Anthropic',
  defaultBaseUrl: BASE,
  credential: 'api-key',
  async target(provider) {
    const { url, headers } = request(provider, '/v1/messages');
    return { url, headers, protocol: 'messages' };
  },
  async models(provider) {
    const models: DiscoveredModel[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await modelsPage(provider, after);
      models.push(...result.models);
      if (result.next === null) return models;
      after = result.next;
    }
    throw new UpstreamFailure(`Model list exceeds ${MAX_PAGES} pages`, null);
  },
};
