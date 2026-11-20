import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckIcon, Loader2Icon, LogInIcon, PencilIcon, SearchIcon, Trash2Icon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { DiscoveredModel, ModelRecord, Protocol } from '@shared/api';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useApi } from '../apiContext';
import { formatAgo, formatCount, formatDateTime, formatUsd, NONE } from '../format';
import { useAction, useLoad, useRowActions } from '../hooks';
import { ConfirmDialog } from '../parts/ConfirmDialog';
import {
  EmptyNote, Facts, LoadFailure, NUM, PageHeader, RefreshButton, Section, StaleNote, TableNote, Tag,
} from '../parts/layout';
import { ScrollTable } from '../parts/ScrollTable';
import { Segmented } from '../parts/Segmented';
import { href, navigate } from '../router';
import { LoginDialog } from './LoginDialog';
import { canSync, credentialProblem, logsIn } from './providerState';
import { ProviderDialog } from './ProviderDialog';
import { connectorName, providerAddress } from './ProvidersPage';

type Shown = 'all' | 'published' | 'unpublished';

/** The three billed kinds, in the order every price in the console uses. */
const PRICE_HEADS = ['输入', '输出', '缓存读'];

const PROTOCOL_LABEL: Record<Protocol, string> = { chat: 'Chat', messages: 'Messages', responses: 'Responses' };

/** The interfaces a model speaks, under its name; nothing when the provider did not say. */
function Protocols({ protocols }: { protocols: Protocol[] | null }) {
  if (protocols === null) return null;
  if (protocols.length === 0) return <span className="block text-xs text-warn">无可用接口</span>;
  return (
    // Never cut: the line wraps between interfaces instead.
    <span className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
      {protocols.map((protocol, index) => (
        <span key={protocol} className="whitespace-nowrap">
          {index > 0 && <span aria-hidden className="mr-1.5">·</span>}
          {PROTOCOL_LABEL[protocol] ?? protocol}
        </span>
      ))}
    </span>
  );
}

const SHOWN: { value: Shown; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'published', label: '已发布' },
  { value: 'unpublished', label: '未发布' },
];

/** The models that route to one upstream model of a provider. */
function publishedAs(models: readonly ModelRecord[], providerId: string, upstreamId: string): ModelRecord[] {
  return models.filter((model) => model.routes.some(
    (route) => route.providerId === providerId && route.upstreamModel === upstreamId,
  ));
}

export function ProviderDetailPage({ id, refreshOnArrival }: { id: string; refreshOnArrival: boolean }) {
  const api = useApi();
  const base = useLoad(async () => {
    const [providers, connectors] = await Promise.all([api.listProviders(), api.listConnectors()]);
    return {
      provider: providers.providers.find((item) => item.id === id) ?? null,
      connectors: connectors.connectors,
    };
  }, [api, id]);
  const discovered = useLoad(() => api.listProviderModels(id), [api, id]);
  const published = useLoad(() => api.listModels(), [api]);

  const refresh = useAction();
  const toggle = useAction();
  const removal = useAction();
  const rows = useRowActions();
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState<Shown>('all');
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const signOut = useAction();
  // The list a refresh answered; it replaces the loaded one until the next load.
  const [refreshed, setRefreshed] = useState<DiscoveredModel[] | null>(null);

  const provider = base.data?.provider ?? null;
  const connectors = base.data?.connectors ?? [];
  const models = refreshed ?? discovered.data?.models ?? [];

  const isLogin = provider !== null && logsIn(provider, connectors);
  const loginState = useLoad(
    async () => (isLogin ? (await api.loginStatus(id)).login : null),
    [api, id, isLogin],
  );

  const runRefresh = () => refresh.run(async () => {
    try {
      setRefreshed((await api.refreshProvider(id)).models);
    } finally {
      // The provider records how the fetch went (time or error) either way; auto-publish may
      // have added models and routes.
      await Promise.all([published.reload(), base.reload()]);
    }
  });

  // The gateway fetches the model list by itself after a provider is created, enabled, or its
  // address or key changes. Until that fetch is recorded the page looks again every 2 s, up to
  // a minute; `watching` holds what the provider said before and when to stop looking.
  const [watching, setWatching] = useState<{ at: string | null; error: string | null; until: number } | null>(
    null,
  );
  const watch = useCallback((from: { modelsRefreshedAt: string | null; modelsError: string | null }) => {
    setWatching({ at: from.modelsRefreshedAt, error: from.modelsError, until: Date.now() + 60_000 });
  }, []);
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current || !base.data) return;
    arrived.current = true;
    if (refreshOnArrival) navigate({ page: 'provider', id }, { replace: true });
    const found = base.data.provider;
    if (found && found.modelsRefreshedAt === null && found.modelsError === null
      && canSync(found, base.data.connectors)) watch(found);
  }, [base.data, id, refreshOnArrival, watch]);
  const watchedProvider = base.data?.provider ?? null;
  useEffect(() => {
    if (!watching || !watchedProvider) return;
    if (watchedProvider.modelsRefreshedAt !== watching.at || watchedProvider.modelsError !== watching.error) {
      setWatching(null);
      setRefreshed(null);
      void Promise.all([discovered.reload(), published.reload()]);
      return;
    }
    // Each reload re-runs this effect, so the limit is a deadline, not a count of tries.
    const timer = window.setTimeout(() => {
      if (Date.now() > watching.until) setWatching(null);
      else void base.reload();
    }, 2000);
    return () => window.clearTimeout(timer);
    // `base` is a fresh object each render; its reload is what is wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, watchedProvider]);

  // After a login: the provider again (it now has a credential), then its models, once.
  const afterSignIn = useCallback(async (): Promise<number | null> => {
    await base.reload();
    try {
      const answer = await api.refreshProvider(id);
      setRefreshed(answer.models);
      await Promise.all([published.reload(), base.reload()]);
      return answer.models.length;
    } catch (failure) {
      console.warn('refresh after login failed', failure);
      return null;
    }
  }, [api, id, base, published]);

  const doSignOut = async () => {
    const done = await signOut.run(async () => {
      await api.signOut(id);
      await Promise.all([base.reload(), loginState.reload()]);
    });
    // No toast: the page itself now says 未登录, and a toast would outlive the page.
    if (done) setSigningOut(false);
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return models.filter((model) => {
      if (shown === 'published' && !model.published) return false;
      if (shown === 'unpublished' && model.published) return false;
      return needle === '' || model.upstreamId.toLowerCase().includes(needle);
    });
  }, [models, query, shown]);

  const publish = (model: DiscoveredModel) => rows.run(model.upstreamId, async () => {
    await api.publishProviderModel(id, { upstreamId: model.upstreamId });
    await Promise.all([discovered.reload(), published.reload()]);
    setRefreshed(null);
    toast.success(`已发布 ${model.upstreamId}`);
  }, (reason) => toast.error(reason));

  const setEnabled = (enabled: boolean) => toggle.run(async () => {
    const before = provider;
    await api.updateProvider(id, { enabled });
    await base.reload();
    if (enabled && before) watch(before);
  });

  const remove = async () => {
    if (!provider) return;
    const done = await removal.run(() => api.deleteProvider(id));
    if (done) {
      toast.success(`已移除 ${provider.name}`);
      navigate({ page: 'providers' });
    }
  };

  if (!provider) {
    return (
      <>
        <PageHeader
          title={base.loading ? '' : (base.error ? '加载失败' : '没有这个提供商')}
          crumb={{ label: '提供商', to: { page: 'providers' } }}
        />
        {base.error && <LoadFailure error={base.error} loading={base.loading} onRetry={() => void base.reload()} />}
      </>
    );
  }

  // What an empty table says depends on what was just tried: it never asks for the refresh
  // that has just failed, or that has just answered with nothing.
  const syncError = provider.modelsError ?? refresh.error;
  let emptyText: React.ReactNode = '没有匹配的模型';
  if (models.length === 0) {
    if (syncError) emptyText = <span className="text-destructive">同步失败：{syncError}</span>;
    else if (watching) {
      emptyText = (
        <span className="inline-flex items-center gap-2">
          <Loader2Icon className="size-4 animate-spin" />
          正在获取模型
        </span>
      );
    }
    else if (refreshed) emptyText = '上游没有返回模型';
    else if (isLogin && !provider.hasCredential) {
      emptyText = <EmptyNote text="未登录" action={{ label: '登录', onClick: () => setLoggingIn(true) }} />;
    } else emptyText = '还没有模型，点刷新向上游查询';
  }

  const problem = credentialProblem(provider, connectors);
  const pendingLogin = loginState.data?.state === 'pending';
  const signedIn = provider.hasCredential && !provider.credentialRejected;
  let loginLabel = '登录';
  if (pendingLogin) loginLabel = '继续登录';
  else if (provider.hasCredential || provider.credentialRejected) loginLabel = '重新登录';

  const address = providerAddress(provider, connectors);
  const publishedCount = models.filter((model) => model.published).length;

  return (
    <>
      <PageHeader
        title={(
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            {provider.name}
            {problem && <Tag tone={problem.tone}>{problem.text}</Tag>}
          </span>
        )}
        crumb={{ label: '提供商', to: { page: 'providers' } }}
      >
        <Label className="mr-2 font-normal text-muted-foreground">
          启用
          <Switch
            checked={provider.enabled}
            disabled={toggle.pending}
            onCheckedChange={(checked) => void setEnabled(checked)}
          />
        </Label>
        {isLogin && (
          <Button variant={signedIn && !pendingLogin ? 'outline' : 'default'} onClick={() => setLoggingIn(true)}>
            <LogInIcon data-icon="inline-start" />
            {loginLabel}
          </Button>
        )}
        {isLogin && provider.hasCredential && (
          <Button variant="outline" onClick={() => setSigningOut(true)}>退出登录</Button>
        )}
        <Button variant="outline" onClick={() => setEditing(true)}>
          <PencilIcon data-icon="inline-start" />
          编辑
        </Button>
        <Button variant="outline" onClick={() => setRemoving(true)}>
          <Trash2Icon data-icon="inline-start" />
          移除
        </Button>
      </PageHeader>

      <StaleNote error={toggle.error ?? base.error} />

      <Facts
        items={[
          { label: '连接器', value: connectorName(provider.connector, connectors) },
          {
            label: address.isDefault ? '地址 · 默认' : '地址',
            value: <span className="font-mono text-code">{address.url ?? NONE}</span>,
            wide: true,
          },
          isLogin
            ? {
              label: '登录',
              value: problem
                ? <span className={problem.tone === 'danger' ? 'text-destructive' : 'text-warn'}>{problem.text}</span>
                : '已登录',
            }
            : {
              label: 'API Key',
              value: provider.credentialRejected
                ? <span className="text-destructive">被拒</span>
                : (provider.hasCredential ? '已保存' : '无'),
            },
          { label: '自动发布', value: provider.autoPublish ? '开' : '关' },
          { label: '添加于', value: <span className="tabular-nums">{formatDateTime(provider.createdAt)}</span> },
        ]}
      />

      <Section
        title="发现的模型"
        count={visible.length === models.length ? models.length : `${visible.length} / ${models.length}`}
        aside={(models.length > 0 || provider.modelsRefreshedAt !== null) && (
          <>
            {models.length > 0 && `已发布 ${publishedCount}`}
            {models.length > 0 && provider.modelsRefreshedAt !== null && ' · '}
            {provider.modelsRefreshedAt !== null && (
              <span title={formatDateTime(provider.modelsRefreshedAt)}>
                更新于 {formatAgo(provider.modelsRefreshedAt)}
              </span>
            )}
          </>
        )}
        actions={(
          <>
            <InputGroup className="w-56">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                placeholder="筛选"
                aria-label="筛选模型"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </InputGroup>
            <Segmented label="发布状态" value={shown} options={SHOWN} onChange={setShown} />
            <RefreshButton loading={refresh.pending} onClick={() => void runRefresh()} />
          </>
        )}
      >
        {syncError && models.length > 0 && <StaleNote error={`同步失败：${syncError}`} />}

        <ScrollTable className="max-h-[calc(100vh-16rem)] min-h-40">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>上游模型</TableHead>
              <TableHead className="text-right">上下文</TableHead>
              <TableHead className="text-right">最长输出</TableHead>
              {PRICE_HEADS.map((label, index) => (
                <TableHead key={label} className={cn('text-right', index === 0 && 'pl-6')}>
                  {label} <span className="text-muted-foreground/70">$/1M</span>
                </TableHead>
              ))}
              <TableHead className="text-right">发布</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((model) => {
              const targets = model.published ? publishedAs(published.data?.models ?? [], id, model.upstreamId) : [];
              return (
                <TableRow key={model.upstreamId}>
                  <TableCell className="max-w-0 w-full">
                    <span className="block truncate" title={model.upstreamId}>{model.upstreamId}</span>
                    <Protocols protocols={model.protocols} />
                  </TableCell>
                  <TableCell className={NUM}>{formatCount(model.contextLength)}</TableCell>
                  <TableCell className={NUM}>{formatCount(model.maxOutputTokens)}</TableCell>
                  <TableCell className={`${NUM} pl-6`}>{formatUsd(model.price.input)}</TableCell>
                  <TableCell className={NUM}>{formatUsd(model.price.output)}</TableCell>
                  <TableCell className={NUM}>{formatUsd(model.price.cacheRead)}</TableCell>
                  <TableCell className="w-28 text-right">
                    {model.published ? (
                      <span className="inline-flex max-w-32 items-center justify-end gap-1.5 text-muted-foreground">
                        <CheckIcon className="size-3.5 shrink-0" />
                        {targets.length === 0 ? '已发布' : (
                          <a
                            href={href({ page: 'model', id: targets[0].id })}
                            className="truncate underline-offset-4 hover:text-foreground hover:underline"
                            title={targets.map((target) => target.name).join('、')}
                          >
                            {targets.length > 1 && `${targets.length} 个模型`}
                            {targets.length === 1 && (targets[0].name === model.upstreamId ? '已发布' : targets[0].name)}
                          </a>
                        )}
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={rows.isPending(model.upstreamId)}
                        onClick={() => void publish(model)}
                      >
                        {rows.isPending(model.upstreamId) && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
                        发布
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {visible.length === 0 && (
              <TableNote
                colSpan={7}
                loading={discovered.loading || refresh.pending}
                error={discovered.data ? null : discovered.error}
                empty={emptyText}
                onRetry={() => void discovered.reload()}
              />
            )}
          </TableBody>
        </ScrollTable>
      </Section>

      {editing && (
        <ProviderDialog
          connectors={connectors}
          provider={provider}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            // A changed address or key makes the gateway fetch the list again.
            watch(provider);
            void base.reload();
          }}
        />
      )}
      {loggingIn && (
        <LoginDialog
          provider={provider}
          initial={loginState.data}
          onClose={() => {
            setLoggingIn(false);
            void loginState.reload();
            void base.reload();
          }}
          onSignedIn={afterSignIn}
        />
      )}
      {signingOut && (
        <ConfirmDialog
          title="退出登录"
          description={`「${provider.name}」的登录凭证移除，请求不再发往这里，直到重新登录。`}
          confirmLabel="退出登录"
          action={signOut}
          onClose={() => { setSigningOut(false); signOut.clearError(); }}
          onConfirm={() => void doSignOut()}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="移除提供商"
          description={`「${provider.name}」和指向它的路由一并移除，无法恢复。`}
          confirmLabel="移除"
          action={removal}
          onClose={() => { setRemoving(false); removal.clearError(); }}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}
