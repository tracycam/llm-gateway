// What a connector is: the code that knows one kind of upstream. It answers four questions
// and nothing else — how the provider is authenticated, where a request goes, with which
// headers and in which protocol, and which models the provider offers. It does not parse
// streams, count usage or choose routes.
import type { Protocol } from '../protocols/protocol';
import type { CredentialKind } from '../../protocol/gatewayApi';
import type { ProviderModelInput } from '../providerStore';

// `CredentialKind` crosses the management API; protocol/gatewayApi.ts defines it once.
export type { CredentialKind };

/** A provider as its connector sees it. */
export interface ProviderAccess {
  id: string;
  /** The address the administrator gave; null when the connector's default applies. */
  baseUrl: string | null;
  /**
   * The stored credential, a JSON text only the connector reads; null when there is none. It is
   * read as stored now, every time: a renewal another request stored is visible here at once.
   */
  credential: string | null;
  /** Replaces the stored credential, for example after a login token was renewed. */
  saveCredential(credential: string): void;
  /**
   * Marks the stored credential as refused by the provider. Its routes are left out of routing
   * until a new credential is stored, which clears the mark.
   */
  rejectCredential(): void;
  /**
   * Runs one credential renewal for this provider, unless one is already running: every caller
   * gets that one's result, and the new credential is stored before any of them resumes. A
   * connector with a rotating refresh token calls this from `target` instead of renewing itself.
   */
  renewOnce(renew: () => Promise<string>): Promise<string>;
  /** What the provider said about one of its models when they were last listed. */
  model(upstreamModel: string): ProviderModelInput | null;
}

/** A device-code grant as the authorization server issued it. */
export interface DeviceCode {
  /** Shown to the administrator, e.g. `ABCD-1234`. */
  userCode: string;
  /** The page where the administrator confirms the code. */
  verificationUri: string;
  /** The same address with the code filled in, when the server gives one. */
  verificationUriComplete: string | null;
  /** When the code stops being accepted. */
  expiresAt: Date;
  /** Seconds between polls. */
  interval: number;
  /** What `poll` needs and nobody else may see: the device code. */
  secret: string;
}

/** One answer of the token endpoint to a poll. */
export type DeviceLoginPoll =
  | { status: 'pending' }
  /** RFC 8628: wait 5 s longer between polls from now on. */
  | { status: 'slow-down' }
  /** The administrator confirmed; `credential` is the JSON text to store for the provider. */
  | { status: 'granted'; credential: string }
  /** Denied, expired, or an error fit to show. The reason names no secret. */
  | { status: 'refused'; reason: string };

/** Signing a provider in with the device-code flow (RFC 8628). */
export interface DeviceLogin {
  /** Ask the authorization server for a code the administrator confirms in a browser. */
  start(fetcher: typeof fetch): Promise<DeviceCode>;
  /**
   * Ask once whether the administrator has confirmed. Rejects when the server could not be
   * asked at all (a network failure or a 5xx): the code may still be confirmed, so the caller
   * keeps polling until it expires.
   */
  poll(code: DeviceCode, fetcher: typeof fetch): Promise<DeviceLoginPoll>;
}

/** Where one request goes. */
export interface UpstreamTarget {
  url: string;
  /** Authentication and whatever else the upstream requires on every request. */
  headers: Record<string, string>;
  /** The protocol this upstream model speaks at that URL. */
  protocol: Protocol;
}

/** What every connector does, whatever its credential kind. */
export interface ConnectorBase {
  /** Stored with the provider; never changes once released. */
  id: string;
  /** Shown where a provider is added. */
  name: string;
  /** Null when the administrator has to give the address. */
  defaultBaseUrl: string | null;
  /**
   * Request headers of the client that this upstream wants passed on. One the client sent
   * replaces the header of the same name from `target`; one it did not send changes nothing.
   */
  clientHeaders?: readonly string[];
  /**
   * Where a request for `upstreamModel` goes. `inbound` is the protocol the client used: a
   * connector whose upstream speaks several protocols for this model picks that one, so the
   * request can be passed through untouched.
   */
  target(provider: ProviderAccess, upstreamModel: string, inbound: Protocol): Promise<UpstreamTarget>;
  /** The models the provider offers now. Rejects when the provider cannot be asked. */
  models(provider: ProviderAccess): Promise<ProviderModelInput[]>;
  /**
   * The upstream refused the credential on the request sent to `target` (HTTP 401). A connector
   * acts only when that request carried the credential stored now; a 401 for a token another
   * request has already replaced changes nothing. What follows is the connector's choice: one
   * without a refresh token marks the credential rejected; one with a refresh token lets the
   * next request renew it.
   */
  rejected?(provider: ProviderAccess, target: UpstreamTarget): void;
}

/** A connector whose provider the administrator gives an API key. */
export interface KeyConnector extends ConnectorBase {
  credential: 'api-key' | 'optional-api-key';
  /** Absent: this connector cannot log a provider in. */
  login?: undefined;
}

/** A connector whose provider the gateway signs in with a device code and keeps signed in. */
export interface LoginConnector extends ConnectorBase {
  credential: 'login';
  /** Required: a login connector must be able to log in. */
  login: DeviceLogin;
}

/** One kind of upstream. Which credential kind it has decides whether it can log in. */
export type Connector = KeyConnector | LoginConnector;

/**
 * The protocol to use for a request: the client's own when the model speaks it (so the request
 * passes through untouched), else the model's first — which the caller may then be unable to
 * serve, and the request is skipped as incompatible. Null `protocols` → `fallback`.
 *
 * `protocols` is a non-empty list or null: `attempt` answers a model that says it speaks none
 * before a connector is asked, so an empty list cannot come through. Should one reach here
 * anyway, nothing can be computed from it and `fallback` applies.
 */
export function protocolFor(
  protocols: Protocol[] | null, inbound: Protocol, fallback: Protocol,
): Protocol {
  if (protocols === null || protocols.length === 0) return fallback;
  return protocols.includes(inbound) ? inbound : protocols[0];
}

/**
 * The bearer token a target presents, or null when it presents none. `rejected` compares it with
 * the credential stored now to tell a 401 for the current token from a late one.
 */
export function accessTokenOf(target: UpstreamTarget): string | null {
  const authorization = Object.entries(target.headers)
    .find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  if (authorization === undefined) return null;
  return /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] ?? null;
}

/** A failure of the upstream that a connector reports in words fit to show. */
export class UpstreamFailure extends Error {
  constructor(
    message: string,
    /** The upstream's status; null when there was no answer. */
    public readonly status: number | null
  ) {
    super(message);
  }
}
