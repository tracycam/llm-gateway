// The AI-Hub daemon connector: control-plane links to live daemons, and their ready workers as
// upstream models. The app binds one instance to its daemon pool; the registry holds a
// standalone one that can still list a daemon's models from a one-shot snapshot.
import { isObject } from '../protocols/json';
import type { ServiceInstance } from './dgp';
import type { ProviderModelInput } from '../providerStore';
import { UpstreamFailure, type Connector, type LeaseResult, type ProviderAccess } from './connector';
import { fetchModels, optionalApiKey } from './http';
import { AihubPool, discoverModels } from './aihubPool';

/** What a service of a snapshot must say to be read as one. */
function isServiceInstance(value: unknown): value is ServiceInstance {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.status === 'string' &&
    typeof value.modelName === 'string' &&
    typeof value.maxConcurrency === 'number' &&
    typeof value.contextLength === 'number' &&
    (value.port === null || typeof value.port === 'number');
}

/** One daemon's ready services, read from its snapshot instead of the live event stream. */
async function snapshotModels(provider: ProviderAccess): Promise<ProviderModelInput[]> {
  const base = (provider.baseUrl ?? '').replace(/\/+$/, '');
  if (base === '') throw new UpstreamFailure('Base URL is required', null);
  const key = optionalApiKey(provider);
  const headers: Record<string, string> = {};
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  const body = await fetchModels(`${base}/api/v1/snapshot`, headers, key);
  if (!isObject(body) || !Array.isArray(body.services)) {
    throw new UpstreamFailure('Invalid daemon snapshot', null);
  }
  return discoverModels(body.services.filter(isServiceInstance));
}

function connectorOf(pool: AihubPool | null): Connector {
  return {
    id: 'aihub',
    name: 'AI-Hub',
    defaultBaseUrl: null,
    credential: 'optional-api-key',
    async target(provider, upstreamModel, inbound) {
      if (!pool) throw new UpstreamFailure('AI-Hub daemon is not connected', null);
      const target = pool.target(provider.id, upstreamModel, inbound);
      if (!target) throw new UpstreamFailure('No ready service for this model', null);
      return target;
    },
    async models(provider) {
      const live = pool?.liveModels(provider.id);
      return live ?? snapshotModels(provider);
    },
    routeAvailable: (providerId, upstreamModel) =>
      pool?.available(providerId, upstreamModel) ?? false,
    routeLimit: (providerId, upstreamModel) =>
      pool?.limit(providerId, upstreamModel) ?? 0,
    acquire: (providerId, upstreamModel, inbound, exclude, signal) =>
      pool
        ? pool.acquire(providerId, upstreamModel, inbound, exclude, signal)
        : Promise.resolve<LeaseResult>({ kind: 'unavailable' }),
  };
}

/** The connector bound to one gateway's daemon pool. */
export function createAihubConnector(pool: AihubPool): Connector {
  return connectorOf(pool);
}

/**
 * The registry's standalone description. It lists models from a daemon snapshot and cannot
 * route: inference always goes through the app's pool-bound connector.
 */
export const aihub: Connector = connectorOf(null);
