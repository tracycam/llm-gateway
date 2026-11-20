import { useEffect, useRef, useState } from 'react';
import { CheckCircle2Icon, ExternalLinkIcon, Loader2Icon } from 'lucide-react';
import type { LoginStatus, ProviderRecord } from '@shared/api';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useApi } from '../apiContext';
import { errorText } from '../hooks';
import { CopyButton } from '../parts/CopyButton';
import { formatCount } from '../format';

/** The gateway is never asked about a pending login more often than this, in seconds. */
const MIN_POLL_S = 2;

type Phase =
  | { kind: 'starting' }
  /** The start was refused; the server's text. */
  | { kind: 'refused'; message: string }
  | { kind: 'status'; login: LoginStatus };

function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The device-code login of one provider. Opening it shows the pending code if a login is
 * already waiting, else starts one. While pending it asks the gateway at the pace the login
 * gives and stops when it closes; closing does not cancel the login, which the gateway keeps
 * waiting on. 取消登录 cancels the pending login only; a stored credential is kept.
 */
export function LoginDialog({
  provider, initial, onClose, onSignedIn,
}: {
  provider: ProviderRecord;
  /** The login as the page last saw it; a pending one is shown instead of starting anew. */
  initial: LoginStatus | null;
  onClose: () => void;
  /** Reload the provider and refresh its models once; answers how many models it found. */
  onSignedIn: () => Promise<number | null>;
}) {
  const api = useApi();
  const [phase, setPhase] = useState<Phase>(
    initial?.state === 'pending' ? { kind: 'status', login: initial } : { kind: 'starting' },
  );
  const [pollError, setPollError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [found, setFound] = useState<number | null | undefined>(undefined);
  const signedIn = useRef(false);
  const open = useRef(true);
  useEffect(() => () => { open.current = false; }, []);

  const start = async () => {
    setPhase({ kind: 'starting' });
    setPollError(null);
    try {
      const { login } = await api.startLogin(provider.id);
      if (open.current) setPhase({ kind: 'status', login });
    } catch (failure) {
      if (open.current) setPhase({ kind: 'refused', message: errorText(failure) });
    }
  };

  useEffect(() => {
    if (initial?.state !== 'pending') void start();
    // Runs once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = phase.kind === 'status' ? phase.login : null;
  const pending = login?.state === 'pending' ? login : null;

  // Ask again after the login's interval while it is pending; nothing once it ends or closes.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(async () => {
      try {
        const answer = await api.loginStatus(provider.id);
        if (!open.current) return;
        setPollError(null);
        setPhase({ kind: 'status', login: answer.login });
      } catch (failure) {
        if (!open.current) return;
        // The login itself goes on at the gateway; try again at the same pace.
        setPollError(errorText(failure));
        setPhase({ kind: 'status', login: { ...pending } });
      }
    }, Math.max(MIN_POLL_S, pending.interval) * 1000);
    return () => window.clearTimeout(timer);
  }, [api, provider.id, pending]);

  // The countdown under the code.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  useEffect(() => {
    if (login?.state !== 'done' || signedIn.current) return;
    signedIn.current = true;
    void onSignedIn().then((count) => { if (open.current) setFound(count); });
  }, [login, onSignedIn]);

  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await api.cancelLogin(provider.id);
      onClose();
    } catch (failure) {
      setCancelError(errorText(failure));
      setCancelling(false);
    }
  };

  const restartable = phase.kind === 'refused'
    || (login !== null && login.state !== 'pending' && login.state !== 'done');

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !cancelling) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">登录 {provider.name}</DialogTitle>
        </DialogHeader>

        {phase.kind === 'starting' && (
          <p className="flex h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            正在获取验证码
          </p>
        )}

        {phase.kind === 'refused' && (
          <p role="alert" className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive [overflow-wrap:anywhere]">
            {phase.message}
          </p>
        )}

        {pending && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">验证码</span>
              <div className="flex items-center justify-between gap-3 rounded-lg bg-muted py-2 pr-2 pl-4">
                <code className="font-mono text-figure font-semibold tracking-[0.12em] select-all [overflow-wrap:anywhere]">{pending.userCode}</code>
                <CopyButton text={pending.userCode} label="复制" variant="outline" />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">验证页</span>
              <a
                href={pending.verificationUriComplete ?? pending.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit max-w-full items-center gap-1.5 text-sm text-brand underline-offset-4 hover:underline"
              >
                打开
                <span className="truncate font-mono text-code">{pending.verificationUri}</span>
                <ExternalLinkIcon className="size-3.5 shrink-0" />
              </a>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
              <span>剩余 <span className="text-foreground">{remaining(pending.expiresAt, now)}</span></span>
              <span className="inline-flex items-center gap-1.5">
                <Loader2Icon className="size-3.5 animate-spin" />
                等待确认
              </span>
              {pollError && <span className="text-destructive">{pollError}</span>}
            </div>
          </div>
        )}

        {login?.state === 'done' && (
          <div className="flex items-center gap-3 rounded-lg bg-muted px-4 py-3">
            <CheckCircle2Icon className="size-5 shrink-0 text-brand" />
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">已登录</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {found === undefined && '正在刷新模型'}
                {typeof found === 'number' && `发现 ${formatCount(found)} 个模型`}
                {found === null && '模型刷新失败'}
              </span>
            </div>
          </div>
        )}

        {login?.state === 'failed' && (
          <div role="alert" className="flex flex-col gap-1 rounded-lg bg-destructive/8 px-4 py-3 text-sm">
            <span className="font-medium text-destructive">登录失败</span>
            <span className="text-destructive [overflow-wrap:anywhere]">{login.reason}</span>
          </div>
        )}

        {login?.state === 'expired' && (
          <p role="alert" className="rounded-lg bg-muted px-4 py-3 text-sm">验证码已过期</p>
        )}

        {login?.state === 'none' && (
          <p className="rounded-lg bg-muted px-4 py-3 text-sm">登录已取消</p>
        )}

        {cancelError && <p role="alert" className="text-sm text-destructive">{cancelError}</p>}

        <DialogFooter className={cn(pending && 'sm:justify-between')}>
          {pending && (
            <Button
              type="button"
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => void cancel()}
              disabled={cancelling}
            >
              {cancelling && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              取消登录
            </Button>
          )}
          <div className="flex gap-2">
            {restartable && (
              <Button type="button" variant="outline" onClick={() => void start()}>重新开始</Button>
            )}
            {/*
              Outline beside the pending login's own actions, primary once the login has ended.
              Keyed by variant so a state change swaps the button instead of animating its
              colours: caught mid-transition it reads as disabled.
            */}
            <Button
              key={pending ? 'close-outline' : 'close-default'}
              type="button"
              variant={pending ? 'outline' : 'default'}
              disabled={cancelling}
              onClick={onClose}
            >
              关闭
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
