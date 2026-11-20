import { useState } from 'react';
import { MoreHorizontalIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import type {
  KeyCreatedResponse, KeyRecord, UsageByKeyRow,
} from '@shared/api';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import {
  TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useApi } from '../apiContext';
import { formatAgo, formatDateTime, formatUsd } from '../format';
import { useAction, useLoad, useRowActions } from '../hooks';
import { ConfirmDialog } from '../parts/ConfirmDialog';
import {
  ACTIONS, EmptyNote, Frame, Meter, NAME, NUM, PageHeader, RowControls, StaleNote, TableNote, Tag,
} from '../parts/layout';
import { GapMark, gapLines } from '../parts/usage';
import { KeyCreatedDialog } from './KeyCreatedDialog';
import { KeyDetailSheet } from './KeyDetailSheet';
import { KeyDialog } from './KeyDialog';
import { keyProblem, type KeyDialogState } from './keyState';

/** Spent in the current period, against the limit when there is one. */
function PeriodCost({ item }: { item: KeyRecord }) {
  const limit = item.costLimit;
  // A limit of 0 allows nothing, so it is always fully used.
  const used = limit === null ? null : (limit === 0 ? 1 : item.periodCost / limit);
  return (
    <div className="ml-auto flex w-36 flex-col items-end gap-1.5">
      <span className="tabular-nums whitespace-nowrap">
        <span className={cn(used !== null && used >= 1 && 'text-destructive')}>{formatUsd(item.periodCost)}</span>
        <span className="text-muted-foreground"> / {limit === null ? '不限' : formatUsd(limit)}</span>
      </span>
      {used !== null && <Meter used={used} label="本周期费用占限额" className="w-full" />}
    </div>
  );
}

export function KeysPage() {
  const api = useApi();
  const list = useLoad(() => api.listKeys(), [api]);
  const models = useLoad(() => api.listModels(), [api]);
  // The key list has no count of requests missing from a key's tokens and cost; the usage
  // report by key has, over the same lifetime.
  const usage = useLoad(() => api.usageByKey(), [api]);
  const rows = useRowActions();
  const confirm = useAction();
  const [dialog, setDialog] = useState<KeyDialogState | null>(null);
  const [created, setCreated] = useState<KeyCreatedResponse | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const keys = list.data?.keys ?? [];
  const modelList = models.data?.models ?? [];
  const usageById = new Map((usage.data?.rows ?? []).map((row) => [row.keyId, row]));
  const now = Date.now();
  const opened = keys.find((item) => item.id === openId) ?? null;

  const closeDialog = () => {
    setDialog(null);
    confirm.clearError();
  };

  const setEnabled = (item: KeyRecord, enabled: boolean) => rows.run(item.id, async () => {
    await api.updateKey(item.id, { enabled });
    await list.reload();
  }, (reason) => toast.error(reason));

  const reset = async (item: KeyRecord) => {
    const done = await confirm.run(async () => {
      await api.resetKeyUsage(item.id);
      await list.reload();
    });
    if (done) {
      closeDialog();
      toast.success(`已重置 ${item.name} 的本周期用量`);
    }
  };

  const remove = async (item: KeyRecord) => {
    const done = await confirm.run(async () => {
      await api.deleteKey(item.id);
      await list.reload();
    });
    if (done) {
      closeDialog();
      setOpenId(null);
      toast.success(`已移除 ${item.name}`);
    }
  };

  return (
    <>
      <PageHeader title="密钥" count={list.data ? keys.length : undefined}>
        <Button disabled={!models.data} onClick={() => setDialog({ kind: 'create' })}>
          <PlusIcon data-icon="inline-start" />
          创建密钥
        </Button>
      </PageHeader>

      {list.data && <StaleNote error={list.error} />}
      {!list.error && models.error && <StaleNote error={`模型列表加载失败：${models.error}`} />}
      {!list.error && !models.error && usage.error && <StaleNote error={`用量加载失败：${usage.error}`} />}

      <Frame>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>名称</TableHead>
            <TableHead>密钥</TableHead>
            <TableHead className="text-right">本周期费用 / 限额</TableHead>
            <TableHead className="text-right">最近使用</TableHead>
            <TableHead className={ACTIONS}><span className="sr-only">启用与操作</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((item) => {
            const problem = keyProblem(item, now);
            const recorded: UsageByKeyRow | undefined = usageById.get(item.id);
            return (
              <TableRow
                key={item.id}
                className={cn('cursor-pointer', !item.enabled && 'text-muted-foreground')}
                onClick={() => setOpenId(item.id)}
              >
                <TableCell className={NAME}>
                  <span className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      className="min-w-0 truncate rounded-sm text-left font-medium outline-none hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring"
                      title={item.name}
                      onClick={(event) => { event.stopPropagation(); setOpenId(item.id); }}
                    >
                      {item.name}
                    </button>
                    {problem && <Tag tone={problem.tone}>{problem.text}</Tag>}
                    {recorded && <GapMark lines={gapLines(recorded)} />}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-code text-muted-foreground">{item.prefix}</TableCell>
                <TableCell className={NUM}><PeriodCost item={item} /></TableCell>
                <TableCell className={cn(NUM, 'text-muted-foreground')} title={item.lastUsedAt ? formatDateTime(item.lastUsedAt) : undefined}>
                  {item.lastUsedAt === null ? '从未' : formatAgo(item.lastUsedAt, new Date(now))}
                </TableCell>
                <TableCell className={ACTIONS}>
                  <RowControls>
                    <Switch
                      checked={item.enabled}
                      disabled={rows.isPending(item.id)}
                      aria-label={`启用 ${item.name}`}
                      onCheckedChange={(checked) => void setEnabled(item, checked)}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${item.name} 的操作`} />}>
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem disabled={!models.data} onClick={() => setDialog({ kind: 'edit', item })}>编辑</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setDialog({ kind: 'reset', item })}>重置用量</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setDialog({ kind: 'remove', item })}>移除</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </RowControls>
                </TableCell>
              </TableRow>
            );
          })}
          {keys.length === 0 && (
            <TableNote
              colSpan={5}
              loading={list.loading}
              error={list.data ? null : list.error}
              empty={<EmptyNote text="还没有密钥" action={{ label: '创建密钥', onClick: () => setDialog({ kind: 'create' }), disabled: !models.data }} />}
              onRetry={() => { void list.reload(); void models.reload(); void usage.reload(); }}
            />
          )}
        </TableBody>
      </Frame>

      <KeyDetailSheet
        item={opened}
        recorded={opened ? usageById.get(opened.id) : undefined}
        models={modelList}
        modelsLoaded={models.data !== null}
        now={now}
        onClose={() => setOpenId(null)}
        onAction={setDialog}
      />

      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && (
        <KeyDialog
          models={modelList}
          existing={dialog.kind === 'edit' ? dialog.item : undefined}
          onClose={closeDialog}
          onCreated={(result) => {
            closeDialog();
            setCreated(result);
            void list.reload();
          }}
          onSaved={() => {
            closeDialog();
            void list.reload();
          }}
        />
      )}
      {dialog?.kind === 'reset' && (
        <ConfirmDialog
          title="重置用量"
          description={`「${dialog.item.name}」本周期已用的 ${formatUsd(dialog.item.periodCost)} 清零。累计用量不变。`}
          confirmLabel="重置"
          action={confirm}
          onClose={closeDialog}
          onConfirm={() => void reset(dialog.item)}
        />
      )}
      {dialog?.kind === 'remove' && (
        <ConfirmDialog
          title="移除密钥"
          description={`「${dialog.item.name}」立即失效，无法恢复。已记录的用量保留。`}
          confirmLabel="移除"
          action={confirm}
          onClose={closeDialog}
          onConfirm={() => void remove(dialog.item)}
        />
      )}
      {created && <KeyCreatedDialog created={created} onClose={() => setCreated(null)} />}
    </>
  );
}
