// Execute one inference attempt without choosing routes or recording state.
import {
  UpstreamFailure,
  type Connector,
  type ProviderAccess,
  type UpstreamTarget,
} from '../connectors/connector';
import { LoginExpired } from '../connectors/tokens';
import type { Usage } from '../pricing';
import { bridgeRequest, bridgeResponse, bridgeStream, type Bridge, type Finished } from '../protocols/bridge';
import { parseJson } from '../protocols/json';
import { protocolModule, canServe, type Protocol } from '../protocols/protocol';
import { isRefused } from '../protocols/refusal';
import { classify, type Outcome } from '../router';

/** Default for Chat requests translated to Messages when the provider reports no limit. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const AUTH_HEADERS = ['authorization', 'x-api-key', 'api-key'];

/** Everything needed to attempt one route. */
export interface AttemptInput {
  connector: Connector;
  provider: ProviderAccess;
  /** The model id to ask the provider for. */
  upstreamModel: string;
  /** The protocol the client speaks. */
  inbound: Protocol;
  /** The client's request body, parsed. */
  body: unknown;
  /** The client's request headers. */
  clientHeaders: Headers;
  /** Fires when the client goes away. */
  signal: AbortSignal;
  fetch: typeof fetch;
  /** Milliseconds, for Retry-After dates and translated answer creation time. */
  now(): number;
}

/** Result of an attempt before or after its first content frame. */
export type AttemptResult =
  /** A complete answer for the client, in the client's protocol. */
  | { kind: 'complete'; body: string; usage: Usage | null }
  /** A streaming answer that has begun; `finished` tells how it ended. */
  | { kind: 'stream'; body: ReadableStream<Uint8Array>; finished: Promise<Finished> }
  /** The request cannot be expressed in this route's protocol. Nothing was sent upstream. */
  | { kind: 'refused'; message: string; param: string }
  /**
   * This route cannot serve the client's protocol: either the model speaks none of the gateway's
   * interfaces, or the one its connector chose cannot be bridged to the client's. `protocols` is
   * what the provider said the model speaks, or the protocol the route chose when it said
   * nothing; empty when the model speaks none. Nothing was sent upstream.
   */
  | { kind: 'incompatible'; protocols: Protocol[] }
  /** The upstream says the request itself is at fault. `body` is for the client. */
  | { kind: 'rejected'; status: number; body: string }
  /** This route could not serve the request; another one may. Nothing reached the client. */
  | { kind: 'failed'; outcome: Outcome; status: number | null; reason: string }
  /** The client went away before an answer began. */
  | { kind: 'abandoned' };

function failed(outcome: Outcome, status: number | null, reason: string): AttemptResult {
  return { kind: 'failed', outcome, status, reason };
}

/** Collect upstream authentication values, longest first to redact bearer tokens completely. */
function secretsOf(target: UpstreamTarget): string[] {
  return Object.entries(target.headers)
    .filter(([name]) => AUTH_HEADERS.includes(name.toLowerCase()))
    .flatMap(([, value]) => {
      const bearer = /^Bearer\s+(.+)$/i.exec(value);
      return bearer ? [value, bearer[1]] : [value];
    })
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function redact(text: string, target: UpstreamTarget): string {
  for (const secret of secretsOf(target)) text = text.replaceAll(secret, '[redacted]');
  return text;
}

function requestHeaders(input: AttemptInput, target: UpstreamTarget, stream: boolean): Headers {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    ...target.headers,
  });
  if (input.inbound === 'messages' && target.protocol === 'messages') {
    for (const name of ['anthropic-version', 'anthropic-beta']) {
      const value = input.clientHeaders.get(name);
      if (value !== null) headers.set(name, value);
    }
  }
  for (const name of input.connector.clientHeaders ?? []) {
    const value = input.clientHeaders.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function errorAnswer(
  input: AttemptInput, target: UpstreamTarget, response: Response, text: string,
): AttemptResult {
  const status = response.status;
  if (status === 401) input.connector.rejected?.(input.provider, target);
  const outcome = classify(status, response.headers.get('retry-after'), input.now());
  const message = protocolModule(target.protocol).errorOf(parseJson(text)) ?? `HTTP ${status}`;
  if (outcome.kind === 'client') {
    const body = input.inbound === target.protocol
      ? text : JSON.stringify(protocolModule(input.inbound).errorBody(status, message));
    return { kind: 'rejected', status, body: redact(body, target) };
  }
  return failed(outcome, status, redact(message, target));
}

async function readAnswer(
  input: AttemptInput,
  target: UpstreamTarget,
  bridge: Bridge,
  response: Response,
): Promise<AttemptResult> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // Reading an upstream body can fail on disconnect, including client cancellation.
    if (input.signal.aborted) return { kind: 'abandoned' };
    return failed({ kind: 'unavailable' }, response.status, 'Failed to read upstream response');
  }
  if (!response.ok) return errorAnswer(input, target, response, text);
  const complete = bridgeResponse(text, bridge);
  if (!complete.ok) return failed({ kind: 'unavailable' }, response.status, redact(complete.reason, target));
  return { kind: 'complete', body: complete.body, usage: complete.usage };
}

async function openStream(
  input: AttemptInput,
  target: UpstreamTarget,
  bridge: Bridge,
  response: Response,
  clientWantsUsage: boolean,
): Promise<AttemptResult> {
  if (!response.body) return failed({ kind: 'unavailable' }, response.status, 'Upstream returned no body');
  const opened = await bridgeStream(response.body, bridge, clientWantsUsage);
  if (!opened.ok) {
    if (input.signal.aborted) return { kind: 'abandoned' };
    return failed({ kind: 'unavailable' }, response.status, redact(opened.reason, target));
  }
  const finished = opened.finished.then((result) => ({
    ...result,
    error: result.error === null ? null : redact(result.error, target),
  }));
  return { kind: 'stream', body: opened.body, finished };
}

async function answer(
  input: AttemptInput,
  target: UpstreamTarget,
  bridge: Bridge,
  response: Response,
  stream: boolean,
  clientWantsUsage: boolean,
): Promise<AttemptResult> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return failed({ kind: 'route' }, response.status, 'Upstream returned a redirect');
  }
  if (!response.ok || !stream) return readAnswer(input, target, bridge, response);
  return openStream(input, target, bridge, response, clientWantsUsage);
}

/** Attempt one request against one provider route. */
export async function attempt(input: AttemptInput): Promise<AttemptResult> {
  const known = input.provider.model(input.upstreamModel);
  // A model that speaks none of the gateway's interfaces cannot serve any request, so where a
  // request for it would go is never asked: no target, no fetch, no credential renewal.
  if (known?.protocols?.length === 0) return { kind: 'incompatible', protocols: [] };
  let target: UpstreamTarget;
  try {
    target = await input.connector.target(input.provider, input.upstreamModel, input.inbound);
  } catch (error) {
    // A login the authorization server will not renew fails this route until the provider is
    // signed in again; its message names no token.
    if (error instanceof LoginExpired) {
      input.provider.rejectCredential();
      return failed({ kind: 'route' }, null, error.message);
    }
    // Connectors report expected target failures as UpstreamFailure; programming errors propagate.
    if (error instanceof UpstreamFailure) return failed({ kind: 'route' }, null, error.message);
    throw error;
  }
  // The Responses API is passed through in both directions and never translated: a route that
  // speaks a different protocol with it on either side cannot serve this request.
  if (!canServe(input.inbound, target.protocol)) {
    return { kind: 'incompatible', protocols: known?.protocols ?? [target.protocol] };
  }
  const bridge: Bridge = {
    inbound: input.inbound,
    upstream: target.protocol,
    upstreamModel: input.upstreamModel,
    maxOutputTokens: known?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    created: Math.floor(input.now() / 1000),
  };
  const request = bridgeRequest(input.body, bridge);
  if (isRefused(request)) return { kind: 'refused', ...request.refused };
  let response: Response;
  try {
    response = await input.fetch(target.url, {
      method: 'POST',
      headers: requestHeaders(input, target, request.stream),
      body: JSON.stringify(request.body),
      redirect: 'manual',
      signal: input.signal,
    });
  } catch (error) {
    // Fetch rejects on network failure or when the client aborts.
    if (input.signal.aborted) return { kind: 'abandoned' };
    const message = error instanceof Error ? error.message : String(error);
    return failed({ kind: 'unavailable' }, null, redact(`Upstream connection failed: ${message}`, target));
  }
  return answer(input, target, bridge, response, request.stream, request.clientWantsUsage);
}
