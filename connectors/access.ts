// Adapt the provider store to the connector's narrow view of a provider.
import type { ProviderModel, ProviderRecord, ProviderStore } from '../providerStore';
import type { ProviderAccess } from './connector';
import type { CredentialRenewals } from './tokens';

/**
 * Build connector access, reading the credential from the store whenever the connector asks for
 * it (a renewal another request made is visible at once) and models on first use. `renewals` is
 * the gateway's one renewal registry, so two requests for the same provider share a renewal.
 */
export function providerAccess(
  providers: ProviderStore, provider: ProviderRecord, renewals: CredentialRenewals,
): ProviderAccess {
  let models: ProviderModel[] | undefined;
  const access: ProviderAccess = {
    id: provider.id,
    baseUrl: provider.baseUrl,
    get credential() { return providers.credential(provider.id); },
    saveCredential: (credential) => { providers.setCredential(provider.id, credential); },
    rejectCredential: () => { providers.rejectCredential(provider.id); },
    renewOnce: (renew) => renewals.fresh(access, renew),
    model: (id) => {
      models ??= providers.models(provider.id);
      return models.find((model) => model.upstreamId === id) ?? null;
    },
  };
  return access;
}
