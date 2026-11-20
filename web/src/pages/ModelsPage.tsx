import React, { useState } from 'react';
import { MoreHorizontalIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { ModelRecord, UsageByModelRow } from '@shared/api';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import {
  TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useApi } from '../apiContext';
import { formatCount, formatPricePair, formatUsd, NONE } from '../format';
import { useAction, useLoad, useRowActions } from '../hooks';
import { ConfirmDialog } from '../parts/ConfirmDialog';
import {
  ACTIONS, Frame, LinkRow, NUM, PageHeader, RowControls, StaleNote, TableNote, Tag,
} from '../parts/layout';
import {
  costUnknown, GapMark, gapLines, RangePicker, rangeOf, type RangeKey,
} from '../parts/usage';
import { href, navigate } from '../router';
import { ModelCreateDialog } from './ModelCreateDialog';

/** The providers a model routes to, each named once; a provider with no enabled route is struck through. */
function RouteProviders({ model }: { model: ModelRecord }) {
  if (model.routes.length === 0) return <Tag tone="warn">无路由</Tag>;
  const providers = new Map<string, { name: string; enabled: boolean }>();
  for (const route of model.routes) {
    const seen = providers.get(route.providerId);
    providers.set(route.providerId, { name: route.providerName, enabled: (seen?.enabled ?? false) || route.enabled });
  }
  const list = [...providers.values()];
  return (
    <span className="block truncate text-muted-foreground" title={list.map((item) => (item.enabled ? item.name : `${item.name}（已停用）`)).join('、')}>
      {list.map((item, index) => (
        <React.Fragment key={item.name}>
          {index > 0 && '、'}
          <span className={cn(!item.enabled && 'line-through')}>{item.name}</span>
        </React.Fragment>
      ))}
    </span>
  );
}

/**
 * One usage figure of a model in the chosen range. A model the report does not list has no
 * recorded request in the range, which is a real 0; a report that failed to load is unknown.
 */
function Figure({
  usage, known, pick, zero = '0', unknown, gap,
}: {
  usage: UsageByModelRow | undefined;
  known: boolean;
  pick: (row: UsageByModelRow) => string;
  /** How a real zero of this figure is written. */
  zero?: string;
  /** True when no answered request gave this figure, so it is unknown rather than 0. */
  unknown?: (row: UsageByModelRow) => boolean;
  /** Requests missing from this figure, for the quiet mark beside it. */
  gap?: (row: UsageByModelRow) => string[];
}) {
  if (!known) return <span className="text-muted-foreground">{NONE}</span>;
  if (!usage) return <span className="text-muted-foreground">{zero}</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {gap && <GapMark lines={gap(usage)} />}
      {unknown?.(usage) ? NONE : pick(usage)}
    </span>
  );
}

export function ModelsPage() {
  const api = useApi();
  const [range, setRange] = useState<RangeKey>('all');
  const list = useLoad(() => api.listModels(), [api]);
  const usage = useLoad(() => api.usageByModel(rangeOf(range)), [api, range]);
  const rows = useRowActions();
  const removal = useAction();
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<ModelRecord | null>(null);
  const [query, setQuery] = useState('');

  const all = list.data?.models ?? [];
  // A provider that publishes by itself brings a hundred models; the list is found by name.
  const needle = query.trim().toLowerCase();
  const models = needle === '' ? all : all.filter((model) => model.name.toLowerCase().includes(needle));
  const usageById = new Map((usage.data?.rows ?? []).map((row) => [row.modelId, row]));
  const usageKnown = usage.data !== null && usage.error === null;

  const setEnabled = (model: ModelRecord, enabled: boolean) => rows.run(model.id, async () => {
    await api.updateModel(model.id, { enabled });
    await list.reload();
  }, (reason) => toast.error(reason));

  const remove = async (model: ModelRecord) => {
    const done = await removal.run(async () => {
      await api.deleteModel(model.id);
      await list.reload();
    });
    if (done) {
      setRemoving(null);
      toast.success(`已移除 ${model.name}`);
    }
  };

  return (
    <>
      <PageHeader title="模型" count={list.data ? all.length : undefined}>
        <InputGroup className="w-56">
          <InputGroupAddon><SearchIcon /></InputGroupAddon>
          <InputGroupInput
            placeholder="筛选"
            aria-label="筛选模型"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
        <RangePicker value={range} onChange={setRange} />
        <Button onClick={() => setCreating(true)}>
          <PlusIcon data-icon="inline-start" />
          新建模型
        </Button>
      </PageHeader>

      {list.data && <StaleNote error={list.error} />}
      {!list.error && usage.error && <StaleNote error={`用量加载失败：${usage.error}`} />}

      <Frame>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>名称</TableHead>
            <TableHead className="text-right">入 / 出 $/1M</TableHead>
            <TableHead>路由</TableHead>
            <TableHead className="text-right">请求</TableHead>
            <TableHead className="text-right">费用</TableHead>
            <TableHead className={ACTIONS}><span className="sr-only">启用与操作</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {models.map((model) => {
            const row = usageById.get(model.id);
            return (
              <LinkRow key={model.id} to={{ page: 'model', id: model.id }} className={cn(!model.enabled && 'text-muted-foreground')}>
                <TableCell className="max-w-0 w-3/5">
                  <a
                    href={href({ page: 'model', id: model.id })}
                    className="block truncate font-medium underline-offset-4 hover:underline"
                    title={model.name}
                  >
                    {model.name}
                  </a>
                </TableCell>
                <TableCell className={NUM}>{formatPricePair(model.price)}</TableCell>
                <TableCell className="max-w-0 w-2/5"><RouteProviders model={model} /></TableCell>
                <TableCell className={NUM}>
                  <Figure usage={row} known={usageKnown} pick={(item) => formatCount(item.requests)} />
                </TableCell>
                <TableCell className={NUM}>
                  <Figure
                    usage={row}
                    known={usageKnown}
                    pick={(item) => formatUsd(item.cost)}
                    zero={formatUsd(0)}
                    unknown={costUnknown}
                    gap={(item) => gapLines(item)}
                  />
                </TableCell>
                <TableCell className={ACTIONS}>
                  <RowControls>
                    <Switch
                      checked={model.enabled}
                      disabled={rows.isPending(model.id)}
                      aria-label={`启用 ${model.name}`}
                      onCheckedChange={(checked) => void setEnabled(model, checked)}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${model.name} 的操作`} />}>
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => navigate({ page: 'model', id: model.id })}>编辑</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setRemoving(model)}>移除</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </RowControls>
                </TableCell>
              </LinkRow>
            );
          })}
          {models.length === 0 && all.length > 0 && (
            <TableNote colSpan={6} loading={false} error={null} empty="没有匹配的模型" onRetry={() => undefined} />
          )}
          {all.length === 0 && (
            <TableNote
              colSpan={6}
              loading={list.loading}
              error={list.data ? null : list.error}
              empty={(
                <span className="flex flex-col items-center gap-3">
                  <span>还没有模型</span>
                  <span className="flex gap-2">
                    <Button variant="outline" onClick={() => navigate({ page: 'providers' })}>从提供商发布</Button>
                    <Button variant="outline" onClick={() => setCreating(true)}>新建模型</Button>
                  </span>
                </span>
              )}
              onRetry={() => { void list.reload(); void usage.reload(); }}
            />
          )}
        </TableBody>
      </Frame>

      {creating && (
        <ModelCreateDialog
          onClose={() => setCreating(false)}
          onCreated={(model) => {
            setCreating(false);
            toast.success(`已创建 ${model.name}`);
            navigate({ page: 'model', id: model.id });
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="移除模型"
          description={`「${removing.name}」和它的路由一并移除，无法恢复。已记录的用量保留。`}
          confirmLabel="移除"
          action={removal}
          onClose={() => { setRemoving(null); removal.clearError(); }}
          onConfirm={() => void remove(removing)}
        />
      )}
    </>
  );
}
