// Observe Chat Completions responses and normalize their usage.

import type { Usage } from '../pricing';
import type { ProtocolModule } from './protocol';
import { isObject, numberOrNull, parseJson } from './json';

const errorTypes: Record<number, string> = {
  400: 'invalid_request_error',
  404: 'invalid_request_error',
  413: 'invalid_request_error',
  422: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  429: 'rate_limit_error',
};

/**
 * Usage for a Chat Completions usage object. Chat's `prompt_tokens` includes cached input; the
 * gateway bills cache reads apart, so its own input is the remainder. Any cache write the upstream
 * reports is input: `prompt_tokens` already counts it and no price is charged for it on its own.
 */
function usageOf(body: unknown): Usage | null {
  const usage = isObject(body) && isObject(body.usage) ? body.usage : null;
  const prompt = numberOrNull(usage?.prompt_tokens);
  const output = numberOrNull(usage?.completion_tokens);
  if (prompt === null || output === null) return null;
  const details = isObject(usage?.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const cacheReadTokens = numberOrNull(details?.cached_tokens) ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cacheReadTokens),
    outputTokens: output,
    cacheReadTokens,
  };
}

function errorOf(body: unknown): string | null {
  const error = isObject(body) ? body.error : null;
  if (typeof error === 'string') return error;
  const message = isObject(error) ? error.message : null;
  return typeof message === 'string' ? message : null;
}

export const chat: ProtocolModule = {
  usageOf,
  errorOf,
  errorBody(status, message, param) {
    const type = errorTypes[status] ?? 'api_error';
    return { error: { message, type, code: null, param: param ?? null } };
  },
  observe() {
    let usage: Usage | null = null;
    let error: string | null = null;
    return {
      usage: () => usage,
      error: () => error,
      see(frame) {
        if (frame.data === null || frame.data === '') return 'preamble';
        if (frame.data === '[DONE]') return 'end';
        const body = parseJson(frame.data);
        if (!isObject(body)) return 'content';
        if (body.error != null) {
          error = errorOf(body);
          return 'error';
        }
        usage = usageOf(body) ?? usage;
        if (!Array.isArray(body.choices)) return 'content';
        if (body.choices.length === 0) return isObject(body.usage) ? 'usage' : 'content';
        const preamble = body.choices.every((item: unknown) => {
          if (!isObject(item) || !isObject(item.delta) || item.finish_reason != null) return false;
          return Object.entries(item.delta).every(([key, value]) =>
            key === 'role' || (key === 'content' && value === ''));
        });
        return preamble ? 'preamble' : 'content';
      },
    };
  },
};
