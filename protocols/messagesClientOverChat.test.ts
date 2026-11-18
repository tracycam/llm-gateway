import { expect, test } from 'bun:test';
import { MessagesStreamWriter, toChatRequest, toMessagesResponse } from './messagesClientOverChat';
import { isObject } from './json';

function request(extra: Record<string, unknown> = {}) {
  const result = toChatRequest({ messages: [], ...extra });
  if ('refused' in result) throw new Error(result.refused.message);
  return result.body;
}

test.each([
  ['model', 'm'], ['stream', true], ['temperature', 1], ['top_p', 0.5], ['max_tokens', 10],
])('request preserves %s', (key, value) => {
  expect(request({ [String(key)]: value })[String(key)]).toEqual(value);
});

test('stop sequences map to stop', () => {
  expect(request({ stop_sequences: ['x'] }).stop).toEqual(['x']);
});

test('metadata user_id maps to user', () => {
  expect(request({ metadata: { user_id: 'u', other: 1 } })).toEqual({ messages: [], user: 'u' });
});

test('system string preserves internal newlines', () => {
  expect(request({ system: 'a\nb' }).messages).toEqual([{ role: 'system', content: 'a\nb' }]);
});

test('system text blocks join with blank lines', () => {
  expect(request({ system: [{ type: 'text', text: 'a\nb' }, { type: 'text', text: 'c' }] }).messages)
    .toEqual([{ role: 'system', content: 'a\nb\n\nc' }]);
});

test('user string and text parts', () => {
  expect(request({ messages: [{ role: 'user', content: 'a' },
    { role: 'user', content: [{ type: 'text', text: 'b' }] },
    { role: 'user', content: [{ type: 'text', text: 'c' }, { type: 'text', text: 'd' }] }] }).messages)
    .toEqual([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' },
      { role: 'user', content: [{ type: 'text', text: 'c' }, { type: 'text', text: 'd' }] }]);
});

test('image blocks retain base64 and URL', () => {
  const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    { type: 'image', source: { type: 'url', url: 'https://example.test/a' } }];
  expect(request({ messages: [{ role: 'user', content }] }).messages).toEqual([{ role: 'user', content: [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    { type: 'image_url', image_url: { url: 'https://example.test/a' } }] }]);
});

test('tool results precede remaining user text', () => {
  const content = [
    { type: 'text', text: 'continue' },
    {
      type: 'tool_result',
      tool_use_id: 't',
      is_error: true,
      content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    },
  ];
  expect(request({ messages: [{ role: 'user', content }] }).messages).toEqual([
    { role: 'tool', tool_call_id: 't', content: 'a\nb' }, { role: 'user', content: 'continue' }]);
});

test('tool-only user message has no user message', () => {
  const messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }];
  expect(request({ messages }).messages).toEqual([{ role: 'tool', tool_call_id: 't', content: 'ok' }]);
});

test('tool result without content becomes an empty tool message', () => {
  const messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' }] }];
  expect(request({ messages }).messages).toEqual([{ role: 'tool', tool_call_id: 't', content: '' }]);
});

test('assistant tool calls with no text use null content', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'f', input: {} }] }];
  expect(request({ messages }).messages).toEqual([{
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }],
  }]);
});

test('assistant text and tool calls omit thinking', () => {
  expect(request({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' },
    { type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' },
    { type: 'tool_use', id: 't', name: 'f', input: { x: 1 } }] }] }).messages)
    .toEqual([{ role: 'assistant', content: 'ab', tool_calls: [
      { id: 't', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] }]);
});

test('tool definitions preserve input_schema', () => {
  expect(request({ tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }] }).tools)
    .toEqual([{
      type: 'function',
      function: { name: 'f', description: 'd', parameters: { type: 'object' } },
    }]);
});

test('tool choice maps any to required and disables parallel calls', () => {
  expect(request({ tool_choice: { type: 'any', disable_parallel_tool_use: true } }))
    .toEqual({ messages: [], tool_choice: 'required', parallel_tool_calls: false });
});

test.each(['auto', 'none'])('tool choice %s maps unchanged', (type) => {
  expect(request({ tool_choice: { type } }).tool_choice).toBe(type);
});

test('named tool choice maps to function', () => {
  expect(request({ tool_choice: { type: 'tool', name: 'f' } }).tool_choice)
    .toEqual({ type: 'function', function: { name: 'f' } });
});

test('performance hints and unknown fields are ignored', () => {
  expect(request({ thinking: {}, top_k: 4, service_tier: 'x', context_management: {}, unknown: true }))
    .toEqual({ messages: [] });
});

test('document blocks are refused at their path', () => {
  expect(toChatRequest({ messages: [{ role: 'user', content: [{ type: 'document' }] }] }))
    .toMatchObject({
      refused: { param: 'messages.0.content.0', message: expect.stringContaining('document') },
    });
});

test.each(['image', 'document'])('%s in a tool result is refused', (type) => {
  expect(toChatRequest({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't',
    content: [{ type }] }] }] })).toMatchObject({
    refused: { param: 'messages.0.content.0.content.0', message: expect.stringContaining('text block') },
  });
});

test('server tools are refused', () => {
  expect(toChatRequest({ messages: [], tools: [{ type: 'web_search_20250305', name: 'search' }] }))
    .toMatchObject({ refused: { param: 'tools.0', message: expect.stringContaining('server tools') } });
});

test.each(['mcp_servers', 'container', 'output_format', 'output_config'])('%s is refused', (key) => {
  expect(toChatRequest({ messages: [], [key]: {} })).toMatchObject({
    refused: { param: key, message: expect.stringContaining(key) },
  });
});

test.each([
  ['non-object body', null, 'body', 'object'],
  ['missing messages', {}, 'messages', 'array'],
  ['non-array messages', { messages: 'x' }, 'messages', 'array'],
  ['invalid role', { messages: [{ role: 'system', content: 'x' }] }, 'messages.0', 'user or assistant'],
  ['unknown block', { messages: [{ role: 'user', content: [{ type: 'unknown' }] }] },
    'messages.0.content.0', 'unknown'],
])('%s is refused with its reason', (_name, value, param, reason) => {
  expect(toChatRequest(value)).toMatchObject({
    refused: { param, message: expect.stringContaining(reason) },
  });
});

const chat = {
  id: 'id',
  model: 'm',
  choices: [{
    finish_reason: 'tool_calls',
    message: {
      reasoning_content: 'think',
      content: 'hello',
      tool_calls: [{ id: 't', function: { name: 'f', arguments: '{"x":1}' } }],
    },
  }],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 7,
    prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
  },
};

test('complete response maps blocks and reports cache writes as input', () => {
  expect(toMessagesResponse(chat)).toEqual({
    id: 'id',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content: [
      { type: 'thinking', thinking: 'think', signature: '' },
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 't', name: 'f', input: { x: 1 } },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 80,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 0,
      output_tokens: 7,
    },
  });
});

test.each([['stop', 'end_turn'], ['length', 'max_tokens'], ['other', 'end_turn']])(
  'finish reason %s maps to %s', (finish, expected) => {
    const result = toMessagesResponse({
      id: 'i', model: 'm', choices: [{ finish_reason: finish, message: {} }],
    });
    expect(result.stop_reason).toBe(expected);
  },
);

test('missing usage maps to wire-format zeros', () => {
  const result = toMessagesResponse({ id: 'i', model: 'm', choices: [{ message: {} }] });
  expect(result.usage).toEqual({
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
  });
});

test('invalid completion throws', () => {
  expect(() => toMessagesResponse({})).toThrow();
});

test.each(['[]', 'null', 'broken'])('invalid tool argument %s throws', (args) => {
  expect(() => toMessagesResponse({ id: 'i', model: 'm', choices: [{ message: { tool_calls: [
    { id: 't', function: { name: 'f', arguments: args } }] } }] })).toThrow();
});

type Event = { name: string; data: Record<string, any> };

function checkStream(raw: string[], names: string[]): Event[] {
  const events = raw.map((value): Event => {
    const match = /^event: ([^\n]+)\ndata: ([^\n]+)\n\n$/.exec(value);
    expect(match).not.toBeNull();
    if (!match) throw new Error('Invalid SSE');
    const data: unknown = JSON.parse(match[2]);
    if (!isObject(data)) throw new Error('Invalid event');
    return { name: match[1], data };
  });
  expect(events.map((item) => item.name)).toEqual(names);
  expect(events[0].name).toBe('message_start');
  let open: number | null = null;
  let index = 0;
  for (const item of events) {
    expect(item.data.type).toBe(item.name);
    if (item.name === 'content_block_start') {
      expect(open).toBeNull();
      expect(item.data.index).toBe(index++);
      open = item.data.index;
    }
    if (item.name === 'content_block_delta') expect(item.data.index).toBe(open);
    if (item.name === 'content_block_stop') {
      expect(item.data.index).toBe(open);
      open = null;
    }
  }
  if (events.at(-1)?.name !== 'error') {
    expect(open).toBeNull();
    expect(events.slice(-2).map((item) => item.name)).toEqual(['message_delta', 'message_stop']);
  }
  return events;
}

function transcript(chunks: unknown[], finish = true): string[] {
  const writer = new MessagesStreamWriter();
  const out: string[] = [];
  for (const chunk of chunks) out.push(...writer.push({ event: null, data: JSON.stringify(chunk) }));
  if (finish) {
    out.push(...writer.push({ event: null, data: '[DONE]' }));
  } else {
    out.push(...writer.end());
  }
  expect(writer.end()).toEqual([]);
  return out;
}

function chunk(delta: unknown, finish_reason: string | null = null, extra: Record<string, unknown> = {}) {
  return { id: 'id', model: 'm', choices: [{ delta, finish_reason }], ...extra };
}

const start = ['message_start'];
const block = ['content_block_start', 'content_block_delta', 'content_block_stop'];
const end = ['message_delta', 'message_stop'];

test('transcript text only', () => {
  checkStream(transcript([chunk({ content: 'hello' }), chunk({}, 'stop')]), [...start, ...block, ...end]);
});

test('transcript reasoning then text', () => {
  checkStream(transcript([chunk({ reasoning: 'r' }), chunk({ content: 't' }), chunk({}, 'stop')]),
    [...start, ...block, ...block, ...end]);
});

test('transcript text then two distinct tool calls', () => {
  const call = (index: number) => ({ tool_calls: [{ index, id: `t${index}`,
    function: { name: 'f', arguments: '{}' } }] });
  const events = checkStream(transcript([chunk({ content: 't' }), chunk(call(0)), chunk(call(1)),
    chunk({}, 'tool_calls')]), [...start, ...block, ...block, ...block, ...end]);
  expect(events.filter((e) => e.name === 'content_block_start').map((e) => e.data.content_block.type))
    .toEqual(['text', 'tool_use', 'tool_use']);
});

test('transcript tool arguments in five fragments', () => {
  const fragments = ['{', '"x"', ':', '1', '}'];
  const chunks = fragments.map((part, index) => chunk({
    tool_calls: [{
      index: 0,
      ...(index === 0 ? { id: 't' } : {}),
      function: { ...(index === 0 ? { name: 'f' } : {}), arguments: part },
    }],
  }));
  const events = checkStream(transcript([...chunks, chunk({}, 'tool_calls')]),
    [...start, 'content_block_start', ...Array(5).fill('content_block_delta'), 'content_block_stop', ...end]);
  const partials = events.filter((e) => e.name === 'content_block_delta');
  expect(partials.map((e) => e.data.delta.partial_json).join('')).toBe(fragments.join(''));
});

test('transcript usage-only chunk before DONE reports the cache write as input', () => {
  const events = checkStream(transcript([chunk({ content: 'x' }), chunk({}, 'stop'),
    { id: 'id', model: 'm', choices: [], usage: chat.usage }]), [...start, ...block, ...end]);
  expect(events.at(-2)?.data.usage.input_tokens).toBe(80);
  expect(events.at(-2)?.data.usage.cache_creation_input_tokens).toBe(0);
});

test('transcript finish reason and usage on same chunk', () => {
  const events = checkStream(transcript([chunk({ content: 'x' }, 'length', { usage: chat.usage })]),
    [...start, ...block, ...end]);
  expect(events.at(-2)?.data.delta.stop_reason).toBe('max_tokens');
  expect(events.at(-2)?.data.usage.output_tokens).toBe(7);
});

test('transcript in-band error after role chunk', () => {
  const events = checkStream(transcript([chunk({ role: 'assistant' }), { error: { message: 'bad' } }]),
    [...start, 'error']);
  expect(events.at(-1)?.data.error.message).toBe('bad');
});

test('transcript cut after content is an error', () => {
  checkStream(transcript([chunk({ content: 'x' })], false),
    [...start, 'content_block_start', 'content_block_delta', 'error']);
});

test('resuming a closed tool block emits an error', () => {
  const first = { tool_calls: [{ index: 0, id: 't', function: { name: 'f', arguments: '{' } }] };
  const again = { tool_calls: [{ index: 0, function: { arguments: '}' } }] };
  checkStream(transcript([chunk(first), chunk({ content: 'x' }), chunk(again)]),
    [...start, ...block, 'content_block_start', 'content_block_delta', 'error']);
});
