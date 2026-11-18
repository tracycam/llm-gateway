// What the gateway needs to know about an upstream wire protocol to pass a response on:
// which frames carry content, where the usage is, and how an error looks.
import type { Protocol } from '../../protocol/gatewayApi';
import type { Usage } from '../pricing';
import type { SseFrame } from './sse';
import { chat } from './chat';
import { messages } from './messages';
import { responses } from './responses';

// `Protocol` crosses the management API as `ProviderModel.protocols`;
// protocol/gatewayApi.ts defines it once.
export type { Protocol };
/** What a frame of an upstream response stream is to the gateway. */
export type FrameKind =
  /** Nothing the model produced yet; held back until content follows. */
  | 'preamble'
  /** Text, reasoning, a tool call, or the normal end of the answer. */
  | 'content'
  /** Carries only usage. */
  | 'usage'
  /** The terminator of the stream. */
  | 'end'
  /** The upstream reports a failure in-band. */
  | 'error';

export interface StreamObserver {
  /** Classify a frame and record any usage or error it carries. */
  see(frame: SseFrame): FrameKind;
  /** Usage read so far; null while the upstream has reported none. */
  usage(): Usage | null;
  /** Message of the in-band error, once `see` returned 'error'. */
  error(): string | null;
}

export interface ProtocolModule {
  /** Create an observer for one upstream stream. */
  observe(): StreamObserver;
  /** Usage of a complete, non-streaming response body; null when it reports none. */
  usageOf(body: unknown): Usage | null;
  /** Message of an error object in a response body; null when there is none. */
  errorOf(body: unknown): string | null;
  /** The protocol's error body for an error the gateway itself raises. */
  errorBody(status: number, message: string, param?: string): unknown;
}

/** Return the implementation for the requested protocol. */
export function protocolModule(protocol: Protocol): ProtocolModule {
  if (protocol === 'chat') return chat;
  if (protocol === 'messages') return messages;
  return responses;
}

/**
 * Whether an upstream speaking `upstream` can answer a request written in `inbound`: the same
 * protocol, or the Chat/Messages pair the bridge translates. The Responses API has no
 * translator in either direction and is served by passthrough only.
 */
export function canServe(inbound: Protocol, upstream: Protocol): boolean {
  if (inbound === upstream) return true;
  return inbound !== 'responses' && upstream !== 'responses';
}
