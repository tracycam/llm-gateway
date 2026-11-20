// An OpenAI Responses client served by a Chat Completions upstream: the request, the complete
// response and the response stream, each translated.
import { isObject, parseJson, type JsonObject } from './json';
import { isRefused, refuse, type Refused } from './refusal';

export type { Refused };

/** A previously parsed upstream SSE frame. */
export interface ParsedFrame {
  event: string | null;
  data: string | null;
}

const NOT_ON_THIS_PROVIDER = "cannot be sent to this model's provider";

// ---------------------------------------------------------------------------------------
// Request: Responses → Chat Completions

/** Text of a Responses system or assistant message: a string, or its text parts. */
function messageText(value: unknown, param: string, output: boolean, separator: string): string | Refused {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return refuse(param, 'expected a string or an array of text parts');
  const texts: string[] = [];
  for (const [i, part] of value.entries()) {
    if (!isObject(part) || typeof part.text !== 'string') {
      return refuse(`${param}.${i}`, 'expected a text part');
    }
    const accepted = part.type === 'text' || (output ? part.type === 'output_text' : part.type === 'input_text');
    if (!accepted) return refuse(`${param}.${i}`, 'expected a text part');
    texts.push(part.text);
  }
  return texts.join(separator);
}

/** The Chat `user` content of a Responses user message. */
function userContent(content: unknown, param: string): string | JsonObject[] | Refused {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return refuse(param, 'expected a string or an array of content parts');
  const parts: JsonObject[] = [];
  for (const [i, part] of content.entries()) {
    const path = `${param}.${i}`;
    if (!isObject(part)) return refuse(path, 'expected a content part');
    if ((part.type === 'input_text' || part.type === 'text') && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'input_image') {
      const url = isObject(part.image_url) ? part.image_url.url : part.image_url;
      if (typeof url !== 'string') return refuse(`${path}.image_url`, 'expected a URL');
      parts.push({ type: 'image_url', image_url: { url } });
    } else {
      const type = JSON.stringify(part.type);
      return refuse(`${path}.type`, `a content part of type ${type} ${NOT_ON_THIS_PROVIDER}`);
    }
  }
  return parts;
}

/** The text of a `function_call_output`, which may be a string or a list of text parts. */
function toolOutput(value: unknown, param: string): string | Refused {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return refuse(param, 'expected a string or an array of text parts');
  const texts: string[] = [];
  for (const [i, part] of value.entries()) {
    if (!isObject(part) || typeof part.text !== 'string') {
      return refuse(`${param}.${i}`, 'expected a text part');
    }
    if (part.type !== 'input_text' && part.type !== 'text' && part.type !== 'output_text') {
      return refuse(`${param}.${i}`, 'expected a text part');
    }
    texts.push(part.text);
  }
  return texts.join('\n');
}

function functionCall(item: JsonObject, param: string): JsonObject | Refused {
  if (typeof item.call_id !== 'string') return refuse(`${param}.call_id`, 'expected the id of the tool call');
  if (typeof item.name !== 'string') return refuse(`${param}.name`, 'expected a function name');
  if (typeof item.arguments !== 'string') return refuse(`${param}.arguments`, 'expected the text of the arguments');
  return { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } };
}

function addToolCall(messages: JsonObject[], call: JsonObject): void {
  const last = messages[messages.length - 1];
  if (last !== undefined && last.role === 'assistant') {
    const calls = Array.isArray(last.tool_calls) ? last.tool_calls : [];
    calls.push(call);
    last.tool_calls = calls;
    return;
  }
  messages.push({ role: 'assistant', content: null, tool_calls: [call] });
}

interface Input {
  messages: JsonObject[];
}

function inputItems(value: unknown): Input | Refused {
  if (typeof value === 'string') return { messages: [{ role: 'user', content: value }] };
  if (!Array.isArray(value)) return refuse('input', 'expected a string or an array of input items');
  const messages: JsonObject[] = [];
  for (const [i, item] of value.entries()) {
    const param = `input.${i}`;
    if (!isObject(item)) return refuse(param, 'expected an input item');
    const type = typeof item.type === 'string' ? item.type : null;

    if (type === 'message' || (type === null && typeof item.role === 'string')) {
      if (item.role === 'system' || item.role === 'developer') {
        const text = messageText(item.content, `${param}.content`, false, '\n');
        if (isRefused(text)) return text;
        messages.push({ role: item.role, content: text });
      } else if (item.role === 'user') {
        const content = userContent(item.content, `${param}.content`);
        if (isRefused(content)) return content;
        messages.push({ role: 'user', content });
      } else if (item.role === 'assistant') {
        const content = messageText(item.content === undefined ? '' : item.content, `${param}.content`, true, '');
        if (isRefused(content)) return content;
        messages.push({ role: 'assistant', content });
      } else {
        return refuse(`${param}.role`, 'expected system, developer, user or assistant');
      }
    } else if (type === 'function_call') {
      const call = functionCall(item, param);
      if (isRefused(call)) return call;
      addToolCall(messages, call);
    } else if (type === 'function_call_output') {
      if (typeof item.call_id !== 'string') {
        return refuse(`${param}.call_id`, 'expected the id of the tool call this answers');
      }
      const output = toolOutput(item.output, `${param}.output`);
      if (isRefused(output)) return output;
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: output });
    } else if (type === 'reasoning') {
      // A reasoning item is only accepted with the identifier and encrypted content its
      // upstream issued, and a stateless Chat upstream has no way to verify or reuse it.
      continue;
    } else {
      const name = type === null ? 'an item with no type' : `an input item of type ${JSON.stringify(type)}`;
      return refuse(`${param}.type`, `${name} ${NOT_ON_THIS_PROVIDER}`);
    }
  }
  return { messages };
}

/** The first field that asks for something a Chat upstream cannot do; null when there is none. */
function refusedField(body: JsonObject): Refused | null {
  if (body.previous_response_id !== undefined) {
    return refuse('previous_response_id', `chaining a previous response ${NOT_ON_THIS_PROVIDER}`);
  }
  if (body.background === true) return refuse('background', `background responses ${NOT_ON_THIS_PROVIDER}`);
  if (body.store === true) return refuse('store', `server-side response storage ${NOT_ON_THIS_PROVIDER}`);
  if (body.truncation === 'auto') return refuse('truncation', `automatic truncation ${NOT_ON_THIS_PROVIDER}`);
  return null;
}

function chatTools(tools: unknown): JsonObject[] | Refused {
  if (!Array.isArray(tools)) return refuse('tools', 'expected an array');
  const result: JsonObject[] = [];
  for (const [i, tool] of tools.entries()) {
    if (!isObject(tool) || tool.type !== 'function') {
      return refuse(`tools.${i}.type`, "server tools are not available on this model's provider");
    }
    if (typeof tool.name !== 'string') return refuse(`tools.${i}.name`, 'expected a function name');
    result.push({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      },
    });
  }
  return result;
}

function chatToolChoice(value: unknown): string | JsonObject | Refused {
  if (value === 'auto' || value === 'none' || value === 'required') return value;
  if (isObject(value) && value.type === 'function' && typeof value.name === 'string') {
    return { type: 'function', function: { name: value.name } };
  }
  return refuse('tool_choice', 'expected a supported tool choice');
}

/** The Chat `response_format` for a Responses `text.format`; null when none was asked for. */
function chatFormat(text: unknown): JsonObject | Refused | null {
  if (text === undefined) return null;
  if (!isObject(text)) return refuse('text', 'expected an object');
  if (text.format === undefined) return null;
  const format = text.format;
  if (!isObject(format) || typeof format.type !== 'string') {
    return refuse('text.format', 'expected a format object');
  }
  if (format.type === 'text') return { type: 'text' };
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema') {
    if (typeof format.name !== 'string') return refuse('text.format.name', 'expected a schema name');
    if (format.schema === undefined) return refuse('text.format.schema', 'expected a JSON schema');
    return {
      type: 'json_schema',
      json_schema: {
        name: format.name,
        schema: format.schema,
        ...(format.strict === undefined ? {} : { strict: format.strict }),
        ...(format.description === undefined ? {} : { description: format.description }),
      },
    };
  }
  const type = JSON.stringify(format.type);
  return refuse('text.format.type', `a response format of type ${type} ${NOT_ON_THIS_PROVIDER}`);
}

/** Translate a Responses request to Chat Completions, or refuse an unrepresentable field. */
export function toChatRequestFromResponses(body: unknown): { body: JsonObject } | Refused {
  if (!isObject(body)) return refuse('body', 'expected an object');
  const refused = refusedField(body);
  if (refused) return refused;

  const messages: JsonObject[] = [];
  if (body.instructions !== undefined) {
    if (typeof body.instructions !== 'string') return refuse('instructions', 'expected a string');
    if (body.instructions !== '') messages.push({ role: 'system', content: body.instructions });
  }
  const mapped = inputItems(body.input);
  if (isRefused(mapped)) return mapped;
  messages.push(...mapped.messages);
  if (messages.length === 0) return refuse('input', 'expected at least one message');

  const out: JsonObject = { messages };
  for (const key of ['model', 'stream', 'temperature', 'top_p', 'parallel_tool_calls', 'user']) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens;

  if (body.reasoning !== undefined) {
    if (!isObject(body.reasoning)) return refuse('reasoning', 'expected an object');
    if (body.reasoning.effort !== undefined) {
      if (typeof body.reasoning.effort !== 'string') return refuse('reasoning.effort', 'expected a string');
      out.reasoning_effort = body.reasoning.effort;
    }
  }

  if (body.tools !== undefined) {
    const tools = chatTools(body.tools);
    if (isRefused(tools)) return tools;
    out.tools = tools;
  }
  if (body.tool_choice !== undefined) {
    const choice = chatToolChoice(body.tool_choice);
    if (isRefused(choice)) return choice;
    out.tool_choice = choice;
  }
  const format = chatFormat(body.text);
  if (isRefused(format)) return format;
  if (format !== null) out.response_format = format;
  return { body: out };
}

// ---------------------------------------------------------------------------------------
// Response: Chat Completions → Responses

/** Responses usage for Chat usage. Both count cached input inside the prompt, so it carries over. */
function responsesUsage(value: unknown): JsonObject {
  const data = isObject(value) ? value : {};
  const count = (field: unknown): number => (typeof field === 'number' ? field : 0);
  const details = isObject(data.prompt_tokens_details) ? data.prompt_tokens_details : {};
  const prompt = count(data.prompt_tokens);
  const completion = count(data.completion_tokens);
  return {
    input_tokens: prompt,
    output_tokens: completion,
    total_tokens: typeof data.total_tokens === 'number' ? data.total_tokens : prompt + completion,
    input_tokens_details: { cached_tokens: count(details.cached_tokens) },
  };
}

function toolCallOf(call: JsonObject, index: number): JsonObject {
  if (typeof call.id !== 'string' || !isObject(call.function) ||
      typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') {
    throw new Error('Invalid tool call');
  }
  return {
    id: `fc_${index}`,
    type: 'function_call',
    status: 'completed',
    call_id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
  };
}

/** Translate a complete Chat Completions response to a Responses response. */
export function toResponsesResponseFromChat(chat: unknown, created: number): JsonObject {
  if (!isObject(chat) || !Array.isArray(chat.choices) || !isObject(chat.choices[0]) ||
      !isObject(chat.choices[0].message)) {
    throw new Error('Invalid chat completion');
  }
  const choice = chat.choices[0];
  const message = choice.message;
  if (!isObject(message)) throw new Error('Invalid chat message');

  const calls: JsonObject[] = [];
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) throw new Error('Invalid tool calls');
    for (const [i, call] of message.tool_calls.entries()) {
      if (!isObject(call)) throw new Error('Invalid tool call');
      calls.push(toolCallOf(call, i));
    }
  }

  const output: JsonObject[] = [];
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  if (reasoning !== '') {
    output.push({
      id: 'rs_0',
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }
  const content = typeof message.content === 'string' ? message.content : '';
  if (content !== '' || (calls.length === 0 && output.length === 0)) {
    output.push({
      id: 'msg_0',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: content, annotations: [] }],
    });
  }
  output.push(...calls);

  const finish = choice.finish_reason;
  const incomplete = finish === 'length' || finish === 'content_filter';
  const rawId = typeof chat.id === 'string' && chat.id !== '' ? chat.id : 'resp_0';
  return {
    id: rawId.startsWith('resp_') ? rawId : `resp_${rawId}`,
    object: 'response',
    created_at: created,
    model: typeof chat.model === 'string' ? chat.model : '',
    status: incomplete ? 'incomplete' : 'completed',
    incomplete_details: incomplete
      ? { reason: finish === 'length' ? 'max_output_tokens' : 'content_filter' }
      : null,
    output,
    usage: responsesUsage(chat.usage),
  };
}

// ---------------------------------------------------------------------------------------
// Stream: Chat Completions SSE → Responses SSE

interface OpenItem {
  kind: 'reasoning' | 'message' | 'function_call';
  id: string;
  outputIndex: number;
  /** The assembled text: reasoning summary, message text, or function arguments. */
  text: string;
  callId?: string;
  name?: string;
}

/** Converts parsed Chat Completions frames to Responses SSE events. */
export class ResponsesFromChatStreamWriter {
  private id = '';
  private model = '';
  private started = false;
  private done = false;
  private finish: string | null = null;
  private usage: JsonObject = {};
  /** The reasoning or message item currently being written; at most one is open. */
  private open: OpenItem | null = null;
  /** Function call items, keyed by their Chat tool-call index. They close at the end. */
  private readonly tools = new Map<number, OpenItem>();
  /** Items in output order, indexed by their output index; a slot is filled when it closes. */
  private readonly output: Array<JsonObject | undefined> = [];
  private nextIndex = 0;

  constructor(private readonly options: { created: number }) {}

  /** Translate one upstream frame into zero or more Responses SSE events. */
  public push(frame: ParsedFrame): string[] {
    if (this.done || frame.data === null) return [];
    if (frame.data === '[DONE]') return this.terminal();
    const chunk = parseJson(frame.data);
    if (chunk === undefined) return this.fail('Invalid upstream JSON');
    if (!isObject(chunk)) return this.fail('Invalid upstream chunk');
    if (chunk.error !== undefined) {
      const message = isObject(chunk.error) && typeof chunk.error.message === 'string'
        ? chunk.error.message : 'Upstream error';
      return this.fail(message);
    }
    if (!Array.isArray(chunk.choices)) return this.fail('Invalid upstream chunk');

    const out: string[] = [];
    this.start(out, chunk);
    if (isObject(chunk.usage)) this.usage = chunk.usage;
    const choice: unknown = chunk.choices[0];
    if (choice === undefined) return out;
    if (!isObject(choice)) return [...out, ...this.fail('Invalid upstream choice')];

    const delta = isObject(choice.delta) ? choice.delta : {};
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (reasoning !== '') this.writeReasoning(out, reasoning);
    if (typeof delta.content === 'string' && delta.content !== '') this.writeText(out, delta.content);
    if (delta.tool_calls !== undefined) {
      // A tool call ends the reasoning or message item that precedes it.
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) this.closeAux(out);
      const failure = this.writeToolCalls(out, delta.tool_calls);
      if (failure !== null) return [...out, ...failure];
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      // The finish reason closes the answer, but the usage chunk the bridge asks for follows it,
      // so the terminal event waits for [DONE] or the end of the stream.
      this.finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop';
      this.closeAux(out);
    }
    return out;
  }

  /** Finish the answer when the upstream ended without a terminal event of its own. */
  public end(): string[] {
    return this.done ? [] : this.terminal();
  }

  private start(out: string[], chunk: JsonObject): void {
    if (this.started) return;
    this.started = true;
    this.id = typeof chunk.id === 'string' && chunk.id !== '' ? chunk.id : 'resp_0';
    this.model = typeof chunk.model === 'string' ? chunk.model : '';
    const response = this.snapshot('in_progress');
    out.push(this.event('response.created', { response }));
    out.push(this.event('response.in_progress', { response }));
  }

  private writeReasoning(out: string[], delta: string): void {
    if (this.open?.kind !== 'reasoning') {
      this.closeAux(out);
      const outputIndex = this.nextIndex++;
      const id = `rs_${outputIndex}`;
      this.open = { kind: 'reasoning', id, outputIndex, text: '' };
      out.push(this.event('response.output_item.added', {
        output_index: outputIndex,
        item: { id, type: 'reasoning', status: 'in_progress', summary: [] },
      }));
      out.push(this.event('response.reasoning_summary_part.added', {
        item_id: id,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }));
    }
    const item = this.open;
    if (item === null) return;
    item.text += delta;
    out.push(this.event('response.reasoning_summary_text.delta', {
      item_id: item.id,
      output_index: item.outputIndex,
      summary_index: 0,
      delta,
    }));
  }

  private writeText(out: string[], delta: string): void {
    if (this.open?.kind !== 'message') {
      this.closeAux(out);
      const outputIndex = this.nextIndex++;
      const id = `msg_${outputIndex}`;
      this.open = { kind: 'message', id, outputIndex, text: '' };
      out.push(this.event('response.output_item.added', {
        output_index: outputIndex,
        item: { id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      }));
      out.push(this.event('response.content_part.added', {
        item_id: id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }));
    }
    const item = this.open;
    if (item === null) return;
    item.text += delta;
    out.push(this.event('response.output_text.delta', {
      item_id: item.id,
      output_index: item.outputIndex,
      content_index: 0,
      delta,
    }));
  }

  /** Write tool-call deltas; an error frame instead when the upstream's calls are malformed. */
  private writeToolCalls(out: string[], value: unknown): string[] | null {
    if (!Array.isArray(value)) return this.fail('Invalid tool calls');
    for (const call of value) {
      if (!isObject(call) || typeof call.index !== 'number' ||
          !Number.isInteger(call.index) || call.index < 0) {
        return this.fail('Invalid tool call index');
      }
      const fn = isObject(call.function) ? call.function : {};
      let item = this.tools.get(call.index);
      if (item === undefined) {
        if (typeof call.id !== 'string' || typeof fn.name !== 'string') {
          return this.fail('Missing tool call id or name');
        }
        const outputIndex = this.nextIndex++;
        item = {
          kind: 'function_call',
          id: `fc_${call.index}`,
          outputIndex,
          text: '',
          callId: call.id,
          name: fn.name,
        };
        this.tools.set(call.index, item);
        out.push(this.event('response.output_item.added', {
          output_index: outputIndex,
          item: {
            id: item.id,
            type: 'function_call',
            status: 'in_progress',
            call_id: item.callId,
            name: item.name,
            arguments: '',
          },
        }));
      }
      if (typeof fn.arguments === 'string' && fn.arguments !== '') {
        item.text += fn.arguments;
        out.push(this.event('response.function_call_arguments.delta', {
          item_id: item.id,
          output_index: item.outputIndex,
          delta: fn.arguments,
        }));
      }
    }
    return null;
  }

  /** Close the open reasoning or message item and record it in the output. */
  private closeAux(out: string[]): void {
    const item = this.open;
    if (item === null) return;
    this.open = null;
    if (item.kind === 'reasoning') {
      const part = { type: 'summary_text', text: item.text };
      out.push(this.event('response.reasoning_summary_text.done', {
        item_id: item.id,
        output_index: item.outputIndex,
        summary_index: 0,
        text: item.text,
      }));
      out.push(this.event('response.reasoning_summary_part.done', {
        item_id: item.id,
        output_index: item.outputIndex,
        summary_index: 0,
        part,
      }));
      const assembled = { id: item.id, type: 'reasoning', status: 'completed', summary: [part] };
      this.output[item.outputIndex] = assembled;
      out.push(this.event('response.output_item.done', { output_index: item.outputIndex, item: assembled }));
      return;
    }
    const part = { type: 'output_text', text: item.text, annotations: [] };
    out.push(this.event('response.output_text.done', {
      item_id: item.id,
      output_index: item.outputIndex,
      content_index: 0,
      text: item.text,
    }));
    out.push(this.event('response.content_part.done', {
      item_id: item.id,
      output_index: item.outputIndex,
      content_index: 0,
      part,
    }));
    const assembled = {
      id: item.id,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [part],
    };
    this.output[item.outputIndex] = assembled;
    out.push(this.event('response.output_item.done', { output_index: item.outputIndex, item: assembled }));
  }

  private closeTools(out: string[]): void {
    for (const item of this.tools.values()) {
      const assembled = {
        id: item.id,
        type: 'function_call',
        status: 'completed',
        call_id: item.callId,
        name: item.name,
        arguments: item.text,
      };
      out.push(this.event('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: item.outputIndex,
        arguments: item.text,
      }));
      this.output[item.outputIndex] = assembled;
      out.push(this.event('response.output_item.done', { output_index: item.outputIndex, item: assembled }));
    }
    this.tools.clear();
  }

  /** The terminal event, carrying the assembled response. */
  private terminal(): string[] {
    if (this.done) return [];
    this.done = true;
    const out: string[] = [];
    if (!this.started) this.start(out, {});
    this.closeAux(out);
    this.closeTools(out);
    const incomplete = this.finish === 'length' || this.finish === 'content_filter';
    const status = incomplete ? 'incomplete' : 'completed';
    const response = {
      ...this.snapshot(status),
      incomplete_details: incomplete
        ? { reason: this.finish === 'length' ? 'max_output_tokens' : 'content_filter' }
        : null,
      output: this.output.filter((item): item is JsonObject => item !== undefined),
      usage: this.usageObject(),
    };
    out.push(this.event(incomplete ? 'response.incomplete' : 'response.completed', { response }));
    return out;
  }

  private snapshot(status: string): JsonObject {
    return {
      id: this.id,
      object: 'response',
      created_at: this.options.created,
      model: this.model,
      status,
      incomplete_details: null,
      output: [],
      usage: null,
    };
  }

  private usageObject(): JsonObject {
    const data = this.usage;
    const count = (field: unknown): number => (typeof field === 'number' ? field : 0);
    const details = isObject(data.prompt_tokens_details) ? data.prompt_tokens_details : {};
    const prompt = count(data.prompt_tokens);
    const completion = count(data.completion_tokens);
    return {
      input_tokens: prompt,
      output_tokens: completion,
      total_tokens: typeof data.total_tokens === 'number' ? data.total_tokens : prompt + completion,
      input_tokens_details: { cached_tokens: count(details.cached_tokens) },
    };
  }

  private fail(message: string): string[] {
    this.done = true;
    return [this.event('error', { code: 'api_error', message })];
  }

  private event(type: string, fields: JsonObject): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  }
}
