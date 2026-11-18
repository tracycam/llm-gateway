// Dependencies shared by gateway management handlers.
import type { Connector } from '../connectors/connector';
import type { ModelStore } from '../modelStore';
import type { ProviderStore } from '../providerStore';

/** Services supplied by the gateway to management handlers. */
export interface AdminDeps {
  providers: ProviderStore;
  models: ModelStore;
  connector(id: string): Connector | null;
  connectors(): readonly Connector[];
  now(): Date;
}
