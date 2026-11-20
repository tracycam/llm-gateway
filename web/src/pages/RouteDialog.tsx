import React, { useState } from 'react';
import { CheckIcon } from 'lucide-react';
import type {
  ModelRecord, ProviderListItem, RouteCreateBody, RoutePatchBody, RouteRecord,
} from '@shared/api';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useApi } from '../apiContext';
import { formatPricePair } from '../format';
import { useAction, useLoad } from '../hooks';
import {
  Field, FormError, parseWhole, PriceFields, priceDraft, readPriceDraft, samePrice, SubmitButton,
} from '../parts/forms';

/**
 * Add a route to a model, or edit one when `route` is given. A route's provider and upstream
 * model are fixed once it exists; its weight and its own price can change.
 */
export function RouteDialog({
  model, providers, route, onClose, onSaved,
}: {
  model: ModelRecord;
  providers: ProviderListItem[];
  route?: RouteRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const action = useAction();
  const [providerId, setProviderId] = useState(route?.providerId ?? providers[0]?.id ?? '');
  const [upstream, setUpstream] = useState(route?.upstreamModel ?? '');
  const [weight, setWeight] = useState(String(route?.weight ?? 1));
  const [ownPrice, setOwnPrice] = useState(route ? route.price !== null : false);
  const [price, setPrice] = useState(priceDraft(route?.price ?? null));

  const discovered = useLoad(
    async () => (providerId === '' || route ? [] : (await api.listProviderModels(providerId)).models),
    [api, providerId, route],
  );

  const provider = providers.find((item) => item.id === providerId);
  const needle = upstream.trim().toLowerCase();
  const candidates = discovered.data ?? [];
  const matches = candidates.filter((item) => needle === '' || item.upstreamId.toLowerCase().includes(needle));

  const parsedWeight = parseWhole(weight, 1);
  const parsedPrice = readPriceDraft(price);
  const priceIncomplete = ownPrice
    && (parsedPrice === undefined || parsedPrice.input === null || parsedPrice.output === null);
  const invalid = providerId === '' || upstream.trim() === ''
    || parsedWeight === undefined || parsedWeight === null || priceIncomplete;

  const toggleOwnPrice = (next: boolean) => {
    setOwnPrice(next);
    if (!next || price.input !== '' || price.output !== '') return;
    // Start from what the provider says this upstream model costs, else from the model's price.
    const quoted = candidates.find((item) => item.upstreamId === upstream.trim())?.price;
    const start = [quoted, model.price].find((item) => item && item.input !== null && item.output !== null);
    if (start) setPrice(priceDraft(start));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (invalid || parsedWeight === undefined || parsedWeight === null) return;
    void action.run(async () => {
      const nextPrice = ownPrice && parsedPrice ? parsedPrice : null;
      if (!route) {
        const body: RouteCreateBody = { providerId, upstreamModel: upstream.trim(), weight: parsedWeight };
        if (nextPrice) body.price = nextPrice;
        await api.createRoute(model.id, body);
      } else {
        const patch: RoutePatchBody = {};
        if (parsedWeight !== route.weight) patch.weight = parsedWeight;
        const unchanged = route.price === null
          ? nextPrice === null
          : nextPrice !== null && samePrice(route.price, nextPrice);
        if (!unchanged) patch.price = nextPrice;
        if (Object.keys(patch).length > 0) await api.updateRoute(route.id, patch);
      }
      onSaved();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !action.pending) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid min-w-0 gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{route ? '编辑路由' : '添加路由'}</DialogTitle>
          </DialogHeader>

          {route ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">提供商</dt>
              <dd className="[overflow-wrap:anywhere]">{route.providerName}</dd>
              <dt className="text-muted-foreground">上游模型</dt>
              <dd className="[overflow-wrap:anywhere]">{route.upstreamModel}</dd>
            </dl>
          ) : (
            <>
              <Field label="提供商">
                <Select value={providerId} onValueChange={(next) => { if (next) setProviderId(next); }}>
                  <SelectTrigger className="w-full" aria-label="提供商">
                    <SelectValue placeholder="选择提供商">{provider?.name}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                        {!item.enabled && <span className="text-muted-foreground">已停用</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="上游模型" htmlFor="route-upstream">
                <Input
                  id="route-upstream"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="筛选或填写"
                  value={upstream}
                  disabled={action.pending}
                  onChange={(event) => setUpstream(event.target.value)}
                />
                <div className="h-44 overflow-y-auto overscroll-contain rounded-lg border">
                  {matches.length === 0 ? (
                    <p className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
                      {discovered.loading && '加载中'}
                      {!discovered.loading && discovered.error}
                      {!discovered.loading && !discovered.error && candidates.length === 0 && '没有发现的模型'}
                      {!discovered.loading && !discovered.error && candidates.length > 0 && '没有匹配项'}
                    </p>
                  ) : (
                    <ul className="p-1">
                      {matches.map((item) => {
                        const picked = item.upstreamId === upstream.trim();
                        return (
                          <li key={item.upstreamId}>
                            <button
                              type="button"
                              disabled={action.pending}
                              onClick={() => setUpstream(item.upstreamId)}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-accent focus-visible:bg-accent',
                                picked && 'bg-accent',
                              )}
                            >
                              <CheckIcon className={cn('size-3.5 shrink-0', !picked && 'invisible')} />
                              <span className="min-w-0 flex-1 truncate" title={item.upstreamId}>{item.upstreamId}</span>
                              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                {formatPricePair(item.price)}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </Field>
            </>
          )}

          <Field label="权重" htmlFor="route-weight" hint="整数 ≥ 1" className="w-40">
            <Input
              id="route-weight"
              inputMode="numeric"
              autoComplete="off"
              className="tabular-nums"
              value={weight}
              disabled={action.pending}
              aria-invalid={parsedWeight === undefined || parsedWeight === null || undefined}
              onChange={(event) => setWeight(event.target.value)}
            />
          </Field>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="route-own-price" className="gap-2">
                单独定价
                <span className="text-xs font-normal text-muted-foreground">
                  {ownPrice ? '$/1M Token' : `跟随模型 ${formatPricePair(model.price)}`}
                </span>
              </Label>
              <Switch
                id="route-own-price"
                checked={ownPrice}
                disabled={action.pending}
                onCheckedChange={toggleOwnPrice}
              />
            </div>
            {ownPrice && (
              <PriceFields idPrefix="route-price" value={price} onChange={setPrice} disabled={action.pending} required legend={null} />
            )}
          </div>

          <FormError message={action.error} />

          <DialogFooter>
            <Button type="button" variant="outline" disabled={action.pending} onClick={onClose}>取消</Button>
            <SubmitButton pending={action.pending} disabled={invalid}>{route ? '保存' : '添加'}</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
