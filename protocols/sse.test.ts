// SSE framing rules and raw stream preservation.
import { expect, test } from 'bun:test';
import { SseParser } from './sse';

for (const [name, eol] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']] as const) {
  test(`${name} line endings delimit blocks`, () => {
    const parser = new SseParser();
    const received = parser.push(`data: x${eol}${eol}`);
    expect([...received, ...parser.end()]).toEqual([
      { raw: `data: x${eol}${eol}`, event: null, data: 'x' },
    ]);
  });
}

test('CRLF split between chunks preserves the CR', () => {
  const parser = new SseParser();
  expect(parser.push('data: x\r')).toEqual([]);
  expect(parser.push('\n\r\n')[0].raw).toBe('data: x\r\n\r\n');
});

test('data fields accept an optional space', () => {
  const parser = new SseParser();
  expect(parser.push('data:x\n\ndata: y\n\n').map((frame) => frame.data)).toEqual(['x', 'y']);
});

test('multiple data lines are joined with a newline', () => {
  expect(new SseParser().push('data: one\ndata: two\n\n')[0].data).toBe('one\ntwo');
});

test('comment-only block has null data', () => {
  expect(new SseParser().push(': comment\n\n')[0].data).toBeNull();
});

test('field without colon has an empty value', () => {
  expect(new SseParser().push('data\n\n')[0].data).toBe('');
});

test('event field supplies the event name', () => {
  expect(new SseParser().push('event: ping\ndata: x\n\n')[0].event).toBe('ping');
});

test('event of one block does not carry over to the next block', () => {
  const frames = new SseParser().push('event: ping\ndata: x\n\ndata: y\n\n');
  expect(frames.map((frame) => frame.event)).toEqual(['ping', null]);
});

test('end returns an unterminated last block', () => {
  const parser = new SseParser();
  expect(parser.push('data: last')).toEqual([]);
  expect(parser.end()).toEqual([{ raw: 'data: last', event: null, data: 'last' }]);
});

test('end on a clean stream returns nothing', () => {
  const parser = new SseParser();
  parser.push('data: x\n\n');
  expect(parser.end()).toEqual([]);
});

test('concatenated raw equals input at every split offset', () => {
  const text = ': comment\r\nevent: hi\r\ndata: one\r\ndata:two\r\n\r\ndata:x\r\rdata: y\n\n: last';
  const parser = new SseParser();
  const expected = [...parser.push(text), ...parser.end()];
  for (let i = 0; i <= text.length; i++) {
    const split = new SseParser();
    const frames = [...split.push(text.slice(0, i)), ...split.push(text.slice(i)), ...split.end()];
    expect(frames).toEqual(expected);
    expect(frames.map((frame) => frame.raw).join('')).toBe(text);
  }
});
