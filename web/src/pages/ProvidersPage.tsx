import { useState } from 'react';
import { MoreHorizontalIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { ConnectorInfo, ProviderListItem } from '@shared/api';
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
import { formatCount, NONE } from '../format';
import { useAction, useLoad, useRowActions } from '../hooks';
import { ConfirmDialog } from '../parts/ConfirmDialog';
import {
  ACTIONS, EmptyNote, Frame, LinkRow, NUM, PageHeader, RowControls, StaleNote, TableNote, Tag,
} from '../parts/layout';
import { providerProblem } from './providerState';
import { href, navigate } from '../router';
import { ProviderDialog } from './ProviderDialog';

/** The address a provider is reached at: its own, or its connector's default. */
export function providerAddress(
  provider: { baseUrl: string | null; connector: string }, connectors: readonly ConnectorInfo[],
): { url: string | null; isDefault: boolean } {
  if (provider.baseUrl !== null) return { url: provider.baseUrl, isDefault: false };
  const connector = connectors.find((item) => item.id === provider.connector);
  return { url: connector?.defaultBaseUrl ?? null, isDefault: true };
}

export function connectorName(id: string, connectors: readonly ConnectorInfo[]): string {
  return connectors.find((item) => item.id === id)?.name ?? id;
}

type Dialog = { kind: 'create' } | { kind: 'edit'; provider: ProviderListItem } | { kind: 'remove'; provider: ProviderListItem };

export function ProvidersPage() {
  const api = useApi();
  const list = useLoad(async () => {
    const [providers, connectors] = await Promise.all([api.listProviders(), api.listConnectors()]);
    return { providers: providers.providers, connectors: connectors.connectors };
  }, [api]);
  const rows = useRowActions();
  const removal = useAction();
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const closeDialog = () => {
    setDialog(null);
    removal.clearError();
  };

  const providers = list.data?.providers ?? [];
  const connectors = list.data?.connectors ?? [];

  const setEnabled = (provider: ProviderListItem, enabled: boolean) => rows.run(provider.id, async () => {
    await api.updateProvider(provider.id, { enabled });
    await list.reload();
  }, (reason) => toast.error(reason));

  const remove = async (provider: ProviderListItem) => {
    const done = await removal.run(async () => {
      await api.deleteProvider(provider.id);
      await list.reload();
    });
    if (done) {
      closeDialog();
      toast.success(`已移除 ${provider.name}`);
    }
  };

  return (
    <>
      <PageHeader title="提供商" count={list.data ? providers.length : undefined}>
        <Button disabled={!list.data} onClick={() => setDialog({ kind: 'create' })}>
          <PlusIcon data-icon="inline-start" />
          添加提供商
        </Button>
      </PageHeader>

      {list.data && <StaleNote error={list.error} />}

      <Frame>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>名称</TableHead>
            <TableHead>连接器</TableHead>
            <TableHead>地址</TableHead>
            <TableHead className="text-right">模型</TableHead>
            <TableHead className={ACTIONS}><span className="sr-only">启用与操作</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {providers.map((provider) => {
            const address = providerAddress(provider, connectors);
            const problem = providerProblem(provider, connectors);
            return (
              <LinkRow key={provider.id} to={{ page: 'provider', id: provider.id }} className={cn(!provider.enabled && 'text-muted-foreground')}>
                <TableCell className="max-w-0 w-3/5 whitespace-normal">
                  {/*
                    The name has the whole width and up to two lines; a credential problem sits
                    under it, never beside.
                  */}
                  <a
                    href={href({ page: 'provider', id: provider.id })}
                    className="line-clamp-2 font-medium [overflow-wrap:anywhere] underline-offset-4 hover:underline"
                    title={provider.name}
                  >
                    {provider.name}
                  </a>
                  {problem && <Tag tone={problem.tone} className="mt-1" title={problem.detail}>{problem.text}</Tag>}
                </TableCell>
                <TableCell className="text-muted-foreground">{connectorName(provider.connector, connectors)}</TableCell>
                <TableCell className="max-w-0 w-2/5">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-mono text-code text-muted-foreground" title={address.url ?? undefined}>{address.url ?? NONE}</span>
                    {address.isDefault && address.url !== null && (
                      <span className="shrink-0 text-xs text-muted-foreground">默认</span>
                    )}
                  </span>
                </TableCell>
                <TableCell className={NUM}>{formatCount(provider.modelCount)}</TableCell>
                <TableCell className={ACTIONS}>
                  <RowControls>
                    <Switch
                      checked={provider.enabled}
                      disabled={rows.isPending(provider.id)}
                      aria-label={`启用 ${provider.name}`}
                      onCheckedChange={(checked) => void setEnabled(provider, checked)}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${provider.name} 的操作`} />}>
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setDialog({ kind: 'edit', provider })}>编辑</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setDialog({ kind: 'remove', provider })}>移除</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </RowControls>
                </TableCell>
              </LinkRow>
            );
          })}
          {providers.length === 0 && (
            <TableNote
              colSpan={5}
              loading={list.loading}
              error={list.data ? null : list.error}
              empty={<EmptyNote text="还没有提供商" action={{ label: '添加提供商', onClick: () => setDialog({ kind: 'create' }), disabled: !list.data }} />}
              onRetry={() => void list.reload()}
            />
          )}
        </TableBody>
      </Frame>

      {dialog?.kind === 'create' && (
        <ProviderDialog
          connectors={connectors}
          onClose={closeDialog}
          onSaved={(saved) => {
            setDialog(null);
            toast.success(`已添加 ${saved.name}`);
            navigate({ page: 'provider', id: saved.id, refresh: true });
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <ProviderDialog
          connectors={connectors}
          provider={dialog.provider}
          onClose={closeDialog}
          onSaved={() => {
            setDialog(null);
            void list.reload();
          }}
        />
      )}
      {dialog?.kind === 'remove' && (
        <ConfirmDialog
          title="移除提供商"
          description={`「${dialog.provider.name}」和指向它的路由一并移除，无法恢复。`}
          confirmLabel="移除"
          action={removal}
          onClose={closeDialog}
          onConfirm={() => void remove(dialog.provider)}
        />
      )}
    </>
  );
}
