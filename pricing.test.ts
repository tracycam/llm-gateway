import { expect, test } from 'bun:test';
import { costOf, type Price, type Usage } from './pricing';

const usage: Usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 };
const price: Price = { input: 2, output: 4, cacheRead: 1 };

test('null usage has unknown cost', () => {
  expect(costOf(null, price)).toBeNull();
});

test('null input or output price has unknown cost', () => {
  expect(costOf(usage, { ...price, input: null })).toBeNull();
  expect(costOf(usage, { ...price, output: null })).toBeNull();
});

test('zero prices are free', () => {
  expect(costOf(usage, { input: 0, output: 0, cacheRead: 0 })).toBe(0);
});

test('cache reads are costed at the cache-read price', () => {
  // 100 input at 2 + 50 output at 4 + 20 cache reads at 1, per 1M tokens.
  expect(costOf(usage, price)).toBe(420 / 1_000_000);
});

test('a null cache-read price falls back to the input price', () => {
  // 100 input at 2 + 50 output at 4 + 20 cache reads at 2, per 1M tokens.
  expect(costOf(usage, { ...price, cacheRead: null })).toBe(440 / 1_000_000);
});

test('a usage and a price have exactly the three billing kinds, with no fourth term', () => {
  expect(Object.keys(usage).sort()).toEqual(['cacheReadTokens', 'inputTokens', 'outputTokens']);
  expect(Object.keys(price).sort()).toEqual(['cacheRead', 'input', 'output']);
});
