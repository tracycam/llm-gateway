// An OpenAI Chat Completions client served by an Anthropic Messages upstream: the request,
// the complete response and the response stream, each translated.
import { isObject, parseJson, type JsonObject } from './json';
import { isRefused, refuse, type Refused } from './refusal';

export type { Refused };

/** One block of the upstream's SSE stream, already split into its fields. */
export interface UpstreamFrame {
  event: string | null;
  data: string | null;
}

const NOT_ON_THIS_PROVIDER = "cannot be sent to this model's provider";

// ---------------------------------------------------------------------------------------
// Request: Chat Completions → Messages

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

function imageBlock(part: JsonObject, param: string): JsonObject | Refused {
  const url = isObject(part.image_url) ? part.image_url.url : undefined;
  if (typeof url !== 'string') return refuse(`${param}.image_url.url`, 'expected a URL');
  const inline = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (inline) return { type: 'image', source: { type: 'base64', media_type: inline[1], data: inline[2] } };
  if (/^https?:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
  return refuse(`${param}.image_url.url`, 'expected a base64 data URL or an http(s) URL');
}

function userBlocks(content: unknown, param: string): JsonObject[] | Refused {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return refuse(param, 'expected a string or an array of content parts');
  const blocks: JsonObject[] = [];
  for (const [i, part] of content.entries()) {
    const path = `${param}.${i}`;
    if (!isObject(part)) return refuse(path, 'expected a content part');
    if (part.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      const image = imageBlock(part, path);
      if (isRefused(image)) return image;
      blocks.push(image);
    } else {
      const type = JSON.stringify(part.type);
      return refuse(`${path}.type`, `a content part of type ${type} ${NOT_ON_THIS_PROVIDER}`);
    }
  }
  return blocks;
}

function toolUseBlock(call: unknown, param: string): JsonObject | Refused {
  if (!isObject(call) || call.type !== 'function' || !isObject(call.function)) {
    return refuse(param, 'expected a function tool call');
  }
  if (typeof call.id !== 'string') return refuse(`${param}.id`, 'expected the id of the tool call');
  const name = call.function.name;
  if (typeof name !== 'string') return refuse(`${param}.function.name`, 'expected a function name');
  const args = call.function.arguments;
  const input = typeof args === 'string' ? parseJson(args) : undefined;
  if (!isObject(input)) return refuse(`${param}.function.arguments`, 'expected the text of a JSON object');
  return { type: 'tool_use', id: call.id, name, input };
}

function assistantBlocks(message: JsonObject, param: string): JsonObject[] | Refused {
  const blocks: JsonObject[] = [];
  // `reasoning_content` is left out: a Messages thinking block is only accepted with the
  // signature its upstream issued, and a Chat client has none to send back.
  if (message.content !== undefined && message.content !== null) {
    const text = textOf(message.content, `${param}.content`, '');
    if (isRefused(text)) return text;
    if (text !== '') blocks.push({ type: 'text', text });
  }
  if (message.tool_calls === undefined) return blocks;
  if (!Array.isArray(message.tool_calls)) return refuse(`${param}.tool_calls`, 'expected an array');
  for (const [j, call] of message.tool_calls.entries()) {
    const block = toolUseBlock(call, `${param}.tool_calls.${j}`);
    if (isRefused(block)) return block;
    blocks.push(block);
  }
  return blocks;
}

function toolResultBlock(message: JsonObject, param: string): JsonObject | Refused {
  if (typeof message.tool_call_id !== 'string') {
    return refuse(`${param}.tool_call_id`, 'expected the id of the tool call this answers');
  }
  const content = textOf(message.content, `${param}.content`, '\n');
  if (isRefused(content)) return content;
  return { type: 'tool_result', tool_use_id: message.tool_call_id, content };
}

interface Conversation {
  /** Every system and developer message, in order; null when there is none. */
  system: string | null;
  messages: JsonObject[];
}

function conversation(messages: unknown[]): Conversation | Refused {
  const system: string[] = [];
  const turns: JsonObject[] = [];
  // The blocks of the user turn that holds the tool results just read. Messages wants the
  // results of parallel calls together in one turn, with the user's next words after them.
  let results: JsonObject[] | null = null;

  for (const [i, message] of messages.entries()) {
    const param = `messages.${i}`;
    if (!isObject(message)) return refuse(param, 'expected a message');

    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content, `${param}.content`, '\n');
      if (isRefused(text)) return text;
      system.push(text);
    } else if (message.role === 'tool') {
      const block = toolResultBlock(message, param);
      if (isRefused(block)) return block;
      if (results === null) {
        results = [];
        turns.push({ role: 'user', content: results });
      }
      results.push(block);
    } else if (message.role === 'user') {
      const blocks = userBlocks(message.content, `${param}.content`);
      if (isRefused(blocks)) return blocks;
      if (results !== null) {
        results.push(...blocks);
      } else {
        turns.push({ role: 'user', content: typeof message.content === 'string' ? message.content : blocks });
      }
      results = null;
    } else if (message.role === 'assistant') {
      const blocks = assistantBlocks(message, param);
      if (isRefused(blocks)) return blocks;
      turns.push({ role: 'assistant', content: blocks });
      results = null;
    } else {
      return refuse(`${param}.role`, 'expected system, developer, user, assistant or tool');
    }
  }
  return { system: system.length > 0 ? system.join('\n\n') : null, messages: turns };
}

/** The first field that asks for something Messages cannot do; null when there is none. */
function refusedField(body: JsonObject): Refused | null {
  if (body.n !== undefined && body.n !== 1) return refuse('n', 'only n = 1 is supported');

  const format = body.response_format;
  if (format !== undefined && !(isObject(format) && format.type === 'text')) {
    return refuse('response_format', `a response format other than text ${NOT_ON_THIS_PROVIDER}`);
  }
  if (body.logprobs !== undefined && body.logprobs !== false) {
    return refuse('logprobs', `log probabilities ${NOT_ON_THIS_PROVIDER}`);
  }
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
  const temperature = body.temperature;
  if (temperature !== undefined && !(typeof temperature === 'number' && temperature >= 0 && temperature <= 1)) {
    // Messages takes 0–1; a clamped value would not be what was asked for.
    return refuse('temperature', `a temperature outside 0–1 ${NOT_ON_THIS_PROVIDER}`);
  }
  return null;
}

function messagesTools(tools: unknown): JsonObject[] | Refused {
  if (!Array.isArray(tools)) return refuse('tools', 'expected an array');
  const result: JsonObject[] = [];
  for (const [i, tool] of tools.entries()) {
    if (!isObject(tool) || tool.type !== 'function' || !isObject(tool.function)) {
      return refuse(`tools.${i}.type`, `a tool that is not a function ${NOT_ON_THIS_PROVIDER}`);
    }
    const fn = tool.function;
    if (typeof fn.name !== 'string') return refuse(`tools.${i}.function.name`, 'expected a function name');
    result.push({
      name: fn.name,
      ...(fn.description === undefined ? {} : { description: fn.description }),
      input_schema: fn.parameters ?? { type: 'object', properties: {} },
    });
  }
  return result;
}

/** The Messages tool choice; null when the request needs none. */
function messagesToolChoice(body: JsonObject, hasTools: boolean): JsonObject | Refused | null {
  const asked = body.tool_choice;
  let choice: JsonObject | null = null;
  if (asked === 'auto') {
    choice = { type: 'auto' };
  } else if (asked === 'required') {
    choice = { type: 'any' };
  } else if (asked === 'none') {
    choice = { type: 'none' };
  } else if (isObject(asked) && asked.type === 'function' && isObject(asked.function)) {
    const name = asked.function.name;
    if (typeof name !== 'string') return refuse('tool_choice.function.name', 'expected a function name');
    choice = { type: 'tool', name };
  } else if (asked !== undefined) {
    return refuse('tool_choice', 'expected auto, required, none or a function');
  }
  if (body.parallel_tool_calls !== false) return choice;
  if (choice === null && !hasTools) return null;
  return { ...(choice ?? { type: 'auto' }), disable_parallel_tool_use: true };
}

/**
 * The Messages request for a Chat Completions request. `maxOutputTokens` is the limit used
 * when the client names none: Messages requires one.
 */
export function toMessagesRequest(body: unknown, maxOutputTokens: number): { body: JsonObject } | Refused {
  if (!isObject(body)) return refuse('body', 'expected a JSON object');
  const refused = refusedField(body);
  if (refused) return refused;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return refuse('messages', 'expected a non-empty array');
  }
  const mapped = conversation(body.messages);
  if (isRefused(mapped)) return mapped;

  const out: JsonObject = {
    messages: mapped.messages,
    max_tokens: body.max_completion_tokens ?? body.max_tokens ?? maxOutputTokens,
  };
  if (mapped.system !== null) out.system = mapped.system;
  for (const key of ['model', 'stream', 'top_p', 'temperature']) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  if (body.stop !== undefined) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.user !== undefined) out.metadata = { user_id: body.user };

  if (body.tools !== undefined) {
    const tools = messagesTools(body.tools);
    if (isRefused(tools)) return tools;
    out.tools = tools;
  }
  const choice = messagesToolChoice(body, Array.isArray(out.tools) && out.tools.length > 0);
  if (isRefused(choice)) return choice;
  if (choice !== null) out.tool_choice = choice;
  return { body: out };
}

// ---------------------------------------------------------------------------------------
// Response: Messages → Chat Completions

function finishReason(stopReason: unknown): string {
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'tool_use') return 'tool_calls';
  return 'stop';
}

/**
 * Chat usage for Messages usage. Messages counts cached input apart from `input_tokens`;
 * Chat counts it inside `prompt_tokens`, so a cache write adds to the prompt there too. A count
 * the upstream left out is written as 0: the Chat usage object has no way to say "unknown".
 */
function chatUsage(usage: JsonObject): JsonObject {
  const count = (key: string): number => (typeof usage[key] === 'number' ? usage[key] : 0);
  const cached = count('cache_read_input_tokens');
  const written = count('cache_creation_input_tokens');
  const prompt = count('input_tokens') + cached + written;
  const completion = count('output_tokens');
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
  };
}

function toolCall(block: JsonObject): JsonObject {
  if (typeof block.id !== 'string' || typeof block.name !== 'string' || !isObject(block.input)) {
    throw new Error('The upstream sent a tool_use block without an id, a name or an object input');
  }
  return {
    id: block.id,
    type: 'function',
    function: { name: block.name, arguments: JSON.stringify(block.input) },
  };
}

/** The Chat Completions response for a complete Messages response. Throws when `message` is not one. */
export function toChatResponse(message: unknown, created: number): JsonObject {
  if (!isObject(message) || message.type !== 'message' || typeof message.id !== 'string' ||
      typeof message.model !== 'string' || !Array.isArray(message.content) || !isObject(message.usage)) {
    throw new Error('The upstream response is not a message');
  }
  const text: string[] = [];
  const thinking: string[] = [];
  const calls: JsonObject[] = [];
  for (const block of message.content) {
    if (!isObject(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    if (block.type === 'thinking' && typeof block.thinking === 'string') thinking.push(block.thinking);
    if (block.type === 'tool_use') calls.push(toolCall(block));
  }
  const answer: JsonObject = { role: 'assistant', content: text.length > 0 ? text.join('') : null };
  if (thinking.length > 0) answer.reasoning_content = thinking.join('');
  if (calls.length > 0) answer.tool_calls = calls;
  return {
    id: message.id,
    object: 'chat.completion',
    created,
    model: message.model,
    choices: [{ index: 0, message: answer, finish_reason: finishReason(message.stop_reason) }],
    usage: chatUsage(message.usage),
  };
}

// ---------------------------------------------------------------------------------------
// Stream: Messages SSE → Chat Completions SSE

/** Turns a Messages stream into a Chat Completions stream, one upstream frame at a time. */
export class ChatStreamWriter {
  private id = '';
  private model = '';
  private started = false;
  /** Set once the stream has been ended, normally or with an error: nothing is written after. */
  private done = false;
  private stopReason: unknown = null;
  /** The upstream's usage counters; each report replaces the fields it carries. */
  private usage: JsonObject = {};
  /** Messages block index → position among the tool calls, which is what Chat numbers. */
  private readonly toolIndex = new Map<number, number>();

  constructor(private readonly options: { created: number; includeUsage: boolean }) {}

  /** The Chat SSE text for one upstream frame. */
  public push(frame: UpstreamFrame): string[] {
    if (this.done || frame.data === null) return [];
    const event = parseJson(frame.data);
    if (!isObject(event)) return this.fail('The upstream sent a frame that is not a JSON object');
    const type = typeof event.type === 'string' ? event.type : frame.event;
    if (type === 'error') return this.onError(event);
    if (type === 'message_start') return this.onMessageStart(event);
    if (!this.started) return this.fail('The upstream stream did not begin with message_start');
    if (type === 'content_block_start') return this.onBlockStart(event);
    if (type === 'content_block_delta') return this.onBlockDelta(event);
    if (type === 'message_delta') return this.onMessageDelta(event);
    if (type === 'message_stop') return this.onMessageStop();
    return [];
  }

  /** What is still owed when the upstream stream ended: an error unless it had finished. */
  public end(): string[] {
    return this.done ? [] : this.fail('The upstream stream ended before the answer was complete');
  }

  private onError(event: JsonObject): string[] {
    const error = isObject(event.error) ? event.error : {};
    const message = typeof error.message === 'string' ? error.message : 'The upstream reported an error';
    return this.fail(message, typeof error.type === 'string' ? error.type : 'api_error');
  }

  private onMessageStart(event: JsonObject): string[] {
    const message = event.message;
    if (!isObject(message) || typeof message.id !== 'string' || typeof message.model !== 'string') {
      return this.fail('The upstream message_start names no id or model');
    }
    this.started = true;
    this.id = message.id;
    this.model = message.model;
    if (isObject(message.usage)) Object.assign(this.usage, message.usage);
    return [this.chunk({ role: 'assistant', content: '' })];
  }

  private onBlockStart(event: JsonObject): string[] {
    const block = event.content_block;
    if (!isObject(block) || block.type !== 'tool_use') return [];
    if (typeof block.id !== 'string' || typeof block.name !== 'string' || typeof event.index !== 'number') {
      return this.fail('The upstream opened a tool_use block without an id, a name or an index');
    }
    const index = this.toolIndex.size;
    this.toolIndex.set(event.index, index);
    const call = { index, id: block.id, type: 'function', function: { name: block.name, arguments: '' } };
    return [this.chunk({ tool_calls: [call] })];
  }

  private onBlockDelta(event: JsonObject): string[] {
    const delta = event.delta;
    if (!isObject(delta)) return [];
    if (delta.type === 'text_delta') return [this.chunk({ content: delta.text })];
    if (delta.type === 'thinking_delta') return [this.chunk({ reasoning_content: delta.thinking })];
    if (delta.type !== 'input_json_delta') return [];
    const index = typeof event.index === 'number' ? this.toolIndex.get(event.index) : undefined;
    if (index === undefined) return this.fail('The upstream wrote to a tool_use block it never opened');
    return [this.chunk({ tool_calls: [{ index, function: { arguments: delta.partial_json } }] })];
  }

  private onMessageDelta(event: JsonObject): string[] {
    if (isObject(event.delta) && event.delta.stop_reason != null) this.stopReason = event.delta.stop_reason;
    if (isObject(event.usage)) Object.assign(this.usage, event.usage);
    return [];
  }

  private onMessageStop(): string[] {
    this.done = true;
    const frames = [this.chunk({}, finishReason(this.stopReason))];
    if (this.options.includeUsage) {
      frames.push(this.frame({ ...this.envelope(), choices: [], usage: chatUsage(this.usage) }));
    }
    frames.push('data: [DONE]\n\n');
    return frames;
  }

  private fail(message: string, type = 'api_error'): string[] {
    this.done = true;
    return [this.frame({ error: { message, type } })];
  }

  private chunk(delta: JsonObject, finish: string | null = null): string {
    return this.frame({ ...this.envelope(), choices: [{ index: 0, delta, finish_reason: finish }] });
  }

  private envelope(): JsonObject {
    return { id: this.id, object: 'chat.completion.chunk', created: this.options.created, model: this.model };
  }

  private frame(value: JsonObject): string {
    return `data: ${JSON.stringify(value)}\n\n`;
  }
}
