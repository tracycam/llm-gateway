import React, { useState } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import type { RequestLogRow, UsageByDayRow, UsageSummary, UsageTotals } from '@shared/api';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useApi } from '../apiContext';
import {
  formatCount, formatDuration, formatLogTime, formatUsd, interfaceLabel, localDay, NONE, shiftDay,
} from '../format';
import { useAction, useLoad, useVisibleInterval } from '../hooks';
import { ConfirmDialog } from '../parts/ConfirmDialog';
import { DayChart, type Metric } from '../parts/DayChart';
import {
  Frame, NUM, PageHeader, RefreshButton, Section, StaleNote, TableNote,
} from '../parts/layout';
import {
  costUnknown, GapMark, gapLines, RangePicker, rangeOf, sumUsage, tokensUnknown, totalInput,
  UsageCells, UsageHeads, type RangeKey,
} from '../parts/usage';
import { href } from '../router';

const ALL = 'all';
/** The log rows shown before 显示全部 is pressed. */
const LOG_FIRST = 50;
/** With 全部 picked, the chart still spans at least this many days, so a young gateway's few days do not fill it. */
const MIN_CHART_DAYS = 14;

interface Option {
  id: string;
  name: string;
  /** False for a model or key that was removed but still has recorded usage. */
  exists: boolean;
}

/** The records that exist now, then the removed ones that the usage report still names. */
/**
 * The choices of a usage filter: what has recorded usage (all time), by name — a model or key
 * with none would only draw an empty chart, and with a hundred published models the list stays
 * short. One that no longer exists is marked.
 */
function options(
  current: readonly { id: string; name: string }[], recorded: readonly { id: string; name: string }[],
): Option[] {
  const exists = new Set(current.map((item) => item.id));
  return recorded
    .map((item) => ({ ...item, exists: exists.has(item.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function Filter({
  label, all, value, items, onChange,
}: {
  label: string;
  all: string;
  value: string;
  items: Option[];
  onChange: (next: string) => void;
}) {
  const picked = items.find((item) => item.id === value);
  return (
    <Select value={value} onValueChange={(next) => { if (next) onChange(next); }}>
      <SelectTrigger className="max-w-52 min-w-32" aria-label={label}>
        <SelectValue><span className="truncate">{picked ? picked.name : all}</span></SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="w-auto max-w-96 min-w-(--anchor-width)">
        <SelectItem value={ALL}>{all}</SelectItem>
        {items.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            {item.name}
            {!item.exists && <span className="text-muted-foreground">已移除</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Figure({ label, unit, children }: { label: string; unit?: string; children: React.ReactNode }) {
  return (
    // A faint frame: a hairline on a barely tinted surface, the page's one radius.
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border bg-muted/30 px-4 py-3">
      <dt className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
        {label}
        {unit && <span className="text-muted-foreground/80">{unit}</span>}
      </dt>
      {/* A figure is never cut: in a column too narrow for it, it wraps. */}
      <dd className="text-title font-semibold tabular-nums [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** What the gateway has served since its database was created. */
function Totals({ totals }: { totals: UsageTotals | null }) {
  return (
    // Four in a row once each box can hold a ten-digit count at the title size, else two by two.
    <div className="@container">
      <dl className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
      <Figure label="累计请求">{formatCount(totals?.requestCount ?? null)}</Figure>
      <Figure label="累计输入 Token" unit="含缓存">{formatCount(totals?.inputTokens ?? null)}</Figure>
      <Figure label="累计输出 Token">{formatCount(totals?.outputTokens ?? null)}</Figure>
      <Figure label="累计费用">{formatUsd(totals?.cost ?? null)}</Figure>
      </dl>
    </div>
  );
}

/**
 * The range's three sums, each a tab that puts its metric on the chart below. Unknown while
 * the report has not loaded.
 */
function MetricTabs({
  total, known, metric, onChange,
}: {
  total: UsageSummary;
  known: boolean;
  metric: Metric;
  onChange: (next: Metric) => void;
}) {
  const tabs: { value: Metric; label: string; figure: string; extra?: React.ReactNode; gap: string[] }[] = [
    {
      value: 'cost',
      label: '费用',
      figure: !known || costUnknown(total) ? NONE : formatUsd(total.cost),
      gap: known ? gapLines({ unknownUsage: 0, uncosted: total.uncosted }) : [],
    },
    {
      value: 'requests',
      label: '请求',
      figure: known ? formatCount(total.requests) : NONE,
      extra: known && total.errors > 0 && (
        <span className="text-sm font-normal text-destructive">{formatCount(total.errors)} 失败</span>
      ),
      gap: [],
    },
    {
      value: 'tokens',
      label: 'Token',
      figure: !known || tokensUnknown(total) ? NONE : formatCount(totalInput(total) + total.outputTokens),
      gap: known ? gapLines({ unknownUsage: total.unknownUsage, uncosted: 0 }) : [],
    },
  ];
  return (
    <div role="tablist" aria-label="图表指标" className="grid grid-cols-3 gap-x-8 border-b">
      {tabs.map((tab) => {
        const selected = tab.value === metric;
        return (
          <div key={tab.value} className="relative flex min-w-0 items-start">
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onChange(tab.value)}
              className={cn(
                'flex w-full min-w-0 flex-col items-start gap-1 pt-1 pb-3 text-left outline-none transition-colors duration-150',
                'focus-visible:ring-2 focus-visible:ring-ring',
                !selected && 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="text-xs">{tab.label}</span>
              <span className="flex flex-wrap items-baseline gap-x-2 text-figure font-semibold tabular-nums [overflow-wrap:anywhere]">
                <span className={cn(selected ? 'text-foreground' : 'text-foreground/80')}>{tab.figure}</span>
                {tab.extra}
              </span>
            </button>
            {/* Drawn for the selected tab only, so no other tab can show a fading copy. */}
            {selected && <span data-indicator aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-foreground" />}
            {tab.gap.length > 0 && (
              // Beside the tab's label, outside the tab itself: a control may not hold another.
              <span className="pointer-events-none absolute top-1 left-0 flex h-4 items-center gap-1.5 text-xs">
                <span className="invisible">{tab.label}</span>
                <GapMark lines={tab.gap} className="pointer-events-auto" />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The first and last day the chart draws: the asked range, or from the first recorded day. */
function chartSpan(range: RangeKey, rows: readonly UsageByDayRow[]): { from: string; to: string } {
  const asked = rangeOf(range);
  const today = localDay(new Date());
  const first = rows.reduce((earliest, row) => (row.day < earliest ? row.day : earliest), today);
  const floor = shiftDay(today, 1 - MIN_CHART_DAYS);
  return { from: asked.from ?? (first < floor ? first : floor), to: asked.to ?? today };
}

/**
 * One request on one line: when, which key, which model, how it ended, tokens, cost and time.
 * A failed request carries its error on the next line, under its status. The row opens to
 * the rest: provider, upstream model, interface, cache tokens, time to first token.
 */
function LogRow({ row }: { row: RequestLogRow }) {
  const [open, setOpen] = useState(false);
  const failed = row.status >= 400;
  const detailId = `log-${row.id}`;
  return (
    <>
      <TableRow
        className={cn('cursor-pointer', (open || row.error !== null) && 'border-b-0')}
        onClick={() => setOpen((value) => !value)}
      >
        <TableCell className="tabular-nums">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            className="flex items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
          >
            <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-90')} />
            {formatLogTime(row.timestamp)}
          </button>
        </TableCell>
        <TableCell className="max-w-0 w-1/4"><span className="block truncate" title={row.keyName}>{row.keyName || NONE}</span></TableCell>
        <TableCell className="max-w-0 w-1/2"><span className="block truncate" title={row.modelName}>{row.modelName || NONE}</span></TableCell>
        <TableCell className={cn(NUM, failed ? 'font-medium text-destructive' : 'text-muted-foreground')}>{row.status}</TableCell>
        <TableCell className={NUM}>
          {row.inputTokens === null && row.outputTokens === null
            ? <span className="text-muted-foreground">{NONE}</span>
            : `${formatCount(allInput(row))} / ${formatCount(row.outputTokens)}`}
        </TableCell>
        <TableCell className={NUM}>{formatUsd(row.cost)}</TableCell>
        <TableCell className={NUM}>{formatDuration(row.latencyMs)}</TableCell>
      </TableRow>
      {row.error !== null && (
        <TableRow className={cn('hover:bg-transparent', open && 'border-b-0 bg-muted/50 hover:bg-muted/50')}>
          <TableCell />
          <TableCell colSpan={6} className="pt-0 pb-3 whitespace-normal text-destructive [overflow-wrap:anywhere]">
            {row.error}
          </TableCell>
        </TableRow>
      )}
      {open && (
        <TableRow id={detailId} className="bg-muted/50 hover:bg-muted/50">
          <TableCell />
          <TableCell colSpan={6} className="pt-0 pb-3 whitespace-normal">
            <dl className="flex flex-wrap gap-x-8 gap-y-2 text-xs">
              <LogFact label="提供商">{row.providerName ?? '未到达'}</LogFact>
              <LogFact label="上游模型">{row.upstreamModel ?? NONE}</LogFact>
              <LogFact label="接口">{interfaceLabel(row.protocol)}</LogFact>
              {/* The three billed token kinds, together and in the order prices use. */}
              <div className="flex min-w-0 items-baseline gap-x-4 gap-y-1">
                <LogFact label="未缓存输入">{formatCount(row.inputTokens)}</LogFact>
                <LogFact label="输出">{formatCount(row.outputTokens)}</LogFact>
                <LogFact label="缓存读">{formatCount(row.cacheReadTokens)}</LogFact>
              </div>
              <LogFact label="首字">{formatDuration(row.ttftMs)}</LogFact>
            </dl>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** A request's input tokens with cache reads, as the totals count them; null when none were reported. */
function allInput(row: RequestLogRow): number | null {
  if (row.inputTokens === null && row.cacheReadTokens === null) return null;
  return (row.inputTokens ?? 0) + (row.cacheReadTokens ?? 0);
}

function LogFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function UsagePage() {
  const api = useApi();
  const [range, setRange] = useState<RangeKey>('30');
  const [metric, setMetric] = useState<Metric>('cost');
  const [model, setModel] = useState(ALL);
  const [key, setKey] = useState(ALL);
  const [byDayOpen, setByDayOpen] = useState(false);
  const [allLogs, setAllLogs] = useState(false);
  const [clearing, setClearing] = useState(false);
  const clear = useAction();

  const totals = useLoad(() => api.getTotals(), [api]);
  const days = useLoad(() => api.usageByDay(rangeOf(range), {
    model: model === ALL ? undefined : model,
    key: key === ALL ? undefined : key,
  }), [api, range, model, key]);
  const logs = useLoad(() => api.listLogs(), [api]);
  const filters = useLoad(async () => {
    const [models, keys, byModel, byKey] = await Promise.all([
      api.listModels(), api.listKeys(), api.usageByModel(), api.usageByKey(),
    ]);
    return {
      models: options(models.models, byModel.rows.map((row) => ({ id: row.modelId, name: row.modelName }))),
      keys: options(keys.keys, byKey.rows.map((row) => ({ id: row.keyId, name: row.keyName }))),
    };
  }, [api]);

  const reloadFigures = () => {
    void totals.reload();
    void days.reload();
    void logs.reload();
  };
  useVisibleInterval(reloadFigures, 5000);

  const clearLogs = async () => {
    const done = await clear.run(async () => {
      await api.clearLogs();
      await logs.reload();
    });
    if (done) setClearing(false);
  };

  const dayRows = [...(days.data?.rows ?? [])].sort((a, b) => (a.day < b.day ? 1 : -1));
  const total = sumUsage(dayRows);
  const span = chartSpan(range, dayRows);
  const logRows = logs.data?.logs ?? [];
  const shownLogs = allLogs ? logRows : logRows.slice(0, LOG_FIRST);
  const neverUsed = totals.data?.totals.requestCount === 0;

  return (
    <>
      <PageHeader title="用量">
        <RefreshButton
          loading={totals.loading || days.loading || logs.loading}
          onClick={() => { reloadFigures(); void filters.reload(); }}
        />
      </PageHeader>

      <StaleNote error={totals.error ?? days.error ?? logs.error ?? filters.error} />
      <Totals totals={totals.data?.totals ?? null} />

      <Section
        title="按天"
        actions={(
          <>
            <Filter label="模型" all="全部模型" value={model} items={filters.data?.models ?? []} onChange={setModel} />
            <Filter label="密钥" all="全部密钥" value={key} items={filters.data?.keys ?? []} onChange={setKey} />
            <RangePicker value={range} onChange={setRange} />
          </>
        )}
      >
        <div className="flex flex-col gap-5">
          <MetricTabs total={total} known={days.data !== null} metric={metric} onChange={setMetric} />
          {days.data === null ? (
            <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
              {days.error ? <span className="text-destructive">{days.error}</span> : '加载中'}
            </div>
          ) : (
            <DayChart rows={dayRows} from={span.from} to={span.to} metric={metric} />
          )}
        </div>

        {dayRows.length > 0 && (
          <div className="flex flex-col gap-3 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-fit px-0 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
              aria-expanded={byDayOpen}
              onClick={() => setByDayOpen((value) => !value)}
            >
              <ChevronRightIcon className={cn('transition-transform duration-150', byDayOpen && 'rotate-90')} data-icon="inline-start" />
              每天明细
              <span className="tabular-nums">{dayRows.length}</span>
            </Button>
            {byDayOpen && (
              <Frame>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>日期</TableHead>
                    <UsageHeads />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dayRows.map((row) => (
                    <TableRow key={row.day}>
                      <TableCell className="tabular-nums">{row.day}</TableCell>
                      <UsageCells row={row} />
                    </TableRow>
                  ))}
                </TableBody>
                {dayRows.length > 1 && (
                  <TableFooter>
                    <TableRow className="hover:bg-transparent">
                      <TableCell>合计</TableCell>
                      <UsageCells row={total} />
                    </TableRow>
                  </TableFooter>
                )}
              </Frame>
            )}
          </div>
        )}
      </Section>

      <Section
        title="请求日志"
        count={logs.data ? logRows.length : undefined}
        aside="最近 200 条"
        actions={<Button variant="outline" disabled={logRows.length === 0} onClick={() => setClearing(true)}>清空</Button>}
      >
        <Frame>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>时间</TableHead>
              <TableHead>密钥</TableHead>
              <TableHead>模型</TableHead>
              <TableHead className="text-right">状态</TableHead>
              <TableHead className="text-right">Token 入 / 出 <span className="text-muted-foreground/80">含缓存</span></TableHead>
              <TableHead className="text-right">费用</TableHead>
              <TableHead className="text-right">耗时</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shownLogs.map((row) => <LogRow key={row.id} row={row} />)}
            {logRows.length === 0 && (
              <TableNote
                colSpan={7}
                loading={logs.loading}
                error={logs.data ? null : logs.error}
                empty={neverUsed ? (
                  <span className="inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
                    还没有请求
                    <a href={href({ page: 'providers' })} className="text-foreground underline underline-offset-4">添加提供商</a>
                    <a href={href({ page: 'keys' })} className="text-foreground underline underline-offset-4">创建密钥</a>
                  </span>
                ) : '日志已清空'}
                onRetry={() => void logs.reload()}
              />
            )}
          </TableBody>
        </Frame>
        {logRows.length > shownLogs.length && (
          <Button variant="outline" className="w-fit self-center" onClick={() => setAllLogs(true)}>
            显示全部 <span className="tabular-nums">{logRows.length}</span> 条
          </Button>
        )}
      </Section>

      {clearing && (
        <ConfirmDialog
          title="清空请求日志"
          description="日志里的请求记录全部删除。累计与按天的用量不变。"
          confirmLabel="清空"
          action={clear}
          onClose={() => { setClearing(false); clear.clearError(); }}
          onConfirm={() => void clearLogs()}
        />
      )}
    </>
  );
}
