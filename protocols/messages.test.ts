// Anthropic Messages frame classification and usage rules.
import { expect, test } from 'bun:test';
import { costOf } from '../pricing';
import { messages } from './messages';
import { SseParser } from './sse';

const start = 'event: message_start\ndata: {"type":"message_start","message":{"usage":' +
  '{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":3,"output_tokens":0}}}\n\n';
const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
const textStart = 'event: content_block_start\ndata: {"type":"content_block_start","index":0,' +
  '"content_block":{"type":"text","text":""}}\n\n';
const textDelta = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,' +
  '"delta":{"type":"text_delta","text":"Hello"}}\n\n';
const blockStop = 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
const toolStart = 'event: content_block_start\ndata: {"type":"content_block_start","index":1,' +
  '"content_block":{"type":"tool_use","id":"tool_1","name":"weather","input":{}}}\n\n';
const toolDelta = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,' +
  '"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n';
const delta4 = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n';
const delta7 = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n';
const stop = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const thinkingStart = 'event: content_block_start\ndata: {"type":"content_block_start",' +
  '"content_block":{"type":"thinking","thinking":""}}\n\n';
const thinkingDelta = 'event: content_block_delta\ndata: {"type":"content_block_delta",' +
  '"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n';
const failure = 'event: error\ndata: {"error":{"type":"overloaded_error","message":"busy"}}\n\n';
const full = start + ping + textStart + textDelta + blockStop + toolStart + toolDelta + blockStop +
  delta4 + delta7 + stop;
const thinking = start + thinkingStart + thinkingDelta + blockStop + stop;
const expectedUsage = { inputTokens: 13, outputTokens: 7, cacheReadTokens: 20 };

function frames(text: string) {
  const parser = new SseParser();
  return [...parser.push(text), ...parser.end()];
}

for (const [name, input] of [['text and tool', full], ['thinking', thinking],
  ['in-band error', start + failure]] as const) {
  test(`${name} transcript is identical at every split offset`, () => {
    const expected = frames(input);
    for (let i = 0; i <= input.length; i++) {
      const parser = new SseParser();
      expect([...parser.push(input.slice(0, i)), ...parser.push(input.slice(i)), ...parser.end()])
        .toEqual(expected);
    }
  });
}

for (const [name, input, expected] of [
  ['comment block is preamble', ': hi\n\n', 'preamble'],
  ['message_start is preamble', start, 'preamble'],
  ['ping is preamble', ping, 'preamble'],
  ['content_block_start is content', textStart, 'content'],
  ['content_block_delta is content', textDelta, 'content'],
  ['content_block_stop is content', blockStop, 'content'],
  ['tool_use start is content', toolStart, 'content'],
  ['input_json_delta is content', toolDelta, 'content'],
  ['thinking start is content', thinkingStart, 'content'],
  ['thinking_delta is content', thinkingDelta, 'content'],
  ['message_delta is content', delta7, 'content'],
  ['message_stop is end', stop, 'end'],
  ['event error is error', failure, 'error'],
  ['unknown event is content', 'event: other\ndata: {}\n\n', 'content'],
] as const) {
  test(name, () => expect(messages.observe().see(frames(input)[0])).toBe(expected));
}

test('text and tool transcript has expected frame kinds', () => {
  const observer = messages.observe();
  expect(frames(full).map((f) => observer.see(f))).toEqual([
    'preamble', 'preamble', 'content', 'content', 'content', 'content',
    'content', 'content', 'content', 'content', 'end',
  ]);
});

test('thinking transcript has expected frame kinds', () => {
  const observer = messages.observe();
  expect(frames(thinking).map((f) => observer.see(f)))
    .toEqual(['preamble', 'content', 'content', 'content', 'end']);
});

test('in-band error transcript has expected frame kinds', () => {
  const observer = messages.observe();
  expect(frames(start + failure).map((f) => observer.see(f))).toEqual(['preamble', 'error']);
  expect(observer.error()).toBe('busy');
});

test('message_delta cumulative usage replaces previous fields', () => {
  const observer = messages.observe();
  for (const frame of frames(full)) observer.see(frame);
  expect(observer.usage()).toEqual(expectedUsage);
});

test('message_start records input side usage', () => {
  const observer = messages.observe();
  observer.see(frames(start)[0]);
  expect(observer.usage()).toEqual({ ...expectedUsage, outputTokens: 0 });
});

for (const [name, input] of [['thinking', thinking], ['in-band error', start + failure]] as const) {
  test(`${name} transcript reports final usage`, () => {
    const observer = messages.observe();
    for (const frame of frames(input)) observer.see(frame);
    expect(observer.usage()).toEqual({ ...expectedUsage, outputTokens: 0 });
  });
}

test('complete usage counts cache creation as input and cache reads apart', () => {
  expect(messages.usageOf({
    usage: {
      input_tokens: 10,
      output_tokens: 7,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3,
    },
  })).toEqual(expectedUsage);
});

test('cache-creation tokens are costed at the input price', () => {
  const usage = messages.usageOf({
    usage: {
      input_tokens: 10,
      output_tokens: 7,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3,
    },
  });
  // 13 input at 2 + 7 output at 4 + 20 cache reads at 1, per 1M tokens.
  expect(costOf(usage, { input: 2, output: 4, cacheRead: 1 })).toBe(74 / 1_000_000);
});

test('missing cache fields default to zero', () => {
  expect(messages.usageOf({ usage: { input_tokens: 1, output_tokens: 2 } })).toEqual({
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
  });
});

test('missing and non-finite usage is null', () => {
  for (const usage of [null, {}, { input_tokens: NaN, output_tokens: 2 },
    { input_tokens: 1, output_tokens: NaN }]) {
    expect(messages.usageOf({ usage })).toBeNull();
  }
});

test('errorOf reads only messages error objects', () => {
  expect(messages.errorOf({ type: 'error', error: { message: 'bad' } })).toBe('bad');
  expect(messages.errorOf({ error: { message: 'bad' } })).toBeNull();
});

for (const [status, type] of [[400, 'invalid_request_error'], [422, 'invalid_request_error'],
  [401, 'authentication_error'], [403, 'permission_error'], [404, 'not_found_error'],
  [413, 'request_too_large'], [429, 'rate_limit_error'], [503, 'overloaded_error'],
  [529, 'overloaded_error'], [500, 'api_error']] as const) {
  test(`errorBody maps ${status} to ${type}`, () => {
    expect(messages.errorBody(status, 'bad')).toEqual({ type: 'error', error: { type, message: 'bad' } });
  });
}
