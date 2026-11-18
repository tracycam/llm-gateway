import { expect, test } from 'bun:test';
import { bridgeRequest, bridgeResponse, bridgeStream, type Bridge } from './bridge';
import type { Protocol } from './protocol';
import { protocolModule } from './protocol';
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
