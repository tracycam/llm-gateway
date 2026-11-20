// RFC 8628's device-code flow as GitHub, OpenAI and xAI implement it, shared by the login
// connectors: one request for a code, then one poll per interval until the server grants it.
//
// Both ways these servers report a poll state are accepted: HTTP 400 with an `error` member
// (the RFC, xAI) and HTTP 200 with the same member (GitHub). A network failure or a 5xx
// rejects, because the code may still be confirmed: the login session keeps polling until the
// code expires. Wire facts and their evidence: docs/connectors.md §7, §8 and §10.
import { isObject, parseJson, type JsonObject } from '../protocols/json';
import type { DeviceCode, DeviceLogin, DeviceLoginPoll } from './connector';

/** What the token endpoint's success body turns into; null when it carries no token. */
export type CredentialText = (body: JsonObject) => string | null;

/** Where a device-code login is carried out. */
export interface DeviceCodeFlow {
  /** Where the code is asked for. */
  deviceEndpoint: string;
  /** Where the token is asked for, by the poll and by nothing else. */
  tokenEndpoint: string;
  /** The OAuth client the authorization server knows. */
  clientId: string;
  /** The scope asked for; null asks for none. */
  scope: string | null;
  /**
   * Extra form fields sent with both requests. GitHub wants its scope here as well, xAI an
   * optional `referrer`; neither is a field of the flow itself.
   */
  extraForm?: Record<string, string>;
  /** Extra request headers sent with both requests. */
  headers?: Record<string, string>;
  /** The clock the code's expiry is computed from. */
  now(): Date;
}

/** RFC 8628's default when the server states no interval. */
const DEFAULT_INTERVAL_S = 5;

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

interface Answer {
  status: number;
  ok: boolean;
  /** The parsed body; undefined when the answer was not JSON. */
  body: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A positive number of seconds, or null. */
function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The interval the server asks for; its default when it states none or a nonsensical one. */
function intervalOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value : DEFAULT_INTERVAL_S;
}

/** The error's description when the server gave one, else its error name, else null. */
function refusalOf(body: JsonObject): string | null {
  return text(body.error_description) ?? text(body.error);
}

function httpFailure(answer: Answer): Error {
  if (isObject(answer.body)) {
    const refusal = refusalOf(answer.body);
    if (refusal !== null) return new Error(refusal);
  }
  return new Error(`Authorization server HTTP ${answer.status}`);
}

/** Form-encoded POST that asks for JSON and refuses to follow a redirect. */
async function post(
  url: string, fields: Record<string, string>, flow: DeviceCodeFlow, fetcher: typeof fetch,
): Promise<Answer> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      ...flow.headers,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
    redirect: 'error',
  });
  return {
    status: response.status,
    ok: response.ok,
    body: parseJson(await response.text()),
  };
}

/** The device code of the start answer, or a failure fit to show. */
function codeOf(body: unknown, now: Date): DeviceCode {
  if (!isObject(body)) throw new Error('The authorization server answered no device code');
  const secret = text(body.device_code);
  const userCode = text(body.user_code);
  const verificationUri = text(body.verification_uri);
  const expiresIn = seconds(body.expires_in);
  if (secret === null || userCode === null || verificationUri === null || expiresIn === null) {
    throw new Error(refusalOf(body) ?? 'The authorization server answered no device code');
  }
  return {
    userCode,
    verificationUri,
    verificationUriComplete: text(body.verification_uri_complete),
    expiresAt: new Date(now.getTime() + expiresIn * 1000),
    interval: intervalOf(body.interval),
    secret,
  };
}

/**
 * What one poll answer means. A 5xx throws, as does a network failure before this point: the
 * caller keeps polling. Everything the token endpoint can say with a 4xx or a 200 body is
 * classified here.
 */
function pollOf(answer: Answer, credentialOf: CredentialText): DeviceLoginPoll {
  if (answer.status >= 500) throw httpFailure(answer);
  if (!isObject(answer.body)) {
    return { status: 'refused', reason: `Authorization server HTTP ${answer.status}` };
  }
  const error = text(answer.body.error);
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'slow-down' };
  if (error !== null) return { status: 'refused', reason: refusalOf(answer.body)! };
  if (!answer.ok) return { status: 'refused', reason: `Authorization server HTTP ${answer.status}` };
  const credential = credentialOf(answer.body);
  if (credential === null) {
    return { status: 'refused', reason: 'The authorization server answered no token' };
  }
  return { status: 'granted', credential };
}

/**
 * A device-code login against one authorization server. `credentialOf` turns the token
 * endpoint's success body into the text the gateway stores for the provider; null says the
 * body held no token, which refuses the login rather than storing nothing.
 */
export function deviceCodeLogin(flow: DeviceCodeFlow, credentialOf: CredentialText): DeviceLogin {
  return {
    async start(fetcher) {
      const fields: Record<string, string> = {
        client_id: flow.clientId,
        ...(flow.scope === null ? {} : { scope: flow.scope }),
        ...flow.extraForm,
      };
      const answer = await post(flow.deviceEndpoint, fields, flow, fetcher);
      if (!answer.ok) throw httpFailure(answer);
      return codeOf(answer.body, flow.now());
    },
    async poll(code, fetcher) {
      const answer = await post(flow.tokenEndpoint, {
        grant_type: DEVICE_GRANT,
        device_code: code.secret,
        client_id: flow.clientId,
        ...flow.extraForm,
      }, flow, fetcher);
      return pollOf(answer, credentialOf);
    },
  };
}
