// Grok on a SuperGrok / X Premium Plus subscription, signed in the way xAI's own terminal
// client (Grok Build) signs in: an OAuth device code against auth.x.ai, then requests to the
// CLI chat proxy. This is the subscription path, not the API-key path of `api.x.ai` (§5).
//
// Ported from, all read 2026-11-18:
// - xai-org/grok-build @ 2bdd1d6a, Apache-2.0 — crates/codegen/xai-grok-login/src/
//   {device_code.rs, config.rs, model.rs, oidc/protocol.rs, oidc/refresh.rs,
//   grok_auth_credentials.rs}, crates/codegen/xai-grok-shell/src/agent/proxy_headers.rs,
//   crates/codegen/xai-grok-shell/src/remote/{client.rs, model_source/oai.rs} and
//   crates/codegen/xai-grok-config/src/endpoints.rs: the login and refresh grant, where the
//   user id comes from, the header set, the model list entry, the inference host.
// - anomalyco/opencode @ 007afb1b, MIT — packages/core/src/plugin/provider/xai.ts: the
//   TypeScript shape of the device flow and the expiry fallback.
// - router-for-me/CLIProxyAPI @ a5e8f69e, MIT — internal/auth/xai/ and
//   internal/runtime/executor/{xai_executor.go, xai_executor_request.go, helps/xai_version.go}:
//   a headless gateway doing the same, the pinned client version and the 1.0.13 / 426 floor.
//
// Wire facts and their evidence: docs/gateway-connectors.md §10.
import { isObject, parseJson, type JsonObject } from '../protocols/json';
import type { Protocol } from '../protocols/protocol';
import type { ProviderModelInput } from '../providerStore';
import { endpoint, fetchModels, positiveNumber } from './http';
import { deviceCodeLogin } from './deviceCode';
import { accessTokenOf, protocolFor, UpstreamFailure } from './connector';
import type { LoginConnector, ProviderAccess, UpstreamTarget } from './connector';
import { due, LoginExpired } from './tokens';

/** xAI's authorization server: the device code and every renewal. */
export const AUTH_BASE = 'https://auth.x.ai';

/** The CLI chat proxy a subscription is served from — not the API-key host `api.x.ai` (§10). */
export const PROXY_BASE = 'https://cli-chat-proxy.grok.com/v1';

/** The public OAuth client of Grok Build (grok-build config.rs:378-384). */
export const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

/** `grok-cli:access` authorizes the token for proxy requests (grok-build config.rs:10-23). */
export const SCOPE = 'openid profile email offline_access grok-cli:access api:access';

/** Attribution only: the device request accepts it without a value or with any value (§10). */
export const REFERRER = 'aihub-gateway';

/**
 * `x-grok-client-version`. The proxy refuses a version below 1.0.13 with HTTP 426; 1.0.46 was
 * the newest Grok Build published on npm when §10 was written (2026-11-18), and is the value
 * CLIProxyAPI pins as its fallback (helps/xai_version.go). Grok Build declared 1.0.45 at the
 * commit read. Compare it numerically, never as text.
 */
export const CLIENT_VERSION = '1.0.46';

/**
 * The `User-Agent`. CLIProxyAPI, the headless gateway doing the same, identifies as the
 * workspace client at the pinned version (`xai-grok-workspace/<version>`); Grok Build itself
 * sends `grok-shell/<version> (os; arch)`. The value is the reference's, not invented.
 */
const USER_AGENT = `xai-grok-workspace/${CLIENT_VERSION}`;

// The header set every authenticated proxy call carries (proxy_headers.rs,
// grok_auth_credentials.rs:93-110, CLIProxyAPI xai_executor_request.go:413-427).
const TOKEN_AUTH_HEADER = 'X-XAI-Token-Auth';
const TOKEN_AUTH_VALUE = 'xai-grok-cli';
const CLIENT_IDENTIFIER = 'grok-shell';
const AUTHENTICATE_RESPONSE = 'authenticate-response';
const CLIENT_MODE = 'interactive';

/**
 * Lifetime of a grant that states neither `expires_in` nor a JWT `exp` — one hour, the fallback
 * opencode's xAI provider uses. Grok Build assumes 30 days and CLIProxyAPI none; a wrong guess
 * costs one 401, after which `rejected` makes the next request renew (§10: lifetimes 未证实).
 */
export const FALLBACK_LIFETIME_S = 3600;

/** Path of each protocol on the proxy. §10: `/chat/completions`, `/responses`, `/messages`. */
const PATHS: Record<Protocol, string> = {
  chat: '/chat/completions',
  responses: '/responses',
  messages: '/messages',
};

/**
 * The stored credential of one Grok provider: the two tokens, the access token's expiry, and
 * what later requests need. Written and read only by this connector.
 */
export interface GrokCredential {
  accessToken: string;
  /** Rotates on every renewal and is single-use; the newest one is always stored first. */
  refreshToken: string;
  /** ISO time the access token stops working. */
  expiresAt: string;
  /** The id `x-userid` carries; null when no grant named one. */
  userId: string | null;
  /** `x-email`, when a grant carried one; null otherwise. */
  email: string | null;
  /**
   * What a 401 did to this token, so the connector never renews in a loop against a proxy that
   * refuses the account. `refused`: the proxy refused this access token, and the renewal that
   * follows is the one it forced. `forced`: this access token exists because a 401 forced that
   * renewal, so a 401 on it means the account itself is refused. Absent for an ordinary token,
   * and a renewal that became due by time stores a token with no mark.
   */
  renewal?: 'refused' | 'forced';
}

/** Whether a stored value is a renewal mark this connector understands. */
function isRenewalMark(value: unknown): value is 'refused' | 'forced' {
  return value === 'refused' || value === 'forced';
}

/** What the connector talks to; a test gives the stub authorization server and its own clock. */
export interface GrokOptions {
  /** Base of the authorization server; the default is xAI's. */
  authBase?: string;
  /** The clock every expiry is computed and compared against. */
  now?: () => Date;
}

/** A non-empty string, or null. */
function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The payload of a JWT, or null when the token is not one this gateway can read. */
function claimsOf(token: string): JsonObject | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  const body = parseJson(Buffer.from(payload, 'base64url').toString('utf8'));
  return isObject(body) ? body : null;
}

interface Identity {
  userId: string | null;
  email: string | null;
}

/**
 * Who a grant belongs to. Grok Build reads the `id_token`'s `sub` and `email` (device_code.rs,
 * `build_auth`); when the grant carries no readable `id_token` it takes the access token's
 * principal instead, which team and organization sessions put in `principal_id` because they
 * have no personal `sub`.
 */
function identityOf(body: JsonObject): Identity | null {
  const idToken = stringOf(body.id_token);
  if (idToken !== null) {
    const claims = claimsOf(idToken);
    if (claims !== null) return { userId: stringOf(claims.sub), email: stringOf(claims.email) };
  }
  const accessToken = stringOf(body.access_token);
  const claims = accessToken === null ? null : claimsOf(accessToken);
  if (claims === null) return null;
  const principalType = stringOf(claims.principal_type) ?? stringOf(claims.principalType);
  const principalId = stringOf(claims.principal_id) ?? stringOf(claims.principalId);
  if (principalId !== null && (principalType === 'Team' || principalType === 'Organization')) {
    return { userId: principalId, email: null };
  }
  return { userId: stringOf(claims.sub), email: stringOf(claims.email) };
}

/**
 * When the access token stops working: `expires_in` when the grant states it (zero means
 * already expired), else the JWT's `exp`, else {@link FALLBACK_LIFETIME_S} from now.
 */
function expiryOf(body: JsonObject, accessToken: string, now: Date): Date {
  const lifetime = body.expires_in;
  if (typeof lifetime === 'number' && Number.isFinite(lifetime) && lifetime >= 0) {
    return new Date(now.getTime() + lifetime * 1000);
  }
  const exp = claimsOf(accessToken)?.exp;
  if (typeof exp === 'number' && Number.isFinite(exp)) return new Date(exp * 1000);
  return new Date(now.getTime() + FALLBACK_LIFETIME_S * 1000);
}

/**
 * The stored text of a token endpoint answer. `previous` is the credential being renewed: a
 * rotation that omits the refresh token keeps the old one (as Grok Build does), and an identity
 * field the answer omits keeps its old value. Null says the answer held no usable token.
 */
function credentialText(
  body: JsonObject, now: Date, previous: GrokCredential | null, renewal?: 'refused' | 'forced',
): string | null {
  const accessToken = stringOf(body.access_token);
  const refreshToken = stringOf(body.refresh_token) ?? previous?.refreshToken ?? null;
  if (accessToken === null || refreshToken === null) return null;
  const identity = identityOf(body);
  const credential: GrokCredential = {
    accessToken,
    refreshToken,
    expiresAt: expiryOf(body, accessToken, now).toISOString(),
    userId: identity?.userId ?? previous?.userId ?? null,
    email: identity?.email ?? previous?.email ?? null,
    ...(renewal === undefined ? {} : { renewal }),
  };
  return JSON.stringify(credential);
}

/** Read the stored text; null when it is not a credential this connector wrote. */
export function readGrokCredential(stored: string | null): GrokCredential | null {
  if (stored === null) return null;
  const body = parseJson(stored);
  if (!isObject(body)) return null;
  const accessToken = stringOf(body.accessToken);
  const refreshToken = stringOf(body.refreshToken);
  const expiresAt = stringOf(body.expiresAt);
  if (accessToken === null || refreshToken === null || expiresAt === null) return null;
  if (Number.isNaN(new Date(expiresAt).getTime())) return null;
  if (body.renewal !== undefined && !isRenewalMark(body.renewal)) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt,
    userId: stringOf(body.userId),
    email: stringOf(body.email),
    ...(body.renewal === undefined ? {} : { renewal: body.renewal }),
  };
}

/** The `api_backend` of a model entry as the protocol it speaks; null when it names none we serve. */
function protocolsOf(value: unknown): Protocol[] | null {
  if (value === 'chat_completions') return ['chat'];
  if (value === 'responses') return ['responses'];
  if (value === 'messages') return ['messages'];
  return null;
}

/**
 * One `/models` entry. The id is the field Grok Build sends upstream: `model`, else `modelId`,
 * else the OpenAI `id`, also read from `_meta` (remote/client.rs, `parse_remote_model_value`);
 * an entry with none of them is skipped. The proxy lists no per-token price, so all three
 * prices stay null rather than being invented. A limit the entry does not state stays null.
 */
function modelOf(item: JsonObject): ProviderModelInput | null {
  const meta = isObject(item._meta) ? item._meta : {};
  const upstreamId = stringOf(item.model) ?? stringOf(item.modelId) ?? stringOf(item.id)
    ?? stringOf(meta.model) ?? stringOf(meta.modelId);
  if (upstreamId === null) return null;
  return {
    upstreamId,
    contextLength: positiveNumber(item.context_window) ?? positiveNumber(item.contextWindow)
      ?? positiveNumber(meta.contextWindow) ?? positiveNumber(meta.totalContextTokens),
    maxOutputTokens: positiveNumber(item.max_completion_tokens)
      ?? positiveNumber(item.maxCompletionTokens),
    price: { input: null, output: null, cacheRead: null },
    protocols: protocolsOf(item.api_backend ?? item.apiBackend),
  };
}

/**
 * The Grok connector. Its credential is a login; a request renews inside the token's last five
 * minutes through `provider.renewOnce`, because the refresh token rotates and is single-use.
 */
export function grokConnector(options: GrokOptions = {}): LoginConnector {
  const authBase = (options.authBase ?? AUTH_BASE).replace(/\/+$/, '');
  const now = options.now ?? (() => new Date());
  const tokenEndpoint = `${authBase}/oauth2/token`;

  /** Spend the refresh token once; `400 invalid_grant` means the login must be made again. */
  async function renew(credential: GrokCredential): Promise<string> {
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credential.refreshToken,
          client_id: CLIENT_ID,
        }).toString(),
        redirect: 'error',
      });
      body = parseJson(await response.text());
    } catch (error) {
      // The authorization server could not be asked at all: the login is not gone, so the route
      // fails and nothing is marked. The message names no token.
      const message = error instanceof Error ? error.message : 'Network error';
      throw new UpstreamFailure(`Token refresh failed: ${message}`, null);
    }
    if (response.status === 400 && isObject(body) && body.error === 'invalid_grant') {
      throw new LoginExpired();
    }
    if (!response.ok || !isObject(body)) {
      throw new UpstreamFailure(`Token refresh failed with HTTP ${response.status}`, response.status);
    }
    // A renewal the 401 mark forced mints a token marked forced; a renewal by time clears it.
    const renewal = credential.renewal === 'refused' ? 'forced' : undefined;
    const renewed = credentialText(body, now(), credential, renewal);
    if (renewed === null) {
      throw new UpstreamFailure('Token refresh answered no token', response.status);
    }
    return renewed;
  }

  /** The credential a request must use: the stored one, renewed first when it is due. */
  async function live(provider: ProviderAccess): Promise<GrokCredential> {
    const stored = readGrokCredential(provider.credential);
    if (stored === null) throw new UpstreamFailure('Sign in required', null);
    if (!due(new Date(stored.expiresAt), now())) return stored;
    const renewed = readGrokCredential(await provider.renewOnce(() => renew(stored)));
    if (renewed === null) throw new UpstreamFailure('Sign in required', null);
    return renewed;
  }

  /** The headers every authenticated inference call carries (proxy_headers.rs). */
  function inferenceHeaders(credential: GrokCredential): Record<string, string> {
    return {
      Authorization: `Bearer ${credential.accessToken}`,
      [TOKEN_AUTH_HEADER]: TOKEN_AUTH_VALUE,
      'x-grok-client-version': CLIENT_VERSION,
      'x-grok-client-identifier': CLIENT_IDENTIFIER,
      'x-authenticateresponse': AUTHENTICATE_RESPONSE,
      'x-grok-client-mode': CLIENT_MODE,
      'User-Agent': USER_AGENT,
    };
  }

  /**
   * The model list's headers: exactly what Grok Build sends there (remote/model_source/oai.rs).
   * The client-identifier and authenticate-response markers are for inference only.
   */
  function modelListHeaders(credential: GrokCredential): Record<string, string> {
    return {
      Authorization: `Bearer ${credential.accessToken}`,
      [TOKEN_AUTH_HEADER]: TOKEN_AUTH_VALUE,
      'x-grok-client-version': CLIENT_VERSION,
      'x-grok-client-mode': CLIENT_MODE,
      'User-Agent': USER_AGENT,
    };
  }

  return {
    id: 'grok',
    name: 'Grok',
    defaultBaseUrl: PROXY_BASE,
    credential: 'login',
    login: deviceCodeLogin({
      deviceEndpoint: `${authBase}/oauth2/device/code`,
      tokenEndpoint,
      clientId: CLIENT_ID,
      scope: SCOPE,
      extraForm: { referrer: REFERRER },
      now,
    }, (body) => credentialText(body, now(), null)),
    async target(provider, upstreamModel, inbound) {
      const credential = await live(provider);
      const protocols = provider.model(upstreamModel)?.protocols ?? null;
      // An entry that names no `api_backend` is Chat Completions: Grok Build's default backend.
      const protocol = protocolFor(protocols, inbound, 'chat');
      return {
        url: endpoint(provider, PROXY_BASE, PATHS[protocol]),
        headers: inferenceHeaders(credential),
        protocol,
      };
    },
    async models(provider) {
      const credential = await live(provider);
      const headers = modelListHeaders(credential);
      // The model list, unlike inference, names the user the login belongs to.
      if (credential.userId !== null) headers['x-userid'] = credential.userId;
      if (credential.email !== null) headers['x-email'] = credential.email;
      let body: unknown;
      try {
        body = await fetchModels(
          endpoint(provider, PROXY_BASE, '/models'), headers, credential.accessToken,
        );
      } catch (error) {
        // 426 is the proxy's client-version gate: name the version this gateway sent, or the
        // administrator cannot tell what to fix.
        if (error instanceof UpstreamFailure && error.status === 426) {
          throw new UpstreamFailure(
            `The proxy no longer accepts x-grok-client-version ${CLIENT_VERSION} (HTTP 426); `
            + 'this gateway must send a newer Grok client version',
            426,
          );
        }
        throw error;
      }
      if (!isObject(body) || !Array.isArray(body.data)) {
        throw new UpstreamFailure('Invalid model list', null);
      }
      const models: ProviderModelInput[] = [];
      for (const item of body.data) {
        if (!isObject(item)) continue;
        const model = modelOf(item);
        if (model !== null) models.push(model);
      }
      return models;
    },
    rejected(provider, target) {
      const credential = readGrokCredential(provider.credential);
      if (credential === null) {
        // Nothing to renew with: only a new login can fix this provider.
        provider.rejectCredential();
        return;
      }
      // A 401 for a token another request already replaced says nothing about the login: acting
      // on it would overwrite the newer tokens with the refused one's spent refresh token.
      if (accessTokenOf(target) !== credential.accessToken) return;
      if (credential.renewal === 'forced') {
        // This token came from the renewal a 401 forced, and the proxy refused it too: the
        // account itself is refused, so renewing again would only mint another refusal.
        provider.rejectCredential();
        return;
      }
      // The next request renews; the token keeps its place until that renewal stores a new one.
      provider.saveCredential(JSON.stringify({
        ...credential, expiresAt: now().toISOString(), renewal: 'refused',
      }));
    },
  };
}

/** The connector the registry lists, talking to xAI's real authorization server. */
export const grok: LoginConnector = grokConnector();
