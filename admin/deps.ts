// Dependencies shared by gateway management handlers.
import type { Connector } from '../connectors/connector';
import type { CredentialRenewals } from '../connectors/tokens';
import type { KeyStore } from '../keyStore';
import type { LoginSessions } from '../login';
import type { ModelStore } from '../modelStore';
import type { ModelSync } from '../modelSync';
import type { ProviderStore } from '../providerStore';
import type { UsageStore } from '../usageStore';

/** Services supplied by the gateway to management handlers. */
export interface AdminDeps {
  providers: ProviderStore;
  models: ModelStore;
  keys: KeyStore;
  usage: UsageStore;
  /** The gateway's one login registry. */
  logins: LoginSessions;
  /** The gateway's one model sync: it fetches, stores and auto-publishes a provider's models. */
  sync: ModelSync;
  /** The gateway's one renewal registry. */
  renewals: CredentialRenewals;
  connector(id: string): Connector | null;
  connectors(): readonly Connector[];
  now(): Date;
  /**
   * A provider was created, changed or deleted. A connector that keeps live state (an AI-Hub
   * daemon link) reconciles it here; absent when no connector needs it.
   */
  onProviderChanged?(providerId: string): void;
}
