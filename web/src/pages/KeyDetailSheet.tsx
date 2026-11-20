import React from 'react';
import type { KeyRecord, ModelRecord, UsageByKeyRow } from '@shared/api';
import { Button } from '@/components/ui/button';
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  formatAgo, formatCount, formatDateTime, formatUsd, NONE, RESET_PERIOD_LABEL,
} from '../format';
import { Meter, Tag } from '../parts/layout';
import { costUnknown, tokensUnknown } from '../parts/usage';
import { keyProblem, type KeyDialogState } from './keyState';

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2.5">{children}</dl>
    </section>
  );
}

function Row({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 tabular-nums [overflow-wrap:anywhere]', className)}>{children}</dd>
    </>
  );
}

/**
 * Everything about one key that its row leaves out: its limits, what it has used since it was
 * created, and the requests missing from those figures.
 */
export function KeyDetailSheet({
  item, recorded, models, modelsLoaded, now, onClose, onAction,
}: {
  item: KeyRecord | null;
  recorded: UsageByKeyRow | undefined;
  models: readonly ModelRecord[];
  modelsLoaded: boolean;
  now: number;
  onClose: () => void;
  onAction: (dialog: KeyDialogState) => void;
}) {
  return (
    <Sheet open={item !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        {item && <Body item={item} recorded={recorded} models={models} modelsLoaded={modelsLoaded} now={now} onAction={onAction} />}
      </SheetContent>
    </Sheet>
  );
}

function Body({
  item, recorded, models, modelsLoaded, now, onAction,
}: {
  item: KeyRecord;
  recorded: UsageByKeyRow | undefined;
  models: readonly ModelRecord[];
  modelsLoaded: boolean;
  now: number;
  onAction: (dialog: KeyDialogState) => void;
}) {
  const problem = keyProblem(item, now);
  const limit = item.costLimit;
  const used = limit === null ? null : (limit === 0 ? 1 : item.periodCost / limit);
  const names = item.modelIds.map((id) => models.find((model) => model.id === id)?.name ?? id);
  const expired = item.expiresAt !== null && new Date(item.expiresAt).getTime() <= now;

  return (
    <>
      <SheetHeader className="gap-2 border-b px-6 pt-6 pb-5">
        <div className="flex flex-wrap items-center gap-2 pr-8">
          <SheetTitle className="[overflow-wrap:anywhere]">{item.name}</SheetTitle>
          {!item.enabled && <Tag tone="muted">已停用</Tag>}
          {problem && <Tag tone={problem.tone}>{problem.text}</Tag>}
        </div>
        <SheetDescription className="font-mono text-code">{item.prefix}</SheetDescription>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-6 py-6">
        <Group title="本周期">
          <Row label="费用 / 限额">
            <span className={cn(used !== null && used >= 1 && 'text-destructive')}>{formatUsd(item.periodCost)}</span>
            <span className="text-muted-foreground"> / {limit === null ? '不限' : formatUsd(limit)}</span>
            {used !== null && <Meter used={used} label="本周期费用占限额" className="mt-2 w-full max-w-56" />}
          </Row>
          <Row label="重置">{RESET_PERIOD_LABEL[item.resetPeriod]}</Row>
          {item.nextResetAt !== null && <Row label="下次重置">{formatDateTime(item.nextResetAt)}</Row>}
          <Row label="周期开始">{formatDateTime(item.periodStart)}</Row>
        </Group>

        <Group title="限制">
          <Row label="可用模型">
            {!item.restricted && '全部模型'}
            {item.restricted && item.modelIds.length === 0 && <span className="text-warn">无</span>}
            {item.restricted && item.modelIds.length > 0 && (
              modelsLoaded ? (
                <ul className="flex flex-col gap-1">
                  {names.map((name) => <li key={name} className="[overflow-wrap:anywhere]">{name}</li>)}
                </ul>
              ) : `${formatCount(item.modelIds.length)} 个`
            )}
          </Row>
          <Row label="最大并发">{item.maxConcurrency === null ? '不限' : formatCount(item.maxConcurrency)}</Row>
          <Row label="到期" className={cn(expired && 'text-destructive')}>
            {item.expiresAt === null ? '永不' : formatDateTime(item.expiresAt)}
          </Row>
        </Group>

        <Group title="累计">
          <Row label="请求">{formatCount(item.requestCount)}</Row>
          {recorded ? (
            // The usage report keeps the three billed kinds apart over the same lifetime.
            <>
              <Row label="未缓存输入">{tokensUnknown(recorded) ? NONE : formatCount(recorded.inputTokens)}</Row>
              <Row label="输出">{tokensUnknown(recorded) ? NONE : formatCount(recorded.outputTokens)}</Row>
              <Row label="缓存读">{tokensUnknown(recorded) ? NONE : formatCount(recorded.cacheReadTokens)}</Row>
            </>
          ) : (
            // Without the report, only the key's own sums: input with cache reads, and output.
            <>
              <Row label="输入 Token">
                {formatCount(item.inputTokens)}
                <span className="ml-2 text-xs text-muted-foreground">含缓存</span>
              </Row>
              <Row label="输出 Token">{formatCount(item.outputTokens)}</Row>
            </>
          )}
          <Row label="费用">{recorded && costUnknown(recorded) ? NONE : formatUsd(item.totalCost)}</Row>
          {recorded && recorded.unknownUsage > 0 && (
            <Row label="未报用量" className="text-warn">{formatCount(recorded.unknownUsage)} 个请求</Row>
          )}
          {recorded && recorded.uncosted > 0 && (
            <Row label="未计费" className="text-warn">{formatCount(recorded.uncosted)} 个请求</Row>
          )}
          <Row label="最近使用">
            {item.lastUsedAt === null ? '从未' : `${formatDateTime(item.lastUsedAt)}`}
            {item.lastUsedAt !== null && <span className="ml-2 text-xs text-muted-foreground">{formatAgo(item.lastUsedAt, new Date(now))}</span>}
          </Row>
          <Row label="创建于">{formatDateTime(item.createdAt)}</Row>
        </Group>
      </div>

      <SheetFooter className="flex-row justify-between gap-2 border-t px-6 py-4">
        <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => onAction({ kind: 'remove', item })}>移除</Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => onAction({ kind: 'reset', item })}>重置用量</Button>
          <Button disabled={!modelsLoaded} onClick={() => onAction({ kind: 'edit', item })}>编辑</Button>
        </div>
      </SheetFooter>
    </>
  );
}
