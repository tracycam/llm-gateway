// What a connector is: the code that knows one kind of upstream. It answers four questions
// and nothing else — how the provider is authenticated, where a request goes, with which
// headers and in which protocol, and which models the provider offers. It does not parse
// streams, count usage or choose routes.
import type { Protocol } from '../protocols/protocol';
import type { ProviderModelInput } from '../providerStore';

/** A provider as its connector sees it. */
export interface ProviderAccess {
  id: string;
  /** The address the administrator gave; null when the connector's default applies. */
  baseUrl: string | null;
  /** The stored credential, a JSON text only the connector reads; null when there is none. */
  credential: string | null;
  /** Replaces the stored credential, for example after a login token was renewed. */
  saveCredential(credential: string): void;
  /** What the provider said about one of its models when they were last listed. */
  model(upstreamModel: string): DiscoveredModel | null;
}

/** Where one request goes. */
export interface UpstreamTarget {
  url: string;
  /** Authentication and whatever else the upstream requires on every request. */
  headers: Record<string, string>;
  /** The protocol this upstream model speaks at that URL. */
  protocol: Protocol;
}

/** A model as its provider describes it. */
export type DiscoveredModel = ProviderModelInput;

/** How the administrator gives a provider its credential. */
export type CredentialKind =
  /** An API key, required. */
  | 'api-key'
  /** An API key, optional (a local server may want none). */
  | 'optional-api-key'
  /** A login the gateway carries out and renews itself. */
  | 'login';

export interface Connector {
  /** Stored with the provider; never changes once released. */
  id: string;
  /** Shown where a provider is added. */
  name: string;
  /** Null when the administrator has to give the address. */
  defaultBaseUrl: string | null;
  credential: CredentialKind;
  /**
   * Where a request for `upstreamModel` goes. `inbound` is the protocol the client used: a
   * connector whose upstream speaks several protocols for this model picks that one, so the
   * request can be passed through untouched.
   */
  target(provider: ProviderAccess, upstreamModel: string, inbound: Protocol): Promise<UpstreamTarget>;
  /** The models the provider offers now. Rejects when the provider cannot be asked. */
  models(provider: ProviderAccess): Promise<DiscoveredModel[]>;
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
