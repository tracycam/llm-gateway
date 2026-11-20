import { expect, test } from 'bun:test';
import { bridgeRequest, bridgeResponse, bridgeStream, type Bridge } from './bridge';
import { isObject } from './json';
import { canServe, protocolModule, type Protocol } from './protocol';
import { SseParser } from './sse';

const protocols: Protocol[] = ['chat', 'messages'];
const bridge = (inbound: Protocol, upstream: Protocol): Bridge => ({
  inbound,
  upstream,
  upstreamModel: 'chosen',
  maxOutputTokens: 100,
  created: 123,
});
const chatFrame = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'id', model: 'm', choices: [{ delta, finish_reason: finish }] })}\r\n\r\n`;
const event = (type: string, fields: object = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const chatParts = [
  ': comment\r\n\r\n',
  chatFrame({ role: 'assistant' }),
  chatFrame({ content: '你' }),
  chatFrame({ content: '好' }),
  chatFrame({}, 'stop'),
  `data: ${JSON.stringify({ id: 'id', model: 'm', choices: [], usage: {
    prompt_tokens: 3,
    completion_tokens: 2,
  } })}\r\n\r\n`,
  'data: [DONE]\r\n\r\n',
];
const messagesParts = [
  event('message_start', { message: { id: 'id', model: 'm', usage: { input_tokens: 3 } } }),
  event('ping'),
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你好' } }),
  event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  event('message_stop'),
];
const parts = (protocol: Protocol) => protocol === 'chat' ? chatParts : messagesParts;
const errorFrame = (protocol: Protocol) => protocol === 'chat'
  ? 'data: {"error":{"message":"broken"}}\n\n'
  : event('error', { error: { message: 'broken' } });

function source(text: string, bytes: boolean, fail = false): ReadableStream<Uint8Array> {
  const data = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset < data.length) {
        const end = bytes ? offset + 1 : data.length;
        controller.enqueue(data.slice(offset, end));
        offset = end;
      } else if (fail) {
        controller.error(new Error('read failed'));
      } else {
        controller.close();
      }
    },
  }, { highWaterMark: 0 });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

function assertNormal(text: string, inbound: Protocol, upstream: Protocol): void {
  if (inbound === upstream) {
    expect(text).toBe(parts(upstream).join(''));
    return;
  }
  const frames = new SseParser().push(text);
  expect(frames.map((frame) => frame.raw).join('')).toBe(text);
  if (inbound === 'messages') {
    expect(frames.map((frame) => frame.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  } else {
    expect(frames.map((frame) =>
      frame.data === '[DONE]' ? '[DONE]' : JSON.parse(frame.data ?? 'null').choices))
      .toEqual([
        [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        [{ index: 0, delta: { content: '你好' }, finish_reason: null }],
        [{ index: 0, delta: {}, finish_reason: 'stop' }],
        [],
        '[DONE]',
      ]);
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
  }
}

function assertFailure(text: string, inbound: Protocol, upstream: Protocol, reason: string): void {
  const prefix = parts(upstream).slice(0, 3).join('');
  if (inbound === upstream) {
    const body = protocolModule(inbound).errorBody(502, reason);
    const frame = reason === 'broken' ? errorFrame(upstream)
      : `${inbound === 'messages' ? 'event: error\n' : ''}data: ${JSON.stringify(body)}\n\n`;
    expect(text).toBe(prefix + frame);
    return;
  }
  const frames = new SseParser().push(text);
  expect(frames.map((frame) => frame.raw).join('')).toBe(text);
  if (inbound === 'messages') {
    expect(frames.map((frame) => frame.event)).toEqual([
      'message_start', 'content_block_start', 'content_block_delta', 'error',
    ]);
  } else {
    expect(frames.map((frame) => {
      const value = JSON.parse(frame.data ?? 'null');
      return value.error ? 'error' : value.choices[0].delta.role;
    })).toEqual(['assistant', 'error']);
  }
  expect(frames.at(-1)?.data?.toLowerCase()).toContain(reason === 'broken' ? reason : 'upstream');
}

test('rule 1: object required and model replaced', () => {
  expect(bridgeRequest(null, bridge('chat', 'chat'))).toEqual({
    refused: { param: 'body', message: 'expected an object' },
  });
  const result = bridgeRequest({ model: 'old' }, bridge('chat', 'chat'));
  expect('body' in result && result.body.model).toBe('chosen');
});

test('rule 2: same protocol preserves unknown fields', () => {
  for (const protocol of protocols) {
    const result = bridgeRequest({ model: 'old', invented: 7 }, bridge(protocol, protocol));
    expect('body' in result && result.body).toEqual({ model: 'chosen', invented: 7 });
  }
});

test('rule 3: chat streaming requests usage and preserves options', () => {
  const result = bridgeRequest({ stream: true, stream_options: { extra: 4 } }, bridge('chat', 'chat'));
  expect('body' in result && result.body.stream_options).toEqual({ extra: 4, include_usage: true });
  expect('clientWantsUsage' in result && result.clientWantsUsage).toBe(false);
  const asked = bridgeRequest({ stream_options: { include_usage: true } }, bridge('chat', 'chat'));
  expect('clientWantsUsage' in asked && asked.clientWantsUsage).toBe(true);
  const other = bridgeRequest({ stream: true, messages: [] }, bridge('messages', 'chat'));
  expect('body' in other && other.body.stream_options).toEqual({ include_usage: true });
  expect('clientWantsUsage' in other && other.clientWantsUsage).toBe(false);
});

test('rule 4: translate requests', () => {
  const request = { messages: [{ role: 'user', content: 'hi' }] };
  const toMessages = bridgeRequest(request, bridge('chat', 'messages'));
  expect('body' in toMessages && toMessages.body.max_tokens).toBe(100);
  const toChat = bridgeRequest(request, bridge('messages', 'chat'));
  expect('body' in toChat && toChat.body.model).toBe('chosen');
});

test('rule 4: preserve refusals', () => {
  const request = { messages: [{ role: 'user', content: 'hi' }] };
  expect(bridgeRequest({ ...request, n: 2 }, bridge('chat', 'messages')))
    .toHaveProperty('refused.param', 'n');
  expect(bridgeRequest({ ...request, container: {} }, bridge('messages', 'chat')))
    .toHaveProperty('refused.param', 'container');
});

test('rule 5: stream requires literal true', () => {
  for (const value of [true, false, 1, 'true', undefined]) {
    const result = bridgeRequest({ stream: value }, bridge('chat', 'chat'));
    expect('stream' in result && result.stream).toBe(value === true);
  }
});

test('rule 6: complete response must be a JSON object', () => {
  for (const value of ['oops', '[]', 'null']) {
    expect(bridgeResponse(value, bridge('chat', 'chat')).ok).toBe(false);
  }
});

test('rule 7: upstream error in a 200 response fails', () => {
  expect(bridgeResponse('{"error":{"message":"bad"}}', bridge('chat', 'chat')))
    .toEqual({ ok: false, reason: 'bad' });
  expect(bridgeResponse('{"type":"error","error":{"message":"bad"}}', bridge('chat', 'messages')))
    .toEqual({ ok: false, reason: 'bad' });
});

test('rule 8: same protocol complete response is unchanged with usage', () => {
  for (const protocol of protocols) {
    const usage = protocol === 'chat' ? { prompt_tokens: 3, completion_tokens: 2 }
      : { input_tokens: 3, output_tokens: 2 };
    const text = ` ${JSON.stringify({ usage })} `;
    const result = bridgeResponse(text, bridge(protocol, protocol));
    expect(result.ok && result.body).toBe(text);
    expect(result.ok && result.usage?.inputTokens).toBe(3);
  }
});

test('rule 9: translate complete response in both directions', () => {
  const chat = JSON.stringify({ id: 'id', model: 'm', choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 3, completion_tokens: 2 } });
  const result = bridgeResponse(chat, bridge('messages', 'chat'));
  expect(result.ok && JSON.parse(result.body).type).toBe('message');
  expect(result.ok && result.usage?.outputTokens).toBe(2);
  const messages = JSON.stringify({
    id: 'id',
    type: 'message',
    model: 'm',
    content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: 3, output_tokens: 2 },
  });
  const reverse = bridgeResponse(messages, bridge('chat', 'messages'));
  expect(reverse.ok && JSON.parse(reverse.body).created).toBe(123);
  expect(reverse.ok && reverse.usage?.outputTokens).toBe(2);
});

test('rule 9: report translator errors', () => {
  expect(bridgeResponse('{}', bridge('chat', 'messages'))).toEqual({
    ok: false,
    reason: 'The upstream response is not a message',
  });
  expect(bridgeResponse('{}', bridge('messages', 'chat'))).toEqual({
    ok: false,
    reason: 'Invalid chat completion',
  });
});

for (const inbound of protocols) {
  for (const upstream of protocols) {
    for (const bytes of [false, true]) {
      const label = `${inbound}/${upstream} bytes=${bytes}`;
      test(`rule 10: hold preamble until content ${label}`, async () => {
        const result = await bridgeStream(
          source(parts(upstream).join(''), bytes), bridge(inbound, upstream), true,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const text = await collect(result.body);
        assertNormal(text, inbound, upstream);
      });
      test(`rule 11: in-band error before content ${label}`, async () => {
        const result = await bridgeStream(
          source(errorFrame(upstream), bytes), bridge(inbound, upstream), true,
        );
        expect(result).toEqual({ ok: false, reason: 'broken' });
      });
      test(`rule 11: read error before content ${label}`, async () => {
        const failed = await bridgeStream(source('', bytes, true), bridge(inbound, upstream), true);
        expect(failed).toEqual({ ok: false, reason: 'read failed' });
      });
      test(`rule 11: end frame before content ${label}`, async () => {
        const result = await bridgeStream(
          source(parts(upstream).at(-1) ?? '', bytes), bridge(inbound, upstream), true,
        );
        expect(result.ok).toBe(false);
      });
      test(`rule 11: stream end before content ${label}`, async () => {
        const result = await bridgeStream(source('', bytes), bridge(inbound, upstream), true);
        expect(result.ok).toBe(false);
      });
      test(`rule 14: translate stream ${label}`, async () => {
        const result = await bridgeStream(
          source(parts(upstream).join(''), bytes), bridge(inbound, upstream), true,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        assertNormal(await collect(result.body), inbound, upstream);
      });
      test(`rule 17: normal end records usage ${label}`, async () => {
        const result = await bridgeStream(
          source(parts(upstream).join(''), bytes), bridge(inbound, upstream), true,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        assertNormal(await collect(result.body), inbound, upstream);
        expect(await result.finished).toEqual({
          usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 },
          error: null,
          cancelled: false,
        });
      });
      test(`rule 15: in-band error after content stops the stream ${label}`, async () => {
        const text = parts(upstream).slice(0, 3).join('') + errorFrame(upstream) + parts(upstream).join('');
        const result = await bridgeStream(source(text, bytes), bridge(inbound, upstream), true);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const output = await collect(result.body);
        assertFailure(output, inbound, upstream, 'broken');
        expect((await result.finished).error).toBe('broken');
      });
      for (const fail of [false, true]) {
        test(`rule 16: ${fail ? 'read error' : 'truncated stream'} closes with error ${label}`, async () => {
          const text = parts(upstream).slice(0, 3).join('');
          const result = await bridgeStream(source(text, bytes, fail), bridge(inbound, upstream), true);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const reason = fail ? 'read failed' : 'Upstream stream ended before terminator';
          assertFailure(await collect(result.body), inbound, upstream, reason);
          expect((await result.finished).error).not.toBeNull();
        });
      }
      test(`rule 18: cancellation resolves and cancels upstream ${label}`, async () => {
        let cancelled = false;
        const chunks = new TextEncoder().encode(parts(upstream).slice(0, 3).join(''));
        let offset = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= chunks.length) return;
            const end = bytes ? offset + 1 : chunks.length;
            controller.enqueue(chunks.slice(offset, end));
            offset = end;
          },
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 });
        const result = await bridgeStream(stream, bridge(inbound, upstream), true);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        await result.body.cancel();
        expect(cancelled).toBe(true);
        expect(await result.finished).toEqual({ usage: null, error: null, cancelled: true });
      });
    }
  }
}

test('rule 10: preamble alone cannot open a response', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  controller.enqueue(new TextEncoder().encode(chatParts[0] + chatParts[1]));
  let opened = false;
  const promise = bridgeStream(stream, bridge('chat', 'chat'), true).then((result) => {
    opened = true;
    return result;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(opened).toBe(false);
  controller.enqueue(new TextEncoder().encode(chatParts[2]));
  const result = await promise;
  expect(result.ok).toBe(true);
  if (result.ok) await result.body.cancel();
});

test('rule 11: end before content fails even while upstream stays open', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      controller.enqueue(new TextEncoder().encode(chatParts[1] + chatParts[6]));
    },
    pull() { return new Promise<void>(() => {}); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('end frame was not handled')), 1000);
    });
    const result = await Promise.race([bridgeStream(stream, bridge('chat', 'chat'), true), timeout]);
    expect(result.ok).toBe(false);
    expect(cancelled).toBe(true);
  } finally {
    clearTimeout(timer);
    controller.error(new Error('test cleanup'));
  }
});

test('rule 14: everything the writer yields for the last upstream frame reaches the client', async () => {
  const result = await bridgeStream(source(chatParts.join(''), true), bridge('messages', 'chat'), true);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const text = await collect(result.body);
  assertNormal(text, 'messages', 'chat');
  expect(text.endsWith(event('message_stop'))).toBe(true);
});

test('rule 17: unterminated final block is passed through and ends normally', async () => {
  const text = chatParts.slice(0, -1).join('') + 'data: [DONE]';
  const result = await bridgeStream(source(text, true), bridge('chat', 'chat'), true);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(await collect(result.body)).toBe(text);
  expect((await result.finished).error).toBeNull();
});

for (const protocol of protocols) {
  test(`rule 12: raw transcript survives byte chunks ${protocol}`, async () => {
    const text = parts(protocol).join('');
    const result = await bridgeStream(source(text, true), bridge(protocol, protocol), true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(await collect(result.body)).toBe(text);
  });
}

test('rule 13: Chat only hides unrequested usage but records it, byte chunks', async () => {
  const result = await bridgeStream(source(chatParts.join(''), true), bridge('chat', 'chat'), false);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(await collect(result.body)).toBe(chatParts.filter((_, index) => index !== 5).join(''));
  expect((await result.finished).usage?.inputTokens).toBe(3);
});

test('rule 13: held usage before content is recorded but not sent to Chat', async () => {
  const text = chatParts[0] + chatParts[5] + chatParts[1] + chatParts[2] + chatParts[6];
  const result = await bridgeStream(source(text, true), bridge('chat', 'chat'), false);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(await collect(result.body)).toBe(chatParts[0] + chatParts[1] + chatParts[2] + chatParts[6]);
  expect((await result.finished).usage?.inputTokens).toBe(3);
});

for (const inbound of protocols) {
  for (const upstream of protocols) {
    test(`rule 14: split UTF-8 character survives ${inbound}/${upstream}`, async () => {
      const text = parts(upstream).join('');
      const data = new TextEncoder().encode(text);
      const character = new TextEncoder().encode('你');
      const split = data.indexOf(character[0]) + 1;
      expect(split).toBeGreaterThan(0);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data.slice(0, split));
          controller.enqueue(data.slice(split));
          controller.close();
        },
      });
      const result = await bridgeStream(stream, bridge(inbound, upstream), true);
      expect(result.ok).toBe(true);
      if (result.ok) assertNormal(await collect(result.body), inbound, upstream);
    });
  }
}

test('rule 18: cancel while an upstream read is pending', async () => {
  let notify!: () => void;
  const waiting = new Promise<void>((resolve) => { notify = resolve; });
  let cancelled = false;
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(chatParts.slice(0, 3).join('')));
      } else {
        notify();
      }
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const result = await bridgeStream(stream, bridge('chat', 'chat'), true);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const reader = result.body.getReader();
  await reader.read();
  await reader.read();
  await reader.read();
  const pending = reader.read();
  await waiting;
  await reader.cancel();
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(cancelled).toBe(true);
  expect(await result.finished).toEqual({ usage: null, error: null, cancelled: true });
});

test('rule 19: no upstream reads until the consumer pulls', async () => {
  let pulls = 0;
  const chunks = chatParts.map((part) => new TextEncoder().encode(part));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  }, { highWaterMark: 0 });
  const result = await bridgeStream(stream, bridge('chat', 'chat'), true);
  expect(result.ok).toBe(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(pulls).toBe(3);
  if (!result.ok) return;
  const reader = result.body.getReader();
  // Opening consumes three frames; the first three reads drain them, then each read needs one frame.
  for (const expected of [3, 3, 3, 4, 5, 6, 7]) {
    expect((await reader.read()).done).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(pulls).toBe(expected);
  }
  expect((await reader.read()).done).toBe(true);
});

// ---------------------------------------------------------------------------------------
// The Responses API, in both directions and through the Chat hub

const every: Protocol[] = ['chat', 'messages', 'responses'];

const responsesParts = [
  ': keepalive\n\n',
  event('response.created', {
    response: { id: 'resp_1', model: 'r', status: 'in_progress', usage: null },
  }),
  event('response.in_progress', { response: { id: 'resp_1', status: 'in_progress' } }),
  event('response.output_item.added', {
    output_index: 0,
    item: { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] },
  }),
  event('response.content_part.added', {
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  }),
  event('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: '你' }),
  event('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: '好' }),
  event('response.output_text.done', { item_id: 'msg_1', output_index: 0, content_index: 0, text: '你好' }),
  event('response.content_part.done', {
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '你好', annotations: [] },
  }),
  event('response.output_item.done', {
    output_index: 0,
    item: {
      id: 'msg_1',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '你好', annotations: [] }],
    },
  }),
  event('response.completed', {
    response: {
      id: 'resp_1',
      model: 'r',
      status: 'completed',
      output: [],
      usage: { input_tokens: 3, output_tokens: 2 },
    },
  }),
];

const everyParts = (protocol: Protocol): string[] =>
  protocol === 'chat' ? chatParts : protocol === 'messages' ? messagesParts : responsesParts;

const upstreamError = (protocol: Protocol): string => protocol === 'responses'
  ? 'event: error\ndata: {"type":"error","code":"server_error","message":"broken"}\n\n'
  : errorFrame(protocol);

/** The frames before and including the first content frame of each upstream transcript. */
const contentPrefix = (protocol: Protocol): string[] =>
  protocol === 'chat' ? chatParts.slice(0, 3)
    : protocol === 'messages' ? messagesParts.slice(0, 3) : responsesParts.slice(0, 4);

/** The frames before and including the first text delta of each upstream transcript. */
const textPrefix = (protocol: Protocol): string[] =>
  protocol === 'chat' ? chatParts.slice(0, 3)
    : protocol === 'messages' ? messagesParts.slice(0, 4) : responsesParts.slice(0, 6);

/** The text a client of `inbound` received in a translated stream. */
function receivedText(text: string, inbound: Protocol): string {
  const parts: string[] = [];
  for (const frame of new SseParser().push(text)) {
    if (frame.data === null || frame.data === '[DONE]') continue;
    const value: unknown = JSON.parse(frame.data);
    if (inbound === 'chat') {
      if (!isObject(value) || !Array.isArray(value.choices)) continue;
      for (const choice of value.choices) {
        if (isObject(choice) && isObject(choice.delta) && typeof choice.delta.content === 'string') {
          parts.push(choice.delta.content);
        }
      }
    } else if (inbound === 'messages') {
      if (isObject(value) && value.type === 'content_block_delta' && isObject(value.delta) &&
          value.delta.type === 'text_delta' && typeof value.delta.text === 'string') {
        parts.push(value.delta.text);
      }
    } else if (isObject(value) && value.type === 'response.output_text.delta' &&
        typeof value.delta === 'string') {
      parts.push(value.delta);
    }
  }
  return parts.join('');
}

const terminalFrame = (protocol: Protocol): string =>
  protocol === 'chat' ? 'data: [DONE]\n\n'
    : protocol === 'messages' ? 'event: message_stop\n' : 'event: response.completed\n';

const chatComplete = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
});
const messagesComplete = JSON.stringify({
  id: 'msg_1',
  type: 'message',
  model: 'm',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 2 },
});
const responsesComplete = JSON.stringify({
  id: 'resp_1',
  object: 'response',
  model: 'r',
  status: 'completed',
  output: [{
    id: 'msg_1',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  }],
  usage: { input_tokens: 3, output_tokens: 2 },
});

test('every protocol pair can be served', () => {
  for (const inbound of every) {
    for (const upstream of every) expect(canServe(inbound, upstream)).toBe(true);
  }
});

test('responses same protocol preserves unknown fields', () => {
  const result = bridgeRequest({ model: 'old', invented: 7, input: 'hi' }, bridge('responses', 'responses'));
  expect('body' in result && result.body).toEqual({ model: 'chosen', invented: 7, input: 'hi' });
});

test('a Chat request becomes a Responses request', () => {
  const request = {
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
    max_completion_tokens: 9,
  };
  const result = bridgeRequest(request, bridge('chat', 'responses'));
  expect(result).toMatchObject({
    body: {
      model: 'chosen',
      instructions: 's',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      max_output_tokens: 9,
    },
  });
});

test('a Messages request becomes a Responses request through Chat', () => {
  const request = { system: 's', messages: [{ role: 'user', content: 'hi' }] };
  const result = bridgeRequest(request, bridge('messages', 'responses'));
  expect(result).toMatchObject({
    body: {
      model: 'chosen',
      instructions: 's',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
    },
  });
});

test('a Responses request becomes a Chat request', () => {
  const result = bridgeRequest({ instructions: 's', input: 'hi' }, bridge('responses', 'chat'));
  expect(result).toMatchObject({
    body: {
      model: 'chosen',
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
    },
  });
});

test('a Responses request becomes a Messages request through Chat', () => {
  const result = bridgeRequest(
    { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
    bridge('responses', 'messages'),
  );
  expect(result).toMatchObject({
    body: {
      model: 'chosen',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 100,
    },
  });
});

test('streaming to a Responses client asks a Chat upstream for usage', () => {
  const result = bridgeRequest({ input: 'hi', stream: true }, bridge('responses', 'chat'));
  expect('body' in result && result.body.stream_options).toEqual({ include_usage: true });
  expect('clientWantsUsage' in result && result.clientWantsUsage).toBe(false);
});

test('refusals survive every new route', () => {
  expect(bridgeRequest({ input: 'hi', store: true }, bridge('responses', 'chat')))
    .toHaveProperty('refused.param', 'store');
  expect(bridgeRequest({ input: 'hi', previous_response_id: 'r' }, bridge('responses', 'messages')))
    .toHaveProperty('refused.param', 'previous_response_id');
  expect(bridgeRequest({ messages: [{ role: 'user', content: 'hi' }], stop: 'x' }, bridge('chat', 'responses')))
    .toHaveProperty('refused.param', 'stop');
  expect(bridgeRequest({ messages: [{ role: 'user', content: 'hi' }], stop_sequences: ['x'] },
    bridge('messages', 'responses')))
    .toHaveProperty('refused.param', 'stop');
});

test('a Responses same-protocol complete response is unchanged, with usage', () => {
  const result = bridgeResponse(responsesComplete, bridge('responses', 'responses'));
  expect(result.ok && result.body).toBe(responsesComplete);
  expect(result.ok && result.usage).toEqual({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 });
});

test('a Responses upstream complete response becomes Chat', () => {
  const result = bridgeResponse(responsesComplete, bridge('chat', 'responses'));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(JSON.parse(result.body)).toMatchObject({
    id: 'resp_1',
    object: 'chat.completion',
    created: 123,
    model: 'r',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  });
  expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 });
});

test('a Responses upstream complete response becomes Messages through Chat', () => {
  const result = bridgeResponse(responsesComplete, bridge('messages', 'responses'));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(JSON.parse(result.body)).toMatchObject({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
  });
  expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 });
});

test('a Chat upstream complete response becomes Responses', () => {
  const result = bridgeResponse(chatComplete, bridge('responses', 'chat'));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(JSON.parse(result.body)).toMatchObject({
    id: 'resp_chatcmpl-1',
    object: 'response',
    created_at: 123,
    status: 'completed',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hi', annotations: [] }],
    }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });
  expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 });
});

test('a Messages upstream complete response becomes Responses through Chat', () => {
  const result = bridgeResponse(messagesComplete, bridge('responses', 'messages'));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(JSON.parse(result.body)).toMatchObject({
    id: 'resp_msg_1',
    object: 'response',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
  });
});

for (const inbound of ['chat', 'messages'] as const) {
  test(`a Responses body that is not a response is reported to the ${inbound} client`, () => {
    expect(bridgeResponse('{}', bridge(inbound, 'responses'))).toEqual({
      ok: false,
      reason: 'The upstream response is not a response',
    });
  });
}

test('a Chat body that is not a chat completion is reported to the Messages client', () => {
  expect(bridgeResponse('{}', bridge('messages', 'chat'))).toEqual({
    ok: false,
    reason: 'Invalid chat completion',
  });
});

test('a Messages body that is not a message is reported to the Responses client', () => {
  expect(bridgeResponse('{}', bridge('responses', 'messages'))).toEqual({
    ok: false,
    reason: 'The upstream response is not a message',
  });
});

for (const inbound of ['chat', 'messages', 'responses'] as const) {
  for (const upstream of ['chat', 'messages', 'responses'] as const) {
    if (inbound !== 'responses' && upstream !== 'responses') continue;
    for (const bytes of [false, true]) {
      test(`responses bridge: normal stream ${inbound}/${upstream} bytes=${bytes}`, async () => {
        const text = everyParts(upstream).join('');
        const result = await bridgeStream(source(text, bytes), bridge(inbound, upstream), true);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const output = await collect(result.body);
        if (inbound === upstream) {
          expect(output).toBe(text);
        } else {
          expect(receivedText(output, inbound)).toBe('你好');
          expect(output.includes(terminalFrame(inbound))).toBe(true);
        }
        expect(await result.finished).toEqual({
          usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 },
          error: null,
          cancelled: false,
        });
      });
    }
  }
}

for (const inbound of ['chat', 'messages', 'responses'] as const) {
  for (const upstream of ['chat', 'messages', 'responses'] as const) {
    if (inbound !== 'responses' && upstream !== 'responses') continue;
    test(`responses bridge: in-band error before content ${inbound}/${upstream}`, async () => {
      const result = await bridgeStream(
        source(upstreamError(upstream), true), bridge(inbound, upstream), true,
      );
      expect(result).toEqual({ ok: false, reason: 'broken' });
    });
    test(`responses bridge: in-band error after content ${inbound}/${upstream}`, async () => {
      const text = contentPrefix(upstream).join('') + upstreamError(upstream);
      const result = await bridgeStream(source(text, true), bridge(inbound, upstream), true);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const output = await collect(result.body);
      expect(output).toContain('broken');
      expect((await result.finished).error).toBe('broken');
    });
  }
}

test('a truncated Responses stream still finishes a Chat answer, and reports the cut', async () => {
  const result = await bridgeStream(
    source(textPrefix('responses').join(''), true), bridge('chat', 'responses'), true,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const output = await collect(result.body);
  expect(receivedText(output, 'chat')).toBe('你');
  expect(output.endsWith('data: [DONE]\n\n')).toBe(true);
  expect((await result.finished).error).toBe('Upstream stream ended before terminator');
});

test('a truncated Responses stream still finishes a Messages answer, and reports the cut', async () => {
  const result = await bridgeStream(
    source(textPrefix('responses').join(''), true), bridge('messages', 'responses'), true,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const output = await collect(result.body);
  expect(receivedText(output, 'messages')).toBe('你');
  expect(output.includes('event: message_stop\n')).toBe(true);
  expect((await result.finished).error).toBe('Upstream stream ended before terminator');
});

test('a truncated Chat stream still finishes a Responses answer, and reports the cut', async () => {
  const result = await bridgeStream(
    source(textPrefix('chat').join(''), true), bridge('responses', 'chat'), true,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const output = await collect(result.body);
  expect(receivedText(output, 'responses')).toBe('你');
  expect(output.includes('event: response.completed\n')).toBe(true);
  expect((await result.finished).error).toBe('Upstream stream ended before terminator');
});

test('a truncated Messages stream reaches a Responses client as an error', async () => {
  const result = await bridgeStream(
    source(contentPrefix('messages').join(''), true), bridge('responses', 'messages'), true,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const output = await collect(result.body);
  expect(output).toContain('error');
  expect((await result.finished).error).toBe('Upstream stream ended before terminator');
});

test('a truncated Responses stream passes its error frame to a Responses client', async () => {
  const result = await bridgeStream(
    source(contentPrefix('responses').join(''), true), bridge('responses', 'responses'), true,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const output = await collect(result.body);
  expect(output).toContain('Upstream stream ended before terminator');
  expect((await result.finished).error).toBe('Upstream stream ended before terminator');
});

test('a Responses upstream that only sent preamble cannot open a Chat answer', async () => {
  const preamble = responsesParts.slice(0, 3).join('');
  const result = await bridgeStream(source(preamble, true), bridge('chat', 'responses'), true);
  expect(result).toEqual({ ok: false, reason: 'Upstream stream ended before content' });
});
