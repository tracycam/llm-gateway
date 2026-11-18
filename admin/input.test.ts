// Boundary reader behavior.
import { expect, test } from 'bun:test';
import { InputError, pathId, readBody } from './input';

test('rule 1: malformed JSON is rejected', async () => {
  const req = new Request('http://localhost', { method: 'POST', body: '{' });
  await expect(readBody(req)).rejects.toThrow('请求体无效');
});

for (const body of [null, [], 1, 'text']) {
  test(`rule 1: non-object ${JSON.stringify(body)} is rejected`, async () => {
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) });
    await expect(readBody(req)).rejects.toBeInstanceOf(InputError);
  });
}

test('rule 1: unexpected body read error propagates', async () => {
  const req = new Request('http://localhost', { method: 'POST', body: '{}' });
  await req.text();
  await expect(readBody(req)).rejects.toBeInstanceOf(TypeError);
});

test('rule 6: path segment is decoded once and slash is rejected', () => {
  expect(pathId('x%252Fy')).toBe('x%2Fy');
  expect(pathId('x%2Fy')).toBeNull();
  expect(pathId('%XX')).toBeNull();
});
