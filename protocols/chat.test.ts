// Chat Completions frame classification and usage rules.
import { expect, test } from 'bun:test';
import { chat } from './chat';
import { SseParser } from './sse';

const role = 'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n';
const done = 'data: [DONE]\n\n';
const usage = '{"prompt_tokens":100,"completion_tokens":7,' +
  '"prompt_tokens_details":{"cached_tokens":20,"cache_write_tokens":10}}';
const expectedUsage = { inputTokens: 80, outputTokens: 7, cacheReadTokens: 20 };
const text = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
const finish = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
const usageChunk = `data: {"choices":[],"usage":${usage}}\n\n`;
const tool = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",' +
  '"function":{"name":"weather","arguments":"{}"}}]}}]}\n\n';
const reasoning = 'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n';
const failure = 'data: {"error":{"message":"overloaded"}}\n\n';
const router = `data: {"choices":[{"delta":{"content":"hi"}}],"usage":${usage}}\n\n`;

function frames(text: string) {
  const parser = new SseParser();
  return [...parser.push(text), ...parser.end()];
}

function kind(text: string) {
  return chat.observe().see(frames(text)[0]);
}

for (const [name, input] of [
  ['OpenAI', ': hello\n\n' + role + text + finish + usageChunk + done],
  ['tool calls', role + tool + done],
  ['reasoning', role + reasoning + done],
  ['in-band error', role + failure],
  ['OpenRouter', role + router + done],
] as const) {
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
  ['comment block is preamble', ': hello\n\n', 'preamble'],
  ['empty data is preamble', 'data:\n\n', 'preamble'],
  ['role-only chunk is preamble', role, 'preamble'],
  ['content chunk is content', text, 'content'],
  ['finish chunk is content', finish, 'content'],
  ['tool call chunk is content', tool, 'content'],
  ['reasoning_content chunk is content', reasoning, 'content'],
  ['reasoning chunk is content', 'data: {"choices":[{"delta":{"reasoning":"x"}}]}\n\n', 'content'],
  ['usage-only chunk is usage', usageChunk, 'usage'],
  ['DONE is end', done, 'end'],
  ['in-band error is error', failure, 'error'],
  ['non-JSON data is content', 'data: invalid\n\n', 'content'],
  ['non-array choices is content', 'data: {"choices":{}}\n\n', 'content'],
] as const) {
  test(name, () => expect(kind(input)).toBe(expected));
}

test('OpenAI transcript has expected frame kinds', () => {
  const observer = chat.observe();
  expect(frames(': hello\n\n' + role + text + finish + usageChunk + done).map((f) => observer.see(f)))
    .toEqual(['preamble', 'preamble', 'content', 'content', 'usage', 'end']);
});

test('tool call transcript has expected frame kinds', () => {
  const observer = chat.observe();
  expect(frames(role + tool + done).map((f) => observer.see(f))).toEqual(['preamble', 'content', 'end']);
});

test('reasoning transcript has expected frame kinds', () => {
  const observer = chat.observe();
  expect(frames(role + reasoning + done).map((f) => observer.see(f))).toEqual(['preamble', 'content', 'end']);
});

test('in-band error transcript has expected frame kinds', () => {
  const observer = chat.observe();
  expect(frames(role + failure).map((f) => observer.see(f))).toEqual(['preamble', 'error']);
  expect(observer.error()).toBe('overloaded');
});

test('OpenRouter transcript has expected frame kinds', () => {
  const observer = chat.observe();
  expect(frames(role + router + done).map((f) => observer.see(f))).toEqual(['preamble', 'content', 'end']);
});

test('input usage subtracts cache read; a cache write stays input', () => {
  expect(chat.usageOf({ usage: JSON.parse(usage) })).toEqual(expectedUsage);
});

test('a usage that reports only cached_tokens keeps its numbers', () => {
  expect(chat.usageOf({
    usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 20 } },
  })).toEqual({ inputTokens: 80, outputTokens: 7, cacheReadTokens: 20 });
});

test('input usage is not negative', () => {
  expect(chat.usageOf({
    usage: { prompt_tokens: 1, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } },
  })?.inputTokens).toBe(0);
});

test('missing or invalid usage is null', () => {
  for (const value of [undefined, null, {}, { prompt_tokens: 1 },
    { prompt_tokens: NaN, completion_tokens: 2 }, { prompt_tokens: 1, completion_tokens: NaN }]) {
    expect(chat.usageOf({ usage: value })).toBeNull();
  }
});

test('missing cache counts default to zero', () => {
  expect(chat.usageOf({ usage: { prompt_tokens: 1, completion_tokens: 2 } })).toEqual({
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
  });
});

test('usage-only chunk records usage', () => {
  const observer = chat.observe();
  observer.see(frames(usageChunk)[0]);
  expect(observer.usage()).toEqual(expectedUsage);
});

test('OpenRouter content chunk records usage', () => {
  const observer = chat.observe();
  observer.see(frames(router)[0]);
  expect(observer.usage()).toEqual(expectedUsage);
});

for (const [name, input, expected] of [
  ['OpenAI', role + text + finish + usageChunk + done, expectedUsage],
  ['tool calls', role + tool + done, null],
  ['reasoning', role + reasoning + done, null],
  ['in-band error', role + failure, null],
  ['OpenRouter', role + router + done, expectedUsage],
] as const) {
  test(`${name} transcript reports final usage`, () => {
    const observer = chat.observe();
    for (const frame of frames(input)) observer.see(frame);
    expect(observer.usage()).toEqual(expected);
  });
}

test('errorOf reads an error message or string', () => {
  expect(chat.errorOf({ error: 'bad' })).toBe('bad');
  expect(chat.errorOf({ error: { message: 'bad' } })).toBe('bad');
  expect(chat.errorOf({})).toBeNull();
});

for (const [status, type] of [[400, 'invalid_request_error'], [404, 'invalid_request_error'],
  [413, 'invalid_request_error'], [422, 'invalid_request_error'], [401, 'authentication_error'],
  [403, 'permission_error'], [429, 'rate_limit_error'], [500, 'api_error']] as const) {
  test(`errorBody maps ${status} to ${type}`, () => {
    expect(chat.errorBody(status, 'bad', 'model')).toEqual({
      error: { message: 'bad', type, code: null, param: 'model' },
    });
  });
}

test('errorBody defaults param to null', () => {
  expect(chat.errorBody(500, 'bad')).toEqual({
    error: { message: 'bad', type: 'api_error', code: null, param: null },
  });
});
