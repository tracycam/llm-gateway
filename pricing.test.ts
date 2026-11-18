import { expect, test } from 'bun:test';
import { costOf, type Price, type Usage } from './pricing';

const usage: Usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10 };
const price: Price = { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 };

test('null usage has unknown cost', () => {
  expect(costOf(null, price)).toBeNull();
});

test('null input or output price has unknown cost', () => {
  expect(costOf(usage, { ...price, input: null })).toBeNull();
  expect(costOf(usage, { ...price, output: null })).toBeNull();
});

test('zero prices are free', () => {
  expect(costOf(usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
});

test('null cache prices fall back to input price', () => {
  expect(costOf(usage, { ...price, cacheRead: null, cacheWrite: null })).toBe(460 / 1_000_000);
});

test('cost uses all four measured token categories', () => {
  expect(costOf(usage, price)).toBe(450 / 1_000_000);
});
