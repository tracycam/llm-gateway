// Typed client for the gateway's management API, `/api/gateway/*`. The console reaches the
// gateway only through these types and HTTP: every request and response shape is
// gateway/shared/api.ts, the same file the gateway's handlers are typed against.
import type {
  ConnectorsResponse,
  KeyCreateBody,
  KeyCreatedResponse,
  KeyPatchBody,
  KeyResponse,
  KeysResponse,
  LoginResponse,
  LogsResponse,
  ModelCreateBody,
  ModelPatchBody,
  ModelResponse,
  ModelsResponse,
  ProviderCreateBody,
  ProviderModelsResponse,
  ProviderPatchBody,
  ProviderResponse,
  ProvidersResponse,
  PublishBody,
  RouteCreateBody,
  RoutePatchBody,
  RouteResponse,
  TotalsResponse,
  UsageByDayResponse,
  UsageByKeyResponse,
  UsageByModelResponse,
  UsageByProviderResponse,
} from '@shared/api';

const BASE = '/api/gateway';

/** A management route's refusal: the gateway's `{error}` text and the HTTP status. */
export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** The day range the usage report accepts; both ends are local calendar days, `YYYY-MM-DD`. */
export interface UsageRange {
  from?: string;
  to?: string;
}

/** What the usage report by day may be narrowed to: a model id, a key id, or both. */
export interface UsageDayFilter {
  model?: string;
  key?: string;
}

/** The `fetch` the client sends through; the console passes the one that notices a 401. */
export type Send = (input: string, init?: RequestInit) => Promise<Response>;

/** Read a refusal body; one that is not JSON leaves the status as the reason. */
async function refusal(response: Response): Promise<ApiRequestError> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload === 'object' && payload !== null && 'error' in payload
      && typeof payload.error === 'string') {
      return new ApiRequestError(payload.error, response.status);
    }
  } catch {
    // The refusal carried no JSON body; the status line below is all there is to report.
  }
  return new ApiRequestError(`HTTP ${response.status}`, response.status);
}

function usagePath(by: string, range: UsageRange, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams({ by });
  for (const [name, value] of Object.entries({ ...range, ...extra })) {
    if (value !== undefined) params.set(name, value);
  }
  return `/usage?${params.toString()}`;
}

/** One typed function per management route, sent through `send`. */
export function createGatewayApi(send: Send) {
  /**
   * Send one management request. The session cookie is the only credential the console holds,
   * hence `same-origin`. A refusal throws the gateway's `{error}` text and status.
   */
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await send(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    if (!response.ok) throw await refusal(response);
    return response;
  }

  async function read<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await call(method, path, body);
    // The server is this repository's gateway, and its responses are typed against
    // gateway/shared/api.ts, so the body is returned as that type rather than re-validated here.
    return (await response.json()) as T;
  }

  const id = encodeURIComponent;

  return {
    /** `GET /connectors`: the kinds of upstream a provider may be created from. */
    listConnectors: (): Promise<ConnectorsResponse> => read('GET', '/connectors'),

    /** `GET /providers`: every provider, with the number of models last discovered. */
    listProviders: (): Promise<ProvidersResponse> => read('GET', '/providers'),

    /** `POST /providers`: add a provider; its credential is never echoed back. */
    createProvider: (body: ProviderCreateBody): Promise<ProviderResponse> =>
      read('POST', '/providers', body),

    /** `PATCH /providers/:id`: change the fields present; omit the rest. */
    updateProvider: (providerId: string, body: ProviderPatchBody): Promise<ProviderResponse> =>
      read('PATCH', `/providers/${id(providerId)}`, body),

    /** `DELETE /providers/:id`. */
    deleteProvider: async (providerId: string): Promise<void> => {
      await call('DELETE', `/providers/${id(providerId)}`);
    },

    /** `GET /providers/:id/models`: the models last discovered from the provider. */
    listProviderModels: (providerId: string): Promise<ProviderModelsResponse> =>
      read('GET', `/providers/${id(providerId)}/models`),

    /**
     * `POST /providers/:id/refresh`: ask the provider for its models and answer the list now
     * stored. Fails with status 502 when the provider cannot be asked.
     */
    refreshProvider: (providerId: string): Promise<ProviderModelsResponse> =>
      read('POST', `/providers/${id(providerId)}/refresh`),

    /**
     * `POST /providers/:id/publish`: create (or reuse) the model named by the upstream id and
     * a route to it; answers that route.
     */
    publishProviderModel: (providerId: string, body: PublishBody): Promise<RouteResponse> =>
      read('POST', `/providers/${id(providerId)}/publish`, body),

    /**
     * `POST /providers/:id/login`: start a device-code login on a provider whose connector logs
     * in; answers the code to confirm (201). Fails with 400 for a provider that does not log
     * in, and 502 with the server's text when the authorization server cannot start one.
     */
    startLogin: (providerId: string): Promise<LoginResponse> =>
      read('POST', `/providers/${id(providerId)}/login`),

    /** `GET /providers/:id/login`: where the provider's login stands. */
    loginStatus: (providerId: string): Promise<LoginResponse> =>
      read('GET', `/providers/${id(providerId)}/login`),

    /** `DELETE /providers/:id/login`: cancel a pending login; a stored credential is kept. */
    cancelLogin: async (providerId: string): Promise<void> => {
      await call('DELETE', `/providers/${id(providerId)}/login`);
    },

    /**
     * `DELETE /providers/:id/credential`: sign a login provider out — cancel a pending login
     * and remove the stored credential. Fails with 400 for a provider that does not log in.
     */
    signOut: async (providerId: string): Promise<void> => {
      await call('DELETE', `/providers/${id(providerId)}/credential`);
    },

    /** `GET /models`: every model, each with its routes. */
    listModels: (): Promise<ModelsResponse> => read('GET', '/models'),

    /** `GET /models/:id`. */
    getModel: (modelId: string): Promise<ModelResponse> => read('GET', `/models/${id(modelId)}`),

    /** `POST /models`: publish a model. */
    createModel: (body: ModelCreateBody): Promise<ModelResponse> => read('POST', '/models', body),

    /** `PATCH /models/:id`: change the fields present; omit the rest. */
    updateModel: (modelId: string, body: ModelPatchBody): Promise<ModelResponse> =>
      read('PATCH', `/models/${id(modelId)}`, body),

    /** `DELETE /models/:id`: removes the model and its routes. */
    deleteModel: async (modelId: string): Promise<void> => {
      await call('DELETE', `/models/${id(modelId)}`);
    },

    /** `POST /models/:id/routes`: add a route to a model. */
    createRoute: (modelId: string, body: RouteCreateBody): Promise<RouteResponse> =>
      read('POST', `/models/${id(modelId)}/routes`, body),

    /** `PATCH /routes/:id`: change the fields present; omit the rest. */
    updateRoute: (routeId: string, body: RoutePatchBody): Promise<RouteResponse> =>
      read('PATCH', `/routes/${id(routeId)}`, body),

    /** `DELETE /routes/:id`. */
    deleteRoute: async (routeId: string): Promise<void> => {
      await call('DELETE', `/routes/${id(routeId)}`);
    },

    /** `GET /keys`: every key; the tokens themselves are not in the answer. */
    listKeys: (): Promise<KeysResponse> => read('GET', '/keys'),

    /** `POST /keys`: create a key; the plaintext token is answered only here. */
    createKey: (body: KeyCreateBody): Promise<KeyCreatedResponse> => read('POST', '/keys', body),

    /** `PATCH /keys/:id`: change the fields present; omit the rest. */
    updateKey: (keyId: string, body: KeyPatchBody): Promise<KeyResponse> =>
      read('PATCH', `/keys/${id(keyId)}`, body),

    /** `DELETE /keys/:id`. */
    deleteKey: async (keyId: string): Promise<void> => {
      await call('DELETE', `/keys/${id(keyId)}`);
    },

    /** `POST /keys/:id/reset`: zero the cost of the key's current period. */
    resetKeyUsage: (keyId: string): Promise<KeyResponse> => read('POST', `/keys/${id(keyId)}/reset`),

    /** `GET /usage?by=model`: recorded usage per model, deleted models included. */
    usageByModel: (range: UsageRange = {}): Promise<UsageByModelResponse> =>
      read('GET', usagePath('model', range)),

    /** `GET /usage?by=provider&model=…`: one model's usage per provider that served it. */
    usageByProvider: (modelId: string, range: UsageRange = {}): Promise<UsageByProviderResponse> =>
      read('GET', usagePath('provider', range, { model: modelId })),

    /** `GET /usage?by=key`: recorded usage per key, deleted keys included. */
    usageByKey: (range: UsageRange = {}): Promise<UsageByKeyResponse> =>
      read('GET', usagePath('key', range)),

    /** `GET /usage?by=day`: recorded usage per local calendar day, optionally narrowed. */
    usageByDay: (range: UsageRange = {}, filter: UsageDayFilter = {}): Promise<UsageByDayResponse> =>
      read('GET', usagePath('day', range, { model: filter.model, key: filter.key })),

    /** `GET /usage/totals`: what the gateway has served since its database was created. */
    getTotals: (): Promise<TotalsResponse> => read('GET', '/usage/totals'),

    /** `GET /logs`: the latest 200 requests, newest first. */
    listLogs: (): Promise<LogsResponse> => read('GET', '/logs'),

    /** `DELETE /logs`: clears the request log; totals are kept. */
    clearLogs: async (): Promise<void> => {
      await call('DELETE', '/logs');
    },
  };
}

export type GatewayApi = ReturnType<typeof createGatewayApi>;
