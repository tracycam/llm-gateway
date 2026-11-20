import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { LoaderCircleIcon, LogOutIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface SessionInfo {
  authRequired: boolean;
  authenticated: boolean;
}

type GateView = 'pending' | 'login' | 'app' | 'error';
type SessionCheck = 'app' | 'login' | 'unknown';

export type AuthFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

interface AuthContextValue {
  authRequired: boolean;
  authFetch: AuthFetch;
  refreshSession: () => Promise<SessionCheck>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSessionInfo(value: unknown): value is SessionInfo {
  return (
    isRecord(value) &&
    typeof value.authRequired === 'boolean' &&
    typeof value.authenticated === 'boolean'
  );
}

async function requestSession(prefix: string): Promise<SessionInfo> {
  const response = await fetch(`${prefix}/session`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (!isSessionInfo(data)) throw new Error('Invalid session response');
  return data;
}

async function responseError(response: Response): Promise<string | null> {
  try {
    const data: unknown = await response.json();
    return isRecord(data) && typeof data.error === 'string'
      ? data.error
      : null;
  } catch {
    return null;
  }
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthGate');
  return context;
}

function LoginForm({ prefix }: { prefix: string }) {
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !token) return;
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`${prefix}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (response.status === 401) {
        setError((await responseError(response)) ?? '令牌错误');
        setPending(false);
        return;
      }
      if (!response.ok) {
        setError('登录失败');
        setPending(false);
        return;
      }
      window.location.reload();
    } catch {
      setError('无法连接服务');
      setPending(false);
    }
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>登录</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-token">管理令牌</Label>
            <Input
              id="admin-token"
              type="password"
              autoFocus
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              disabled={pending}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={pending || !token}>
            {pending && <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />}
            {pending ? '登录中' : '登录'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function AuthGate({
  prefix,
  children,
}: {
  prefix: string;
  children: React.ReactNode;
}) {
  const [view, setView] = useState<GateView>('pending');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [attempt, setAttempt] = useState(0);
  const authRequiredRef = useRef(false);

  useEffect(() => {
    document.documentElement.classList.toggle(
      'dark',
      localStorage.getItem('aihub-theme') === 'dark'
    );
  }, []);

  const applySession = useCallback((next: SessionInfo) => {
    authRequiredRef.current = next.authRequired;
    setSession(next);
    setView(next.authRequired && !next.authenticated ? 'login' : 'app');
  }, []);

  useEffect(() => {
    let active = true;
    setView('pending');
    void requestSession(prefix)
      .then((next) => {
        if (active) applySession(next);
      })
      .catch(() => {
        if (active) setView('error');
      });
    return () => {
      active = false;
    };
  }, [prefix, attempt, applySession]);

  const refreshSession = useCallback(async (): Promise<SessionCheck> => {
    try {
      const next = await requestSession(prefix);
      applySession(next);
      return next.authRequired && !next.authenticated ? 'login' : 'app';
    } catch {
      return 'unknown';
    }
  }, [prefix, applySession]);

  const handleUnauthorized = useCallback(() => {
    if (!authRequiredRef.current) return;
    setSession((current) =>
      current ? { ...current, authenticated: false } : current
    );
    setView('login');
  }, []);

  const authFetch = useCallback<AuthFetch>(
    async (input, init) => {
      const response = await fetch(input, init);
      if (response.status === 401) handleUnauthorized();
      return response;
    },
    [handleUnauthorized]
  );

  const logout = useCallback(async () => {
    const response = await fetch(`${prefix}/logout`, { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setSession((current) =>
      current ? { ...current, authenticated: false } : current
    );
    setView('login');
  }, [prefix]);

  const value = useMemo<AuthContextValue>(
    () => ({
      authRequired: session?.authRequired ?? false,
      authFetch,
      refreshSession,
      logout,
    }),
    [session?.authRequired, authFetch, refreshSession, logout]
  );

  let content: React.ReactNode = null;
  if (view === 'app') {
    content = children;
  } else if (view === 'login') {
    content = (
      <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
        <LoginForm prefix={prefix} />
      </div>
    );
  } else if (view === 'error') {
    content = (
      <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>无法连接服务</CardTitle>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={() => setAttempt((value) => value + 1)}>
              重试
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <AuthContext.Provider value={value}>{content}</AuthContext.Provider>;
}

export function AuthLogoutButton({
  iconOnly = false,
  size = 'sm',
  className,
}: {
  iconOnly?: boolean;
  size?: 'sm' | 'icon' | 'icon-xs';
  className?: string;
}) {
  const { authRequired, logout } = useAuth();
  const [pending, setPending] = useState(false);

  if (!authRequired) return null;

  const handleLogout = async () => {
    if (pending) return;
    setPending(true);
    try {
      await logout();
    } catch {
      toast.error('退出失败');
      setPending(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      className={className}
      disabled={pending}
      onClick={() => void handleLogout()}
      aria-label="退出"
    >
      {pending ? (
        <LoaderCircleIcon className="animate-spin" data-icon={iconOnly ? undefined : 'inline-start'} />
      ) : (
        <LogOutIcon data-icon={iconOnly ? undefined : 'inline-start'} />
      )}
      {!iconOnly && (pending ? '退出中' : '退出')}
    </Button>
  );
}
