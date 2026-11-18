// Observe Anthropic Messages responses and normalize their usage.

import type { Usage } from '../pricing';
import type { ProtocolModule } from './protocol';
import { isObject, numberOrNull, parseJson } from './json';

const errorTypes: Record<number, string> = {
  400: 'invalid_request_error',
  422: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  503: 'overloaded_error',
  529: 'overloaded_error',
};

/**
 * Usage for a Messages usage object. Messages keeps cached input out of `input_tokens`, apart from
 * what the upstream read from or wrote to a cache; the gateway bills cache reads on their own and
 * counts cache writes as input, so `inputTokens` is `input_tokens` plus `cache_creation_input_tokens`.
 */
function usageOf(value: unknown): Usage | null {
  if (!isObject(value)) return null;
  const input = numberOrNull(value.input_tokens);
  const output = numberOrNull(value.output_tokens);
  if (input === null || output === null) return null;
  return {
    inputTokens: input + (numberOrNull(value.cache_creation_input_tokens) ?? 0),
    outputTokens: output,
    cacheReadTokens: numberOrNull(value.cache_read_input_tokens) ?? 0,
  };
}

function errorOf(body: unknown): string | null {
  const message = isObject(body) && body.type === 'error' && isObject(body.error) ? body.error.message : null;
  return typeof message === 'string' ? message : null;
}

export const messages: ProtocolModule = {
  usageOf: (body) => usageOf(isObject(body) ? body.usage : null),
  errorOf,
  errorBody(status, message) {
    const type = errorTypes[status] ?? 'api_error';
    return { type: 'error', error: { type, message } };
  },
  observe() {
    let usage: Usage | null = null;
    /** Every usage field the upstream has reported: a later report may carry only some of them. */
    let fields: Record<string, unknown> = {};
    let error: string | null = null;
    return {
      usage: () => usage,
      error: () => error,
      see(frame) {
        if (frame.data === null) return 'preamble';
        const parsed = parseJson(frame.data);
        const body = isObject(parsed) ? parsed : null;
        const type = typeof body?.type === 'string' ? body.type : frame.event;
        const update = type === 'message_start' && isObject(body?.message) ? body.message.usage
          : type === 'message_delta' ? body?.usage : null;
        if (isObject(update)) {
          fields = { ...fields, ...update };
          usage = usageOf(fields) ?? usage;
        }
        if (type === 'error') {
          const message = isObject(body?.error) ? body.error.message : null;
          error = typeof message === 'string' ? message : null;
          return 'error';
        }
        if (type === 'message_start' || type === 'ping') return 'preamble';
        if (type === 'message_stop') return 'end';
        return 'content';
      },
    };
  },
};
