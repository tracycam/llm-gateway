import { expect, test } from 'bun:test';
import { isObject } from './json';
import { responses } from './responses';
import { SseParser } from './sse';
import {
  ResponsesFromChatStreamWriter,
  toChatRequestFromResponses,
  toResponsesResponseFromChat,
} from './responsesClientOverChat';

type Json = Record<string, unknown>;

/** The Chat request for a Responses request that says hello, plus `extra`. */
function translated(extra: Json): Json {
  const result = toChatRequestFromResponses({ model: 'm', input: 'hello', ...extra });
  if ('refused' in result) throw new Error(`refused: ${result.refused.param}: ${result.refused.message}`);
  return result.body;
}

/** The refusal of a Responses request that says hello, plus `extra`. */
function refusal(extra: Json): { message: string; param: string } {
  const result = toChatRequestFromResponses({ model: 'm', input: 'hello', ...extra });
  if (!('refused' in result)) throw new Error('the request was not refused');
  return result.refused;
}

const messages = (input: unknown) => translated({ input }).messages as Json[];

// ---------------------------------------------------------------------------------------
// Request: plain fields

test('model, stream, temperature, top_p, parallel_tool_calls and user keep their names', () => {
  expect(translated({ stream: true, temperature: 0.5, top_p: 0.25, parallel_tool_calls: false, user: 'u' }))
    .toMatchObject({
      model: 'm',
      stream: true,
      temperature: 0.5,
      top_p: 0.25,
      parallel_tool_calls: false,
      user: 'u',
    });
});

test('max_output_tokens becomes max_tokens', () => {
  expect(translated({ max_output_tokens: 4 }).max_tokens).toBe(4);
});

test('without max_output_tokens no limit is sent', () => {
  expect('max_tokens' in translated({})).toBe(false);
});

test('a body that is not an object is refused', () => {
  for (const body of [null, 'text', []]) {
    expect(toChatRequestFromResponses(body)).toHaveProperty('refused.param', 'body');
  }
});

// ---------------------------------------------------------------------------------------
// Request: what a stateless Chat upstream cannot do

for (const [name, value, param] of [
  ['previous_response_id', 'resp_1', 'previous_response_id'],
  ['background', true, 'background'],
  ['store', true, 'store'],
  ['truncation', 'auto', 'truncation'],
] as const) {
  test(`${name} = ${JSON.stringify(value)} is refused`, () => {
    expect(refusal({ [name]: value }).param).toBe(param);
  });
}

test('store false, background false and truncation disabled are allowed and left out', () => {
  const body = translated({ store: false, background: false, truncation: 'disabled' });
  expect(body).toEqual({ model: 'm', messages: [{ role: 'user', content: 'hello' }] });
});

// ---------------------------------------------------------------------------------------
// Request: messages

test('instructions become a system message', () => {
  expect(translated({ instructions: 'be brief' }).messages).toEqual([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hello' },
  ]);
});

test('empty instructions write no message', () => {
  expect(translated({ instructions: '' }).messages).toHaveLength(1);
});

test('instructions that are not a string are refused', () => {
  expect(refusal({ instructions: [{ type: 'input_text', text: 'x' }] }).param).toBe('instructions');
});

test('a string input becomes a user message', () => {
  expect(messages('hello')).toEqual([{ role: 'user', content: 'hello' }]);
});

test('an input message item with a system role becomes a system message', () => {
  const input = [{ type: 'message', role: 'system', content: [{ type: 'input_text', text: 'a' }] }];
  expect(messages(input)).toEqual([{ role: 'system', content: 'a' }]);
});

test('an input message without a type but with a role is a message', () => {
  expect(messages([{ role: 'user', content: 'hi' }])).toEqual([{ role: 'user', content: 'hi' }]);
});

test('input_text parts become text parts', () => {
  expect(messages([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] }]))
    .toEqual([{ role: 'user', content: [{ type: 'text', text: 'a' }] }]);
});

test('an input_image with a string URL becomes an image_url part', () => {
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://x/a.png' }] }];
  expect(messages(input)).toEqual([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/a.png' } }] },
  ]);
});

test('an input_image with an object URL becomes an image_url part', () => {
  const input = [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_image', image_url: { url: 'data:image/png;base64,abc' } }],
  }];
  expect(messages(input)).toEqual([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
  ]);
});

for (const type of ['input_file', 'input_audio', 'something_else']) {
  test(`an input part of type ${type} is refused`, () => {
    const input = [{ type: 'message', role: 'user', content: [{ type }] }];
    expect(refusal({ input })).toEqual({
      param: 'input.0.content.0.type',
      message: `a content part of type "${type}" cannot be sent to this model's provider`,
    });
  });
}

test('assistant output_text parts are joined into the content', () => {
  const input = [{
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }],
  }];
  expect(messages(input)).toEqual([{ role: 'assistant', content: 'ab' }]);
});

test('a function_call after an assistant message joins its tool_calls', () => {
  const input = [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    { type: 'function_call', call_id: 'a', name: 'f', arguments: '{"x":1}' },
  ];
  expect(messages(input)).toEqual([{
    role: 'assistant',
    content: 'hi',
    tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }],
  }]);
});

test('consecutive function_calls join one assistant message', () => {
  const input = [
    { type: 'function_call', call_id: 'a', name: 'f', arguments: '{}' },
    { type: 'function_call', call_id: 'b', name: 'g', arguments: '{}' },
  ];
  expect(messages(input)).toEqual([{
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } },
      { id: 'b', type: 'function', function: { name: 'g', arguments: '{}' } },
    ],
  }]);
});

test('a function_call without a call id is refused', () => {
  expect(refusal({ input: [{ type: 'function_call', name: 'f', arguments: '{}' }] }).param)
    .toBe('input.0.call_id');
});

test('a function_call_output becomes a tool message', () => {
  expect(messages([{ type: 'function_call_output', call_id: 'a', output: '1' }]))
    .toEqual([{ role: 'tool', tool_call_id: 'a', content: '1' }]);
});

test('the text parts of a function_call_output are joined with a newline', () => {
  const input = [{
    type: 'function_call_output',
    call_id: 'a',
    output: [{ type: 'input_text', text: '1' }, { type: 'input_text', text: '2' }],
  }];
  expect(messages(input)).toEqual([{ role: 'tool', tool_call_id: 'a', content: '1\n2' }]);
});

test('a function_call_output that is not text is refused', () => {
  const input = [{ type: 'function_call_output', call_id: 'a', output: [{ type: 'input_image', image_url: 'x' }] }];
  expect(refusal({ input }).param).toBe('input.0.output.0');
});

test('a reasoning item is skipped', () => {
  const input = [
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'hm' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ];
  expect(messages(input)).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
});

test('an item of an unknown type is refused', () => {
  expect(refusal({ input: [{ type: 'web_search_call' }] })).toEqual({
    param: 'input.0.type',
    message: 'an input item of type "web_search_call" cannot be sent to this model\'s provider',
  });
});

test('an item with no type and no role is refused', () => {
  expect(refusal({ input: [{}] }).param).toBe('input.0.type');
});

test('missing input is refused', () => {
  expect(refusal({ input: undefined }).param).toBe('input');
});

test('input that is neither a string nor an array is refused', () => {
  expect(refusal({ input: 7 }).param).toBe('input');
});

test('an input without any message is refused', () => {
  expect(refusal({ input: [] }).param).toBe('input');
});

// ---------------------------------------------------------------------------------------
// Request: tools

test('a Responses function tool becomes a Chat function tool', () => {
  const tool = { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: true };
  expect(translated({ tools: [tool] }).tools).toEqual([
    { type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' }, strict: true } },
  ]);
});

test('a function tool without optional fields omits them', () => {
  expect(translated({ tools: [{ type: 'function', name: 'f' }] }).tools).toEqual([
    { type: 'function', function: { name: 'f' } },
  ]);
});

test('a server tool is refused', () => {
  expect(refusal({ tools: [{ type: 'web_search' }] })).toEqual({
    param: 'tools.0.type',
    message: "server tools are not available on this model's provider",
  });
});

test('a function tool without a name is refused', () => {
  expect(refusal({ tools: [{ type: 'function' }] }).param).toBe('tools.0.name');
});

for (const asked of ['auto', 'none', 'required']) {
  test(`tool_choice ${asked} passes through`, () => {
    expect(translated({ tool_choice: asked }).tool_choice).toBe(asked);
  });
}

test('tool_choice naming a function becomes a Chat function choice', () => {
  expect(translated({ tool_choice: { type: 'function', name: 'f' } }).tool_choice)
    .toEqual({ type: 'function', function: { name: 'f' } });
});

test('any other tool_choice is refused', () => {
  expect(refusal({ tool_choice: { type: 'allowed_tools' } }).param).toBe('tool_choice');
});

// ---------------------------------------------------------------------------------------
// Request: reasoning and response format

test('reasoning.effort becomes reasoning_effort', () => {
  expect(translated({ reasoning: { effort: 'high' } }).reasoning_effort).toBe('high');
});

test('reasoning without effort writes nothing', () => {
  expect('reasoning_effort' in translated({ reasoning: {} })).toBe(false);
});

test('reasoning that is not an object is refused', () => {
  expect(refusal({ reasoning: 'high' }).param).toBe('reasoning');
});

test('text.format text becomes response_format text', () => {
  expect(translated({ text: { format: { type: 'text' } } }).response_format).toEqual({ type: 'text' });
});

test('text.format json_object becomes response_format json_object', () => {
  expect(translated({ text: { format: { type: 'json_object' } } }).response_format)
    .toEqual({ type: 'json_object' });
});

test('text.format json_schema nests the schema', () => {
  const format = {
    type: 'json_schema',
    name: 'answer',
    schema: { type: 'object' },
    strict: true,
    description: 'an answer',
  };
  expect(translated({ text: { format } }).response_format).toEqual({
    type: 'json_schema',
    json_schema: { name: 'answer', schema: { type: 'object' }, strict: true, description: 'an answer' },
  });
});

test('a JSON schema format without a name is refused', () => {
  expect(refusal({ text: { format: { type: 'json_schema', schema: {} } } }).param).toBe('text.format.name');
});

test('a JSON schema format without a schema is refused', () => {
  expect(refusal({ text: { format: { type: 'json_schema', name: 'a' } } }).param).toBe('text.format.schema');
});

test('an unknown text format is refused', () => {
  expect(refusal({ text: { format: { type: 'xml' } } }).param).toBe('text.format.type');
});

// ---------------------------------------------------------------------------------------
// Complete response

const CHAT_USAGE = {
  prompt_tokens: 10,
  completion_tokens: 4,
  total_tokens: 14,
  prompt_tokens_details: { cached_tokens: 2 },
};

function upstream(message: Json, extra: Json = {}): Json {
  return { id: 'chatcmpl-1', object: 'chat.completion', model: 'm', choices: [{ message }], usage: CHAT_USAGE, ...extra };
}

const outputOf = (body: Json) => toResponsesResponseFromChat(body, 12).output as Json[];

test('the envelope is a Responses object with the id prefixed and the given creation time', () => {
  expect(toResponsesResponseFromChat(upstream({ content: 'hi' }), 12)).toMatchObject({
    id: 'resp_chatcmpl-1',
    object: 'response',
    created_at: 12,
    model: 'm',
    status: 'completed',
    incomplete_details: null,
  });
});

test('an id that already names a response keeps its prefix', () => {
  expect(toResponsesResponseFromChat({ ...upstream({ content: 'hi' }), id: 'resp_1' }, 12).id).toBe('resp_1');
});

test('a missing id becomes resp_0', () => {
  const body = upstream({ content: 'hi' });
  delete body.id;
  expect(toResponsesResponseFromChat(body, 12).id).toBe('resp_0');
});

test('text becomes a message item with output_text', () => {
  expect(outputOf(upstream({ content: 'hi' }))).toEqual([{
    id: 'msg_0',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  }]);
});

test('without content and tools an empty message item is written', () => {
  expect(outputOf(upstream({ content: null }))).toEqual([{
    id: 'msg_0',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: '', annotations: [] }],
  }]);
});

test('reasoning_content becomes a reasoning item before the message', () => {
  expect(outputOf(upstream({ content: 'hi', reasoning_content: 'hm' }))).toEqual([
    {
      id: 'rs_0',
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: 'hm' }],
    },
    {
      id: 'msg_0',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hi', annotations: [] }],
    },
  ]);
});

test('reasoning without content writes no message', () => {
  expect(outputOf(upstream({ content: null, reasoning_content: 'hm' }))).toHaveLength(1);
});

test('tool_calls become function_call items', () => {
  const message = {
    content: null,
    tool_calls: [
      { id: 'a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
      { id: 'b', type: 'function', function: { name: 'g', arguments: '{}' } },
    ],
  };
  expect(outputOf(upstream(message))).toEqual([
    { id: 'fc_0', type: 'function_call', status: 'completed', call_id: 'a', name: 'f', arguments: '{"x":1}' },
    { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'b', name: 'g', arguments: '{}' },
  ]);
});

for (const [finish, status, reason] of [
  ['stop', 'completed', null],
  ['tool_calls', 'completed', null],
  ['length', 'incomplete', 'max_output_tokens'],
  ['content_filter', 'incomplete', 'content_filter'],
] as const) {
  test(`finish_reason ${finish} becomes status ${status}`, () => {
    const body = upstream({ content: 'hi' }, { choices: [{ message: { content: 'hi' }, finish_reason: finish }] });
    const response = toResponsesResponseFromChat(body, 12);
    expect(response.status).toBe(status);
    expect(response.incomplete_details).toEqual(reason === null ? null : { reason });
  });
}

test('usage maps to input, output, total and cached tokens', () => {
  expect(toResponsesResponseFromChat(upstream({ content: 'hi' }), 12).usage).toEqual({
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: 2 },
  });
});

test('a body that is not a chat completion throws', () => {
  for (const body of [{}, { choices: [] }, { choices: [{ message: 'x' }] }]) {
    expect(() => toResponsesResponseFromChat(body, 12)).toThrow('Invalid chat');
  }
});

test('a tool call without a function name throws', () => {
  const message = { content: null, tool_calls: [{ id: 'a', type: 'function', function: { arguments: '{}' } }] };
  expect(() => toResponsesResponseFromChat(upstream(message), 12)).toThrow('Invalid tool call');
});

// ---------------------------------------------------------------------------------------
// Stream

const CREATED_CHUNK = {
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'm',
};

const chunk = (delta: Json, finish: string | null = null): Json => ({
  ...CREATED_CHUNK,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const usageChunk = (usage: Json = CHAT_USAGE): Json => ({ ...CREATED_CHUNK, choices: [], usage });

/** The Responses events a Chat stream becomes. */
function events(chunks: Array<Json | '[DONE]'>): Json[] {
  const writer = new ResponsesFromChatStreamWriter({ created: 12 });
  const frames = chunks.flatMap((value) =>
    writer.push({ event: null, data: value === '[DONE]' ? '[DONE]' : JSON.stringify(value) }));
  frames.push(...writer.end());
  const parser = new SseParser();
  return [...parser.push(frames.join('')), ...parser.end()].map((frame) => {
    expect(frame.event).not.toBeNull();
    const data = JSON.parse(frame.data ?? 'null') as Json;
    expect(data.type).toBe(frame.event);
    return data;
  });
}

const types = (list: Json[]) => list.map((event) => event.type);

const TEXT = [
  chunk({ role: 'assistant' }),
  chunk({ content: 'he' }),
  chunk({ content: 'llo' }),
  chunk({}, 'stop'),
  usageChunk(),
  '[DONE]',
] as const;

test('the first chunk writes response.created and response.in_progress', () => {
  expect(types(events([chunk({ role: 'assistant' })]))).toEqual([
    'response.created',
    'response.in_progress',
    'response.completed',
  ]);
});

test('the created response carries the upstream id, model and creation time', () => {
  expect(events([chunk({ role: 'assistant' })])[0].response).toMatchObject({
    id: 'chatcmpl-1',
    object: 'response',
    created_at: 12,
    model: 'm',
    status: 'in_progress',
  });
});

test('a text answer becomes a message item with output_text deltas', () => {
  expect(types(events([...TEXT]))).toEqual([
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
});

test('the text deltas add up to the content the upstream wrote', () => {
  const deltas = events([...TEXT]).filter((event) => event.type === 'response.output_text.delta');
  expect(deltas.map((event) => event.delta).join('')).toBe('hello');
});

test('the completed response holds the assembled output and usage', () => {
  const last = events([...TEXT]).at(-1);
  expect(last?.type).toBe('response.completed');
  expect(last?.response).toMatchObject({
    id: 'chatcmpl-1',
    object: 'response',
    created_at: 12,
    model: 'm',
    status: 'completed',
    incomplete_details: null,
  });
  expect((last?.response as Json).output).toEqual([{
    id: 'msg_0',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'hello', annotations: [] }],
  }]);
  expect((last?.response as Json).usage).toEqual({
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: 2 },
  });
});

test('the terminal event waits for the usage chunk and [DONE]', () => {
  const writer = new ResponsesFromChatStreamWriter({ created: 12 });
  const first = writer.push({ event: null, data: JSON.stringify(chunk({ content: 'x' })) });
  expect(first.some((frame) => frame.includes('response.completed'))).toBe(false);
  const frames = writer.push({ event: null, data: JSON.stringify(chunk({}, 'stop')) });
  expect(frames.some((frame) => frame.includes('response.completed'))).toBe(false);
  expect(frames.some((frame) => frame.includes('response.output_text.done'))).toBe(true);
  const final = writer.push({ event: null, data: '[DONE]' });
  expect(final.some((frame) => frame.includes('response.completed'))).toBe(true);
});

test('a reasoning delta opens a reasoning item and writes a summary delta', () => {
  const list = events([chunk({ reasoning_content: 'hm' }), chunk({ content: 'ok' }), '[DONE]']);
  expect(types(list)).toEqual([
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.reasoning_summary_part.added',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done',
    'response.reasoning_summary_part.done',
    'response.output_item.done',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
  const last = list.at(-1);
  expect((last?.response as Json).output).toEqual([
    { id: 'rs_0', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'hm' }] },
    {
      id: 'msg_1',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    },
  ]);
});

const TOOLS = [
  chunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'f', arguments: '' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }),
  chunk({ tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'g', arguments: '' } }] }),
  chunk({ tool_calls: [{ index: 1, function: { arguments: '{}' } }] }),
  chunk({}, 'tool_calls'),
  usageChunk(),
  '[DONE]',
] as const;

test('tool calls become function_call items with argument deltas', () => {
  const list = events([...TOOLS]);
  const added = list.filter((event) => event.type === 'response.output_item.added');
  expect(added.map((event) => event.item)).toEqual([
    { id: 'fc_0', type: 'function_call', status: 'in_progress', call_id: 'a', name: 'f', arguments: '' },
    { id: 'fc_1', type: 'function_call', status: 'in_progress', call_id: 'b', name: 'g', arguments: '' },
  ]);
  const deltas = list.filter((event) => event.type === 'response.function_call_arguments.delta');
  expect(deltas.map((event) => event.delta)).toEqual(['{"x":', '1}', '{}']);
  expect(deltas.map((event) => event.item_id)).toEqual(['fc_0', 'fc_0', 'fc_1']);
});

test('the completed response carries both function calls with their arguments', () => {
  const last = events([...TOOLS]).at(-1);
  expect((last?.response as Json).output).toEqual([
    { id: 'fc_0', type: 'function_call', status: 'completed', call_id: 'a', name: 'f', arguments: '{"x":1}' },
    { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'b', name: 'g', arguments: '{}' },
  ]);
  expect((last?.response as Json).status).toBe('completed');
});

test('the first text delta closes the reasoning item before the message opens', () => {
  const list = events([chunk({ reasoning_content: 'hm' }), chunk({ content: 'ok' }), '[DONE]']);
  const done = list.findIndex((event) =>
    event.type === 'response.output_item.done' && isObject(event.item) && event.item.type === 'reasoning');
  const opened = list.findIndex((event) =>
    event.type === 'response.output_item.added' && isObject(event.item) && event.item.type === 'message');
  expect(done).toBeGreaterThan(-1);
  expect(opened).toBeGreaterThan(done);
});

test('a tool call closes the open text item before its own item opens', () => {
  const list = events([
    chunk({ content: 'x' }),
    chunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'f', arguments: '' } }] }),
    '[DONE]',
  ]);
  const done = list.findIndex((event) =>
    event.type === 'response.output_item.done' && isObject(event.item) && event.item.type === 'message');
  const opened = list.findIndex((event) =>
    event.type === 'response.output_item.added' && isObject(event.item) && event.item.type === 'function_call');
  expect(done).toBeGreaterThan(-1);
  expect(opened).toBeGreaterThan(done);
  const last = list.at(-1);
  expect((last?.response as Json).output).toEqual([
    {
      id: 'msg_0',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'x', annotations: [] }],
    },
    { id: 'fc_0', type: 'function_call', status: 'completed', call_id: 'a', name: 'f', arguments: '' },
  ]);
});

for (const [finish, type, reason] of [
  ['length', 'response.incomplete', 'max_output_tokens'],
  ['content_filter', 'response.incomplete', 'content_filter'],
] as const) {
  test(`finish_reason ${finish} becomes ${type}`, () => {
    const list = events([chunk({ content: 'x' }), chunk({}, finish), usageChunk(), '[DONE]']);
    const last = list.at(-1);
    expect(last?.type).toBe(type);
    expect((last?.response as Json)).toMatchObject({
      status: 'incomplete',
      incomplete_details: { reason },
    });
  });
}

test('a stream cut before [DONE] ends with a completed response', () => {
  const writer = new ResponsesFromChatStreamWriter({ created: 12 });
  writer.push({ event: null, data: JSON.stringify(chunk({ content: 'x' })) });
  const frames = writer.end();
  const parser = new SseParser();
  const parsed = [...parser.push(frames.join('')), ...parser.end()];
  expect(parsed.at(-1)?.event).toBe('response.completed');
});

test('end is idempotent after the terminal event', () => {
  const writer = new ResponsesFromChatStreamWriter({ created: 12 });
  writer.push({ event: null, data: '[DONE]' });
  expect(writer.end()).toEqual([]);
});

test('an upstream error chunk becomes an error event', () => {
  const list = events([{ error: { message: 'boom', type: 'api_error' } }]);
  expect(list).toEqual([{ type: 'error', code: 'api_error', message: 'boom' }]);
});

test('a chunk that is not an object becomes an error event', () => {
  const writer = new ResponsesFromChatStreamWriter({ created: 12 });
  const frames = writer.push({ event: null, data: '[]' });
  const parser = new SseParser();
  const [frame] = parser.push(frames.join(''));
  expect(frame.event).toBe('error');
  expect(JSON.parse(frame.data ?? 'null')).toMatchObject({ type: 'error', message: expect.any(String) });
});

test('the Responses observer reads the emitted stream as preamble, content and the end', () => {
  const writer = new ResponsesFromChatStreamWriter({ created: 12 });
  const frames = [...TEXT].flatMap((value) =>
    writer.push({ event: null, data: value === '[DONE]' ? '[DONE]' : JSON.stringify(value) }));
  frames.push(...writer.end());
  const parser = new SseParser();
  const observer = responses.observe();
  const kinds = [...parser.push(frames.join('')), ...parser.end()].map((frame) => observer.see(frame));
  expect(kinds[0]).toBe('preamble');
  expect(kinds[1]).toBe('preamble');
  expect(kinds.at(-1)).toBe('end');
  expect(kinds.filter((kind) => kind === 'content').length).toBeGreaterThan(0);
  expect(observer.usage()).toEqual({ inputTokens: 8, outputTokens: 4, cacheReadTokens: 2 });
  expect(observer.error()).toBeNull();
});
