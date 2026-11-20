// Every type that crosses the gateway's management API, `/api/gateway/*`, in either direction:
// the records and request bodies the gateway's management handlers accept and return, and the
// envelopes those handlers answer with. The gateway's stores and handlers are typed by this file
// and the console (`gateway/web/`) imports it type-only, so a drift between the two is a `tsc` error.
//
// Type declarations only: no runtime code and no imports from elsewhere in this repository.
//
// This is the gateway's standalone copy at `gateway/shared/api.ts`; `gateway/web/` resolves it
// through the `@shared/*` alias, so the console builds without the rest of the repository.

/** A price in USD per 1M tokens. A null field means the price is unknown. */
export interface Price {
  /** USD per 1M input (prompt) tokens; null means the price is unknown. */
  input: number | null;
  /** USD per 1M output (completion) tokens; null means the price is unknown. */
  output: number | null;
  /**
   * USD per 1M cache-read tokens. Null falls back to `input` when costing, which is what the
   * upstreams themselves charge when they do not price cache reads separately.
   */
  cacheRead: number | null;
}

/** How often a key's cost limit resets. 'none' never resets. */
export type ResetPeriod = 'none' | 'day' | 'week' | 'month';

/** How a provider holds its credential. */
export type CredentialKind =
  /** An API key the administrator must give. */
  | 'api-key'
  /** An API key the administrator may give; a local server may want none. */
  | 'optional-api-key'
  /** A login the gateway carries out and renews itself; no API key is accepted. */
  | 'login';

/** One kind of upstream the administrator may choose, as `GET /api/gateway/connectors` lists it. */
export interface ConnectorInfo {
  /** Stored with the provider; never changes once released. */
  id: string;
  /** What the console shows where a provider is added. */
  name: string;
  /** The address used when the provider gives none; null when the administrator must give one. */
  defaultBaseUrl: string | null;
  credential: CredentialKind;
}

/** A configured provider, as every provider route returns it. */
export interface ProviderRecord {
  /** `prv-` followed by 8 hex digits. */
  id: string;
  /** Unique across providers. */
  name: string;
  /** The id of the connector this provider uses. */
  connector: string;
  /** The address the administrator gave; null means the connector's default applies. */
  baseUrl: string | null;
  /** False refuses this provider's models to inference. */
  enabled: boolean;
  /** True publishes newly discovered models without the administrator asking. */
  autoPublish: boolean;
  /** Whether a credential is stored. The credential itself is never returned. */
  hasCredential: boolean;
  /**
   * True when the provider refused the stored credential: its routes are left out of routing
   * until a new credential is stored or a login grants one.
   */
  credentialRejected: boolean;
  /**
   * ISO time of the last model list this provider answered; null when none has succeeded yet.
   * A failed sync leaves it at the last success.
   */
  modelsRefreshedAt: string | null;
  /**
   * Why the last model list sync failed, in words fit to show; null when the last attempt
   * succeeded. A failure leaves the stored model list and the published models as they were.
   */
  modelsError: string | null;
  /** ISO time the provider was created. */
  createdAt: string;
}

/** A provider with the number of models last discovered from it. */
export interface ProviderListItem extends ProviderRecord {
  /** How many models the provider described at its last refresh. */
  modelCount: number;
}

/** Where the login of a provider on a `login` connector stands, as the login routes return it. */
export type LoginStatus =
  /** No login was started on this gateway, or the last one was cancelled. */
  | { state: 'none' }
  /** Waiting for the administrator to confirm the code in a browser. */
  | {
    state: 'pending';
    /** The code the administrator confirms, e.g. `ABCD-1234`. */
    userCode: string;
    /** The page that takes the code. */
    verificationUri: string;
    /** The same page with the code filled in; null when the server gives none. */
    verificationUriComplete: string | null;
    /** ISO time after which the code is no longer accepted. */
    expiresAt: string;
    /** Seconds between polls; 5 longer after each time the server asks to slow down. */
    interval: number;
  }
  /** The credential was stored; the provider is signed in. */
  | { state: 'done' }
  /** The authorization server refused the login; `reason` is fit to show and names no secret. */
  | { state: 'failed'; reason: string }
  /** The code expired before anyone confirmed it. */
  | { state: 'expired' };

/**
 * An upstream inference wire protocol: `chat` for OpenAI Chat Completions, `messages` for
 * Anthropic Messages, `responses` for OpenAI Responses.
 */
export type Protocol = 'chat' | 'messages' | 'responses';

/** A model as its provider described it at the last refresh. */
export interface ProviderModel {
  /** The model name the provider itself uses. */
  upstreamId: string;
  /** The provider's context window in tokens; null when it did not say. */
  contextLength: number | null;
  /** The longest answer the model gives, in tokens; null when it did not say. */
  maxOutputTokens: number | null;
  /** USD per 1M tokens; a null field means the provider did not say. */
  price: Price;
  /**
   * The interfaces this model speaks at this provider, in the provider's order of preference.
   * Null when the provider did not say, so its connector decides. An empty list says the model
   * speaks none of the gateway's interfaces: it can still be listed, and every request for it
   * is skipped as incompatible.
   */
  protocols: Protocol[] | null;
  /** ISO time of the refresh that wrote this row; every row of one refresh shares it. */
  fetchedAt: string;
}

/** A discovered model, with whether some model already routes to it. */
export interface DiscoveredModel extends ProviderModel {
  /** True when one route of some model points at this provider and upstream id. */
  published: boolean;
}

/** One route of a model: where its requests may go and with what weight. */
export interface RouteRecord {
  /** `rte-` followed by 8 hex digits. */
  id: string;
  /** The model this route belongs to. */
  modelId: string;
  /** The provider this route sends to. */
  providerId: string;
  /** That provider's current name, for display; a route is removed with its provider. */
  providerName: string;
  /** The model name at that provider. */
  upstreamModel: string;
  /** Relative share of the model's requests; an integer of at least 1. */
  weight: number;
  /** False keeps this route out of routing. */
  enabled: boolean;
  /**
   * USD per 1M tokens charged instead of the model's price; null means this route follows the
   * model's price. Unlike `ProviderModel.price`, a route price is complete or null: an override
   * always carries both `input` and `output`.
   */
  price: Price | null;
}

/** A model the gateway publishes, with every route it may be served through. */
export interface ModelRecord {
  /** `mdl-` followed by 8 hex digits. */
  id: string;
  /** The model name inference clients send. Unique across models. */
  name: string;
  /** USD per 1M tokens charged when no route overrides it; a null field means unknown. */
  price: Price;
  /** Context window in tokens; null when unset. */
  contextLength: number | null;
  /** False removes the model from the inference list. */
  enabled: boolean;
  /** ISO time the model was created. */
  createdAt: string;
  /** In the order they were added. */
  routes: RouteRecord[];
}

/** An API key as every key route returns it. The token itself is returned only on creation. */
export interface KeyRecord {
  /** `key-` followed by 12 hex digits. */
  id: string;
  name: string;
  /** The masked token, e.g. `sk-gw-abcdef...1a2b`, for the console to show. */
  prefix: string;
  /** False refuses this key. */
  enabled: boolean;
  /** True limits the key to the models in `modelIds`; false allows every model. */
  restricted: boolean;
  /** The models a restricted key may call; empty when restricted means none. */
  modelIds: string[];
  /** USD the key may spend in one period; null means no limit. */
  costLimit: number | null;
  resetPeriod: ResetPeriod;
  /** ISO time the current period began; for 'none', the last reset or creation. */
  periodStart: string;
  /** USD spent in the current period. */
  periodCost: number;
  /** ISO time of the next reset; null for 'none'. */
  nextResetAt: string | null;
  /** Requests this key may have in flight at once; null means no limit. */
  maxConcurrency: number | null;
  /** ISO time after which the key is refused; null means it never expires. */
  expiresAt: string | null;
  /** Requests recorded against the key since creation. */
  requestCount: number;
  /** Input tokens recorded since creation, cache reads included. */
  inputTokens: number;
  /** Output tokens recorded since creation. */
  outputTokens: number;
  /** USD recorded since creation, across periods. */
  totalCost: number;
  /** ISO time of the last recorded request; null when the key was never used. */
  lastUsedAt: string | null;
  /** ISO time the key was created. */
  createdAt: string;
}

/** What one group of recorded usage adds up to. Every row of the usage report carries it. */
export interface UsageSummary {
  /** Requests recorded in the group. */
  requests: number;
  /** Of those, the ones that failed (status 400 and above). */
  errors: number;
  /** Of the answered ones, those whose token counts the upstream did not report. */
  unknownUsage: number;
  /** Of the answered ones, those with no recorded cost (no price, or no usage); they add 0. */
  uncosted: number;
  /**
   * Input tokens that were not read from a cache. The input and cache-read counts are disjoint:
   * all the input of the group is their sum. (`KeyRecord.inputTokens` and
   * `UsageTotals.inputTokens` are that sum already.)
   */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens read from a cache. */
  cacheReadTokens: number;
  /** USD recorded for the group; uncosted requests contribute 0. */
  cost: number;
}

/** Usage grouped by model, as `GET /api/gateway/usage?by=model` returns it. */
export interface UsageByModelRow extends UsageSummary {
  /** The model's id; the usage outlives the model. */
  modelId: string;
  /** Its current name, or the name recorded with its most recent usage when it was deleted. */
  modelName: string;
}

/** Usage grouped by provider, as `GET /api/gateway/usage?by=provider&model=…` returns it. */
export interface UsageByProviderRow extends UsageSummary {
  /** The provider's id; the empty string for requests no provider served. */
  providerId: string;
  /** Its current name, or the name recorded with its most recent usage; empty with an empty id. */
  providerName: string;
}

/** Usage grouped by key, as `GET /api/gateway/usage?by=key` returns it. */
export interface UsageByKeyRow extends UsageSummary {
  /** The key's id; usage outlives its key. */
  keyId: string;
  /** Its current name, or the name recorded with its most recent usage. */
  keyName: string;
}

/** Usage grouped by day, as `GET /api/gateway/usage?by=day` returns it. */
export interface UsageByDayRow extends UsageSummary {
  /** The local calendar day, `YYYY-MM-DD`. */
  day: string;
}

/** What the gateway has served since its database was created; clearing the log keeps it. */
export interface UsageTotals {
  /** Requests recorded, failed ones included. */
  requestCount: number;
  /** Input tokens, cache reads included. */
  inputTokens: number;
  outputTokens: number;
  /** USD recorded; requests without a computed cost add 0. */
  cost: number;
}

/** One row of the request log, newest first. The log keeps the latest 200 rows. */
export interface RequestLogRow {
  /** Ascending with time; the list is ordered by it, descending. */
  id: number;
  /** ISO time the request finished. */
  timestamp: string;
  /**
   * The interface the client used: `chat` (OpenAI Chat Completions) or `messages` (Anthropic
   * Messages). Rows written by gateway versions before the provider model may carry other names.
   */
  protocol: string;
  keyName: string;
  modelName: string;
  /** The provider the request was routed to; null when none answered it. */
  providerName: string | null;
  /** The model name at that provider; null when none answered it. */
  upstreamModel: string | null;
  /** The HTTP status the client received. */
  status: number;
  /**
   * Token counts the upstream reported; null when it reported none. As in `UsageSummary`, the
   * input and cache-read counts are disjoint.
   */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  /** USD computed for the request; null when the price was unknown. */
  cost: number | null;
  /**
   * Milliseconds from the request's arrival to the first content of a streaming answer; null
   * for an answer that was not streamed and for a request that got no answer.
   */
  ttftMs: number | null;
  /** Milliseconds from request to response. */
  latencyMs: number;
  /** The error shown to the client; null when the request was answered. */
  error: string | null;
}

/** `POST /api/gateway/providers`: a provider to add. */
export interface ProviderCreateBody {
  /** Unique across providers. */
  name: string;
  /** A `ConnectorInfo.id`. */
  connector: string;
  /** Omit to use the connector's default, which the connector must have. */
  baseUrl?: string;
  /**
   * The plaintext API key, stored by the gateway and never returned. Required when the
   * connector's credential is 'api-key'; rejected when it is 'login'.
   */
  apiKey?: string;
  /** Publish newly discovered models without asking. Defaults to false. */
  autoPublish?: boolean;
}

/** `PATCH /api/gateway/providers/:id`: the fields to change; omitted fields stay as they are. */
export interface ProviderPatchBody {
  name?: string;
  /** Null makes the connector's default apply again; the connector must have one. */
  baseUrl?: string | null;
  enabled?: boolean;
  autoPublish?: boolean;
  /** A new plaintext API key; null removes the stored one. Omit to keep it. */
  apiKey?: string | null;
}

/** `POST /api/gateway/models`: a model to publish. */
export interface ModelCreateBody {
  /** The name inference clients send. Unique across models. */
  name: string;
  /** USD per 1M tokens; omit for a model whose price is unknown. */
  price?: Price;
  /** Context window in tokens; omit or null leaves it unset. */
  contextLength?: number | null;
}

/** `PATCH /api/gateway/models/:id`: the fields to change; omitted fields stay as they are. */
export interface ModelPatchBody {
  name?: string;
  /** Replaces the whole price; a field left null becomes unknown. */
  price?: Price;
  contextLength?: number | null;
  enabled?: boolean;
}

/** `POST /api/gateway/models/:id/routes`: a route to add to a model. */
export interface RouteCreateBody {
  /** The provider to send to. */
  providerId: string;
  /** The model name at that provider. */
  upstreamModel: string;
  /** Relative share of the model's requests; an integer of at least 1. Defaults to 1. */
  weight?: number;
  /**
   * USD per 1M tokens for this route only; omit or null follows the model's price. An override
   * must carry both `input` and `output`.
   */
  price?: Price | null;
}

/** `PATCH /api/gateway/routes/:id`: the fields to change; omitted fields stay as they are. */
export interface RoutePatchBody {
  weight?: number;
  enabled?: boolean;
  /** Null drops the override so the route follows its model's price again. */
  price?: Price | null;
}

/** `POST /api/gateway/keys`: a key to create. The plaintext token is answered once. */
export interface KeyCreateBody {
  name: string;
  /** Limit the key to `modelIds`. Defaults to false. */
  restricted?: boolean;
  /** The models a restricted key may call; each must exist. */
  modelIds?: string[];
  /** USD allowed per period; omit or null for no limit. */
  costLimit?: number | null;
  /** Defaults to 'none'. */
  resetPeriod?: ResetPeriod;
  /** In-flight request limit; omit or null for no limit. */
  maxConcurrency?: number | null;
  /** ISO time after which the key is refused; omit or null for no expiry. */
  expiresAt?: string | null;
}

/** `PATCH /api/gateway/keys/:id`: the fields to change; omitted fields stay as they are. */
export interface KeyPatchBody {
  name?: string;
  enabled?: boolean;
  restricted?: boolean;
  /** Replaces the whole list. */
  modelIds?: string[];
  costLimit?: number | null;
  resetPeriod?: ResetPeriod;
  maxConcurrency?: number | null;
  expiresAt?: string | null;
}

/** `POST /api/gateway/providers/:id/publish`: the discovered model to route to. */
export interface PublishBody {
  /** A `ProviderModel.upstreamId` of that provider. */
  upstreamId: string;
}

/** Any management route's refusal body; HTTP status carries the rest. */
export interface ApiError {
  /** The reason, in words fit to show. */
  error: string;
}

/** `GET /api/gateway/connectors`. */
export interface ConnectorsResponse {
  connectors: ConnectorInfo[];
}

/** `GET /api/gateway/providers`. */
export interface ProvidersResponse {
  providers: ProviderListItem[];
}

/** `POST /api/gateway/providers` and `PATCH /api/gateway/providers/:id`. */
export interface ProviderResponse {
  provider: ProviderRecord;
}

/** `GET /api/gateway/providers/:id/models` and `POST /api/gateway/providers/:id/refresh`. */
export interface ProviderModelsResponse {
  models: DiscoveredModel[];
}

/** `POST` and `GET /api/gateway/providers/:id/login`: the login as it stands. */
export interface LoginResponse {
  login: LoginStatus;
}

/** `POST /api/gateway/providers/:id/publish`, and adding or patching a route. */
export interface RouteResponse {
  route: RouteRecord;
}

/** `GET /api/gateway/models`. */
export interface ModelsResponse {
  models: ModelRecord[];
}

/** `GET /api/gateway/models/:id`, `POST /api/gateway/models` and `PATCH /api/gateway/models/:id`. */
export interface ModelResponse {
  model: ModelRecord;
}

/** `GET /api/gateway/keys`. */
export interface KeysResponse {
  keys: KeyRecord[];
}

/** `PATCH /api/gateway/keys/:id` and `POST /api/gateway/keys/:id/reset`. */
export interface KeyResponse {
  key: KeyRecord;
}

/** `POST /api/gateway/keys`: the key and the token that is answered only here. */
export interface KeyCreatedResponse {
  key: KeyRecord;
  /** The plaintext token, e.g. `sk-gw-…`; it is never returned again. */
  token: string;
}

/** `GET /api/gateway/usage?by=model`. */
export interface UsageByModelResponse {
  rows: UsageByModelRow[];
}

/** `GET /api/gateway/usage?by=provider&model=…`. */
export interface UsageByProviderResponse {
  rows: UsageByProviderRow[];
}

/** `GET /api/gateway/usage?by=key`. */
export interface UsageByKeyResponse {
  rows: UsageByKeyRow[];
}

/** `GET /api/gateway/usage?by=day`. */
export interface UsageByDayResponse {
  rows: UsageByDayRow[];
}

/**
 * `GET /api/gateway/usage?by=…`: one of the four reports, chosen by the query. The body carries
 * no field saying which, so the caller must keep the `by` it asked for.
 */
export type UsageResponse =
  | UsageByModelResponse
  | UsageByProviderResponse
  | UsageByKeyResponse
  | UsageByDayResponse;

/** `GET /api/gateway/usage/totals`. */
export interface TotalsResponse {
  totals: UsageTotals;
}

/** `GET /api/gateway/logs`. */
export interface LogsResponse {
  logs: RequestLogRow[];
}
