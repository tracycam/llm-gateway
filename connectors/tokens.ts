// Keeping a login alive: one credential renewal per provider at a time, and the error a
// connector throws when the authorization server says the refresh token is gone.
import type { ProviderAccess } from './connector';

/**
 * The authorization server no longer accepts the refresh token (`400 invalid_grant`): the
 * provider must be signed in again. The message is fixed, so nothing a connector reads from
 * that server can reach a log line.
 */
export class LoginExpired extends Error {
  constructor() {
    super('Provider login expired; sign in again');
    this.name = 'LoginExpired';
  }
}

/**
 * Whether a credential should be renewed now: inside its last `leadSeconds`, or already past
 * its expiry. A credential with no expiry (`null`) is never renewed here; a login without one
 * has nothing to renew with.
 */
export function due(expiresAt: Date | null, now: Date, leadSeconds = 300): boolean {
  if (expiresAt === null) return false;
  return expiresAt.getTime() - now.getTime() <= leadSeconds * 1000;
}

/**
 * Renewals in flight, one per provider. A connector whose refresh token rotates calls `fresh`
 * from `target`: the second of two concurrent callers waits for the first one's renewal instead
 * of spending a refresh token that is already spent (docs/connectors.md §10).
 */
export class CredentialRenewals {
  private readonly running = new Map<string, Promise<string>>();

  /**
   * Run `renew` for this provider unless one is already running; every caller gets that one's
   * result, which is the credential text now stored. The credential is stored before any
   * caller is released, a rejection reaches every waiter and stores nothing, and the next call
   * after it settles starts a new renewal.
   */
  public fresh(provider: ProviderAccess, renew: () => Promise<string>): Promise<string> {
    const running = this.running.get(provider.id);
    if (running) return running;
    const renewed = Promise.resolve().then(renew).then((credential) => {
      provider.saveCredential(credential);
      return credential;
    });
    this.running.set(provider.id, renewed);
    const clear = (): void => {
      if (this.running.get(provider.id) === renewed) this.running.delete(provider.id);
    };
    // Both outcomes free the slot; the rejection itself is delivered to the waiters.
    renewed.then(clear, clear);
    return renewed;
  }
}
