import React, { useMemo, useState } from 'react';
import { SearchIcon } from 'lucide-react';
import type {
  KeyCreateBody, KeyCreatedResponse, KeyPatchBody, KeyRecord, ModelRecord, ResetPeriod,
} from '@shared/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useApi } from '../apiContext';
import { RESET_PERIOD_LABEL, toLocalInput } from '../format';
import { useAction } from '../hooks';
import {
  Field, FormError, numberText, parseAmount, parseWhole, SubmitButton,
} from '../parts/forms';
import { Segmented } from '../parts/Segmented';

const PERIODS: ResetPeriod[] = ['none', 'day', 'week', 'month'];

const SCOPE: { value: 'all' | 'some'; label: string }[] = [
  { value: 'all', label: '全部模型' },
  { value: 'some', label: '指定模型' },
];

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** Create a key, or edit one when `existing` is given. */
export function KeyDialog({
  models, existing, onClose, onCreated, onSaved,
}: {
  models: ModelRecord[];
  existing?: KeyRecord;
  onClose: () => void;
  onCreated: (created: KeyCreatedResponse) => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const action = useAction();
  const [name, setName] = useState(existing?.name ?? '');
  const [restricted, setRestricted] = useState(existing?.restricted ?? false);
  const [modelIds, setModelIds] = useState<string[]>(existing?.modelIds ?? []);
  const [filter, setFilter] = useState('');
  const [costLimit, setCostLimit] = useState(numberText(existing?.costLimit ?? null));
  const [resetPeriod, setResetPeriod] = useState<ResetPeriod>(existing?.resetPeriod ?? 'none');
  const [concurrency, setConcurrency] = useState(numberText(existing?.maxConcurrency ?? null));
  const initialExpiry = toLocalInput(existing?.expiresAt ?? null);
  const [expiry, setExpiry] = useState(initialExpiry);

  const parsedLimit = parseAmount(costLimit);
  const parsedConcurrency = parseWhole(concurrency, 1);
  const expiryDate = expiry === '' ? null : new Date(expiry);
  const expiryInvalid = expiryDate !== null && !Number.isFinite(expiryDate.getTime());
  const invalid = name.trim() === '' || parsedLimit === undefined || parsedConcurrency === undefined || expiryInvalid;

  // With a hundred models the ones this key already has are listed first (as the dialog
  // opened, so ticking does not move rows), the rest by name.
  const [chosenAtOpen] = useState(() => new Set(existing?.modelIds ?? []));
  const ordered = useMemo(() => [...models].sort((a, b) => (
    Number(chosenAtOpen.has(b.id)) - Number(chosenAtOpen.has(a.id)) || a.name.localeCompare(b.name)
  )), [models, chosenAtOpen]);
  const needle = filter.trim().toLowerCase();
  const shown = ordered.filter((model) => needle === '' || model.name.toLowerCase().includes(needle));

  const toggleModel = (id: string, checked: boolean) => {
    setModelIds((current) => (checked ? [...current, id] : current.filter((item) => item !== id)));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (invalid || parsedLimit === undefined || parsedConcurrency === undefined) return;
    void action.run(async () => {
      const expiresAt = expiryDate ? expiryDate.toISOString() : null;
      if (!existing) {
        const body: KeyCreateBody = {
          name: name.trim(), restricted, costLimit: parsedLimit, resetPeriod,
          maxConcurrency: parsedConcurrency, expiresAt,
        };
        if (restricted) body.modelIds = modelIds;
        onCreated(await api.createKey(body));
        return;
      }
      const patch: KeyPatchBody = {};
      if (name.trim() !== existing.name) patch.name = name.trim();
      if (restricted !== existing.restricted) patch.restricted = restricted;
      if (restricted && !sameIds(modelIds, existing.modelIds)) patch.modelIds = modelIds;
      if (parsedLimit !== existing.costLimit) patch.costLimit = parsedLimit;
      if (resetPeriod !== existing.resetPeriod) patch.resetPeriod = resetPeriod;
      if (parsedConcurrency !== existing.maxConcurrency) patch.maxConcurrency = parsedConcurrency;
      // The field holds minutes; an expiry left as it was keeps its stored seconds.
      if (expiry !== initialExpiry) patch.expiresAt = expiresAt;
      if (Object.keys(patch).length > 0) await api.updateKey(existing.id, patch);
      onSaved();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !action.pending) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid min-w-0 gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{existing ? '编辑密钥' : '创建密钥'}</DialogTitle>
          </DialogHeader>

          <Field label="名称" htmlFor="key-name">
            <Input
              id="key-name"
              autoComplete="off"
              value={name}
              disabled={action.pending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field label="可用模型" hint={restricted ? `已选 ${modelIds.length} / ${models.length}` : undefined}>
            <Segmented
              label="可用模型"
              value={restricted ? 'some' : 'all'}
              options={SCOPE}
              disabled={action.pending}
              onChange={(next) => setRestricted(next === 'some')}
            />
            {restricted && (
              <div className="mt-1 flex flex-col gap-1.5">
                {models.length > 8 && (
                  <InputGroup>
                    <InputGroupAddon><SearchIcon /></InputGroupAddon>
                    <InputGroupInput
                      placeholder="筛选模型"
                      aria-label="筛选模型"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                    />
                  </InputGroup>
                )}
                <div className="max-h-56 overflow-y-auto overscroll-contain rounded-lg border p-1">
                  {shown.map((model) => (
                    <label
                      key={model.id}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent"
                    >
                      <Checkbox
                        checked={modelIds.includes(model.id)}
                        disabled={action.pending}
                        onCheckedChange={(checked) => toggleModel(model.id, checked === true)}
                      />
                      <span className="min-w-0 flex-1 truncate" title={model.name}>{model.name}</span>
                      {!model.enabled && <span className="shrink-0 text-xs text-muted-foreground">已停用</span>}
                    </label>
                  ))}
                  {shown.length === 0 && (
                    <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                      {models.length === 0 ? '还没有模型' : '没有匹配的模型'}
                    </p>
                  )}
                </div>
              </div>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="费用限额" htmlFor="key-limit" hint="USD / 周期">
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input
                  id="key-limit"
                  inputMode="decimal"
                  autoComplete="off"
                  className="pl-6 tabular-nums"
                  placeholder="不限"
                  value={costLimit}
                  disabled={action.pending}
                  aria-invalid={parsedLimit === undefined || undefined}
                  onChange={(event) => setCostLimit(event.target.value)}
                />
              </div>
            </Field>
            <Field label="重置周期">
              <Select
                value={resetPeriod}
                onValueChange={(next) => { if (next) setResetPeriod(next as ResetPeriod); }}
                disabled={action.pending}
              >
                <SelectTrigger className="w-full" aria-label="重置周期">
                  <SelectValue>{RESET_PERIOD_LABEL[resetPeriod]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PERIODS.map((period) => (
                    <SelectItem key={period} value={period}>{RESET_PERIOD_LABEL[period]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="最大并发" htmlFor="key-concurrency" hint="请求">
              <Input
                id="key-concurrency"
                inputMode="numeric"
                autoComplete="off"
                className="tabular-nums"
                placeholder="不限"
                value={concurrency}
                disabled={action.pending}
                aria-invalid={parsedConcurrency === undefined || undefined}
                onChange={(event) => setConcurrency(event.target.value)}
              />
            </Field>
            <Field label="到期时间" htmlFor="key-expiry" hint="留空不到期">
              <Input
                id="key-expiry"
                type="datetime-local"
                className="tabular-nums"
                value={expiry}
                disabled={action.pending}
                aria-invalid={expiryInvalid || undefined}
                onChange={(event) => setExpiry(event.target.value)}
              />
            </Field>
          </div>

          <FormError message={action.error} />

          <DialogFooter>
            <Button type="button" variant="outline" disabled={action.pending} onClick={onClose}>取消</Button>
            <SubmitButton pending={action.pending} disabled={invalid}>{existing ? '保存' : '创建'}</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
