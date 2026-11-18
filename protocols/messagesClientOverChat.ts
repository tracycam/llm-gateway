// An Anthropic Messages client (for example Claude Code) served by a Chat Completions
// upstream: the request, the complete response and the response stream, each translated.
import { isObject, parseJson, type JsonObject } from './json';
import { isRefused, refuse, type Refused } from './refusal';

export type { Refused };

/** A previously parsed upstream SSE frame. */
export interface ParsedFrame {
  event: string | null;
  data: string | null;
}

function textBlocks(value: unknown, param: string, separator = '\n'): string | Refused {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return refuse(param, 'expected a string or an array of text blocks');
  const parts: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const block: unknown = value[i];
    if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') {
      return refuse(`${param}.${i}`, 'expected a text block; other content cannot be sent to this provider');
    }
    parts.push(block.text);
  }
  return parts.join(separator);
}

function imagePart(block: JsonObject, param: string): JsonObject | Refused {
  if (!isObject(block.source)) return refuse(param, 'expected an image source');
  const source = block.source;
  let url: string;
  if (source.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
    url = `data:${source.media_type};base64,${source.data}`;
  } else if (source.type === 'url' && typeof source.url === 'string') {
    url = source.url;
  } else {
    return refuse(param, 'expected a base64 or URL image source');
  }
  return { type: 'image_url', image_url: { url } };
}

function toolResultMessage(block: JsonObject, param: string): JsonObject | Refused {
  if (typeof block.tool_use_id !== 'string') return refuse(param, 'expected a tool use id');
  const content = textBlocks(block.content === undefined ? '' : block.content, `${param}.content`);
  if (typeof content !== 'string') return content;
  return { role: 'tool', tool_call_id: block.tool_use_id, content };
}

function toolCall(block: JsonObject, param: string): JsonObject | Refused {
  if (typeof block.id !== 'string' || typeof block.name !== 'string' || !isObject(block.input)) {
    return refuse(param, 'expected a tool id, name and object input');
  }
  return {
    id: block.id,
    type: 'function',
    function: { name: block.name, arguments: JSON.stringify(block.input) },
  };
}

function unsupportedBlock(block: unknown, param: string): Refused {
  if (isObject(block) && block.type === 'document') {
    return refuse(param, "document blocks cannot be sent to this model's provider");
  }
  return refuse(param, 'unknown or invalid content block');
}

function userMessages(message: JsonObject, param: string): JsonObject[] | Refused {
  if (typeof message.content === 'string') return [{ role: 'user', content: message.content }];
  if (!Array.isArray(message.content)) return refuse(`${param}.content`, 'expected a string or an array');
  const parts: JsonObject[] = [];
  const results: JsonObject[] = [];
  for (let i = 0; i < message.content.length; i++) {
    const block: unknown = message.content[i];
    const path = `${param}.content.${i}`;
    if (!isObject(block)) return unsupportedBlock(block, path);
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const part = imagePart(block, path);
      if (isRefused(part)) return part;
      parts.push(part);
    } else if (block.type === 'tool_result') {
      const result = toolResultMessage(block, path);
      if (isRefused(result)) return result;
      results.push(result);
    } else {
      return unsupportedBlock(block, path);
    }
  }
  if (parts.length) {
    const content = parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
    results.push({ role: 'user', content });
  }
  return results;
}

function assistantMessage(message: JsonObject, param: string): JsonObject[] | Refused {
  if (typeof message.content === 'string') return [{ role: 'assistant', content: message.content }];
  if (!Array.isArray(message.content)) return refuse(`${param}.content`, 'expected a string or an array');
  const parts: string[] = [];
  const calls: JsonObject[] = [];
  for (let i = 0; i < message.content.length; i++) {
    const block: unknown = message.content[i];
    const path = `${param}.content.${i}`;
    if (!isObject(block)) return unsupportedBlock(block, path);
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      const call = toolCall(block, path);
      if (isRefused(call)) return call;
      calls.push(call);
    } else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') {
      return unsupportedBlock(block, path);
    }
  }
  const content = parts.join('');
  const result: JsonObject = { role: 'assistant', content: calls.length && !content ? null : content };
  if (calls.length) result.tool_calls = calls;
  return [result];
}

function mapMessage(message: unknown, index: number): JsonObject[] | Refused {
  const param = `messages.${index}`;
  if (!isObject(message) || (message.role !== 'user' && message.role !== 'assistant')) {
    return refuse(param, 'expected a user or assistant message');
  }
  return message.role === 'user' ? userMessages(message, param) : assistantMessage(message, param);
}

function chatTools(value: unknown): JsonObject[] | Refused {
  if (!Array.isArray(value)) return refuse('tools', 'expected an array');
  const tools: JsonObject[] = [];
  for (let i = 0; i < value.length; i++) {
    const tool: unknown = value[i];
    const param = `tools.${i}`;
    if (!isObject(tool)) return refuse(param, 'expected a tool object');
    if (tool.type !== undefined && tool.type !== 'custom') {
      return refuse(param, "server tools are not available on this model's provider");
    }
    if (typeof tool.name !== 'string') return refuse(param, 'expected a tool name');
    const fn: JsonObject = { name: tool.name, parameters: tool.input_schema };
    if ('description' in tool) fn.description = tool.description;
    tools.push({ type: 'function', function: fn });
  }
  return tools;
}

function chatToolChoice(value: unknown): JsonObject | Refused {
  if (!isObject(value)) return refuse('tool_choice', 'expected a tool choice object');
  const result: JsonObject = {};
  if (value.type === 'auto' || value.type === 'none') {
    result.tool_choice = value.type;
  } else if (value.type === 'any') {
    result.tool_choice = 'required';
  } else if (value.type === 'tool' && typeof value.name === 'string') {
    result.tool_choice = { type: 'function', function: { name: value.name } };
  } else {
    return refuse('tool_choice', 'expected a supported tool choice');
  }
  if (value.disable_parallel_tool_use === true) result.parallel_tool_calls = false;
  return result;
}

/** Translate a Messages request to Chat Completions, or refuse an unrepresentable field. */
export function toChatRequest(body: unknown): { body: JsonObject } | Refused {
  if (!isObject(body)) return refuse('body', 'expected an object');
  for (const key of ['mcp_servers', 'container', 'output_format', 'output_config']) {
    if (key in body) return refuse(key, `${key} cannot be sent to this model's provider`);
  }
  if (!Array.isArray(body.messages)) return refuse('messages', 'expected an array');
  const messages: JsonObject[] = [];
  if (body.system !== undefined) {
    const system = textBlocks(body.system, 'system', '\n\n');
    if (typeof system !== 'string') return system;
    messages.push({ role: 'system', content: system });
  }
  for (let i = 0; i < body.messages.length; i++) {
    const mapped = mapMessage(body.messages[i], i);
    if (!Array.isArray(mapped)) return mapped;
    messages.push(...mapped);
  }
  const result: JsonObject = { messages };
  for (const key of ['model', 'stream', 'temperature', 'top_p', 'max_tokens']) {
    if (key in body) result[key] = body[key];
  }
  if ('stop_sequences' in body) result.stop = body.stop_sequences;
  if (isObject(body.metadata) && 'user_id' in body.metadata) result.user = body.metadata.user_id;
  if (body.tools !== undefined) {
    const tools = chatTools(body.tools);
    if (!Array.isArray(tools)) return tools;
    result.tools = tools;
  }
  if (body.tool_choice !== undefined) {
    const choice = chatToolChoice(body.tool_choice);
    if (isRefused(choice)) return choice;
    Object.assign(result, choice);
  }
  return { body: result };
}

function usage(value: unknown): Record<string, number> {
  const data = isObject(value) ? value : {};
  const details = isObject(data.prompt_tokens_details) ? data.prompt_tokens_details : {};
  const count = (v: unknown) => typeof v === 'number' ? v : 0;
  const cached = count(details.cached_tokens);
  // Chat's `prompt_tokens` includes cached input; Messages counts it apart, so the rest is input.
  // A cache write the Chat usage reports is input too, and the gateway has no count of its own to
  // report for it: the field stays at 0 because Messages clients read it.
  // Messages requires numeric usage even when the upstream did not provide it.
  return {
    input_tokens: Math.max(0, count(data.prompt_tokens) - cached),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: count(data.completion_tokens),
  };
}

function mapStopReason(value: unknown): string {
  if (value === 'length') return 'max_tokens';
  if (value === 'tool_calls') return 'tool_use';
  return 'end_turn';
}

/** Translate a complete Chat Completions response to a Messages response. */
export function toMessagesResponse(chat: unknown): JsonObject {
  if (!isObject(chat) || typeof chat.id !== 'string' || typeof chat.model !== 'string' ||
      !Array.isArray(chat.choices) || !isObject(chat.choices[0]) || !isObject(chat.choices[0].message)) {
    throw new Error('Invalid chat completion');
  }
  const choice = chat.choices[0];
  const message = choice.message;
  if (!isObject(message)) throw new Error('Invalid chat message');
  const content: JsonObject[] = [];
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content, signature: '' });
  }
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) throw new Error('Invalid tool calls');
    for (const call of message.tool_calls) {
      if (!isObject(call) || typeof call.id !== 'string' || !isObject(call.function) ||
          typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') {
        throw new Error('Invalid tool call');
      }
      const input = parseJson(call.function.arguments);
      if (!isObject(input)) throw new Error('Tool input must be an object');
      content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
    }
  }
  return {
    id: chat.id,
    type: 'message',
    role: 'assistant',
    model: chat.model,
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: usage(chat.usage),
  };
}

function event(type: string, fields: JsonObject): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

/** Converts parsed Chat Completions frames to Messages SSE events. */
export class MessagesStreamWriter {
  private started = false;
  private done = false;
  private stopReason: string | null = null;
  private usage = usage(undefined);
  private nextIndex = 0;
  private openBlock: { key: string; index: number } | null = null;
  private seenTools = new Set<number>();

  /** Translate one upstream frame into zero or more Messages SSE events. */
  public push(frame: ParsedFrame): string[] {
    if (this.done || frame.data === null) return [];
    if (frame.data === '[DONE]') return this.end();
    const chunk = parseJson(frame.data);
    if (chunk === undefined) return this.fail('Invalid upstream JSON');
    if (!isObject(chunk)) return this.fail('Invalid upstream chunk');
    if (chunk.error !== undefined) {
      const message = isObject(chunk.error) && typeof chunk.error.message === 'string'
        ? chunk.error.message : 'Upstream error';
      return this.fail(message);
    }
    if (!Array.isArray(chunk.choices)) return this.fail('Invalid upstream chunk');
    const out = this.startMessage(chunk);
    if (this.done) return out;
    if (isObject(chunk.usage)) this.usage = usage(chunk.usage);
    const choice: unknown = chunk.choices[0];
    if (choice === undefined) return out;
    if (!isObject(choice)) return [...out, ...this.fail('Invalid upstream choice')];
    const delta = isObject(choice.delta) ? choice.delta : {};
    this.writeThinking(out, delta);
    this.writeText(out, delta);
    if (delta.tool_calls !== undefined) this.writeToolCalls(out, delta.tool_calls);
    if (this.done) return out;
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      this.close(out);
      this.stopReason = mapStopReason(choice.finish_reason);
    }
    return out;
  }

  /** Finish the stream or report an upstream stream cut before its finish reason. */
  public end(): string[] {
    if (this.done) return [];
    if (!this.started || this.stopReason === null) {
      return this.fail('Upstream stream ended before finish reason');
    }
    this.done = true;
    const out: string[] = [];
    this.close(out);
    out.push(event('message_delta', {
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: this.usage,
    }));
    out.push(event('message_stop', {}));
    return out;
  }

  private startMessage(chunk: JsonObject): string[] {
    if (this.started) return [];
    if (typeof chunk.id !== 'string' || typeof chunk.model !== 'string') {
      return this.fail('Missing upstream id or model');
    }
    this.started = true;
    return [event('message_start', {
      message: {
        id: chunk.id,
        type: 'message',
        role: 'assistant',
        model: chunk.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })];
  }

  private writeThinking(out: string[], delta: JsonObject): void {
    const thinking = delta.reasoning_content ?? delta.reasoning;
    if (typeof thinking !== 'string' || !thinking) return;
    this.block(out, 'thinking', { type: 'thinking', thinking: '' });
    this.delta(out, { type: 'thinking_delta', thinking });
  }

  private writeText(out: string[], delta: JsonObject): void {
    if (typeof delta.content !== 'string' || !delta.content) return;
    this.block(out, 'text', { type: 'text', text: '' });
    this.delta(out, { type: 'text_delta', text: delta.content });
  }

  private writeToolCalls(out: string[], value: unknown): void {
    if (!Array.isArray(value)) {
      out.push(...this.fail('Invalid tool calls'));
      return;
    }
    for (const call of value) {
      if (!isObject(call) || typeof call.index !== 'number' ||
          !Number.isInteger(call.index) || call.index < 0) {
        out.push(...this.fail('Invalid tool call index'));
        return;
      }
      const key = `tool:${call.index}`;
      const fn = isObject(call.function) ? call.function : {};
      if (this.openBlock?.key !== key) {
        if (this.seenTools.has(call.index)) {
          out.push(...this.fail('Tool call resumed after its block closed'));
          return;
        }
        if (typeof call.id !== 'string' || typeof fn.name !== 'string') {
          out.push(...this.fail('Missing tool call id or name'));
          return;
        }
        this.seenTools.add(call.index);
        this.block(out, key, { type: 'tool_use', id: call.id, name: fn.name, input: {} });
      }
      if (typeof fn.arguments === 'string' && fn.arguments) {
        this.delta(out, { type: 'input_json_delta', partial_json: fn.arguments });
      }
    }
  }

  private fail(message: string): string[] {
    this.done = true;
    return [event('error', { error: { type: 'api_error', message } })];
  }

  private close(out: string[]): void {
    if (this.openBlock) out.push(event('content_block_stop', { index: this.openBlock.index }));
    this.openBlock = null;
  }

  private block(out: string[], key: string, content: JsonObject): void {
    if (this.openBlock?.key === key) return;
    this.close(out);
    const index = this.nextIndex++;
    this.openBlock = { key, index };
    out.push(event('content_block_start', { index, content_block: content }));
  }

  private delta(out: string[], delta: JsonObject): void {
    if (this.openBlock) out.push(event('content_block_delta', { index: this.openBlock.index, delta }));
  }
}
