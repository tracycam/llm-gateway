// Adapt the provider store to the connector's narrow view of a provider.
import type { ProviderModel, ProviderRecord, ProviderStore } from '../providerStore';
import type { ProviderAccess } from './connector';

/** Build connector access, loading credentials now and models on first use. */
export function providerAccess(providers: ProviderStore, provider: ProviderRecord): ProviderAccess {
  let models: ProviderModel[] | undefined;
  return {
    id: provider.id,
    baseUrl: provider.baseUrl,
    credential: providers.credential(provider.id),
    saveCredential: (credential) => { providers.setCredential(provider.id, credential); },
    model: (id) => {
      models ??= providers.models(provider.id);
      return models.find((model) => model.upstreamId === id) ?? null;
    },
  };
}
