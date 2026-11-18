// A connector that signs a provider in with a device code and renews its access token with a
// rotating refresh token, built from the same helper and contract the three OAuth connectors
// will use. It exists so the shared machinery is proven before any of them is written.
import { accessTokenOf, UpstreamFailure } from '../connectors/connector';
import type { Connector, LoginConnector, ProviderAccess, UpstreamTarget } from '../connectors/connector';
import { deviceCodeLogin } from '../connectors/deviceCode';
import { due, LoginExpired } from '../connectors/tokens';
import { isObject, parseJson, type JsonObject } from '../protocols/json';

/** The credential this fake stores and reads back. */
export interface FakeCredential {
  accessToken: string;
  refreshToken: string;
  /** ISO time the access token stops working; null when the grant named no lifetime. */
  expiresAt: string | null;
}

export interface FakeLoginOptions {
  /** The connector id; `fake-login` unless a test needs two of them. */
  id?: string;
  /** The stub authorization server's two endpoints. */
  deviceEndpoint: string;
  tokenEndpoint: string;
  /** Where inference requests go. */
  upstream: string;
  /** The clock the stored expiry is computed from. */
  now(): Date;
  clientId?: string;
  scope?: string | null;
  extraForm?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface FakeLogin {
  connector: LoginConnector;
  /** The credential as the connector reads it, for assertions. */
  read(provider: ProviderAccess): FakeCredential | null;
}

function readCredential(text: string | null): FakeCredential | null {
  const body = parseJson(text ?? '');
  if (!isObject(body)) return null;
  const { accessToken, refreshToken, expiresAt } = body;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') return null;
  return { accessToken, refreshToken, expiresAt: typeof expiresAt === 'string' ? expiresAt : null };
}

/** The stored text of a token endpoint grant. */
function credentialText(body: JsonObject, now: Date): string | null {
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') return null;
  const lifetime = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
    ? body.expires_in : null;
  const credential: FakeCredential = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: lifetime === null ? null : new Date(now.getTime() + lifetime * 1000).toISOString(),
  };
  return JSON.stringify(credential);
}

/** Spend one refresh token; `400 invalid_grant` means the login is gone for good. */
async function renew(
  credential: FakeCredential, options: FakeLoginOptions,
): Promise<string> {
  const response = await fetch(options.tokenEndpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: options.clientId ?? 'fake-login-client',
    }).toString(),
    redirect: 'error',
  });
  const body = parseJson(await response.text());
  if (response.status === 400 && isObject(body) && body.error === 'invalid_grant') {
    throw new LoginExpired();
  }
  if (!response.ok || !isObject(body)) {
    throw new UpstreamFailure(`Token refresh failed with HTTP ${response.status}`, response.status);
  }
  const text = credentialText(body, options.now());
  if (text === null) throw new UpstreamFailure('Token refresh answered no token', response.status);
  return text;
}

/**
 * The fake connector. Its credential is the two tokens and the access token's expiry; a
 * request renews once the token is inside its last 5 minutes, through `provider.renewOnce`.
 */
export function fakeLoginConnector(options: FakeLoginOptions): FakeLogin {
  const now = options.now;
  const connector: LoginConnector = {
    id: options.id ?? 'fake-login',
    name: 'Fake login',
    defaultBaseUrl: options.upstream,
    credential: 'login',
    login: deviceCodeLogin({
      deviceEndpoint: options.deviceEndpoint,
      tokenEndpoint: options.tokenEndpoint,
      clientId: options.clientId ?? 'fake-login-client',
      scope: options.scope ?? null,
      extraForm: options.extraForm,
      headers: options.headers,
      now,
    }, (body) => credentialText(body, now())),
    async target(provider) {
      const stored = readCredential(provider.credential);
      if (stored === null) throw new UpstreamFailure('Sign in required', null);
      let credential = stored;
      const expiresAt = credential.expiresAt === null ? null : new Date(credential.expiresAt);
      if (due(expiresAt, now())) {
        const fresh = readCredential(await provider.renewOnce(() => renew(stored, options)));
        if (fresh === null) throw new UpstreamFailure('Sign in required', null);
        credential = fresh;
      }
      return {
        url: `${options.upstream}/chat/completions`,
        headers: { authorization: `Bearer ${credential.accessToken}` },
        protocol: 'chat',
      };
    },
    async models() {
      return [];
    },
    rejected(provider, target) {
      // One way a connector with a refresh token can act on a 401: let the next request renew —
      // for the token the refused request carried, never for one already replaced.
      const credential = readCredential(provider.credential);
      if (credential === null) return;
      if (accessTokenOf(target) !== credential.accessToken) return;
      provider.saveCredential(JSON.stringify({ ...credential, expiresAt: now().toISOString() }));
    },
  };
  return {
    connector,
    read: (provider) => readCredential(provider.credential),
  };
}

/** A connector that must never log in, for tests of the routes that refuse that. */
export function fakeKeyConnector(): Connector {
  return {
    id: 'fake-key',
    name: 'Fake key',
    defaultBaseUrl: 'https://example.test',
    credential: 'api-key',
    async target() { throw new Error('unused'); },
    async models() { return []; },
  };
}
