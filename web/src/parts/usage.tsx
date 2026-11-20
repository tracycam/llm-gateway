import { CircleAlertIcon } from 'lucide-react';
import type { UsageSummary } from '@shared/api';
import { TableCell, TableHead } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { NUM } from './layout';
import { Segmented } from './Segmented';
import type { UsageRange } from '../api';
import { formatCount, formatUsd, localDay, NONE, shiftDay } from '../format';

export type RangeKey = '7' | '30' | 'all';

const RANGE_LABEL: Record<RangeKey, string> = { '7': '7 天', '30': '30 天', all: '全部' };

/** The days a range key covers, ending today (the browser's calendar day). */
export function rangeOf(key: RangeKey, now: Date = new Date()): UsageRange {
  if (key === 'all') return {};
  const today = localDay(now);
  return { from: shiftDay(today, 1 - Number(key)), to: today };
}

export function RangePicker({ value, onChange }: { value: RangeKey; onChange: (next: RangeKey) => void }) {
  return (
    <Segmented
      label="时间范围"
      value={value}
      onChange={onChange}
      options={(Object.keys(RANGE_LABEL) as RangeKey[]).map((key) => ({ value: key, label: RANGE_LABEL[key] }))}
    />
  );
}

/** All the input of a group: plain input plus cache reads, which are disjoint. */
export function totalInput(row: UsageSummary): number {
  return row.inputTokens + row.cacheReadTokens;
}

/** Add up usage rows, for a table's total line. */
export function sumUsage(rows: readonly UsageSummary[]): UsageSummary {
  const total: UsageSummary = {
    requests: 0, errors: 0, unknownUsage: 0, uncosted: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0,
  };
  for (const row of rows) {
    total.requests += row.requests;
    total.errors += row.errors;
    total.unknownUsage += row.unknownUsage;
    total.uncosted += row.uncosted;
    total.inputTokens += row.inputTokens;
    total.outputTokens += row.outputTokens;
    total.cacheReadTokens += row.cacheReadTokens;
    total.cost += row.cost;
  }
  return total;
}

/**
 * True when none of the group's answered requests reported usage: its token counts are then
 * unknown, not 0.
 */
export function tokensUnknown(row: UsageSummary): boolean {
  const answered = row.requests - row.errors;
  return answered > 0 && row.unknownUsage >= answered;
}

/** True when none of the group's answered requests carries a cost: its cost is unknown, not 0. */
export function costUnknown(row: UsageSummary): boolean {
  const answered = row.requests - row.errors;
  return answered > 0 && row.uncosted >= answered;
}

/** The words for the requests missing from a group's tokens and from its cost. */
export function gapLines(row: Pick<UsageSummary, 'unknownUsage' | 'uncosted'>): string[] {
  const lines: string[] = [];
  if (row.unknownUsage > 0) lines.push(`${formatCount(row.unknownUsage)} 个请求上游未报用量，Token 少计`);
  if (row.uncosted > 0) lines.push(`${formatCount(row.uncosted)} 个请求未计费，费用少计`);
  return lines;
}

/**
 * One small mark beside a figure that reads low because some requests are missing from it;
 * the counts are in its tooltip. Nothing when none are missing.
 */
export function GapMark({ lines, className }: { lines: string[]; className?: string }) {
  if (lines.length === 0) return null;
  const text = lines.join('；');
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={text}
        onClick={(event) => event.stopPropagation()}
        className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded-full text-warn outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
      >
        <CircleAlertIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        {lines.map((line) => <span key={line}>{line}</span>)}
      </TooltipContent>
    </Tooltip>
  );
}

/** The column headings that go with `UsageCells`. */
export function UsageHeads() {
  return (
    <>
      <TableHead className="text-right">请求</TableHead>
      <TableHead className="text-right">失败</TableHead>
      {/* The three billed token kinds as one group, set apart from the counts and the cost. */}
      <TableHead className="pl-8 text-right">未缓存输入</TableHead>
      <TableHead className="text-right">输出</TableHead>
      <TableHead className="text-right">缓存读</TableHead>
      <TableHead className="pl-8 text-right">费用</TableHead>
    </>
  );
}

/**
 * One group's figures, with the input and cache-read counts kept apart as the report gives them. A
 * figure that reads low carries the mark, with the count in its tooltip.
 */
export function UsageCells({ row }: { row: UsageSummary }) {
  const tokens = (count: number) => (tokensUnknown(row) ? NONE : formatCount(count));
  const tokenGap = row.unknownUsage > 0 ? gapLines({ unknownUsage: row.unknownUsage, uncosted: 0 }) : [];
  const costGap = row.uncosted > 0 ? gapLines({ unknownUsage: 0, uncosted: row.uncosted }) : [];
  return (
    <>
      <TableCell className={NUM}>{formatCount(row.requests)}</TableCell>
      <TableCell className={cn(NUM, row.errors > 0 ? 'text-destructive' : 'text-muted-foreground')}>{formatCount(row.errors)}</TableCell>
      <TableCell className={`${NUM} pl-8`}>
        <span className="inline-flex items-center gap-1.5">
          <GapMark lines={tokenGap} />
          {tokens(row.inputTokens)}
        </span>
      </TableCell>
      <TableCell className={NUM}>{tokens(row.outputTokens)}</TableCell>
      <TableCell className={NUM}>{tokens(row.cacheReadTokens)}</TableCell>
      <TableCell className={`${NUM} pl-8`}>
        <span className="inline-flex items-center gap-1.5">
          <GapMark lines={costGap} />
          {costUnknown(row) ? NONE : formatUsd(row.cost)}
        </span>
      </TableCell>
    </>
  );
}
