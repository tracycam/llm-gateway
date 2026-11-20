import type { ConnectorInfo, ProviderRecord } from '@shared/api';

/** Whether the provider's connector signs in (device code) rather than taking an API key. */
export function logsIn(provider: Pick<ProviderRecord, 'connector'>, connectors: readonly ConnectorInfo[]): boolean {
  return connectors.find((item) => item.id === provider.connector)?.credential === 'login';
}

/**
 * What keeps a provider from being sent requests because of its credential, for the tag beside
 * its name; null when nothing does. A refused credential is the worst: requests no longer go
 * there.
 */
export function credentialProblem(
  provider: Pick<ProviderRecord, 'connector' | 'hasCredential' | 'credentialRejected'>,
  connectors: readonly ConnectorInfo[],
): { tone: 'danger' | 'warn'; text: string } | null {
  const login = logsIn(provider, connectors);
  if (provider.credentialRejected) return { tone: 'danger', text: login ? '需重新登录' : 'API Key 被拒' };
  if (login && !provider.hasCredential) return { tone: 'warn', text: '未登录' };
  return null;
}

/**
 * What the tag beside a provider's name says: a credential problem first (it stops requests),
 * else a failed model list sync (the list is stale; requests still go out). Null when neither.
 */
export function providerProblem(
  provider: Pick<ProviderRecord, 'connector' | 'hasCredential' | 'credentialRejected' | 'modelsError'>,
  connectors: readonly ConnectorInfo[],
): { tone: 'danger' | 'warn'; text: string; detail?: string } | null {
  const credential = credentialProblem(provider, connectors);
  if (credential) return credential;
  if (provider.modelsError !== null) return { tone: 'warn', text: '同步失败', detail: provider.modelsError };
  return null;
}

/**
 * Whether the gateway can ask this provider for its model list now: enabled, and a credential
 * that is not refused — stored, unless the connector works without one.
 */
export function canSync(
  provider: Pick<ProviderRecord, 'connector' | 'enabled' | 'hasCredential' | 'credentialRejected'>,
  connectors: readonly ConnectorInfo[],
): boolean {
  const connector = connectors.find((item) => item.id === provider.connector);
  if (!connector || !provider.enabled || provider.credentialRejected) return false;
  return connector.credential === 'optional-api-key' || provider.hasCredential;
}
