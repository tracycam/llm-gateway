import type { ResetPeriod } from './shared/api';

// `ResetPeriod` crosses the management API; shared/api.ts defines it once.
export type { ResetPeriod };

export function periodStart(period: ResetPeriod, now: Date): Date | null {
  if (period === 'none') return null;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  if (period === 'month') start.setDate(1);
  return start;
}

export function nextReset(period: ResetPeriod, now: Date): Date | null {
  const next = periodStart(period, now);
  if (next === null) return null;
  if (period === 'day') next.setDate(next.getDate() + 1);
  if (period === 'week') next.setDate(next.getDate() + 7);
  if (period === 'month') next.setMonth(next.getMonth() + 1);
  return next;
}

export function localDay(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
