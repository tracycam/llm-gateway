// Bridge one request and its response between client and upstream protocols without I/O.
import type { Usage } from '../pricing';
import { isObject, parseJson, type JsonObject } from './json';
import { isRefused, refuse, type Refused } from './refusal';
import { protocolModule, type FrameKind, type Protocol, type StreamObserver } from './protocol';
import { SseParser, type SseFrame } from './sse';
import { toChatRequest, toMessagesResponse, MessagesStreamWriter } from './messagesClientOverChat';
import { toMessagesRequest, toChatResponse, ChatStreamWriter } from './chatClientOverMessages';
import {
  toResponsesRequest,
  toChatResponseFromResponses,
  ChatFromResponsesStreamWriter,
} from './chatClientOverResponses';
import {
  toChatRequestFromResponses,
  toResponsesResponseFromChat,
  ResponsesFromChatStreamWriter,
} from './responsesClientOverChat';

/** Protocols and fixed values for one request. */
export interface Bridge {
  /** Protocol spoken by the client. */
  inbound: Protocol;
  /** Protocol spoken by the chosen upstream model. */
  upstream: Protocol;
  /** Model id to send upstream. */
  upstreamModel: string;
  /** Token limit for a Messages upstream when a Chat client names none. */
  maxOutputTokens: number;
  /** Creation time in seconds for Chat responses written by the bridge. */
  created: number;
}

/** Request prepared for the chosen upstream. */
export interface BridgedRequest {
  /** Request body to send upstream. */
  body: JsonObject;
  /** Whether the client requested a stream. */
  stream: boolean;
  /** Whether a Chat client explicitly requested a usage chunk. */
  clientWantsUsage: boolean;
}

function translateRequest(body: JsonObject, bridge: Bridge): { body: JsonObject } | Refused {
  const { inbound, upstream } = bridge;
  if (inbound === upstream) return { body: { ...body } };
  if (inbound === 'chat') {
    return upstream === 'messages' ? toMessagesRequest(body, bridge.maxOutputTokens) : toResponsesRequest(body);
  }
  if (inbound === 'messages') {
    if (upstream === 'chat') return toChatRequest(body);
    // Messages → Chat → Responses: the Chat form is the hub the two translations share.
    const chat = toChatRequest(body);
    return isRefused(chat) ? chat : toResponsesRequest(chat.body);
  }
  if (upstream === 'chat') return toChatRequestFromResponses(body);
  // Responses → Chat → Messages.
  const chat = toChatRequestFromResponses(body);
  return isRefused(chat) ? chat : toMessagesRequest(chat.body, bridge.maxOutputTokens);
}

/** Translate a request and select the upstream model. */
export function bridgeRequest(body: unknown, bridge: Bridge): BridgedRequest | Refused {
  if (!isObject(body)) return refuse('body', 'expected an object');
  const stream = body.stream === true;
  const clientWantsUsage = bridge.inbound === 'chat' && isObject(body.stream_options) &&
    body.stream_options.include_usage === true;
  const translated = translateRequest(body, bridge);
  if (isRefused(translated)) return translated;
  translated.body.model = bridge.upstreamModel;
  if (bridge.upstream === 'chat' && stream) {
    const options = isObject(translated.body.stream_options) ? translated.body.stream_options : {};
    translated.body.stream_options = { ...options, include_usage: true };
  }
  return { body: translated.body, stream, clientWantsUsage };
}

/** A usable complete response or a reason to try another route. */
export type Complete =
  | {
    ok: true;
    /** Response body in the client's protocol. */
    body: string;
    /** Usage reported by the upstream, if any. */
    usage: Usage | null;
  }
  | {
    ok: false;
    /** Nothing usable was sent; the caller may try another route. */
    reason: string;
  };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function translateResponse(body: JsonObject, bridge: Bridge): JsonObject {
  const { inbound, upstream } = bridge;
  if (inbound === 'chat') {
    return upstream === 'messages' ? toChatResponse(body, bridge.created)
      : toChatResponseFromResponses(body, bridge.created);
  }
  if (inbound === 'messages') {
    return upstream === 'chat' ? toMessagesResponse(body)
      : toMessagesResponse(toChatResponseFromResponses(body, bridge.created));
  }
  return upstream === 'chat' ? toResponsesResponseFromChat(body, bridge.created)
    : toResponsesResponseFromChat(toChatResponse(body, bridge.created), bridge.created);
}

/** Translate a complete successful HTTP response. */
export function bridgeResponse(text: string, bridge: Bridge): Complete {
  const body = parseJson(text);
  if (!isObject(body)) return { ok: false, reason: 'Upstream response is not a JSON object' };
  const protocol = protocolModule(bridge.upstream);
  const error = protocol.errorOf(body);
  if (error !== null) return { ok: false, reason: error };
  const usage = protocol.usageOf(body);
  if (bridge.inbound === bridge.upstream) return { ok: true, body: text, usage };
  try {
    return { ok: true, body: JSON.stringify(translateResponse(body, bridge)), usage };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

/** Outcome of reading a response stream. */
export interface Finished {
  /** Usage reported by the upstream as far as it was read. */
  usage: Usage | null;
  /** Failure after the answer began, if any. */
  error: string | null;
  /** Whether the client went away. */
  cancelled: boolean;
}

/** Opened stream, or failure before content arrived. */
export type Opened =
  | {
    ok: true;
    /** Response body driven by client pulls. */
    body: ReadableStream<Uint8Array>;
    /** Outcome once reading or cancellation finishes. */
    finished: Promise<Finished>;
  }
  | {
    ok: false;
    /** Nothing was sent; the caller may try another route. */
    reason: string;
  };

/** A stream translator: what a client should receive for one upstream frame. */
export interface StreamWriter {
  push(frame: { event: string | null; data: string | null }): string[];
  end(): string[];
}

/** Runs a two-hop translation: the Chat SSE the first writer emits feeds the second writer. */
class ChainedStreamWriter implements StreamWriter {
  private readonly parser = new SseParser();

  constructor(private readonly first: StreamWriter, private readonly second: StreamWriter) {}

  public push(frame: { event: string | null; data: string | null }): string[] {
    return this.drain(this.first.push(frame));
  }

  public end(): string[] {
    const out = this.drain(this.first.end());
    out.push(...this.drainFrames(this.parser.end()));
    out.push(...this.second.end());
    return out;
  }

  private drain(frames: string[]): string[] {
    const out: string[] = [];
    for (const frame of frames) out.push(...this.drainFrames(this.parser.push(frame)));
    return out;
  }

  private drainFrames(frames: SseFrame[]): string[] {
    return frames.flatMap((frame) => this.second.push(frame));
  }
}

function streamWriter(bridge: Bridge, clientWantsUsage: boolean): StreamWriter | null {
  const { inbound, upstream } = bridge;
  if (inbound === upstream) return null;
  if (inbound === 'chat') {
    return upstream === 'messages'
      ? new ChatStreamWriter({ created: bridge.created, includeUsage: clientWantsUsage })
      : new ChatFromResponsesStreamWriter({ created: bridge.created, includeUsage: clientWantsUsage });
  }
  if (inbound === 'messages') {
    // Messages → Responses goes through Chat; the Chat hop always reports usage so the
    // Messages hop can put it in `message_delta`.
    return upstream === 'chat' ? new MessagesStreamWriter()
      : new ChainedStreamWriter(
        new ChatFromResponsesStreamWriter({ created: bridge.created, includeUsage: true }),
        new MessagesStreamWriter(),
      );
  }
  return upstream === 'chat' ? new ResponsesFromChatStreamWriter({ created: bridge.created })
    : new ChainedStreamWriter(
      new ChatStreamWriter({ created: bridge.created, includeUsage: true }),
      new ResponsesFromChatStreamWriter({ created: bridge.created }),
    );
}

/** Format a gateway-generated streaming error in the client's protocol. */
function errorFrame(protocol: Protocol, status: number, message: string): string {
  // Messages names most frames, and a Responses error is an `error` event; Chat has neither.
  const prefix = protocol === 'chat' ? '' : 'event: error\n';
  const body = protocolModule(protocol).errorBody(status, message);
  return `${prefix}data: ${JSON.stringify(body)}\n\n`;
}

/** Open reads through the first content frame; afterward client pulls drive reading. */
class StreamBridge {
  /** Reader for the upstream bytes. */
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Incremental SSE frame parser. */
  private readonly parser = new SseParser();
  /** Incremental UTF-8 decoder. */
  private readonly decoder = new TextDecoder();
  /** Encoder for client output. */
  private readonly encoder = new TextEncoder();
  /** Classifies upstream frames and records usage. */
  private readonly observer: StreamObserver;
  /** Translates frames when protocols differ. */
  private readonly writer: StreamWriter | null;
  /** Parsed frames not yet looked at. */
  private frames: SseFrame[] = [];
  /** Text owed to the client. */
  private pending: string[] = [];
  /** The upstream stream is exhausted. */
  private ended = false;
  /** The outcome is decided and nothing more is read. */
  private settled = false;
  /** Completes the outcome promise. */
  private resolveFinished!: (finished: Finished) => void;
  /** Outcome shared with the caller. */
  private readonly finished = new Promise<Finished>((resolve) => { this.resolveFinished = resolve; });

  constructor(
    upstream: ReadableStream<Uint8Array>,
    private readonly bridge: Bridge,
    private readonly clientWantsUsage: boolean,
  ) {
    this.reader = upstream.getReader();
    this.observer = protocolModule(bridge.upstream).observe();
    this.writer = streamWriter(bridge, clientWantsUsage);
  }

  public async open(): Promise<Opened> {
    const held: Array<{ frame: SseFrame; kind: FrameKind }> = [];
    while (true) {
      const frame = await this.read();
      if (frame && 'failed' in frame) return this.reject(frame.failed);
      if (!frame) return this.reject('Upstream stream ended before content');
      const kind = this.observer.see(frame);
      if (kind === 'error') return this.reject(this.observer.error() ?? 'Upstream error');
      if (kind === 'end') return this.reject('Upstream stream ended before content');
      held.push({ frame, kind });
      if (kind !== 'content') continue;
      for (const item of held) this.emit(item.frame, item.kind);
      const body = new ReadableStream<Uint8Array>({
        pull: (controller) => this.pull(controller),
        cancel: () => this.settle(null, true),
      }, { highWaterMark: 0 });
      return { ok: true, body, finished: this.finished };
    }
  }

  private async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    while (!this.pending.length && !this.settled) {
      const frame = await this.read();
      if (this.settled) return;
      if (frame && 'failed' in frame) {
        this.cut(frame.failed);
        break;
      }
      if (!frame) {
        this.cut('Upstream stream ended before terminator');
        break;
      }
      const kind = this.observer.see(frame);
      this.emit(frame, kind);
      if (kind === 'error') this.settle(this.observer.error() ?? 'Upstream error');
      if (kind === 'end') {
        if (this.writer) this.pending.push(...this.writer.end());
        this.settle(null);
      }
    }
    if (this.pending.length) controller.enqueue(this.encoder.encode(this.pending.shift()));
    if (this.settled && !this.pending.length) controller.close();
  }

  private async read(): Promise<SseFrame | null | { failed: string }> {
    try {
      return await this.next();
    } catch (error) {
      return { failed: reasonOf(error) };
    }
  }

  private async next(): Promise<SseFrame | null> {
    while (!this.frames.length && !this.ended) {
      const chunk = await this.reader.read();
      if (chunk.done) {
        this.ended = true;
        this.frames.push(...this.parser.push(this.decoder.decode()), ...this.parser.end());
      } else {
        this.frames.push(...this.parser.push(this.decoder.decode(chunk.value, { stream: true })));
      }
    }
    return this.frames.shift() ?? null;
  }

  private emit(frame: SseFrame, kind: FrameKind): void {
    if (this.writer) {
      this.pending.push(...this.writer.push(frame));
    } else if (!(this.bridge.inbound === 'chat' && kind === 'usage' && !this.clientWantsUsage)) {
      this.pending.push(frame.raw);
    }
  }

  /** Reject a failed upstream before any content is sent. */
  private reject(reason: string): Opened {
    this.settle(reason);
    return { ok: false, reason };
  }

  /** Close a truncated or failed upstream after content has been sent. */
  private cut(reason: string): void {
    if (this.writer) {
      this.pending.push(...this.writer.end());
    } else {
      this.pending.push(errorFrame(this.bridge.inbound, 502, reason));
    }
    this.settle(reason);
  }

  private settle(error: string | null, cancelled = false): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveFinished({ usage: this.observer.usage(), error, cancelled });
    // An already-errored upstream can reject cancel with the failure recorded above.
    if (!this.ended) void this.reader.cancel().catch(() => undefined);
    this.reader.releaseLock();
  }
}

/** Open a pull-driven bridge once the upstream produces content. */
export function bridgeStream(
  upstream: ReadableStream<Uint8Array>,
  bridge: Bridge,
  clientWantsUsage: boolean,
): Promise<Opened> {
  return new StreamBridge(upstream, bridge, clientWantsUsage).open();
}
