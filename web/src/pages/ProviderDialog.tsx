import React, { useState } from 'react';
import type {
  ConnectorInfo, ProviderCreateBody, ProviderPatchBody, ProviderRecord,
} from '@shared/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useApi } from '../apiContext';
import { useAction } from '../hooks';
import { Field, FormError, SubmitButton } from '../parts/forms';

/**
 * Add a provider, or edit one when `provider` is given. The API key is write-only: an edit
 * shows that one is stored, replaces it when a new one is typed, and removes it on request
 * where the connector works without one.
 */
export function ProviderDialog({
  connectors, provider, onClose, onSaved,
}: {
  connectors: ConnectorInfo[];
  provider?: ProviderRecord;
  onClose: () => void;
  onSaved: (saved: ProviderRecord) => void;
}) {
  const api = useApi();
  const action = useAction();
  const [connectorId, setConnectorId] = useState(provider?.connector ?? connectors[0]?.id ?? '');
  const [name, setName] = useState(provider?.name ?? connectors[0]?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [autoPublish, setAutoPublish] = useState(provider?.autoPublish ?? true);

  const connector = connectors.find((item) => item.id === connectorId);
  const credential = connector?.credential;
  const stored = provider?.hasCredential ?? false;
  const urlRequired = connector !== undefined && connector.defaultBaseUrl === null;
  const keyRequired = credential === 'api-key' && !stored;
  // A login connector takes no credential here: the provider signs in on its own page. Its
  // address is asked for only when the connector has no default (or one was set before).
  const showUrl = credential !== 'login' || urlRequired || (provider?.baseUrl ?? null) !== null;
  const urlPlaceholder = connector?.defaultBaseUrl
    ?? (connectorId === 'aihub' ? 'http://127.0.0.1:4310' : 'http://127.0.0.1:8080/v1');
  const incomplete = name.trim() === ''
    || connector === undefined
    || (urlRequired && baseUrl.trim() === '')
    || (keyRequired && apiKey === '');

  const pickConnector = (next: string) => {
    const previous = connector?.name ?? '';
    const picked = connectors.find((item) => item.id === next);
    setConnectorId(next);
    // The name follows the connector until the administrator types one of their own.
    if (picked && (name.trim() === '' || name === previous)) setName(picked.name);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (incomplete) return;
    void action.run(async () => {
      const url = baseUrl.trim();
      if (!provider) {
        const body: ProviderCreateBody = { name: name.trim(), connector: connectorId, autoPublish };
        if (url !== '') body.baseUrl = url;
        if (apiKey !== '') body.apiKey = apiKey;
        onSaved((await api.createProvider(body)).provider);
        return;
      }
      const patch: ProviderPatchBody = {};
      if (name.trim() !== provider.name) patch.name = name.trim();
      if (url !== (provider.baseUrl ?? '')) patch.baseUrl = url === '' ? null : url;
      if (autoPublish !== provider.autoPublish) patch.autoPublish = autoPublish;
      if (apiKey !== '') patch.apiKey = apiKey;
      else if (removeKey) patch.apiKey = null;
      if (Object.keys(patch).length === 0) {
        onSaved(provider);
        return;
      }
      onSaved((await api.updateProvider(provider.id, patch)).provider);
    });
  };

  let keyHint: string | undefined;
  if (stored) keyHint = '已保存，留空不变';
  else if (credential === 'optional-api-key') keyHint = '可不填';

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !action.pending) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{provider ? '编辑提供商' : '添加提供商'}</DialogTitle>
          </DialogHeader>

          {provider ? (
            // The connector is fixed once the provider exists; it is stated, not offered.
            <p className="text-sm">
              <span className="text-muted-foreground">连接器 </span>
              {connector?.name ?? connectorId}
            </p>
          ) : (
            <Field label="连接器" hint={credential === 'login' ? '添加后登录' : undefined}>
              <Select value={connectorId} onValueChange={(next) => { if (next) pickConnector(next); }}>
                <SelectTrigger className="w-full" aria-label="连接器">
                  <SelectValue>
                    {connector?.name ?? connectorId}
                    {credential === 'login' && <span className="text-muted-foreground">登录</span>}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {connectors.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                      {item.credential === 'login' && <span className="text-muted-foreground">登录</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          <Field label="名称" htmlFor="provider-name">
            <Input
              id="provider-name"
              autoComplete="off"
              value={name}
              disabled={action.pending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          {showUrl && (
          <Field label="地址" htmlFor="provider-url" hint={urlRequired ? '必填' : '留空用默认'}>
            <Input
              id="provider-url"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-code"
              placeholder={urlPlaceholder}
              value={baseUrl}
              disabled={action.pending}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
          )}

          {credential === 'login' ? null : (
            <Field label="API Key" htmlFor="provider-key" hint={keyHint}>
              <Input
                id="provider-key"
                type="password"
                autoComplete="new-password"
                placeholder={stored ? '替换为新 Key' : undefined}
                value={apiKey}
                disabled={action.pending || removeKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              {stored && credential === 'optional-api-key' && (
                <Label className="mt-1 font-normal text-muted-foreground">
                  <Checkbox
                    checked={removeKey}
                    disabled={action.pending || apiKey !== ''}
                    onCheckedChange={(checked) => setRemoveKey(checked === true)}
                  />
                  移除已保存的 Key
                </Label>
              )}
            </Field>
          )}

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="provider-auto">自动发布新模型</Label>
            <Switch
              id="provider-auto"
              checked={autoPublish}
              disabled={action.pending}
              onCheckedChange={(checked) => setAutoPublish(checked)}
            />
          </div>

          <FormError message={action.error} />

          <DialogFooter>
            <Button type="button" variant="outline" disabled={action.pending} onClick={onClose}>取消</Button>
            <SubmitButton pending={action.pending} disabled={incomplete}>
              {provider ? '保存' : '添加'}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
