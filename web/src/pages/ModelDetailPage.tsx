import React, { useState } from 'react';
import { MoreHorizontalIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import type {
  ModelPatchBody, ModelRecord, ProviderListItem, RouteRecord,
} from '@shared/api';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useApi } from '../apiContext';
import { formatCount, formatPricePair } from '../format';
import { useAction, useLoad, useRowActions } from '../hooks';
import { ConfirmDialog } from '../parts/ConfirmDialog';
import {
  Field, FormError, numberText, parseWhole, PriceFields, priceDraft, readPriceDraft, samePrice,
  SubmitButton,
} from '../parts/forms';
import {
  ACTIONS, Frame, LoadFailure, NUM, PageHeader, RowControls, Section, StaleNote, TableNote, Tag,
} from '../parts/layout';
import {
  RangePicker, rangeOf, sumUsage, UsageCells, UsageHeads, type RangeKey,
} from '../parts/usage';
import { href, navigate } from '../router';
import { RouteDialog } from './RouteDialog';

/** Name, the four prices and the context length, saved together. */
function ModelSettings({ model, onSaved }: { model: ModelRecord; onSaved: () => Promise<void> }) {
  const api = useApi();
  const action = useAction();
  const [name, setName] = useState(model.name);
  const [price, setPrice] = useState(priceDraft(model.price));
  const [context, setContext] = useState(numberText(model.contextLength));

  const parsedPrice = readPriceDraft(price);
  const parsedContext = parseWhole(context, 1);
  const invalid = name.trim() === '' || parsedPrice === undefined || parsedContext === undefined;
  const patch: ModelPatchBody = {};
  if (name.trim() !== model.name) patch.name = name.trim();
  if (parsedPrice && !samePrice(parsedPrice, model.price)) patch.price = parsedPrice;
  if (parsedContext !== undefined && parsedContext !== model.contextLength) patch.contextLength = parsedContext;
  const dirty = Object.keys(patch).length > 0;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (invalid || !dirty) return;
    void action.run(async () => {
      await api.updateModel(model.id, patch);
      await onSaved();
      toast.success('已保存');
    });
  };

  return (
    <form className="flex max-w-3xl flex-col gap-5" onSubmit={submit}>
        {/* One three-column grid: the name over 输入 and 输出, the context length over 缓存读. */}
        <div className="grid grid-cols-3 gap-4">
          <Field label="名称" htmlFor="detail-name" hint="请求里的 model" className="col-span-2">
            <Input
              id="detail-name"
              autoComplete="off"
              spellCheck={false}
              value={name}
              disabled={action.pending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="上下文长度" htmlFor="detail-context" hint="Token">
            <Input
              id="detail-context"
              inputMode="numeric"
              autoComplete="off"
              className="tabular-nums"
              placeholder="未设"
              value={context}
              disabled={action.pending}
              aria-invalid={parsedContext === undefined || undefined}
              onChange={(event) => setContext(event.target.value)}
            />
          </Field>
        </div>
        <PriceFields idPrefix="detail-price" value={price} onChange={setPrice} disabled={action.pending} />
        <FormError message={action.error} />
        <div className="flex items-center gap-2">
          <SubmitButton pending={action.pending} disabled={invalid || !dirty}>保存</SubmitButton>
          {dirty && !action.pending && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setName(model.name);
                setPrice(priceDraft(model.price));
                setContext(numberText(model.contextLength));
                action.clearError();
              }}
            >
              还原
            </Button>
          )}
        </div>
      </form>
  );
}

type RouteEdit = { kind: 'add' } | { kind: 'edit'; route: RouteRecord } | { kind: 'remove'; route: RouteRecord };

export function ModelDetailPage({ id }: { id: string }) {
  const api = useApi();
  const [range, setRange] = useState<RangeKey>('all');
  const detail = useLoad(() => api.getModel(id), [api, id]);
  const providers = useLoad(() => api.listProviders(), [api]);
  const usage = useLoad(() => api.usageByProvider(id, rangeOf(range)), [api, id, range]);

  const toggle = useAction();
  const removal = useAction();
  const routeRemoval = useAction();
  const rows = useRowActions();
  const [routeEdit, setRouteEdit] = useState<RouteEdit | null>(null);
  const [removing, setRemoving] = useState(false);

  const model = detail.data?.model ?? null;
  const providerList: ProviderListItem[] = providers.data?.providers ?? [];

  if (!model) {
    return (
      <>
        <PageHeader
          title={detail.loading ? '' : (detail.error ? '加载失败' : '没有这个模型')}
          crumb={{ label: '模型', to: { page: 'models' } }}
        />
        {detail.error && <LoadFailure error={detail.error} loading={detail.loading} onRetry={() => void detail.reload()} />}
      </>
    );
  }

  const setEnabled = (enabled: boolean) => toggle.run(async () => {
    await api.updateModel(id, { enabled });
    await detail.reload();
  });

  const setRouteEnabled = (route: RouteRecord, enabled: boolean) => rows.run(route.id, async () => {
    await api.updateRoute(route.id, { enabled });
    await detail.reload();
  }, (reason) => toast.error(reason));

  const remove = async () => {
    const done = await removal.run(() => api.deleteModel(id));
    if (done) {
      toast.success(`已移除 ${model.name}`);
      navigate({ page: 'models' });
    }
  };

  const removeRoute = async (route: RouteRecord) => {
    const done = await routeRemoval.run(async () => {
      await api.deleteRoute(route.id);
      await detail.reload();
    });
    if (done) setRouteEdit(null);
  };

  const usageRows = usage.data?.rows ?? [];
  const total = sumUsage(usageRows);
  const settingsKey = `${model.name}|${JSON.stringify(model.price)}|${model.contextLength}`;

  return (
    <>
      <PageHeader title={model.name} crumb={{ label: '模型', to: { page: 'models' } }}>
        <Label className="mr-2 font-normal text-muted-foreground">
          启用
          <Switch checked={model.enabled} disabled={toggle.pending} onCheckedChange={(checked) => void setEnabled(checked)} />
        </Label>
        <Button variant="outline" onClick={() => setRemoving(true)}>
          <Trash2Icon data-icon="inline-start" />
          移除
        </Button>
      </PageHeader>

      <StaleNote error={toggle.error ?? detail.error} />

      <Section title="设置">
        <ModelSettings key={settingsKey} model={model} onSaved={detail.reload} />
      </Section>

      <Section
        title="路由"
        count={model.routes.length}
        actions={(
          <Button variant="outline" disabled={!providers.data} onClick={() => setRouteEdit({ kind: 'add' })}>
            <PlusIcon data-icon="inline-start" />
            添加路由
          </Button>
        )}
      >
        <Frame>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>提供商</TableHead>
              <TableHead>上游模型</TableHead>
              <TableHead className="text-right">权重</TableHead>
              <TableHead className="text-right">入 / 出 $/1M</TableHead>
              <TableHead className={ACTIONS}><span className="sr-only">启用与操作</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {model.routes.map((route) => (
              <TableRow key={route.id} className={cn(!route.enabled && 'text-muted-foreground')}>
                <TableCell className="max-w-0 w-2/5">
                  <a href={href({ page: 'provider', id: route.providerId })} className="block truncate underline-offset-4 hover:underline" title={route.providerName}>
                    {route.providerName}
                  </a>
                </TableCell>
                <TableCell className="max-w-0 w-3/5">
                  <span className="block truncate" title={route.upstreamModel}>{route.upstreamModel}</span>
                </TableCell>
                <TableCell className={NUM}>{formatCount(route.weight)}</TableCell>
                <TableCell className={NUM}>
                  {route.price
                    ? formatPricePair(route.price)
                    : <span className="text-muted-foreground">跟随模型</span>}
                </TableCell>
                <TableCell className={ACTIONS}>
                  <RowControls>
                    <Switch
                      checked={route.enabled}
                      disabled={rows.isPending(route.id)}
                      aria-label={`启用到 ${route.providerName} 的路由`}
                      onCheckedChange={(checked) => void setRouteEnabled(route, checked)}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="路由的操作" />}>
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setRouteEdit({ kind: 'edit', route })}>编辑</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => setRouteEdit({ kind: 'remove', route })}>移除</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </RowControls>
                </TableCell>
              </TableRow>
            ))}
            {model.routes.length === 0 && (
              <TableNote
                colSpan={5}
                loading={false}
                error={null}
                empty={(
                  <span className="flex flex-col items-center gap-3">
                    <Tag tone="warn">无路由，请求会被拒绝</Tag>
                    <Button variant="outline" disabled={!providers.data} onClick={() => setRouteEdit({ kind: 'add' })}>添加路由</Button>
                  </span>
                )}
                onRetry={() => void detail.reload()}
              />
            )}
          </TableBody>
        </Frame>
      </Section>

      <Section title="按提供商的用量" actions={<RangePicker value={range} onChange={setRange} />}>
        <Frame>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>提供商</TableHead>
              <UsageHeads />
            </TableRow>
          </TableHeader>
          <TableBody>
            {usageRows.map((row) => {
              const exists = providerList.some((provider) => provider.id === row.providerId);
              return (
                <TableRow key={row.providerId}>
                  <TableCell className="max-w-0 w-full">
                    {row.providerId === '' && <span className="text-muted-foreground">未到达提供商</span>}
                    {row.providerId !== '' && exists && (
                      <a href={href({ page: 'provider', id: row.providerId })} className="block truncate underline-offset-4 hover:underline" title={row.providerName}>
                        {row.providerName}
                      </a>
                    )}
                    {row.providerId !== '' && !exists && (
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate" title={row.providerName}>{row.providerName}</span>
                        {providers.data && <Tag tone="muted">已移除</Tag>}
                      </span>
                    )}
                  </TableCell>
                  <UsageCells row={row} />
                </TableRow>
              );
            })}
            {usageRows.length === 0 && (
              <TableNote
                colSpan={8}
                loading={usage.loading}
                error={usage.error}
                empty="这段时间没有请求"
                onRetry={() => void usage.reload()}
              />
            )}
          </TableBody>
          {usageRows.length > 1 && (
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableCell>合计</TableCell>
                <UsageCells row={total} />
              </TableRow>
            </TableFooter>
          )}
        </Frame>
      </Section>

      {routeEdit?.kind === 'add' && (
        <RouteDialog
          model={model}
          providers={providerList}
          onClose={() => setRouteEdit(null)}
          onSaved={() => {
            setRouteEdit(null);
            void detail.reload();
          }}
        />
      )}
      {routeEdit?.kind === 'edit' && (
        <RouteDialog
          model={model}
          providers={providerList}
          route={routeEdit.route}
          onClose={() => setRouteEdit(null)}
          onSaved={() => {
            setRouteEdit(null);
            void detail.reload();
          }}
        />
      )}
      {routeEdit?.kind === 'remove' && (
        <ConfirmDialog
          title="移除路由"
          description={`到「${routeEdit.route.providerName}」的 ${routeEdit.route.upstreamModel} 不再接收这个模型的请求。`}
          confirmLabel="移除"
          action={routeRemoval}
          onClose={() => { setRouteEdit(null); routeRemoval.clearError(); }}
          onConfirm={() => void removeRoute(routeEdit.route)}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="移除模型"
          description={`「${model.name}」和它的路由一并移除，无法恢复。已记录的用量保留。`}
          confirmLabel="移除"
          action={removal}
          onClose={() => { setRemoving(false); removal.clearError(); }}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}
