// OpenAI Responses frame classification and usage rules.
import { expect, test } from 'bun:test';
import { costOf } from '../pricing';
import { responses } from './responses';
import { SseParser } from './sse';

const usage = '{"input_tokens":100,"input_tokens_details":{"cached_tokens":20,' +
  '"cache_write_tokens":10},"output_tokens":7,"total_tokens":107}';
const expectedUsage = { inputTokens: 80, outputTokens: 7, cacheReadTokens: 20 };

const created = 'event: response.created\ndata: {"type":"response.created","response":' +
  '{"id":"resp_1","status":"in_progress","usage":null}}\n\n';
const inProgress = 'event: response.in_progress\ndata: {"type":"response.in_progress","response":' +
  '{"id":"resp_1","status":"in_progress"}}\n\n';
const createdWithUsage = 'event: response.created\ndata: {"type":"response.created","response":' +
  `{"id":"resp_1","status":"in_progress","usage":${usage}}}\n\n`;
const queued = 'event: response.queued\ndata: {"type":"response.queued","response":' +
  '{"id":"resp_1","status":"queued"}}\n\n';
const itemAdded = 'event: response.output_item.added\ndata: {"type":"response.output_item.added",' +
  '"output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n';
const partAdded = 'event: response.content_part.added\ndata: {"type":"response.content_part.added",' +
  '"item_id":"msg_1","output_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n';
const textDelta = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta",' +
  '"item_id":"msg_1","delta":"Hello"}\n\n';
const textDone = 'event: response.output_text.done\ndata: {"type":"response.output_text.done",' +
  '"item_id":"msg_1","text":"Hello"}\n\n';
const reasoningDelta = 'event: response.reasoning_summary_text.delta\ndata:' +
  '{"type":"response.reasoning_summary_text.delta","item_id":"rs_1","delta":"think"}\n\n';
const argumentsDelta = 'event: response.function_call_arguments.delta\ndata:' +
  '{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"city\\":"}\n\n';
const completed = `event: response.completed\ndata: {"type":"response.completed","response":` +
  `{"id":"resp_1","status":"completed","usage":${usage}}}\n\n`;
const incomplete = `event: response.incomplete\ndata: {"type":"response.incomplete","response":` +
  `{"id":"resp_1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},` +
  `"usage":${usage}}}\n\n`;
const failed = 'event: response.failed\ndata: {"type":"response.failed","response":' +
  '{"id":"resp_1","status":"failed","error":{"code":"server_error","message":"boom"}}}\n\n';
const errorEvent = 'event: error\ndata: {"type":"error","code":"server_error","message":"boom"}\n\n';
const full = created + itemAdded + partAdded + textDelta + textDone + completed;

function frames(text: string) {
  const parser = new SseParser();
  return [...parser.push(text), ...parser.end()];
}

function kind(text: string) {
  return responses.observe().see(frames(text)[0]);
}

test('a full transcript is identical at every split offset', () => {
  const expected = frames(full);
  for (let i = 0; i <= full.length; i++) {
    const parser = new SseParser();
    expect([...parser.push(full.slice(0, i)), ...parser.push(full.slice(i)), ...parser.end()])
      .toEqual(expected);
  }
});

for (const [name, input, expected] of [
  ['response.created is preamble', created, 'preamble'],
  ['response.in_progress is preamble', inProgress, 'preamble'],
  ['a queued response is preamble', queued, 'preamble'],
  ['an output item is content', itemAdded, 'content'],
  ['a content part is content', partAdded, 'content'],
  ['a text delta is content', textDelta, 'content'],
  ['a reasoning delta is content', reasoningDelta, 'content'],
  ['a function-call argument delta is content', argumentsDelta, 'content'],
  ['response.completed is the end', completed, 'end'],
  ['response.incomplete is the end', incomplete, 'end'],
  ['response.failed is an error', failed, 'error'],
  ['an error event is an error', errorEvent, 'error'],
  ['a comment block is preamble', ': keepalive\n\n', 'preamble'],
  ['[DONE] is tolerated as an end', 'data: [DONE]\n\n', 'end'],
] as const) {
  test(name, () => expect(kind(input)).toBe(expected));
}

test('the frame kinds of the full transcript are in order', () => {
  const observer = responses.observe();
  expect(frames(full).map((frame) => observer.see(frame)))
    .toEqual(['preamble', 'content', 'content', 'content', 'content', 'end']);
  expect(observer.usage()).toEqual(expectedUsage);
});

test('response.created reports no usage before the terminal event', () => {
  const observer = responses.observe();
  observer.see(frames(createdWithUsage)[0]);
  expect(observer.usage()).toBeNull();
});

test('a frame named only by its event line is classified', () => {
  expect(kind('event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n')).toBe('content');
  expect(kind('event: response.completed\ndata: {"response":{"usage":' + usage + '}}\n\n')).toBe('end');
});

test('a frame named only by its data type member is classified', () => {
  expect(kind('data: {"type":"response.output_text.delta","delta":"Hi"}\n\n')).toBe('content');
  expect(kind('data: {"type":"response.created","response":{}}\n\n')).toBe('preamble');
});

for (const [name, input] of [
  ['response.completed', completed],
  ['response.incomplete', incomplete],
] as const) {
  test(`${name} reports usage with cached input subtracted`, () => {
    const observer = responses.observe();
    for (const frame of frames(created + textDelta + input)) observer.see(frame);
    expect(observer.usage()).toEqual(expectedUsage);
  });
}

test('response.incomplete reports usage even without content before it', () => {
  const observer = responses.observe();
  observer.see(frames(incomplete)[0]);
  expect(observer.usage()).toEqual(expectedUsage);
});

test('a stream that ends without a terminal event reports no end and no usage', () => {
  const observer = responses.observe();
  const kinds = frames(created + itemAdded + textDelta).map((frame) => observer.see(frame));
  expect(kinds).toEqual(['preamble', 'content', 'content']);
  expect(observer.usage()).toBeNull();
});

for (const [name, input, message] of [
  ['response.failed', failed, 'boom'],
  ['an error event', errorEvent, 'boom'],
] as const) {
  test(`${name} reports its message`, () => {
    const observer = responses.observe();
    expect(observer.see(frames(input)[0])).toBe('error');
    expect(observer.error()).toBe(message);
  });
}

test('usage subtracts cache reads and keeps cache writes in input', () => {
  expect(responses.usageOf({ usage: JSON.parse(usage) })).toEqual(expectedUsage);
});

test('input usage is never negative', () => {
  expect(responses.usageOf({
    usage: { input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: 5 } },
  })?.inputTokens).toBe(0);
});

test('missing cache details default to zero', () => {
  expect(responses.usageOf({ usage: { input_tokens: 1, output_tokens: 2 } })).toEqual({
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
  });
});

test('missing or invalid usage is null', () => {
  for (const value of [undefined, null, {}, { input_tokens: 1 },
    { input_tokens: NaN, output_tokens: 2 }, { input_tokens: 1, output_tokens: NaN }]) {
    expect(responses.usageOf({ usage: value })).toBeNull();
  }
});

test('usage counts at the input, output and cache-read prices', () => {
  // 80 input at 2 + 7 output at 4 + 20 cache reads at 1, per 1M tokens.
  expect(costOf(responses.usageOf({ usage: JSON.parse(usage) }), { input: 2, output: 4, cacheRead: 1 }))
    .toBe(208 / 1_000_000);
});

test('errorOf reads the error of a failed non-streaming body', () => {
  expect(responses.errorOf({
    id: 'resp_1', object: 'response', status: 'failed',
    error: { code: 'server_error', message: 'boom' },
  })).toBe('boom');
  expect(responses.errorOf({ error: 'bad' })).toBe('bad');
  expect(responses.errorOf({ id: 'resp_1', status: 'completed', error: null })).toBeNull();
  expect(responses.errorOf({})).toBeNull();
});

test('errorBody is the OpenAI error shape', () => {
  expect(responses.errorBody(400, 'bad', 'model')).toEqual({
    error: { message: 'bad', type: 'invalid_request_error', code: null, param: 'model' },
  });
  expect(responses.errorBody(502, 'bad')).toEqual({
    error: { message: 'bad', type: 'api_error', code: null, param: null },
  });
});
