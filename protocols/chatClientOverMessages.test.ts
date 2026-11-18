import { expect, test } from 'bun:test';
import { ChatStreamWriter, toChatResponse, toMessagesRequest } from './chatClientOverMessages';

type Json = Record<string, unknown>;

const DEFAULT_LIMIT = 50;
const HELLO = [{ role: 'user', content: 'hello' }];

/** The Messages request for a Chat request that says hello, plus `extra`. */
function translated(extra: Json): Json {
  const result = toMessagesRequest({ model: 'm', messages: HELLO, ...extra }, DEFAULT_LIMIT);
  if ('refused' in result) throw new Error(`refused: ${result.refused.param}: ${result.refused.message}`);
  return result.body;
}

/** The refusal of a Chat request that says hello, plus `extra`. */
function refusal(extra: Json): { message: string; param: string } {
  const result = toMessagesRequest({ model: 'm', messages: HELLO, ...extra }, DEFAULT_LIMIT);
  if (!('refused' in result)) throw new Error('the request was not refused');
  return result.refused;
}

const turns = (messages: unknown[]) => translated({ messages }).messages as Json[];

// ---------------------------------------------------------------------------------------
// Request: plain fields

test('model, stream and top_p keep their names', () => {
  expect(translated({ stream: true, top_p: 0.5 })).toMatchObject({ model: 'm', stream: true, top_p: 0.5 });
});

test('a temperature within 0–1 is passed on', () => {
  expect(translated({ temperature: 0.7 }).temperature).toBe(0.7);
});

test('a temperature above 1 is refused, not clamped', () => {
  expect(refusal({ temperature: 1.1 })).toEqual({
    param: 'temperature',
    message: "a temperature outside 0–1 cannot be sent to this model's provider",
  });
});

test('without a limit from the client, max_tokens is the limit given by the caller', () => {
  expect(translated({}).max_tokens).toBe(DEFAULT_LIMIT);
});

test('max_tokens of the client is used', () => {
  expect(translated({ max_tokens: 3 }).max_tokens).toBe(3);
});

test('max_completion_tokens wins over max_tokens', () => {
  expect(translated({ max_tokens: 3, max_completion_tokens: 4 }).max_tokens).toBe(4);
});

test('a single stop string becomes a list of stop sequences', () => {
  expect(translated({ stop: 'x' }).stop_sequences).toEqual(['x']);
});

test('a list of stop strings is passed on', () => {
  expect(translated({ stop: ['a', 'b'] }).stop_sequences).toEqual(['a', 'b']);
});

test('user becomes metadata.user_id', () => {
  expect(translated({ user: 'u' }).metadata).toEqual({ user_id: 'u' });
});

test('fields that do not change what the answer means are left out', () => {
  const body = translated({
    n: 1,
    logprobs: false,
    frequency_penalty: 0,
    presence_penalty: 0,
    response_format: { type: 'text' },
    modalities: ['text'],
    seed: 1,
    metadata: {},
    store: true,
    stream_options: { include_usage: true },
    service_tier: 'auto',
    reasoning_effort: 'low',
    some_unknown_field: 1,
  });
  expect(body).toEqual({ model: 'm', messages: HELLO, max_tokens: DEFAULT_LIMIT });
});

// ---------------------------------------------------------------------------------------
// Request: messages

test('system and developer messages become the top-level system text, in order', () => {
  const body = translated({
    messages: [{ role: 'system', content: 'a' }, ...HELLO, { role: 'developer', content: 'b' }],
  });
  expect(body.system).toBe('a\n\nb');
  expect(body.messages).toEqual(HELLO);
});

test('the text parts of one system message are joined with a newline', () => {
  const parts = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
  expect(translated({ messages: [{ role: 'system', content: parts }, ...HELLO] }).system).toBe('a\nb');
});

test('without a system message there is no system field', () => {
  expect('system' in translated({})).toBe(false);
});

test('a user message with string content is passed on as a string', () => {
  expect(turns(HELLO)).toEqual([{ role: 'user', content: 'hello' }]);
});

test('a text part becomes a text block', () => {
  expect(turns([{ role: 'user', content: [{ type: 'text', text: 'a' }] }])).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
  ]);
});

test('an image given as a base64 data URL becomes a base64 image block', () => {
  const part = { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } };
  expect(turns([{ role: 'user', content: [part] }])).toEqual([
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }] },
  ]);
});

test('an image given as an http URL becomes a URL image block', () => {
  const part = { type: 'image_url', image_url: { url: 'https://example.test/a.png' } };
  expect(turns([{ role: 'user', content: [part] }])).toEqual([
    { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }] },
  ]);
});

test('an image URL that is neither is refused', () => {
  const part = { type: 'image_url', image_url: { url: 'file:///etc/passwd' } };
  expect(refusal({ messages: [{ role: 'user', content: [part] }] }).param).toBe('messages.0.content.0.image_url.url');
});

for (const type of ['input_audio', 'file', 'something_else']) {
  test(`a content part of type ${type} is refused`, () => {
    expect(refusal({ messages: [{ role: 'user', content: [{ type }] }] })).toEqual({
      param: 'messages.0.content.0.type',
      message: `a content part of type "${type}" cannot be sent to this model's provider`,
    });
  });
}

test('assistant text becomes a text block', () => {
  expect(turns([...HELLO, { role: 'assistant', content: 'hi' }])[1]).toEqual({
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
  });
});

test('assistant text parts are joined into one text block', () => {
  const parts = [{ type: 'text', text: 'h' }, { type: 'text', text: 'i' }];
  expect(turns([...HELLO, { role: 'assistant', content: parts }])[1]).toEqual({
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
  });
});

test('an assistant tool call becomes a tool_use block with its arguments parsed', () => {
  const call = { id: 't', type: 'function', function: { name: 'f', arguments: '{"x":1}' } };
  expect(turns([...HELLO, { role: 'assistant', content: null, tool_calls: [call] }])[1]).toEqual({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't', name: 'f', input: { x: 1 } }],
  });
});

test('assistant text comes before its tool calls', () => {
  const call = { id: 't', type: 'function', function: { name: 'f', arguments: '{}' } };
  expect(turns([...HELLO, { role: 'assistant', content: 'hi', tool_calls: [call] }])[1]).toEqual({
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't', name: 'f', input: {} }],
  });
});

test('the reasoning_content of an assistant message is left out', () => {
  const message = { role: 'assistant', content: 'hi', reasoning_content: 'because' };
  expect(turns([...HELLO, message])[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] });
});

for (const args of ['[]', 'null', 'not json', '7']) {
  test(`tool call arguments ${args} are refused: they are not a JSON object`, () => {
    const call = { id: 't', type: 'function', function: { name: 'f', arguments: args } };
    expect(refusal({ messages: [...HELLO, { role: 'assistant', tool_calls: [call] }] })).toEqual({
      param: 'messages.1.tool_calls.0.function.arguments',
      message: 'expected the text of a JSON object',
    });
  });
}

test('a tool call without an id is refused', () => {
  const call = { type: 'function', function: { name: 'f', arguments: '{}' } };
  expect(refusal({ messages: [...HELLO, { role: 'assistant', tool_calls: [call] }] }).param)
    .toBe('messages.1.tool_calls.0.id');
});

test('a tool call without a function name is refused', () => {
  const call = { id: 't', type: 'function', function: { arguments: '{}' } };
  expect(refusal({ messages: [...HELLO, { role: 'assistant', tool_calls: [call] }] }).param)
    .toBe('messages.1.tool_calls.0.function.name');
});

test('a tool message becomes a tool_result block in a user turn', () => {
  expect(turns([{ role: 'tool', tool_call_id: 'a', content: '1' }])).toEqual([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '1' }] },
  ]);
});

test('the text parts of a tool message are joined with a newline', () => {
  const parts = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
  expect(turns([{ role: 'tool', tool_call_id: 'a', content: parts }])).toEqual([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'a\nb' }] },
  ]);
});

test('a tool message without tool_call_id is refused', () => {
  expect(refusal({ messages: [{ role: 'tool', content: '1' }] }).param).toBe('messages.0.tool_call_id');
});

test('consecutive tool messages go into one user turn', () => {
  const results = [
    { role: 'tool', tool_call_id: 'a', content: '1' },
    { role: 'tool', tool_call_id: 'b', content: '2' },
  ];
  expect(turns(results)).toEqual([
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: '1' },
        { type: 'tool_result', tool_use_id: 'b', content: '2' },
      ],
    },
  ]);
});

test('a user message right after tool messages joins their turn, after the results', () => {
  const messages = [{ role: 'tool', tool_call_id: 'a', content: '1' }, { role: 'user', content: 'next' }];
  expect(turns(messages)).toEqual([
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a', content: '1' }, { type: 'text', text: 'next' }],
    },
  ]);
});

test('a second user message does not join the turn of the tool results', () => {
  const messages = [
    { role: 'tool', tool_call_id: 'a', content: '1' },
    { role: 'user', content: 'next' },
    { role: 'user', content: 'more' },
  ];
  expect(turns(messages)).toHaveLength(2);
});

test('tool messages after an assistant turn start a new user turn', () => {
  const call = { id: 'b', type: 'function', function: { name: 'f', arguments: '{}' } };
  const messages = [
    { role: 'tool', tool_call_id: 'a', content: '1' },
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', tool_call_id: 'b', content: '2' },
  ];
  expect(turns(messages).map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
});

test('a message with an unknown role is refused', () => {
  expect(refusal({ messages: [{ role: 'narrator', content: 'x' }] }).param).toBe('messages.0.role');
});

test('a body that is not an object is refused', () => {
  for (const body of [null, 'text', []]) {
    expect(toMessagesRequest(body, DEFAULT_LIMIT)).toHaveProperty('refused.param', 'body');
  }
});

test('messages that are not an array are refused', () => {
  expect(refusal({ messages: 'hello' }).param).toBe('messages');
});

test('an empty list of messages is refused', () => {
  expect(refusal({ messages: [] }).param).toBe('messages');
});

// ---------------------------------------------------------------------------------------
// Request: tools

const TOOLS = [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }];

test('a function tool becomes a Messages tool with its schema as input_schema', () => {
  expect(translated({ tools: TOOLS }).tools).toEqual([
    { name: 'f', description: 'd', input_schema: { type: 'object' } },
  ]);
});

test('a function tool without parameters gets an empty object schema', () => {
  expect(translated({ tools: [{ type: 'function', function: { name: 'f' } }] }).tools).toEqual([
    { name: 'f', input_schema: { type: 'object', properties: {} } },
  ]);
});

test('a tool that is not a function is refused', () => {
  expect(refusal({ tools: [{ type: 'custom' }] }).param).toBe('tools.0.type');
});

test('a function tool without a name is refused', () => {
  expect(refusal({ tools: [{ type: 'function', function: {} }] }).param).toBe('tools.0.function.name');
});

for (const [asked, type] of [['auto', 'auto'], ['required', 'any'], ['none', 'none']]) {
  test(`tool_choice ${asked} becomes {type: ${type}}`, () => {
    expect(translated({ tools: TOOLS, tool_choice: asked }).tool_choice).toEqual({ type });
  });
}

test('tool_choice naming a function becomes {type: tool, name}', () => {
  const choice = { type: 'function', function: { name: 'f' } };
  expect(translated({ tools: TOOLS, tool_choice: choice }).tool_choice).toEqual({ type: 'tool', name: 'f' });
});

test('any other tool_choice is refused', () => {
  expect(refusal({ tools: TOOLS, tool_choice: 'sometimes' }).param).toBe('tool_choice');
});

test('without tool_choice there is no tool_choice', () => {
  expect('tool_choice' in translated({ tools: TOOLS })).toBe(false);
});

test('parallel_tool_calls false is added to the tool choice the client gave', () => {
  expect(translated({ tools: TOOLS, tool_choice: 'required', parallel_tool_calls: false }).tool_choice).toEqual({
    type: 'any',
    disable_parallel_tool_use: true,
  });
});

test('parallel_tool_calls false with tools and no tool_choice creates an auto choice', () => {
  expect(translated({ tools: TOOLS, parallel_tool_calls: false }).tool_choice).toEqual({
    type: 'auto',
    disable_parallel_tool_use: true,
  });
});

test('parallel_tool_calls false without tools adds nothing', () => {
  expect('tool_choice' in translated({ parallel_tool_calls: false })).toBe(false);
});

// ---------------------------------------------------------------------------------------
// Request: what Messages cannot do

const REFUSED_FIELDS: Record<string, unknown> = {
  n: 2,
  response_format: { type: 'json_object' },
  logprobs: true,
  top_logprobs: 1,
  logit_bias: {},
  frequency_penalty: 1,
  presence_penalty: 1,
  audio: {},
  modalities: ['text', 'audio'],
  prediction: {},
  temperature: -0.1,
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

const USAGE = { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 };

function upstreamMessage(content: unknown[], extra: Json = {}): Json {
  return { type: 'message', id: 'msg_1', model: 'claude', content, stop_reason: 'end_turn', usage: USAGE, ...extra };
}

const answerOf = (content: unknown[]) =>
  (toChatResponse(upstreamMessage(content), 12).choices as Array<{ message: Json }>)[0].message;

test('the envelope carries the id and model of the message and the given creation time', () => {
  expect(toChatResponse(upstreamMessage([]), 12)).toMatchObject({
    id: 'msg_1',
    object: 'chat.completion',
    created: 12,
    model: 'claude',
  });
});

test('text blocks are joined into the content', () => {
  expect(answerOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toEqual({
    role: 'assistant',
    content: 'ab',
  });
});

test('without a text block the content is null', () => {
  expect(answerOf([]).content).toBeNull();
});

test('thinking blocks become reasoning_content', () => {
  expect(answerOf([{ type: 'thinking', thinking: 'h', signature: 's' }]).reasoning_content).toBe('h');
});

test('a tool_use block becomes a tool call with its input as JSON text', () => {
  expect(answerOf([{ type: 'tool_use', id: 't', name: 'f', input: { x: 1 } }]).tool_calls).toEqual([
    { id: 't', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
  ]);
});

for (const [stop, finish] of [
  ['end_turn', 'stop'],
  ['stop_sequence', 'stop'],
  ['max_tokens', 'length'],
  ['tool_use', 'tool_calls'],
  ['pause_turn', 'stop'],
]) {
  test(`stop_reason ${stop} becomes finish_reason ${finish}`, () => {
    expect(toChatResponse(upstreamMessage([], { stop_reason: stop }), 12)).toHaveProperty('choices.0.finish_reason', finish);
  });
}

test('prompt_tokens is uncached input plus cache read plus cache write', () => {
  // The Chat usage keeps the cache-write detail the Chat protocol defines; gateway accounting
  // counts those tokens as input instead.
  expect(toChatResponse(upstreamMessage([]), 12).usage).toEqual({
    prompt_tokens: 15,
    completion_tokens: 4,
    total_tokens: 19,
    prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
  });
});

test('a body that is not a message throws', () => {
  expect(() => toChatResponse({ type: 'error', error: { message: 'no' } }, 12)).toThrow('not a message');
});

for (const [missing, block] of Object.entries({
  id: { type: 'tool_use', name: 'f', input: {} },
  name: { type: 'tool_use', id: 't', input: {} },
  'object input': { type: 'tool_use', id: 't', name: 'f', input: [] },
})) {
  test(`a tool_use block without ${missing} throws`, () => {
    expect(() => toChatResponse(upstreamMessage([block]), 12)).toThrow('tool_use');
  });
}

// ---------------------------------------------------------------------------------------
// Stream

interface Event {
  type: string;
  [key: string]: unknown;
}

const START: Event = {
  type: 'message_start',
  message: { id: 'msg_1', model: 'claude', usage: { ...USAGE, output_tokens: 1 } },
};
const STOP: Event = { type: 'message_stop' };
const PING: Event = { type: 'ping' };
const DONE = 'data: [DONE]\n\n';

const blockStart = (index: number, block: Json): Event => ({ type: 'content_block_start', index, content_block: block });
const blockStop = (index: number): Event => ({ type: 'content_block_stop', index });
const delta = (index: number, value: Json): Event => ({ type: 'content_block_delta', index, delta: value });
const text = (index: number, value: string) => delta(index, { type: 'text_delta', text: value });
const json = (index: number, value: string) => delta(index, { type: 'input_json_delta', partial_json: value });
const toolUse = (index: number, id: string) => blockStart(index, { type: 'tool_use', id, name: 'f', input: {} });
const messageDelta = (stop: string | null, usage?: Json): Event => ({
  type: 'message_delta',
  delta: { stop_reason: stop },
  ...(usage ? { usage } : {}),
});

/** What the client receives for an upstream stream of `events`, parsed; `[DONE]` stays a string. */
function written(events: Event[], includeUsage = false): Array<Json | '[DONE]'> {
  const writer = new ChatStreamWriter({ created: 12, includeUsage });
  const frames = events.flatMap((event) => writer.push({ event: event.type, data: JSON.stringify(event) }));
  frames.push(...writer.end());
  const parsed = frames.map((frame) => {
    expect(frame.startsWith('data: ') && frame.endsWith('\n\n')).toBe(true);
    return frame === DONE ? '[DONE]' as const : JSON.parse(frame.slice(6)) as Json;
  });
  expectWellFormed(parsed);
  return parsed;
}

/** A Chat stream: the role first, one finish reason, usage after it, then [DONE] — or an error last. */
function expectWellFormed(frames: Array<Json | '[DONE]'>): void {
  const last = frames[frames.length - 1];
  const chunks = frames.filter((frame): frame is Json => frame !== '[DONE]' && !('error' in frame));
  for (const chunk of chunks) {
    expect(chunk).toMatchObject({ id: 'msg_1', object: 'chat.completion.chunk', created: 12, model: 'claude' });
  }
  if (chunks.length > 0) expect(chunks[0]).toHaveProperty('choices.0.delta.role', 'assistant');
  const finished = chunks.filter((chunk) => (chunk.choices as Json[])[0]?.finish_reason != null);
  if (last === '[DONE]') {
    expect(finished).toHaveLength(1);
    expect(frames.indexOf('[DONE]')).toBe(frames.length - 1);
    const usage = chunks.filter((chunk) => 'usage' in chunk);
    for (const chunk of usage) {
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

const TEXT_ONLY = [START, PING, blockStart(0, { type: 'text', text: '' }), text(0, 'he'), text(0, 'llo'),
  blockStop(0), messageDelta('end_turn', { output_tokens: 4 }), STOP];

test('message_start becomes the chunk that carries the role', () => {
  expect(deltas(written(TEXT_ONLY))[0]).toEqual({ role: 'assistant', content: '' });
});

test('a text delta becomes a content delta', () => {
  expect(deltas(written(TEXT_ONLY)).slice(1, 3)).toEqual([{ content: 'he' }, { content: 'llo' }]);
});

test('ping, the start and the stop of a text block write nothing', () => {
  expect(written(TEXT_ONLY)).toHaveLength(5);
});

test('message_stop writes the finish reason and then [DONE]', () => {
  const frames = written(TEXT_ONLY);
  expect(frames[3]).toHaveProperty('choices.0.finish_reason', 'stop');
  expect(frames[3]).toHaveProperty('choices.0.delta', {});
  expect(frames[4]).toBe('[DONE]');
});

test('a thinking delta becomes reasoning_content; its signature writes nothing', () => {
  const frames = written([
    START,
    blockStart(0, { type: 'thinking', thinking: '' }),
    delta(0, { type: 'thinking_delta', thinking: 'hm' }),
    delta(0, { type: 'signature_delta', signature: 'sig' }),
    blockStop(0),
    blockStart(1, { type: 'text', text: '' }),
    text(1, 'ok'),
    blockStop(1),
    messageDelta('end_turn'),
    STOP,
  ]);
  expect(deltas(frames)).toEqual([{ role: 'assistant', content: '' }, { reasoning_content: 'hm' }, { content: 'ok' }, {}]);
});

const TWO_TOOLS = [
  START,
  blockStart(0, { type: 'text', text: '' }),
  text(0, 'x'),
  blockStop(0),
  toolUse(1, 'call_a'),
  json(1, '{"x":'),
  json(1, '1}'),
  blockStop(1),
  toolUse(2, 'call_b'),
  json(2, '{"y":2}'),
  blockStop(2),
  messageDelta('tool_use'),
  STOP,
];

test('the start of a tool_use block becomes a tool call with its id, name and empty arguments', () => {
  expect(deltas(written(TWO_TOOLS))[2]).toEqual({
    tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'f', arguments: '' } }],
  });
});

test('tool calls are numbered from 0 among themselves, not by their block index', () => {
  const indexes = deltas(written(TWO_TOOLS))
    .flatMap((value) => ((value as Json).tool_calls as Json[] | undefined) ?? [])
    .map((call) => call.index);
  expect(indexes).toEqual([0, 0, 0, 1, 1]);
});

test('the argument fragments of each tool call add up to the JSON the upstream wrote', () => {
  const args = ['', ''];
  for (const value of deltas(written(TWO_TOOLS))) {
    for (const call of ((value as Json).tool_calls as Array<{ index: number; function: Json }> | undefined) ?? []) {
      args[call.index] += call.function.arguments;
    }
  }
  expect(args).toEqual(['{"x":1}', '{"y":2}']);
});

test('stop_reason tool_use becomes finish_reason tool_calls', () => {
  const frames = written(TWO_TOOLS);
  expect(frames[frames.length - 2]).toHaveProperty('choices.0.finish_reason', 'tool_calls');
});

test('with includeUsage, a usage chunk with no choices follows the finish reason', () => {
  const frames = written(TEXT_ONLY, true);
  expect(frames[4]).toMatchObject({ choices: [], usage: { completion_tokens: 4 } });
  expect(frames[5]).toBe('[DONE]');
});

test('without includeUsage no usage chunk is written', () => {
  expect(written(TEXT_ONLY).some((frame) => frame !== '[DONE]' && 'usage' in frame)).toBe(false);
});

test('each usage report replaces the counters it carries: the last message_delta wins', () => {
  const frames = written([START, messageDelta(null, { output_tokens: 2 }), messageDelta('max_tokens', { output_tokens: 4 }),
    STOP], true);
  expect(frames[2]).toHaveProperty('usage', {
    prompt_tokens: 15,
    completion_tokens: 4,
    total_tokens: 19,
    prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
  });
});

test('an error event becomes an error frame with its message and type, and ends the stream', () => {
  const error: Event = { type: 'error', error: { type: 'overloaded_error', message: 'busy' } };
  expect(written([START, error, text(0, 'late'), STOP])).toEqual([
    expect.objectContaining({ choices: [expect.objectContaining({ delta: { role: 'assistant', content: '' } })] }),
    { error: { message: 'busy', type: 'overloaded_error' } },
  ]);
});

test('a stream cut before message_stop ends with an error, not with [DONE]', () => {
  const frames = written([START, blockStart(0, { type: 'text', text: '' }), text(0, 'x')]);
  expect(frames[frames.length - 1]).toHaveProperty('error.type', 'api_error');
  expect(frames).not.toContain('[DONE]');
});

test('a stream that does not begin with message_start is an error', () => {
  expect(written([text(0, 'x'), STOP])).toEqual([{ error: expect.objectContaining({ type: 'api_error' }) }]);
});

test('a message_start without an id is an error', () => {
  const start: Event = { type: 'message_start', message: { model: 'claude' } };
  expect(written([start, STOP])).toEqual([{ error: expect.objectContaining({ type: 'api_error' }) }]);
});

test('a tool_use block opened without an id is an error', () => {
  const frames = written([START, blockStart(0, { type: 'tool_use', name: 'f' }), STOP]);
  expect(frames[frames.length - 1]).toHaveProperty('error.type', 'api_error');
});

test('a tool_use block opened without a name is an error', () => {
  const frames = written([START, blockStart(0, { type: 'tool_use', id: 'call_a' }), STOP]);
  expect(frames[frames.length - 1]).toHaveProperty('error.type', 'api_error');
});

test('arguments for a tool_use block that was never opened are an error', () => {
  const frames = written([START, json(3, '{}'), STOP]);
  expect(frames[frames.length - 1]).toHaveProperty('error.type', 'api_error');
});

test('the event name of the SSE block is used when the data carries no type', () => {
  const writer = new ChatStreamWriter({ created: 12, includeUsage: false });
  writer.push({ event: 'message_start', data: JSON.stringify({ message: START.message }) });
  expect(writer.push({ event: 'message_stop', data: '{}' }).pop()).toBe(DONE);
});

test('a frame without data writes nothing', () => {
  expect(new ChatStreamWriter({ created: 12, includeUsage: false }).push({ event: null, data: null })).toEqual([]);
});
