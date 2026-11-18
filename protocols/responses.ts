// Observe OpenAI Responses responses and normalize their usage.

import type { Usage } from '../pricing';
import type { ProtocolModule } from './protocol';
import { chat } from './chat';
import { isObject, numberOrNull, parseJson } from './json';
import type { SseFrame } from './sse';

/** Events the upstream sends before the model has produced anything. */
const PREAMBLE_EVENTS = new Set(['response.created', 'response.in_progress', 'response.queued']);

/** The two terminal events of a stream: the normal end of the answer. */
const END_EVENTS = new Set(['response.completed', 'response.incomplete']);

/**
 * Usage for a Responses usage object. `input_tokens` includes cached input, which the gateway
 * bills apart, so its own input is the remainder. A cache write the upstream reports is input:
 * `input_tokens` already counts it and no price is charged for it on its own.
 */
function normalizeUsage(usage: unknown): Usage | null {
  if (!isObject(usage)) return null;
  const input = numberOrNull(usage.input_tokens);
  const output = numberOrNull(usage.output_tokens);
  if (input === null || output === null) return null;
  const details = isObject(usage.input_tokens_details) ? usage.input_tokens_details : null;
  const cacheReadTokens = numberOrNull(details?.cached_tokens) ?? 0;
  return {
    inputTokens: Math.max(0, input - cacheReadTokens),
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

/**
 * The message of a failure event: `response.failed` reports it inside the response object, an
 * `error` event at the top of the body.
 */
function failureOf(body: unknown): string | null {
  if (!isObject(body)) return null;
  const response = isObject(body.response) ? body.response : null;
  const nested = isObject(response?.error) ? response.error.message : null;
  if (typeof nested === 'string') return nested;
  return typeof body.message === 'string' ? body.message : null;
}

/** Parsed data of a frame; undefined for a frame that carries none. */
function bodyOf(frame: SseFrame): unknown {
  return frame.data === null || frame.data === '' ? undefined : parseJson(frame.data);
}

/** The event kind a frame names: its data's `type` member, else its `event:` line. */
function eventName(frame: SseFrame): string | null {
  const body = bodyOf(frame);
  if (isObject(body) && typeof body.type === 'string') return body.type;
  return frame.event;
}

/** Usage of a terminal event, which carries it inside the response object. */
function endUsage(body: unknown): Usage | null {
  if (!isObject(body)) return null;
  const response = isObject(body.response) ? body.response : body;
  return normalizeUsage(response.usage);
}

export const responses: ProtocolModule = {
  usageOf: (body) => normalizeUsage(isObject(body) ? body.usage : null),
  errorOf,
  // The Responses API's error body is the OpenAI error shape, which Chat Completions defines.
  errorBody: (status, message, param) => chat.errorBody(status, message, param),
  observe() {
    let usage: Usage | null = null;
    let error: string | null = null;
    return {
      usage: () => usage,
      error: () => error,
      see(frame) {
        // Not part of the Responses stream, which ends on its terminal event; tolerated anyway.
        if (frame.data === '[DONE]') return 'end';
        const name = eventName(frame);
        const body = bodyOf(frame);
        if (name === 'error' || name === 'response.failed') {
          error = failureOf(body) ?? errorOf(body);
          return 'error';
        }
        if (name !== null && END_EVENTS.has(name)) {
          usage = endUsage(body) ?? usage;
          return 'end';
        }
        if (name !== null && PREAMBLE_EVENTS.has(name)) return 'preamble';
        // A frame with no name at all (a comment or a keepalive) produced nothing.
        if (frame.data === null || frame.data === '') return 'preamble';
        return 'content';
      },
    };
  },
};
