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

function mergeUsage(previous: Usage | null, value: unknown): Usage | null {
  if (!isObject(value)) return previous;
  const input = numberOrNull(value.input_tokens) ?? previous?.inputTokens;
  const output = numberOrNull(value.output_tokens) ?? previous?.outputTokens;
  if (input === undefined || output === undefined) return previous;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: numberOrNull(value.cache_read_input_tokens) ?? previous?.cacheReadTokens ?? 0,
    cacheWriteTokens: numberOrNull(value.cache_creation_input_tokens) ?? previous?.cacheWriteTokens ?? 0,
  };
}

function errorOf(body: unknown): string | null {
  const message = isObject(body) && body.type === 'error' && isObject(body.error) ? body.error.message : null;
  return typeof message === 'string' ? message : null;
}

export const messages: ProtocolModule = {
  usageOf: (body) => mergeUsage(null, isObject(body) ? body.usage : null),
  errorOf,
  errorBody(status, message) {
    const type = errorTypes[status] ?? 'api_error';
    return { type: 'error', error: { type, message } };
  },
  observe() {
    let usage: Usage | null = null;
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
          usage = mergeUsage(usage, fields);
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
