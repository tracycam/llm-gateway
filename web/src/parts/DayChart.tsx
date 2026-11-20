import { useState } from 'react';
import type { UsageByDayRow } from '@shared/api';
import { cn } from '@/lib/utils';
import { formatCount, formatUsd, shiftDay } from '../format';
import { totalInput } from './usage';

export type Metric = 'cost' | 'requests' | 'tokens';

function value(row: UsageByDayRow | undefined, metric: Metric): number {
  if (!row) return 0;
  if (metric === 'cost') return row.cost;
  if (metric === 'requests') return row.requests;
  return totalInput(row) + row.outputTokens;
}

function write(amount: number, metric: Metric): string {
  return metric === 'cost' ? formatUsd(amount) : formatCount(amount);
}

/** Every calendar day from `from` to `to`, both included. */
function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to && days.length < 3660; day = shiftDay(day, 1)) days.push(day);
  return days;
}

/**
 * The top of the axis: the peak rounded up to 1, 2, 2.5 or 5 times a power of ten, so the
 * gridline halfway up lands on a round figure. Counts keep a top of at least 2 so that
 * halfway is a whole number.
 */
function axisTop(peak: number, metric: Metric): number {
  if (peak <= 0) return 0;
  const power = 10 ** Math.floor(Math.log10(peak));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => peak <= candidate * power * (1 + 1e-9)) ?? 10;
  const top = step * power;
  return metric === 'cost' ? top : Math.max(2, Math.ceil(top));
}

/** At most six dated days, counted back from the last so today is always dated. */
function labelled(count: number): (index: number) => boolean {
  const step = Math.max(1, Math.ceil((count - 1) / 5));
  return (index) => (count - 1 - index) % step === 0;
}

/** A bar or part of a bar that is not 0 is never drawn lower than this, in pixels. */
const MIN_PX = 2;

function share(part: number, whole: number): string {
  if (whole === 0) return '';
  const percent = (part / whole) * 100;
  return ` (${percent > 0 && percent < 1 ? '<1' : Math.round(percent)}%)`;
}

/**
 * One slot per calendar day, on an axis with a gridline at the top, halfway and at zero. A
 * day the report does not list had no recorded request and draws no bar. With requests as the
 * metric, the failed requests are the red foot of each bar, on the same scale as the rest.
 */
export function DayChart({
  rows, from, to, metric,
}: {
  rows: readonly UsageByDayRow[];
  /** The first and last day to draw. */
  from: string;
  to: string;
  metric: Metric;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days = daysBetween(from, to);
  const peak = Math.max(0, ...days.map((day) => value(byDay.get(day), metric)));
  const top = axisTop(peak, metric);
  const focus = hovered ? byDay.get(hovered) : undefined;
  const hasLabel = labelled(days.length);
  const ticks = top > 0 ? [top, top / 2, 0] : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-5 flex-wrap items-baseline gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
        {hovered ? (
          <>
            <span className="font-medium text-foreground">{hovered}</span>
            {focus ? (
              <>
                <span><span className="text-foreground">{formatCount(focus.requests)}</span> 请求</span>
                <span className={cn(focus.errors > 0 && 'text-destructive')}>
                  {formatCount(focus.errors)} 失败{share(focus.errors, focus.requests)}
                </span>
                <span><span className="text-foreground">{formatCount(totalInput(focus) + focus.outputTokens)}</span> Token</span>
                <span className="text-foreground">{formatUsd(focus.cost)}</span>
              </>
            ) : <span>无请求</span>}
          </>
        ) : (
          <>
            <span>{from} – {to}</span>
            {metric === 'requests' && (
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-brand" />成功</span>
                <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-destructive" />失败</span>
              </span>
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
        <div className="relative h-48 min-w-8 text-right text-xs leading-none text-muted-foreground tabular-nums">
          {ticks.map((tick, index) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 whitespace-nowrap"
              style={{ top: `${index * 50}%` }}
            >
              {write(tick, metric)}
            </span>
          ))}
        </div>

        <div className="relative h-48" onMouseLeave={() => setHovered(null)}>
          {[0, 50].map((offset) => (
            <div key={offset} className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border" style={{ top: `${offset}%` }} />
          ))}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-foreground/25" />
          {top === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">这段时间没有请求</div>
          )}
          <div className="absolute inset-0 flex items-stretch">
            {days.map((day) => {
              const row = byDay.get(day);
              const amount = value(row, metric);
              const failed = metric === 'requests' && row ? row.errors : 0;
              const ok = amount - failed;
              const height = (part: number) => (part > 0 && top > 0 ? `max(${MIN_PX}px, ${(part / top) * 100}%)` : '0px');
              return (
                <div
                  key={day}
                  data-day={day}
                  className={cn('flex min-w-0 flex-1 flex-col items-center justify-end rounded-sm transition-colors duration-150', hovered === day && 'bg-muted/70')}
                  onMouseEnter={() => setHovered(day)}
                >
                  {ok > 0 && (
                    <div
                      className={cn('w-3/5 max-w-8 rounded-t-[3px] bg-brand transition-opacity duration-150', hovered !== null && hovered !== day && 'opacity-60', failed > 0 && 'mb-px')}
                      style={{ height: height(ok) }}
                    />
                  )}
                  {failed > 0 && (
                    <div
                      className={cn('w-3/5 max-w-8 bg-destructive transition-opacity duration-150', ok === 0 && 'rounded-t-[3px]', hovered !== null && hovered !== day && 'opacity-60')}
                      style={{ height: height(failed) }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div />
        <div className="relative flex h-4 text-xs text-muted-foreground tabular-nums">
          {days.map((day, index) => (
            <div key={day} className="relative min-w-0 flex-1">
              {hasLabel(index) && (
                <span
                  className={cn(
                    'absolute top-0 whitespace-nowrap',
                    index === 0 && days.length > 1 ? 'left-0' : index === days.length - 1 && days.length > 1 ? 'right-0' : 'left-1/2 -translate-x-1/2',
                    hovered === day && 'text-foreground',
                  )}
                >
                  {day.slice(5)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
