// GitHub Copilot: one provider the administrator signs in with GitHub's device-code flow, after
// which the gateway serves the models of that Copilot subscription. The GitHub OAuth token is the
// API credential itself: it is sent to the account's Copilot API and no Copilot session token is
// minted (docs/connectors.md §7, re-verified in §10). Wire facts and their evidence: §7.
//
// Ported from, all MIT, read 2026-11-18:
// - anomalyco/opencode @ 007afb1b0c8a36dff93d7945909d4e976545ba95,
//   `packages/core/src/plugin/provider/github-copilot.ts` and
//   `packages/core/src/github-copilot/models.ts`: the device-code parameters, the model list
//   (`supported_endpoints`, the rule when it is missing), `/copilot_internal/user` discovery and
//   the account's entitlement answer.
// - BerriAI/litellm @ c4e70ccc1b229f5bc953303efcee8200cc522d91,
//   `litellm/llms/github_copilot/common_utils.py`: the client identity headers and their values.
// - microsoft/vscode @ 3f0859c68d,
//   `src/vs/platform/agentHost/node/shared/copilotApiService.ts`: the GitHub token as the
//   credential, and `endpoints.api` discovery on `/copilot_internal/user`.
// - can1357/oh-my-pi @ 2421bdb99f84fbc74454eda374747afcbf9c0f4d,
//   `packages/catalog/src/wire/github-copilot.ts`: the Copilot API version that unlocks the full
//   `/models` limits, and the warning that it must not be sent to api.github.com.
import type { Price } from '../pricing';
import type { Protocol } from '../protocols/protocol';
import { isObject, parseJson, type JsonObject } from '../protocols/json';
import { accessTokenOf, protocolFor, UpstreamFailure } from './connector';
import type { LoginConnector, ProviderAccess, UpstreamTarget } from './connector';
import { deviceCodeLogin } from './deviceCode';
import { fetchModels, positiveNumber } from './http';
import type { ProviderModelInput } from '../providerStore';

/**
 * The OAuth app the administrator signs in with — VS Code's Copilot app, the default in the
 * references — and the only scope GitHub documents for Copilot sign-in (`read:user`, §7).
 */
const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const SCOPE = 'read:user';

/** The name every GitHub and Copilot request carries, from litellm's `USER_AGENT`. */
const USER_AGENT = 'GitHubCopilotChat/0.26.7';

/**
 * The client identity sent with every Copilot API request, in one place. `Copilot-Integration-Id`
 * decides authorization and not only telemetry — the limited integration is refused premium
 * models — and the API version decides how much of `/models` is filled in (§7, oh-my-pi).
 * `vscode-chat` is the integration that belongs to the VS Code app above; the values are
 * litellm's (`common_utils.py`), except the API version, which is oh-my-pi's `COPILOT_API_VERSION`
 * — the newest the references send and the one that renames `cache_price` to `cache_read_price`.
 * `X-Initiator` is a fixed `user`: the connector never sees the request body, so it cannot tell a
 * user turn from an agent turn (§7), and `Copilot-Vision-Request` is left out for the same reason.
 */
const CLIENT_HEADERS: Readonly<Record<string, string>> = {
  'Copilot-Integration-Id': 'vscode-chat',
  'Editor-Version': 'vscode/1.95.0',
  'Editor-Plugin-Version': 'copilot-chat/0.26.7',
  'User-Agent': USER_AGENT,
  'Openai-Intent': 'conversation-panel',
  'X-GitHub-Api-Version': '2026-08-01',
  'X-Initiator': 'user',
};

/**
 * The REST version `api.github.com` validates. The Copilot API's version above is not part of the
 * REST vocabulary, so it must not be sent there (oh-my-pi `github-copilot.ts`).
 */
const GITHUB_API_VERSION = '2025-04-01';

/** The path of each protocol on the account's Copilot base (§7). */
const PATHS: Readonly<Record<Protocol, string>> = {
  chat: '/chat/completions',
  responses: '/responses',
  messages: '/v1/messages',
};

/** A subscription has no per-token price, so every price is unknown rather than invented. */
const NO_PRICE: Price = { input: null, output: null, cacheRead: null };

/** The `supported_endpoints` entry of each protocol, in the vocabulary the API lists them in. */
const ENDPOINT_PROTOCOLS: Readonly<Record<string, Protocol>> = {
  '/chat/completions': 'chat',
  '/responses': 'responses',
  '/v1/messages': 'messages',
};

const SIGN_IN_REQUIRED = 'GitHub Copilot sign-in required';
const NO_ENTITLEMENT = 'This GitHub account does not have GitHub Copilot access';

/** The hosts this connector talks to; a test gives its own and nothing else is ever reached. */
export interface CopilotHosts {
  /** GitHub's OAuth device flow and pages: `https://github.com`. */
  github: string;
  /** The GitHub REST API: `https://api.github.com`. */
  githubApi: string;
  /** The Copilot API base used when an account's user document names none. */
  copilotApi: string;
}

const REAL_HOSTS: CopilotHosts = {
  github: 'https://github.com',
  githubApi: 'https://api.github.com',
  copilotApi: 'https://api.githubcopilot.com',
};

/**
 * What the provider's credential holds, as JSON text:
 * `{"accessToken": "<GitHub OAuth token>", "apiBase": "<base>" | null}`.
 *
 * `accessToken` is the GitHub OAuth token, which is the Copilot API credential itself: GitHub
 * mints no Copilot session token for it and nothing renews it, so a refused token means signing
 * in again (§7). `apiBase` is the account's Copilot API base as `/copilot_internal/user` gave it;
 * it is null right after a login and stored as soon as the account has been asked once, so a
 * restart sends requests to the same account base without asking again. A model refresh always
 * asks again, because the base changes with the account's plan.
 */
interface CopilotCredential {
  accessToken: string;
  apiBase: string | null;
}

/** A base without the trailing slashes a URL join would double. */
function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Join an account base and a path. */
function urlOf(base: string, path: string): string {
  return `${withoutTrailingSlash(base)}${path}`;
}

/**
 * A Copilot API base taken from the credential or the user document: an absolute `http(s)` URL;
 * anything else is "no base" rather than a host the token is sent to.
 */
function apiBaseOf(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return withoutTrailingSlash(value);
  } catch (error) {
    // A string URL that cannot parse is no base; another failure is not this reader's to swallow.
    if (error instanceof TypeError) return null;
    throw error;
  }
}

/** The stored credential; a missing or malformed one is a provider that must be signed in. */
function credentialOf(provider: ProviderAccess): CopilotCredential {
  const body = parseJson(provider.credential ?? '');
  if (!isObject(body) || typeof body.accessToken !== 'string' || body.accessToken === '') {
    throw new UpstreamFailure(SIGN_IN_REQUIRED, null);
  }
  return { accessToken: body.accessToken, apiBase: apiBaseOf(body.apiBase) };
}

/** Store a base the account's document answered, unless it is the one already stored. */
function rememberBase(
  provider: ProviderAccess, credential: CopilotCredential, base: string,
): void {
  if (base === credential.apiBase) return;
  provider.saveCredential(JSON.stringify({ accessToken: credential.accessToken, apiBase: base }));
}

/**
 * GET a JSON document with the shared reader: it applies the model-list deadline, refuses a
 * redirect, and redacts the token from any error it reports.
 */
async function getJson(url: string, headers: Record<string, string>, token: string): Promise<unknown> {
  return fetchModels(url, headers, token);
}

/**
 * Ask GitHub which Copilot API serves this account. The answer also says whether the account has
 * Copilot at all: OAuth succeeds for any GitHub account, so `chat_enabled: false` is the only
 * denial the flow produces (opencode `copilotEntitlementError`).
 */
async function accountBase(credential: CopilotCredential, hosts: CopilotHosts): Promise<string> {
  const body = await getJson(urlOf(hosts.githubApi, '/copilot_internal/user'), {
    Accept: 'application/json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': USER_AGENT,
    Authorization: `Bearer ${credential.accessToken}`,
  }, credential.accessToken);
  if (!isObject(body)) throw new UpstreamFailure('Invalid GitHub Copilot user document', null);
  if (body.chat_enabled === false) throw new UpstreamFailure(NO_ENTITLEMENT, null);
  const endpoints = isObject(body.endpoints) ? body.endpoints : {};
  return apiBaseOf(endpoints.api) ?? withoutTrailingSlash(hosts.copilotApi);
}

/**
 * The base to list models on: the administrator's address when given, else the account's own,
 * read again on every refresh so a plan change is picked up (opencode reads it per refresh).
 * The answer is not stored here: a refresh that then fails must not rewrite the credential, since
 * storing one clears the refused mark. A failed lookup is a failure to list models, never a
 * guessed host.
 */
async function listedBase(
  provider: ProviderAccess, credential: CopilotCredential, hosts: CopilotHosts,
): Promise<{ base: string; fromAccount: boolean }> {
  if (provider.baseUrl !== null) {
    return { base: withoutTrailingSlash(provider.baseUrl), fromAccount: false };
  }
  return { base: await accountBase(credential, hosts), fromAccount: true };
}

/**
 * The base to send one request to: the administrator's address, else the one the credential
 * caches. Before the first refresh there is none, and the account is asked once; concurrent first
 * requests may each ask, which costs a request and cannot disagree — the value is the account's.
 */
async function requestBase(
  provider: ProviderAccess, credential: CopilotCredential, hosts: CopilotHosts,
): Promise<string> {
  if (provider.baseUrl !== null) return withoutTrailingSlash(provider.baseUrl);
  if (credential.apiBase !== null) return credential.apiBase;
  const base = await accountBase(credential, hosts);
  rememberBase(provider, credential, base);
  return base;
}

/** The Copilot API headers: the client identity plus the GitHub token, which is the credential. */
function apiHeaders(token: string): Record<string, string> {
  return { ...CLIENT_HEADERS, Authorization: `Bearer ${token}` };
}

/**
 * The protocol of a model whose entry lists no `supported_endpoints`: GPT-5 and later except
 * `gpt-5-mini`, and the Grok and MAI Code families, are served only on `/responses`; everything
 * else on Chat Completions (opencode `models.ts`; §7 records the GPT-5 part of this rule).
 */
function fallbackProtocol(upstreamId: string): Protocol {
  const gpt = /^gpt-(\d+)/.exec(upstreamId);
  if (gpt !== null && Number(gpt[1]) >= 5 && !upstreamId.startsWith('gpt-5-mini')) return 'responses';
  if (upstreamId.startsWith('grok-') || upstreamId.startsWith('mai-code-')) return 'responses';
  return 'chat';
}

/**
 * The interfaces a model speaks, in the order the list gives them: a model that names none of the
 * three is kept with an empty list rather than being dropped (gateway/protocols/protocol.ts).
 */
function protocolsOf(item: JsonObject, upstreamId: string): Protocol[] {
  const endpoints = item.supported_endpoints;
  if (!Array.isArray(endpoints)) return [fallbackProtocol(upstreamId)];
  const protocols: Protocol[] = [];
  for (const endpoint of endpoints) {
    if (typeof endpoint !== 'string') continue;
    const protocol = ENDPOINT_PROTOCOLS[endpoint];
    if (protocol !== undefined && !protocols.includes(protocol)) protocols.push(protocol);
  }
  return protocols;
}

/**
 * Whether the list says this entry is a chat model the account may use. `capabilities.type`
 * decides that it is a chat model (`embeddings`, `completion` and others are not);
 * `policy.state: "disabled"` decides that this account may not use it. `model_picker_enabled` is
 * not that signal — some identities get `false` for models they may call (opencode keeps such
 * entries and disables them in its own picker; §7 names only `policy.state` as the usability
 * field), so it is not read here.
 */
function usable(item: JsonObject): boolean {
  const capabilities = isObject(item.capabilities) ? item.capabilities : {};
  if (typeof capabilities.type === 'string' && capabilities.type !== 'chat') return false;
  const policy = isObject(item.policy) ? item.policy : {};
  return policy.state !== 'disabled';
}

/** One entry of the Copilot model list as the gateway records it. */
function copilotModel(
  item: JsonObject, upstreamId: string,
): Omit<ProviderModelInput, 'upstreamId'> {
  const capabilities = isObject(item.capabilities) ? item.capabilities : {};
  const limits = isObject(capabilities.limits) ? capabilities.limits : {};
  return {
    // The window the list states, else its prompt limit: some entries state only the latter
    // (opencode `models.ts`).
    contextLength: positiveNumber(limits.max_context_window_tokens)
      ?? positiveNumber(limits.max_prompt_tokens),
    maxOutputTokens: positiveNumber(limits.max_output_tokens),
    price: { ...NO_PRICE },
    protocols: protocolsOf(item, upstreamId),
  };
}

/** The credential text a granted device-code poll stores: the token, with no base known yet. */
function loginCredential(body: JsonObject): string | null {
  if (typeof body.access_token !== 'string' || body.access_token === '') return null;
  const credential: CopilotCredential = { accessToken: body.access_token, apiBase: null };
  return JSON.stringify(credential);
}

/**
 * The GitHub Copilot connector over the given hosts. The default instance talks to GitHub; a test
 * builds one whose three hosts are its own stub, so no request can reach a real GitHub host.
 */
export function copilotConnector(hosts: CopilotHosts = REAL_HOSTS): LoginConnector {
  return {
    id: 'copilot',
    name: 'GitHub Copilot',
    defaultBaseUrl: withoutTrailingSlash(hosts.copilotApi),
    credential: 'login',
    login: deviceCodeLogin({
      deviceEndpoint: urlOf(hosts.github, '/login/device/code'),
      tokenEndpoint: urlOf(hosts.github, '/login/oauth/access_token'),
      clientId: CLIENT_ID,
      scope: SCOPE,
      headers: { 'User-Agent': USER_AGENT },
      now: () => new Date(),
    }, loginCredential),
    async models(provider) {
      const credential = credentialOf(provider);
      const { base, fromAccount } = await listedBase(provider, credential, hosts);
      const body = await getJson(urlOf(base, '/models'), apiHeaders(credential.accessToken),
        credential.accessToken);
      if (!isObject(body) || !Array.isArray(body.data)) {
        throw new UpstreamFailure('Invalid model list', null);
      }
      const models: ProviderModelInput[] = [];
      for (const item of body.data) {
        if (!isObject(item) || typeof item.id !== 'string' || item.id === '') continue;
        if (!usable(item)) continue;
        models.push({ upstreamId: item.id, ...copilotModel(item, item.id) });
      }
      if (fromAccount) rememberBase(provider, credential, base);
      return models;
    },
    async target(provider, upstreamModel, inbound) {
      const credential = credentialOf(provider);
      const base = await requestBase(provider, credential, hosts);
      const protocol = protocolFor(provider.model(upstreamModel)?.protocols ?? null, inbound, 'chat');
      return {
        url: urlOf(base, PATHS[protocol]),
        protocol,
        headers: { ...apiHeaders(credential.accessToken), 'Content-Type': 'application/json' },
      };
    },
    rejected(provider, target) {
      // Only the token stored now may be marked; a 401 for one another request or a new sign-in
      // already replaced says nothing about the login that is stored.
      const body = parseJson(provider.credential ?? '');
      const stored = isObject(body) && typeof body.accessToken === 'string'
        ? body.accessToken : null;
      if (stored === null || accessTokenOf(target) !== stored) return;
      // No refresh token exists: the only act on a 401 is to mark the credential and have the
      // administrator sign in again. A new credential starts with no base, so the account is
      // asked for its current one at the next refresh (§7).
      provider.rejectCredential();
    },
  };
}

/** GitHub Copilot, at the hosts GitHub publishes. */
export const copilot = copilotConnector();
