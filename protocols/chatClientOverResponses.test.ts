import { expect, test } from 'bun:test';
import { ChatFromResponsesStreamWriter, toChatResponseFromResponses, toResponsesRequest } from './chatClientOverResponses';

type Json = Record<string, unknown>;

const HELLO = [{ role: 'user', content: 'hello' }];

/** The Responses request for a Chat request that says hello, plus `extra`. */
function translated(extra: Json): Json {
  const result = toResponsesRequest({ model: 'm', messages: HELLO, ...extra });
  if ('refused' in result) throw new Error(`refused: ${result.refused.param}: ${result.refused.message}`);
  return result.body;
}

/** The refusal of a Chat request that says hello, plus `extra`. */
function refusal(extra: Json): { message: string; param: string } {
  const result = toResponsesRequest({ model: 'm', messages: HELLO, ...extra });
  if (!('refused' in result)) throw new Error('the request was not refused');
  return result.refused;
}

const input = (messages: unknown[]) => translated({ messages }).input as Json[];

// ---------------------------------------------------------------------------------------
// Request: plain fields

test('model, stream, temperature, top_p and parallel_tool_calls keep their names', () => {
  expect(translated({ stream: true, temperature: 0.5, top_p: 0.25, parallel_tool_calls: false }))
    .toMatchObject({ model: 'm', stream: true, temperature: 0.5, top_p: 0.25, parallel_tool_calls: false });
});

test('user is passed on when it is a string', () => {
  expect(translated({ user: 'u' }).user).toBe('u');
});

test('a non-string user is left out', () => {
  expect('user' in translated({ user: 7 })).toBe(false);
});

test('max_completion_tokens becomes max_output_tokens', () => {
  expect(translated({ max_completion_tokens: 4 }).max_output_tokens).toBe(4);
});

test('max_completion_tokens wins over max_tokens', () => {
  expect(translated({ max_tokens: 3, max_completion_tokens: 4 }).max_output_tokens).toBe(4);
});

test('without a limit from the client no max_output_tokens is sent', () => {
  expect('max_output_tokens' in translated({})).toBe(false);
});

test('a body that is not an object is refused', () => {
  for (const body of [null, 'text', []]) {
    expect(toResponsesRequest(body)).toHaveProperty('refused.param', 'body');
  }
});

test('messages that are not an array are refused', () => {
  expect(refusal({ messages: 'hello' }).param).toBe('messages');
});

test('fields that do not change what the answer means are left out', () => {
  const body = translated({
    n: 1,
    logprobs: false,
    frequency_penalty: 0,
    presence_penalty: 0,
    modalities: ['text'],
    seed: 1,
    metadata: {},
    store: true,
    stream_options: { include_usage: true },
    service_tier: 'auto',
  });
  expect(body).toEqual({
    model: 'm',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
  });
});

// ---------------------------------------------------------------------------------------
// Request: messages

test('system and developer messages become the top-level instructions, in order', () => {
  const body = translated({
    messages: [{ role: 'system', content: 'a' }, ...HELLO, { role: 'developer', content: 'b' }],
  });
  expect(body.instructions).toBe('a\n\nb');
  expect(body.input).toEqual([{ type: 'message', role: 'user', content: 'hello' }]);
});

test('the text parts of one system message are joined with a newline', () => {
  const parts = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
  expect(translated({ messages: [{ role: 'system', content: parts }, ...HELLO] }).instructions).toBe('a\nb');
});

test('without a system message there are no instructions', () => {
  expect('instructions' in translated({})).toBe(false);
});

test('a user message with string content is passed on as a string', () => {
  expect(input(HELLO)).toEqual([{ type: 'message', role: 'user', content: 'hello' }]);
});

test('a text part becomes an input_text part', () => {
  expect(input([{ role: 'user', content: [{ type: 'text', text: 'a' }] }])).toEqual([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] },
  ]);
});

test('an image URL object becomes an input_image part', () => {
  expect(input([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }]))
    .toEqual([{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }],
    }]);
});

test('an image URL string becomes an input_image part', () => {
  expect(input([{ role: 'user', content: [{ type: 'image_url', image_url: 'https://example.test/a.png' }] }]))
    .toEqual([{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'https://example.test/a.png' }],
    }]);
});

for (const type of ['input_audio', 'file', 'something_else']) {
  test(`a content part of type ${type} is refused`, () => {
    expect(refusal({ messages: [{ role: 'user', content: [{ type }] }] })).toEqual({
      param: 'messages.0.content.0.type',
      message: `a content part of type "${type}" cannot be sent to this model's provider`,
    });
  });
}

test('assistant text becomes a message item with output_text', () => {
  expect(input([...HELLO, { role: 'assistant', content: 'hi' }])[1]).toEqual({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'hi' }],
  });
});

test('an empty assistant message writes no item', () => {
  expect(input([...HELLO, { role: 'assistant', content: '' }])).toHaveLength(1);
});

test('an assistant tool call becomes a function_call item', () => {
  const call = { id: 't', type: 'function', function: { name: 'f', arguments: '{"x":1}' } };
  expect(input([...HELLO, { role: 'assistant', content: null, tool_calls: [call] }])[1]).toEqual({
    type: 'function_call',
    call_id: 't',
    name: 'f',
    arguments: '{"x":1}',
  });
});

test('assistant text comes before its tool calls', () => {
  const call = { id: 't', type: 'function', function: { name: 'f', arguments: '{}' } };
  expect(input([...HELLO, { role: 'assistant', content: 'hi', tool_calls: [call] }]).slice(1)).toEqual([
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    { type: 'function_call', call_id: 't', name: 'f', arguments: '{}' },
  ]);
});

test('a tool message becomes a function_call_output item', () => {
  expect(input([{ role: 'tool', tool_call_id: 'a', content: '1' }])).toEqual([
    { type: 'function_call_output', call_id: 'a', output: '1' },
  ]);
});

test('the text parts of a tool message are joined with a newline', () => {
  const parts = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
  expect(input([{ role: 'tool', tool_call_id: 'a', content: parts }])[0].output).toBe('a\nb');
});

test('a tool message without tool_call_id is refused', () => {
  expect(refusal({ messages: [{ role: 'tool', content: '1' }] }).param).toBe('messages.0.tool_call_id');
});

test('a message with an unknown role is refused', () => {
  expect(refusal({ messages: [{ role: 'narrator', content: 'x' }] }).param).toBe('messages.0.role');
});

// ---------------------------------------------------------------------------------------
// Request: tools

const TOOLS = [{
  type: 'function',
  function: { name: 'f', description: 'd', parameters: { type: 'object' }, strict: true },
}];

test('a function tool becomes a flat Responses function tool', () => {
  expect(translated({ tools: TOOLS }).tools).toEqual([
    { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: true },
  ]);
});

test('a function tool without optional fields omits them', () => {
  expect(translated({ tools: [{ type: 'function', function: { name: 'f' } }] }).tools).toEqual([
    { type: 'function', name: 'f' },
  ]);
});

test('a tool that is not a function is refused', () => {
  expect(refusal({ tools: [{ type: 'custom' }] }).param).toBe('tools.0.type');
});

test('a function tool without a name is refused', () => {
  expect(refusal({ tools: [{ type: 'function', function: {} }] }).param).toBe('tools.0.function.name');
});

for (const asked of ['auto', 'none', 'required']) {
  test(`tool_choice ${asked} passes through`, () => {
    expect(translated({ tools: TOOLS, tool_choice: asked }).tool_choice).toBe(asked);
  });
}

test('tool_choice naming a function becomes {type: function, name}', () => {
  const choice = { type: 'function', function: { name: 'f' } };
  expect(translated({ tools: TOOLS, tool_choice: choice }).tool_choice).toEqual({ type: 'function', name: 'f' });
});

test('any other tool_choice is refused', () => {
  expect(refusal({ tools: TOOLS, tool_choice: 'sometimes' }).param).toBe('tool_choice');
});

// ---------------------------------------------------------------------------------------
// Request: reasoning and response format

for (const effort of ['low', 'medium', 'high', 'minimal', 'xhigh']) {
  test(`reasoning_effort ${effort} becomes reasoning.effort`, () => {
    expect(translated({ reasoning_effort: effort }).reasoning).toEqual({ effort });
  });
}

test('an unknown reasoning_effort is refused', () => {
  expect(refusal({ reasoning_effort: 'extreme' }).param).toBe('reasoning_effort');
});

test('response_format text becomes text.format text', () => {
  expect(translated({ response_format: { type: 'text' } }).text).toEqual({ format: { type: 'text' } });
});

test('response_format json_object becomes text.format json_object', () => {
  expect(translated({ response_format: { type: 'json_object' } }).text)
    .toEqual({ format: { type: 'json_object' } });
});

test('response_format json_schema is flattened into text.format', () => {
  const format = {
    type: 'json_schema',
    json_schema: {
      name: 'answer',
      schema: { type: 'object' },
      strict: true,
      description: 'an answer',
    },
  };
  expect(translated({ response_format: format }).text).toEqual({
    format: {
      type: 'json_schema',
      name: 'answer',
      schema: { type: 'object' },
      strict: true,
      description: 'an answer',
    },
  });
});

test('a JSON schema format without a name is refused', () => {
  const format = { type: 'json_schema', json_schema: { schema: {} } };
  expect(refusal({ response_format: format }).param).toBe('response_format.json_schema.name');
});

test('a JSON schema format without a schema is refused', () => {
  const format = { type: 'json_schema', json_schema: { name: 'a' } };
  expect(refusal({ response_format: format }).param).toBe('response_format.json_schema.schema');
});

test('an unknown response format is refused', () => {
  expect(refusal({ response_format: { type: 'xml' } }).param).toBe('response_format.type');
});

// ---------------------------------------------------------------------------------------
// Request: what Responses cannot do

const REFUSED_FIELDS: Record<string, unknown> = {
  n: 2,
  stop: 'x',
  logprobs: true,
  top_logprobs: 1,
  logit_bias: {},
  frequency_penalty: 1,
  presence_penalty: 1,
  audio: {},
  prediction: {},
  modalities: ['text', 'audio'],
};

for (const [name, value] of Object.entries(REFUSED_FIELDS)) {
  test(`${name} = ${JSON.stringify(value)} is refused`, () => {
    expect(refusal({ [name]: value }).param).toBe(name);
  });
}

test('the refusal of n says that only one answer is supported', () => {
  expect(refusal({ n: 2 }).message).toBe('only n = 1 is supported');
});

// ---------------------------------------------------------------------------------------
// Complete response

const USAGE = {
  input_tokens: 10,
  output_tokens: 4,
  input_tokens_details: { cached_tokens: 2 },
};

function upstream(output: unknown[], extra: Json = {}): Json {
  return { id: 'resp_1', object: 'response', model: 'gpt', output, usage: USAGE, ...extra };
}

const answerOf = (output: unknown[]) =>
  (toChatResponseFromResponses(upstream(output), 12).choices as Array<{ message: Json }>)[0].message;

test('the envelope carries the id and model of the response and the given creation time', () => {
  expect(toChatResponseFromResponses(upstream([]), 12)).toMatchObject({
    id: 'resp_1',
    object: 'chat.completion',
    created: 12,
    model: 'gpt',
  });
});

test('a missing id falls back to chatcmpl-', () => {
  const body = upstream([]);
  delete body.id;
  expect(toChatResponseFromResponses(body, 12).id).toBe('chatcmpl-');
});

test('message output_text parts are joined into the content', () => {
  const item = {
    type: 'message',
    content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }],
  };
  expect(answerOf([item])).toEqual({ role: 'assistant', content: 'ab' });
});

test('a refusal part counts as content', () => {
  const item = { type: 'message', content: [{ type: 'refusal', refusal: 'no' }] };
  expect(answerOf([item]).content).toBe('no');
});

test('without text the content is null', () => {
  expect(answerOf([{ type: 'message', content: [] }]).content).toBeNull();
});

test('reasoning summary parts become reasoning_content', () => {
  const item = { type: 'reasoning', summary: [{ type: 'summary_text', text: 'a' }, { type: 'summary_text', text: 'b' }] };
  expect(answerOf([item]).reasoning_content).toBe('ab');
});

test('reasoning content parts are used when there is no summary', () => {
  const item = { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'deep' }] };
  expect(answerOf([item]).reasoning_content).toBe('deep');
});

test('a function_call item becomes a tool call with its arguments as JSON text', () => {
  const item = { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'f', arguments: '{"x":1}' };
  expect(answerOf([item]).tool_calls).toEqual([
    { id: 'call_a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
  ]);
});

test('a function_call without a call_id uses the item id', () => {
  const item = { type: 'function_call', id: 'fc_1', name: 'f', arguments: '{}' };
  expect(answerOf([item]).tool_calls).toEqual([
    { id: 'fc_1', type: 'function', function: { name: 'f', arguments: '{}' } },
  ]);
});

for (const [extra, finish] of [
  [{ status: 'completed' }, 'stop'],
  [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'length'],
  [{ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'content_filter'],
  [{ status: 'incomplete', incomplete_details: { reason: 'something' } }, 'length'],
] as const) {
  test(`status ${JSON.stringify(extra)} becomes finish_reason ${finish}`, () => {
    const body = toChatResponseFromResponses(upstream([], extra), 12);
    expect(body).toHaveProperty('choices.0.finish_reason', finish);
  });
}

test('a function call makes finish_reason tool_calls', () => {
  const item = { type: 'function_call', call_id: 'a', name: 'f', arguments: '{}' };
  expect(toChatResponseFromResponses(upstream([item]), 12)).toHaveProperty('choices.0.finish_reason', 'tool_calls');
});

test('usage maps to prompt, completion and total tokens with cached input detailed', () => {
  expect(toChatResponseFromResponses(upstream([]), 12).usage).toEqual({
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 2 },
  });
});

test('without cached input there is no prompt_tokens_details', () => {
  const body = upstream([], { usage: { input_tokens: 10, output_tokens: 4 } });
  expect(toChatResponseFromResponses(body, 12).usage).toEqual({
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
  });
});

test('a body that is not a response throws', () => {
  expect(() => toChatResponseFromResponses({}, 12)).toThrow('not a response');
});

test('a function_call without arguments throws', () => {
  const item = { type: 'function_call', call_id: 'a', name: 'f' };
  expect(() => toChatResponseFromResponses(upstream([item]), 12)).toThrow('arguments');
});

// ---------------------------------------------------------------------------------------
// Stream

interface Event {
  type: string;
  [key: string]: unknown;
}

const CREATED: Event = {
  type: 'response.created',
  response: { id: 'resp_1', object: 'response', model: 'gpt', status: 'in_progress' },
};
const IN_PROGRESS: Event = { type: 'response.in_progress', response: { id: 'resp_1', status: 'in_progress' } };
const usage = { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } };

const messageAdded = (id = 'msg_1'): Event => ({
  type: 'response.output_item.added',
  output_index: 0,
  item: { id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
});
const partAdded = (id = 'msg_1'): Event => ({
  type: 'response.content_part.added',
  item_id: id,
  output_index: 0,
  content_index: 0,
  part: { type: 'output_text', text: '', annotations: [] },
});
const textDelta = (delta: string, id = 'msg_1'): Event => ({
  type: 'response.output_text.delta',
  item_id: id,
  output_index: 0,
  content_index: 0,
  delta,
});
const textDone = (text: string, id = 'msg_1'): Event => ({
  type: 'response.output_text.done',
  item_id: id,
  output_index: 0,
  content_index: 0,
  text,
});
const reasoningDelta = (delta: string, id = 'rs_1'): Event => ({
  type: 'response.reasoning_summary_text.delta',
  item_id: id,
  output_index: 0,
  summary_index: 0,
  delta,
});
const callAdded = (id: string, callId: string, outputIndex = 0): Event => ({
  type: 'response.output_item.added',
  output_index: outputIndex,
  item: { id, type: 'function_call', status: 'in_progress', call_id: callId, name: 'f', arguments: '' },
});
const argsDelta = (delta: string, id: string, outputIndex = 0): Event => ({
  type: 'response.function_call_arguments.delta',
  item_id: id,
  output_index: outputIndex,
  delta,
});
const completed = (extra: Json = {}): Event => ({
  type: 'response.completed',
  response: { id: 'resp_1', model: 'gpt', status: 'completed', usage, ...extra },
});
const incomplete = (reason: string): Event => ({
  type: 'response.incomplete',
  response: { id: 'resp_1', model: 'gpt', status: 'incomplete', incomplete_details: { reason }, usage },
});

/** What the client receives for an upstream stream of `events`, parsed; `[DONE]` stays a string. */
function written(events: Event[], includeUsage = false): Array<Json | '[DONE]'> {
  const writer = new ChatFromResponsesStreamWriter({ created: 12, includeUsage });
  const frames = events.flatMap((event) => writer.push({ event: event.type, data: JSON.stringify(event) }));
  frames.push(...writer.end());
  const parsed = frames.map((frame) => {
    expect(frame.startsWith('data: ') && frame.endsWith('\n\n')).toBe(true);
    return frame === 'data: [DONE]\n\n' ? '[DONE]' as const : JSON.parse(frame.slice(6)) as Json;
  });
  expectWellFormed(parsed);
  return parsed;
}

/** A Chat stream: at most one finish reason, then an optional usage chunk, then [DONE]. */
function expectWellFormed(frames: Array<Json | '[DONE]'>): void {
  const last = frames[frames.length - 1];
  const chunks = frames.filter((frame): frame is Json => frame !== '[DONE]' && !('error' in frame));
  for (const chunk of chunks) {
    expect(chunk).toMatchObject({ id: expect.any(String), object: 'chat.completion.chunk', created: 12 });
  }
  const finished = chunks.filter((chunk) => (chunk.choices as Json[])[0]?.finish_reason != null);
  if (last === '[DONE]') {
    expect(finished).toHaveLength(1);
    expect(frames.indexOf('[DONE]')).toBe(frames.length - 1);
    for (const chunk of chunks.filter((value) => 'usage' in value)) {
      expect(chunk.choices).toEqual([]);
      expect(frames.indexOf(chunk)).toBeGreaterThan(frames.indexOf(finished[0]));
    }
  } else {
    expect(last).toHaveProperty('error.message');
    expect(finished).toHaveLength(0);
  }
}

const deltas = (frames: Array<Json | '[DONE]'>) =>
  frames.flatMap((frame) => (frame === '[DONE]' || !Array.isArray(frame.choices) ? [] : frame.choices))
    .map((choice) => (choice as Json).delta);

const TEXT_ONLY = [CREATED, IN_PROGRESS, messageAdded(), partAdded(), textDelta('he'), textDelta('llo'),
  textDone('hello'), completed()];

test('response.created and response.in_progress write nothing', () => {
  const writer = new ChatFromResponsesStreamWriter({ created: 12, includeUsage: false });
  expect(writer.push({ event: CREATED.type, data: JSON.stringify(CREATED) })).toEqual([]);
  expect(writer.push({ event: IN_PROGRESS.type, data: JSON.stringify(IN_PROGRESS) })).toEqual([]);
});

test('the first text delta carries the assistant role and the content', () => {
  expect(deltas(written(TEXT_ONLY)).slice(0, 2)).toEqual([
    { role: 'assistant', content: 'he' },
    { content: 'llo' },
  ]);
});

test('the output of a text-only stream is the role, the deltas and the finish reason', () => {
  expect(deltas(written(TEXT_ONLY))).toEqual([
    { role: 'assistant', content: 'he' },
    { content: 'llo' },
    {},
  ]);
});

test('response.completed writes finish_reason stop and then [DONE]', () => {
  const frames = written(TEXT_ONLY);
  expect(frames[2]).toHaveProperty('choices.0.finish_reason', 'stop');
  expect(frames[3]).toBe('[DONE]');
});

test('with includeUsage, a usage chunk follows the finish reason', () => {
  const frames = written(TEXT_ONLY, true);
  expect(frames[3]).toMatchObject({
    choices: [],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      prompt_tokens_details: { cached_tokens: 2 },
    },
  });
  expect(frames[4]).toBe('[DONE]');
});

test('without includeUsage no usage chunk is written', () => {
  expect(written(TEXT_ONLY).some((frame) => frame !== '[DONE]' && 'usage' in frame)).toBe(false);
});

test('a reasoning summary delta becomes reasoning_content', () => {
  const frames = written([CREATED, reasoningDelta('hm'), completed()]);
  expect(deltas(frames)).toEqual([{ role: 'assistant', reasoning_content: 'hm' }, {}]);
});

test('the start of a function call becomes a tool call with its id, name and empty arguments', () => {
  const frames = written([CREATED, callAdded('fc_1', 'call_a'), completed()]);
  expect(deltas(frames)[0]).toEqual({
    role: 'assistant',
    tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'f', arguments: '' } }],
  });
});

test('an argument delta addressed only by output_index finds its function call', () => {
  const frames = written([
    CREATED,
    callAdded('fc_1', 'call_a'),
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
    completed(),
  ]);
  expect(deltas(frames)[1]).toEqual({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] });
});

test('argument deltas are numbered by their function call', () => {
  const frames = written([
    CREATED,
    callAdded('fc_1', 'call_a'),
    argsDelta('{"x":', 'fc_1'),
    argsDelta('1}', 'fc_1'),
    callAdded('fc_2', 'call_b', 1),
    argsDelta('{}', 'fc_2', 1),
    completed(),
  ]);
  expect(deltas(frames)).toEqual([
    { role: 'assistant', tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'f', arguments: '' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
    { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'f', arguments: '' } }] },
    { tool_calls: [{ index: 1, function: { arguments: '{}' } }] },
    {},
  ]);
});

test('the argument fragments of each tool call add up to the JSON the upstream wrote', () => {
  const frames = written([
    CREATED,
    callAdded('fc_1', 'call_a'),
    argsDelta('{"x":', 'fc_1'),
    argsDelta('1}', 'fc_1'),
    callAdded('fc_2', 'call_b', 1),
    argsDelta('{}', 'fc_2', 1),
    completed(),
  ]);
  const args = ['', ''];
  for (const value of deltas(frames)) {
    for (const call of ((value as Json).tool_calls as Array<{ index: number; function: Json }> | undefined) ?? []) {
      args[call.index] += call.function.arguments;
    }
  }
  expect(args).toEqual(['{"x":1}', '{}']);
});

test('tool calls make finish_reason tool_calls', () => {
  const frames = written([CREATED, callAdded('fc_1', 'call_a'), completed()]);
  expect(frames[frames.length - 2]).toHaveProperty('choices.0.finish_reason', 'tool_calls');
});

test('response.incomplete with max_output_tokens becomes finish_reason length', () => {
  const frames = written([CREATED, textDelta('x'), incomplete('max_output_tokens')]);
  expect(frames[frames.length - 2]).toHaveProperty('choices.0.finish_reason', 'length');
});

test('response.incomplete with content_filter becomes finish_reason content_filter', () => {
  const frames = written([CREATED, textDelta('x'), incomplete('content_filter')]);
  expect(frames[frames.length - 2]).toHaveProperty('choices.0.finish_reason', 'content_filter');
});

test('a stream cut before the terminal event still ends with a finish reason and [DONE]', () => {
  const frames = written([CREATED, textDelta('x')]);
  expect(frames[frames.length - 2]).toHaveProperty('choices.0.finish_reason', 'stop');
  expect(frames[frames.length - 1]).toBe('[DONE]');
});

test('a cut stream with a tool call finishes with tool_calls', () => {
  const frames = written([CREATED, callAdded('fc_1', 'call_a')]);
  expect(frames[frames.length - 2]).toHaveProperty('choices.0.finish_reason', 'tool_calls');
});

test('an error event becomes an error frame and ends the stream', () => {
  const error: Event = { type: 'error', code: 'server_error', message: 'busy' };
  expect(written([CREATED, error, textDelta('late')])).toEqual([
    { error: { message: 'busy', type: 'api_error' } },
  ]);
});

test('response.failed reports the error inside the response object', () => {
  const failed: Event = {
    type: 'response.failed',
    response: { id: 'resp_1', status: 'failed', error: { code: 'server_error', message: 'boom' } },
  };
  expect(written([CREATED, failed])).toEqual([{ error: { message: 'boom', type: 'api_error' } }]);
});

test('a frame that is not a JSON object is an error', () => {
  const writer = new ChatFromResponsesStreamWriter({ created: 12, includeUsage: false });
  const frames = writer.push({ event: null, data: '[]' });
  expect(frames).toHaveLength(1);
  expect(JSON.parse(frames[0].slice('data: '.length))).toEqual({
    error: { message: expect.any(String), type: 'api_error' },
  });
});

test('a frame without data writes nothing', () => {
  expect(new ChatFromResponsesStreamWriter({ created: 12, includeUsage: false }).push({ event: null, data: null }))
    .toEqual([]);
});

test('the event name of the SSE block is used when the data carries no type', () => {
  const writer = new ChatFromResponsesStreamWriter({ created: 12, includeUsage: false });
  writer.push({ event: 'response.created', data: JSON.stringify({ response: { id: 'r', model: 'm' } }) });
  const frames = writer.push({ event: 'response.completed', data: JSON.stringify({ response: { usage } }) });
  expect(JSON.parse(frames[0].slice('data: '.length))).toMatchObject({ id: 'r', model: 'm' });
  expect(frames[frames.length - 1]).toBe('data: [DONE]\n\n');
});

test('[DONE] finishes the stream', () => {
  const writer = new ChatFromResponsesStreamWriter({ created: 12, includeUsage: false });
  const frames = writer.push({ event: null, data: '[DONE]' });
  expect(JSON.parse(frames[0].slice('data: '.length))).toMatchObject({
    choices: [expect.objectContaining({ delta: { role: 'assistant' } })],
  });
  expect(frames[frames.length - 1]).toBe('data: [DONE]\n\n');
});

test('end is idempotent after the terminal event', () => {
  const writer = new ChatFromResponsesStreamWriter({ created: 12, includeUsage: false });
  writer.push({ event: 'response.created', data: JSON.stringify(CREATED) });
  writer.push({ event: 'response.completed', data: JSON.stringify(completed()) });
  expect(writer.end()).toEqual([]);
});
