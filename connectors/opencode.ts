// OpenCode Zen and OpenCode Go: one implementation for the two Console plans. Both accept every
// listed model on the root of the client's own protocol and convert it themselves, so a request
// is passed through untranslated. Wire facts and their evidence: docs/gateway-connectors.md §9.
import pkg from '../../package.json';
import { isObject } from '../protocols/json';
import type { JsonObject } from '../protocols/json';
import type { Protocol } from '../protocols/protocol';
import { ANTHROPIC_VERSION } from './anthropic';
import { UpstreamFailure } from './connector';
import type { Connector, DiscoveredModel, ProviderAccess, UpstreamTarget } from './connector';
import { endpoint, fetchModels, positiveNumber, requiredApiKey } from './http';

/**
 * Sent on every request: OpenCode asks a client to identify itself rather than hide behind a
 * generic library's name (docs/gateway-connectors.md §9). The version is the root
 * `package.json`'s, which the image's build stage copies for this import.
 */
export const USER_AGENT = `aihub-gateway/${pkg.version}`;

// The header OpenCode asks a client to fill with a stable id per conversation; §9.
const SESSION_HEADER = 'x-opencode-session';

interface ModelRequest {
  url: string;
  headers: Record<string, string>;
  key: string;
}

/** A value when it is a JSON object, else the empty object. */
function objectOf(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

/** A listed price in USD per 1M tokens: finite and non-negative; 0 is a known free price. */
function priceOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function opencodeModel(item: JsonObject): Omit<DiscoveredModel, 'upstreamId'> {
  const text = objectOf(objectOf(item.cost).text);
  const input = objectOf(text.input);
  const output = objectOf(text.output);
  const cache = objectOf(input.cache);
  const limit = objectOf(item.limit);
  return {
    contextLength: positiveNumber(limit.context),
    maxOutputTokens: positiveNumber(limit.output),
    // The listed price is already USD per 1M tokens, so no conversion. `overrides` (a higher
    // price above a context threshold) and `multipliers` are not read: a request above the
    // threshold is under-costed by the gateway. §9.
    price: {
      input: priceOf(input.price),
      output: priceOf(output.price),
      cacheRead: priceOf(cache.read),
      cacheWrite: priceOf(cache.write),
    },
  };
}

function modelRequest(provider: ProviderAccess, defaultBase: string): ModelRequest {
  const key = requiredApiKey(provider);
  return {
    url: endpoint(provider, defaultBase, '/v1/models'),
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': USER_AGENT },
    key,
  };
}

function target(provider: ProviderAccess, defaultBase: string, inbound: Protocol): UpstreamTarget {
  const key = requiredApiKey(provider);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'User-Agent': USER_AGENT,
    // The value sent when the client names no conversation; the Go plan refuses a request
    // without this header at all. §9.
    [SESSION_HEADER]: `aihub-gateway-${provider.id}`,
  };
  if (inbound === 'messages') {
    return {
      url: endpoint(provider, defaultBase, '/anthropic/v1/messages'),
      protocol: 'messages',
      headers: { ...headers, 'anthropic-version': ANTHROPIC_VERSION },
    };
  }
  return {
    url: endpoint(provider, defaultBase, '/openai/v1/chat/completions'),
    protocol: 'chat',
    headers,
  };
}

function connector(id: string, name: string, defaultBase: string): Connector {
  return {
    id,
    name,
    defaultBaseUrl: defaultBase,
    credential: 'api-key',
    clientHeaders: [SESSION_HEADER],
    async target(provider, _upstreamModel, inbound) {
      return target(provider, defaultBase, inbound);
    },
    async models(provider) {
      const { url, headers, key } = modelRequest(provider, defaultBase);
      const body = await fetchModels(url, headers, key);
      if (!isObject(body) || !Array.isArray(body.data)) {
        throw new UpstreamFailure('Invalid model list', null);
      }
      const models: DiscoveredModel[] = [];
      for (const item of body.data) {
        if (!isObject(item) || typeof item.id !== 'string') continue;
        if (item.type !== undefined && item.type !== 'chat') continue;
        models.push({ upstreamId: item.id, ...opencodeModel(item) });
      }
      return models;
    },
  };
}

/** OpenCode Zen: Console credits, pay as you go. */
export const opencode = connector('opencode', 'OpenCode Zen', 'https://opencode.ai/inference');
/** OpenCode Go: the subscription plan, served under its own base. */
export const opencodeGo = connector('opencode-go', 'OpenCode Go', 'https://opencode.ai/inference/go');
