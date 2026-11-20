// How the console writes numbers and times. Unknown is written as a dash, never as zero.
import type { Price, ResetPeriod } from '@shared/api';

/** What stands in for a value the gateway does not have. */
export const NONE = '—';

/**
 * A USD amount. One dollar and above: two decimals. Below one dollar: four significant digits
 * with trailing zeros dropped and at least two decimals, so $0.0000267 stays $0.0000267 and a
 * non-zero amount never reads as $0.00. Null is unknown.
 */
export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NONE;
  if (value === 0) return '$0.00';
  const sign = value < 0 ? '-' : '';
  const amount = Math.abs(value);
  if (amount >= 1) {
    return `${sign}$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  const decimals = Math.min(20, Math.max(2, 3 - Math.floor(Math.log10(amount))));
  const [whole, fraction = ''] = amount.toFixed(decimals).split('.');
  return `${sign}$${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

/** A price's input and output, USD per 1M tokens, as `$0.30 / $1.20`. */
export function formatPricePair(price: Price): string {
  return `${formatUsd(price.input)} / ${formatUsd(price.output)}`;
}

/** A whole number with thousands separators; null is unknown. */
export function formatCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NONE;
  return value.toLocaleString('en-US');
}

/** A duration measured in milliseconds; null is unknown, and under a millisecond is not 0. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return NONE;
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function parse(iso: string | null): Date | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** `2026-11-18 14:03`, in the browser's time zone. */
export function formatDateTime(iso: string | null): string {
  const date = parse(iso);
  if (!date) return NONE;
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** `11-18 14:03`: a moment at most a month away, where the year would only take room. */
export function formatDayTime(iso: string | null): string {
  const text = formatDateTime(iso);
  return text === NONE ? NONE : text.slice(5);
}

/** `2026-11-18`, the calendar day of a moment in the browser's time zone. */
export function formatDate(iso: string | null): string {
  const text = formatDateTime(iso);
  return text === NONE ? NONE : text.slice(0, 10);
}

/** `11-18 14:03:22`, for log rows. */
export function formatLogTime(iso: string): string {
  const date = parse(iso);
  if (!date) return NONE;
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** How long ago, in words; older than 30 days is written as the date. */
export function formatAgo(iso: string | null, now: Date = new Date()): string {
  const date = parse(iso);
  if (!date) return NONE;
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)} 天前`;
  return formatDateTime(iso).slice(0, 10);
}

/** The local calendar day of a moment, `YYYY-MM-DD`, as the usage report names days. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** The day `offset` days from `day`. */
export function shiftDay(day: string, offset: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return localDay(new Date(year, month - 1, date + offset));
}

/** An ISO time as the value of an `<input type="datetime-local">`. */
export function toLocalInput(iso: string | null): string {
  const date = parse(iso);
  if (!date) return '';
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

export const RESET_PERIOD_LABEL: Record<ResetPeriod, string> = {
  none: '不重置',
  day: '每日',
  week: '每周',
  month: '每月',
};

/** The two interfaces the log names, in words; anything else is shown as recorded. */
export function interfaceLabel(protocol: string): string {
  if (protocol === 'chat') return 'Chat';
  if (protocol === 'messages') return 'Messages';
  return protocol;
}
