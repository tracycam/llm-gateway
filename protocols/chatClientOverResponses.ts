// An OpenAI Chat Completions client served by an OpenAI Responses upstream: the request, the
// complete response and the response stream, each translated.
import { isObject, parseJson, type JsonObject } from './json';
import { isRefused, refuse, type Refused } from './refusal';

export type { Refused };

/** One block of the upstream's SSE stream, already split into its fields. */
export interface UpstreamFrame {
  event: string | null;
  data: string | null;
}

const NOT_ON_THIS_PROVIDER = "cannot be sent to this model's provider";

/** Reasoning efforts the Responses API accepts. */
const EFFORTS: Record<string, true> = {
  low: true,
  medium: true,
  high: true,
  minimal: true,
  xhigh: true,
};

// ---------------------------------------------------------------------------------------
// Request: Chat Completions → Responses

/** The text of a system, developer, assistant or tool message: a string, or text parts. */
function textOf(content: unknown, param: string, separator: string): string | Refused {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return refuse(param, 'expected a string or an array of text parts');
  const texts: string[] = [];
  for (const [i, part] of content.entries()) {
    if (!isObject(part) || part.type !== 'text' || typeof part.text !== 'string') {
      return refuse(`${param}.${i}`, 'expected a text part');
    }
    texts.push(part.text);
  }
  return texts.join(separator);
}

/** The Chat `user` content as Responses input content: a string, or text and image parts. */
function userContent(content: unknown, param: string): string | JsonObject[] | Refused {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return refuse(param, 'expected a string or an array of content parts');
  const parts: JsonObject[] = [];
  for (const [i, part] of content.entries()) {
    const path = `${param}.${i}`;
    if (!isObject(part)) return refuse(path, 'expected a content part');
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'input_text', text: part.text });
    } else if (part.type === 'image_url') {
      const url = isObject(part.image_url) ? part.image_url.url : part.image_url;
      if (typeof url !== 'string') return refuse(`${path}.image_url`, 'expected a URL');
      parts.push({ type: 'input_image', image_url: url });
    } else {
      const type = JSON.stringify(part.type);
      return refuse(`${path}.type`, `a content part of type ${type} ${NOT_ON_THIS_PROVIDER}`);
    }
  }
  return parts;
}

function functionCall(call: unknown, param: string): JsonObject | Refused {
  if (!isObject(call) || call.type !== 'function' || !isObject(call.function)) {
    return refuse(param, 'expected a function tool call');
  }
  if (typeof call.id !== 'string') return refuse(`${param}.id`, 'expected the id of the tool call');
  const name = call.function.name;
  if (typeof name !== 'string') return refuse(`${param}.function.name`, 'expected a function name');
  const args = call.function.arguments;
  if (typeof args !== 'string') return refuse(`${param}.function.arguments`, 'expected the text of the arguments');
  return { type: 'function_call', call_id: call.id, name, arguments: args };
}

function assistantItems(message: JsonObject, param: string): JsonObject[] | Refused {
  const items: JsonObject[] = [];
  // `reasoning_content` is left out: a Responses reasoning item is only accepted with the
  // identifier its upstream issued, and a Chat client has none to send back.
  if (message.content !== undefined && message.content !== null) {
    const text = textOf(message.content, `${param}.content`, '');
    if (isRefused(text)) return text;
    if (text !== '') {
      items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    }
  }
  if (message.tool_calls === undefined) return items;
  if (!Array.isArray(message.tool_calls)) return refuse(`${param}.tool_calls`, 'expected an array');
  for (const [j, call] of message.tool_calls.entries()) {
    const item = functionCall(call, `${param}.tool_calls.${j}`);
    if (isRefused(item)) return item;
    items.push(item);
  }
  return items;
}

function toolOutput(message: JsonObject, param: string): JsonObject | Refused {
  if (typeof message.tool_call_id !== 'string') {
    return refuse(`${param}.tool_call_id`, 'expected the id of the tool call this answers');
  }
  const output = textOf(message.content, `${param}.content`, '\n');
  if (isRefused(output)) return output;
  return { type: 'function_call_output', call_id: message.tool_call_id, output };
}

interface Input {
  /** Every system and developer message, in order; null when there is none. */
  instructions: string | null;
  input: JsonObject[];
}

function inputOf(messages: unknown[]): Input | Refused {
  const system: string[] = [];
  const input: JsonObject[] = [];
  for (const [i, message] of messages.entries()) {
    const param = `messages.${i}`;
    if (!isObject(message)) return refuse(param, 'expected a message');

    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content, `${param}.content`, '\n');
      if (isRefused(text)) return text;
      system.push(text);
    } else if (message.role === 'user') {
      const content = userContent(message.content, `${param}.content`);
      if (isRefused(content)) return content;
      input.push({ type: 'message', role: 'user', content });
    } else if (message.role === 'assistant') {
      const items = assistantItems(message, param);
      if (isRefused(items)) return items;
      input.push(...items);
    } else if (message.role === 'tool') {
      const item = toolOutput(message, param);
      if (isRefused(item)) return item;
      input.push(item);
    } else {
      return refuse(`${param}.role`, 'expected system, developer, user, assistant or tool');
    }
  }
  return { instructions: system.length > 0 ? system.join('\n\n') : null, input };
}

/** The first field that asks for something Responses cannot do; null when there is none. */
function refusedField(body: JsonObject): Refused | null {
  if (body.n !== undefined && body.n !== 1) return refuse('n', 'only n = 1 is supported');
  if (body.stop !== undefined) return refuse('stop', `stop sequences ${NOT_ON_THIS_PROVIDER}`);
  if (body.logprobs === true) return refuse('logprobs', `log probabilities ${NOT_ON_THIS_PROVIDER}`);
  for (const key of ['top_logprobs', 'logit_bias', 'audio', 'prediction']) {
    if (body[key] !== undefined) return refuse(key, `${key} ${NOT_ON_THIS_PROVIDER}`);
  }
  for (const key of ['frequency_penalty', 'presence_penalty']) {
    if (body[key] === undefined || body[key] === 0) continue;
    return refuse(key, `a non-zero ${key} ${NOT_ON_THIS_PROVIDER}`);
  }
  const modalities = body.modalities;
  const textOnly = Array.isArray(modalities) && modalities.length === 1 && modalities[0] === 'text';
  if (modalities !== undefined && !textOnly) {
    return refuse('modalities', `output other than text ${NOT_ON_THIS_PROVIDER}`);
  }
  return null;
}

function responsesTools(tools: unknown): JsonObject[] | Refused {
  if (!Array.isArray(tools)) return refuse('tools', 'expected an array');
  const result: JsonObject[] = [];
  for (const [i, tool] of tools.entries()) {
    if (!isObject(tool) || tool.type !== 'function' || !isObject(tool.function)) {
      return refuse(`tools.${i}.type`, `a tool that is not a function ${NOT_ON_THIS_PROVIDER}`);
    }
    const fn = tool.function;
    if (typeof fn.name !== 'string') return refuse(`tools.${i}.function.name`, 'expected a function name');
    result.push({
      type: 'function',
      name: fn.name,
      ...(fn.description === undefined ? {} : { description: fn.description }),
      ...(fn.parameters === undefined ? {} : { parameters: fn.parameters }),
      ...(fn.strict === undefined ? {} : { strict: fn.strict }),
    });
  }
  return result;
}

function responsesToolChoice(asked: unknown): string | JsonObject | Refused {
  if (asked === 'auto' || asked === 'none' || asked === 'required') return asked;
  if (isObject(asked) && asked.type === 'function' && isObject(asked.function) &&
      typeof asked.function.name === 'string') {
    return { type: 'function', name: asked.function.name };
  }
  return refuse('tool_choice', 'expected auto, none, required or a function');
}

/** The Responses `text.format` for a Chat `response_format`; null when none was asked for. */
function textFormat(format: unknown): JsonObject | Refused | null {
  if (format === undefined) return null;
  if (!isObject(format) || typeof format.type !== 'string') {
    return refuse('response_format', 'expected a response format object');
  }
  if (format.type === 'text') return { format: { type: 'text' } };
  if (format.type === 'json_object') return { format: { type: 'json_object' } };
  if (format.type === 'json_schema') {
    const schema = isObject(format.json_schema) ? format.json_schema : null;
    if (schema === null) return refuse('response_format.json_schema', 'expected a JSON schema');
    if (typeof schema.name !== 'string') return refuse('response_format.json_schema.name', 'expected a schema name');
    if (schema.schema === undefined) {
      return refuse('response_format.json_schema.schema', 'expected a JSON schema');
    }
    return {
      format: {
        type: 'json_schema',
        name: schema.name,
        schema: schema.schema,
        ...(schema.strict === undefined ? {} : { strict: schema.strict }),
        ...(schema.description === undefined ? {} : { description: schema.description }),
      },
    };
  }
  const type = JSON.stringify(format.type);
  return refuse('response_format.type', `a response format of type ${type} ${NOT_ON_THIS_PROVIDER}`);
}

/** Translate a Chat Completions request to Responses, or refuse an unrepresentable field. */
export function toResponsesRequest(body: unknown): { body: JsonObject } | Refused {
  if (!isObject(body)) return refuse('body', 'expected a JSON object');
  const refused = refusedField(body);
  if (refused) return refused;
  if (!Array.isArray(body.messages)) return refuse('messages', 'expected an array');
  const mapped = inputOf(body.messages);
  if (isRefused(mapped)) return mapped;

  const out: JsonObject = { input: mapped.input };
  if (mapped.instructions !== null) out.instructions = mapped.instructions;
  for (const key of ['model', 'stream', 'temperature', 'top_p', 'parallel_tool_calls']) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  if (typeof body.user === 'string') out.user = body.user;

  const limit = body.max_completion_tokens ?? body.max_tokens;
  if (limit !== undefined) out.max_output_tokens = limit;

  if (body.reasoning_effort !== undefined) {
    const effort = body.reasoning_effort;
    if (typeof effort !== 'string' || EFFORTS[effort] !== true) {
      return refuse('reasoning_effort', 'expected low, medium, high, minimal or xhigh');
    }
    out.reasoning = { effort };
  }

  if (body.tools !== undefined) {
    const tools = responsesTools(body.tools);
    if (isRefused(tools)) return tools;
    out.tools = tools;
  }
  if (body.tool_choice !== undefined) {
    const choice = responsesToolChoice(body.tool_choice);
    if (isRefused(choice)) return choice;
    out.tool_choice = choice;
  }
  if (body.response_format !== undefined) {
    const text = textFormat(body.response_format);
    if (isRefused(text)) return text;
    if (text !== null) out.text = text;
  }
  return { body: out };
}

// ---------------------------------------------------------------------------------------
// Response: Responses → Chat Completions

/**
 * Chat usage for Responses usage. Responses `input_tokens` includes cached input, as Chat's
 * `prompt_tokens` does, so the counts carry over. A count the upstream left out is written as 0:
 * the Chat usage object has no way to say "unknown".
 */
function chatUsage(usage: unknown): JsonObject {
  const data = isObject(usage) ? usage : {};
  const count = (value: unknown): number => (typeof value === 'number' ? value : 0);
  const details = isObject(data.input_tokens_details) ? data.input_tokens_details : {};
  const cached = count(details.cached_tokens);
  const prompt = count(data.input_tokens);
  const completion = count(data.output_tokens);
  const result: JsonObject = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  if (cached > 0) result.prompt_tokens_details = { cached_tokens: cached };
  return result;
}

/** The text of a Responses part list: `summary` parts or a message's content parts. */
function partTexts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  const texts: string[] = [];
  for (const part of parts) {
    if (isObject(part) && typeof part.text === 'string') texts.push(part.text);
  }
  return texts;
}

function chatToolCall(item: JsonObject): JsonObject {
  const id = typeof item.call_id === 'string' ? item.call_id : item.id;
  if (typeof id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') {
    throw new Error('The upstream sent a function call without a call id, a name or arguments');
  }
  return { id, type: 'function', function: { name: item.name, arguments: item.arguments } };
}

/** The Chat finish reason for a Responses response. */
function finishReason(body: JsonObject, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_calls';
  if (body.status === 'incomplete') {
    const details = isObject(body.incomplete_details) ? body.incomplete_details : {};
    if (details.reason === 'content_filter') return 'content_filter';
    return 'length';
  }
  return 'stop';
}

/** The Chat Completions response for a complete Responses response. Throws when it is not one. */
export function toChatResponseFromResponses(body: JsonObject, created: number): JsonObject {
  if (!Array.isArray(body.output)) throw new Error('The upstream response is not a response');
  const text: string[] = [];
  const thinking: string[] = [];
  const calls: JsonObject[] = [];
  for (const item of body.output) {
    if (!isObject(item)) continue;
    if (item.type === 'reasoning') {
      const summary = partTexts(item.summary);
      // A reasoning item may carry its content in `content` instead of `summary`.
      const parts = summary.length > 0 ? summary : partTexts(item.content);
      if (parts.length > 0) thinking.push(parts.join(''));
    } else if (item.type === 'message') {
      if (!Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (!isObject(part)) continue;
        if (part.type === 'output_text' && typeof part.text === 'string') text.push(part.text);
        if (part.type === 'refusal' && typeof part.refusal === 'string') text.push(part.refusal);
      }
    } else if (item.type === 'function_call') {
      calls.push(chatToolCall(item));
    }
  }
  const content = text.length > 0 ? text.join('') : null;
  const answer: JsonObject = { role: 'assistant', content };
  if (thinking.length > 0) answer.reasoning_content = thinking.join('');
  if (calls.length > 0) answer.tool_calls = calls;
  return {
    id: typeof body.id === 'string' && body.id !== '' ? body.id : 'chatcmpl-',
    object: 'chat.completion',
    created,
    model: typeof body.model === 'string' ? body.model : '',
    choices: [{ index: 0, message: answer, finish_reason: finishReason(body, calls.length > 0) }],
    usage: chatUsage(body.usage),
  };
}

// ---------------------------------------------------------------------------------------
// Stream: Responses SSE → Chat Completions SSE

/** Turns a Responses stream into a Chat Completions stream, one upstream frame at a time. */
export class ChatFromResponsesStreamWriter {
  private id = '';
  private model = '';
  /** Set once the stream has been ended, normally or with an error: nothing is written after. */
  private done = false;
  /** Whether the chunk that carries the assistant role has been written. */
  private sentRole = false;
  /** Chat finish reason, decided by the terminal event. */
  private finish: string | null = null;
  /** Usage of the terminal event. */
  private usage: JsonObject = {};
  /** Function calls opened by the upstream, keyed by both item id and output index. */
  private readonly toolIndex = new Map<string, number>();
  private toolCount = 0;
  private hasToolCalls = false;

  constructor(private readonly options: { created: number; includeUsage: boolean }) {}

  /** The Chat SSE text for one upstream frame. */
  public push(frame: UpstreamFrame): string[] {
    if (this.done || frame.data === null) return [];
    if (frame.data === '[DONE]') return this.end();
    const event = parseJson(frame.data);
    if (!isObject(event)) return this.fail('The upstream sent a frame that is not a JSON object');
    const type = typeof event.type === 'string' ? event.type : frame.event;
    if (type === 'error' || type === 'response.failed') return this.onError(event);
    if (type === 'response.created' || type === 'response.in_progress' || type === 'response.queued') {
      return this.onStart(event);
    }
    if (type === 'response.output_item.added') return this.onItemAdded(event);
    if (type === 'response.reasoning_summary_text.delta') return this.onDelta(event, 'reasoning_content');
    if (type === 'response.output_text.delta') return this.onDelta(event, 'content');
    if (type === 'response.function_call_arguments.delta') return this.onArguments(event);
    if (type === 'response.completed' || type === 'response.incomplete') return this.onTerminal(event, type);
    return [];
  }

  /** What is still owed when the upstream stream ended: a terminal chunk unless it had finished. */
  public end(): string[] {
    return this.done ? [] : this.terminal();
  }

  private onStart(event: JsonObject): string[] {
    const response = isObject(event.response) ? event.response : {};
    if (typeof response.id === 'string') this.id = response.id;
    if (typeof response.model === 'string') this.model = response.model;
    return [];
  }

  private onItemAdded(event: JsonObject): string[] {
    const item = isObject(event.item) ? event.item : null;
    if (item === null || item.type !== 'function_call') return [];
    const callId = typeof item.call_id === 'string' ? item.call_id : null;
    const name = typeof item.name === 'string' ? item.name : null;
    if (callId === null || name === null) {
      return this.fail('The upstream opened a function call without a call id or a name');
    }
    const index = this.toolCount++;
    this.hasToolCalls = true;
    if (typeof item.id === 'string') this.toolIndex.set(item.id, index);
    if (typeof event.output_index === 'number') this.toolIndex.set(`index:${event.output_index}`, index);
    const call = { index, id: callId, type: 'function', function: { name, arguments: '' } };
    return [this.chunk({ tool_calls: [call] })];
  }

  private onDelta(event: JsonObject, key: 'content' | 'reasoning_content'): string[] {
    const delta = event.delta;
    if (typeof delta !== 'string') return [];
    return [this.chunk({ [key]: delta })];
  }

  private onArguments(event: JsonObject): string[] {
    const itemId = typeof event.item_id === 'string' ? event.item_id : null;
    const outputIndex = typeof event.output_index === 'number' ? `index:${event.output_index}` : null;
    const index = (itemId === null ? undefined : this.toolIndex.get(itemId)) ??
      (outputIndex === null ? undefined : this.toolIndex.get(outputIndex));
    if (index === undefined) return this.fail('The upstream wrote arguments for a function call it never opened');
    const delta = event.delta;
    if (typeof delta !== 'string') return [];
    return [this.chunk({ tool_calls: [{ index, function: { arguments: delta } }] })];
  }

  private onTerminal(event: JsonObject, type: string): string[] {
    const response = isObject(event.response) ? event.response : {};
    if (typeof response.id === 'string') this.id = response.id;
    if (typeof response.model === 'string') this.model = response.model;
    if (isObject(response.usage)) this.usage = response.usage;
    this.finish = this.finishReason(response, type);
    return this.terminal();
  }

  private finishReason(response: JsonObject, type: string): string {
    if (this.hasToolCalls) return 'tool_calls';
    if (type === 'response.incomplete' || response.status === 'incomplete') {
      const details = isObject(response.incomplete_details) ? response.incomplete_details : {};
      if (details.reason === 'content_filter') return 'content_filter';
      return 'length';
    }
    return 'stop';
  }

  /** The finish-reason chunk, the optional usage chunk, and the end of the stream. */
  private terminal(): string[] {
    this.done = true;
    const reason = this.finish ?? (this.hasToolCalls ? 'tool_calls' : 'stop');
    const frames = [this.chunk({}, reason)];
    if (this.options.includeUsage) {
      frames.push(this.frame({ ...this.envelope(), choices: [], usage: chatUsage(this.usage) }));
    }
    frames.push('data: [DONE]\n\n');
    return frames;
  }

  private onError(event: JsonObject): string[] {
    const nested = isObject(event.error) ? event.error.message : null;
    const response = isObject(event.response) ? event.response : null;
    const inner = isObject(response?.error) ? response.error.message : null;
    const message = typeof nested === 'string' ? nested
      : typeof inner === 'string' ? inner
        : typeof event.message === 'string' ? event.message : null;
    return this.fail(message ?? 'The upstream reported an error');
  }

  private fail(message: string): string[] {
    this.done = true;
    return [this.frame({ error: { message, type: 'api_error' } })];
  }

  private chunk(delta: JsonObject, finish: string | null = null): string {
    const value = this.sentRole ? delta : { role: 'assistant', ...delta };
    this.sentRole = true;
    return this.frame({ ...this.envelope(), choices: [{ index: 0, delta: value, finish_reason: finish }] });
  }

  private envelope(): JsonObject {
    return { id: this.id, object: 'chat.completion.chunk', created: this.options.created, model: this.model };
  }

  private frame(value: JsonObject): string {
    return `data: ${JSON.stringify(value)}\n\n`;
  }
}
