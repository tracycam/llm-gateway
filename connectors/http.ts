// Shared credential and HTTP handling for API-key connectors.
import { isObject, parseJson } from '../protocols/json';
import { UpstreamFailure } from './connector';
import type { ProviderAccess } from './connector';

/** Deadline for a model-list request. */
export const MODEL_TIMEOUT_MS = 30_000;

/** Read and validate an API key without exposing credential text in errors. */
export function optionalApiKey(provider: ProviderAccess): string | null {
  const stored = provider.credential;
  if (stored === null) {
    return null;
  }
  const value = parseJson(stored);
  if (!isObject(value) || typeof value.apiKey !== 'string' || !value.apiKey.trim()) {
    throw new UpstreamFailure('Invalid API key credential', null);
  }
  return value.apiKey;
}

/** Read a required API key. */
export function requiredApiKey(provider: ProviderAccess): string {
  const key = optionalApiKey(provider);
  if (key === null) throw new UpstreamFailure('API key is required', null);
  return key;
}

/** Join a configured or default base URL to an upstream path. */
export function endpoint(provider: ProviderAccess, defaultBase: string | null, path: string): string {
  const base = provider.baseUrl ?? defaultBase;
  if (!base || !base.replace(/\/+$/, '')) throw new UpstreamFailure('Base URL is required', null);
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** Fetch and decode a model list, rejecting redirects and upstream errors. */
export async function fetchModels(
  url: string, headers: Record<string, string>, key: string | null
): Promise<unknown> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    // Fetch or body reading can fail for DNS, refused connections, TLS, or the 30 s timeout.
    const message = error instanceof Error ? error.message : 'Network error';
    throw new UpstreamFailure(key ? message.replaceAll(key, '[redacted]') : message, null);
  }
  const body = parseJson(text);
  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamFailure(
      'The upstream redirected to another address, which is not followed', response.status
    );
  }
  if (response.status !== 200) {
    const detail = errorMessage(body);
    const safe = key && detail ? detail.replaceAll(key, '[redacted]') : detail;
    throw new UpstreamFailure(`Upstream HTTP ${response.status}${safe ? `: ${safe}` : ''}`, response.status);
  }
  if (body === undefined) throw new UpstreamFailure('Invalid upstream JSON', null);
  return body;
}

function errorMessage(body: unknown): string | null {
  if (!isObject(body)) return null;
  if (typeof body.error === 'string') return body.error;
  if (isObject(body.error) && typeof body.error.message === 'string') return body.error.message;
  return typeof body.message === 'string' ? body.message : null;
}

/** Return a positive finite model limit, or null if unknown. */
export function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
