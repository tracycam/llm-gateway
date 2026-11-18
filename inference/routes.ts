// Which routes of a model a request can be sent on: enabled, with a live provider, a known
// connector and a credential that can still work. Pure: reads the stores and the connector
// registry, nothing else.

import type { Connector } from '../connectors/connector';
import type { ModelRecord, RouteRecord } from '../modelStore';
import type { ProviderRecord, ProviderStore } from '../providerStore';

/** A route of a model together with what is needed to use it. */
export interface UsableRoute {
  route: RouteRecord;
  provider: ProviderRecord;
  connector: Connector;
}

/**
 * Whether requests may be sent to this provider: its credential is not one the provider has
 * refused, and a provider the gateway signs in has a credential. Requests sent to such a
 * provider would fail and cost a round trip, so the model fails over instead.
 */
function credentialUsable(provider: ProviderRecord, connector: Connector): boolean {
  if (provider.credentialRejected) return false;
  return connector.credential !== 'login' || provider.hasCredential;
}

/**
 * The routes of `model` a request may be sent on: the route is enabled, its provider exists
 * and is enabled, the provider's connector is known, and the provider's credential is usable.
 * In the order the store returns them.
 */
export function usableRoutes(
  model: ModelRecord,
  providers: ProviderStore,
  connector: (id: string) => Connector | null,
): UsableRoute[] {
  const usable: UsableRoute[] = [];
  for (const route of model.routes) {
    if (!route.enabled) continue;
    const provider = providers.get(route.providerId);
    if (!provider || !provider.enabled) continue;
    const found = connector(provider.connector);
    if (!found) continue;
    if (!credentialUsable(provider, found)) continue;
    usable.push({ route, provider, connector: found });
  }
  return usable;
}
