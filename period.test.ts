import { expect, test } from 'bun:test';
import { localDay, nextReset, periodStart } from './period';

process.env.TZ = 'Europe/Berlin';

test('none has no period boundary', () => {
  const now = new Date('2024-03-31T12:00:00Z');
  expect(periodStart('none', now)).toBeNull();
  expect(nextReset('none', now)).toBeNull();
});

test('local day handles UTC date boundary', () => {
  expect(localDay(new Date('2024-03-31T22:30:00Z'))).toBe('2024-04-01');
});

test('day boundaries follow DST', () => {
  const now = new Date('2024-03-31T12:00:00Z');
  expect(periodStart('day', now)?.toISOString()).toBe('2024-03-30T23:00:00.000Z');
  expect(nextReset('day', now)?.toISOString()).toBe('2024-03-31T22:00:00.000Z');
});

test('week starts Monday and crosses DST', () => {
  const now = new Date('2024-03-31T12:00:00Z');
  expect(periodStart('week', now)?.toISOString()).toBe('2024-03-24T23:00:00.000Z');
  expect(nextReset('week', now)?.toISOString()).toBe('2024-03-31T22:00:00.000Z');
});

test('month boundaries handle month end', () => {
  const now = new Date('2024-01-31T12:00:00Z');
  expect(periodStart('month', now)?.toISOString()).toBe('2023-12-31T23:00:00.000Z');
  expect(nextReset('month', now)?.toISOString()).toBe('2024-01-31T23:00:00.000Z');
});
