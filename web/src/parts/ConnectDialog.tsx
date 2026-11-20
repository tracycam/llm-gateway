import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '../apiContext';
import { useLoad } from '../hooks';
import { CopyButton } from './CopyButton';

type Snippet = 'chat' | 'messages' | 'responses' | 'models';

function snippet(kind: Snippet, origin: string, model: string): string {
  if (kind === 'models') {
    return `curl ${origin}/v1/models \\\n  -H "Authorization: Bearer $GATEWAY_KEY"`;
  }
  if (kind === 'responses') {
    return [
      `curl ${origin}/v1/responses \\`,
      '  -H "Authorization: Bearer $GATEWAY_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '{"model": "${model}", "input": "你好"}'`,
    ].join('\n');
  }
  if (kind === 'messages') {
    return [
      `curl ${origin}/v1/messages \\`,
      '  -H "x-api-key: $GATEWAY_KEY" \\',
      '  -H "anthropic-version: 2023-06-01" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '{"model": "${model}", "max_tokens": 256,`,
      '       "messages": [{"role": "user", "content": "你好"}]}\'',
    ].join('\n');
  }
  return [
    `curl ${origin}/v1/chat/completions \\`,
    '  -H "Authorization: Bearer $GATEWAY_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model": "${model}",`,
    '       "messages": [{"role": "user", "content": "你好"}]}\'',
  ].join('\n');
}

function Address({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 rounded-lg bg-muted py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-code" title={value}>{value}</code>
        <CopyButton text={value} />
      </div>
    </div>
  );
}

/** How a client reaches this gateway: the two base addresses and one request per interface. */
export function ConnectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        {open && <ConnectBody />}
      </DialogContent>
    </Dialog>
  );
}

function ConnectBody() {
  const api = useApi();
  const [kind, setKind] = useState<Snippet>('chat');
  const models = useLoad(() => api.listModels(), [api]);
  const origin = window.location.origin;
  const model = models.data?.models.find((item) => item.enabled)?.name ?? '模型名';
  const code = snippet(kind, origin, model);

  return (
    <>
      <DialogHeader>
        <DialogTitle>接入</DialogTitle>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <Address label="OpenAI SDK base_url" value={`${origin}/v1`} />
        <Address label="Anthropic SDK base_url" value={origin} />
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Tabs value={kind} onValueChange={(next) => setKind(next as Snippet)}>
            <TabsList>
              <TabsTrigger value="chat" className="px-2.5 font-mono text-xs">POST /v1/chat/completions</TabsTrigger>
              <TabsTrigger value="messages" className="px-2.5 font-mono text-xs">POST /v1/messages</TabsTrigger>
              <TabsTrigger value="responses" className="px-2.5 font-mono text-xs">POST /v1/responses</TabsTrigger>
              <TabsTrigger value="models" className="px-2.5 font-mono text-xs">GET /v1/models</TabsTrigger>
            </TabsList>
          </Tabs>
          <CopyButton text={code} label="复制" variant="outline" />
        </div>
        <pre className="overflow-x-auto rounded-lg bg-muted p-4 font-mono text-code">{code}</pre>
      </div>
    </>
  );
}
