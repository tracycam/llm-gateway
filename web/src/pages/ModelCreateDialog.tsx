import React, { useState } from 'react';
import type { ModelCreateBody, ModelRecord } from '@shared/api';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useApi } from '../apiContext';
import { useAction } from '../hooks';
import {
  Field, FormError, parseWhole, PriceFields, priceDraft, readPriceDraft, SubmitButton,
} from '../parts/forms';

/** Create a model by hand; its routes are added on its page afterwards. */
export function ModelCreateDialog({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (model: ModelRecord) => void;
}) {
  const api = useApi();
  const action = useAction();
  const [name, setName] = useState('');
  const [price, setPrice] = useState(priceDraft(null));
  const [context, setContext] = useState('');

  const parsedPrice = readPriceDraft(price);
  const parsedContext = parseWhole(context, 1);
  const invalid = name.trim() === '' || parsedPrice === undefined || parsedContext === undefined;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (invalid) return;
    void action.run(async () => {
      const body: ModelCreateBody = { name: name.trim(), price: parsedPrice, contextLength: parsedContext };
      onCreated((await api.createModel(body)).model);
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !action.pending) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>新建模型</DialogTitle>
          </DialogHeader>

          <Field label="名称" htmlFor="model-name" hint="请求里的 model">
            <Input
              id="model-name"
              autoComplete="off"
              spellCheck={false}
              value={name}
              disabled={action.pending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <PriceFields idPrefix="model-price" value={price} onChange={setPrice} disabled={action.pending} />

          <div className="grid grid-cols-3 gap-4">
          <Field label="上下文长度" htmlFor="model-context" hint="Token">
            <Input
              id="model-context"
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

          <FormError message={action.error} />

          <DialogFooter>
            <Button type="button" variant="outline" disabled={action.pending} onClick={onClose}>取消</Button>
            <SubmitButton pending={action.pending} disabled={invalid}>创建</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
