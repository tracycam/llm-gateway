import React, { useEffect, useState } from 'react';
import {
  ActivityIcon, BoxesIcon, CableIcon, KeyRoundIcon, MoonIcon, SunIcon, TerminalIcon,
} from 'lucide-react';
import { AuthLogoutButton } from '@/components/AuthGate';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiProvider } from './apiContext';
import { ConnectDialog } from './parts/ConnectDialog';
import { KeysPage } from './pages/KeysPage';
import { ModelDetailPage } from './pages/ModelDetailPage';
import { ModelsPage } from './pages/ModelsPage';
import { ProviderDetailPage } from './pages/ProviderDetailPage';
import { ProvidersPage } from './pages/ProvidersPage';
import { UsagePage } from './pages/UsagePage';
import { href, sectionOf, useRoute, type Route, type Section } from './router';

const NAV: { section: Section; label: string; icon: React.ElementType }[] = [
  { section: 'usage', label: '用量', icon: ActivityIcon },
  { section: 'providers', label: '提供商', icon: CableIcon },
  { section: 'models', label: '模型', icon: BoxesIcon },
  { section: 'keys', label: '密钥', icon: KeyRoundIcon },
];

/** Where a scheme picked against the system is kept; absent means the system decides. */
const THEME_KEY = 'aihub-gateway-theme';
const SYSTEM_DARK = '(prefers-color-scheme: dark)';

function readStored(): 'light' | 'dark' | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch (failure) {
    // Site data may be blocked; the page then follows the system without remembering a choice.
    console.warn('theme preference unavailable', failure);
    return null;
  }
}

function writeStored(value: 'light' | 'dark' | null): void {
  try {
    if (value === null) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, value);
  } catch (failure) {
    console.warn('theme preference not saved', failure);
  }
}

function apply(dark: boolean): void {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  root.classList.toggle('dark', dark);
  // Two frames: the new colours paint without transitions, then transitions come back.
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
}

/**
 * Follows the system scheme until the toggle picks the other one; picking the system's own
 * scheme again forgets the choice, so the page follows the system once more.
 */
function useTheme(): [boolean, () => void] {
  const [stored, setStored] = useState(readStored);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(SYSTEM_DARK).matches);
  const dark = stored === null ? systemDark : stored === 'dark';

  useEffect(() => {
    const media = window.matchMedia(SYSTEM_DARK);
    const onSystem = () => setSystemDark(media.matches);
    const onStorage = (event: StorageEvent) => { if (event.key === THEME_KEY) setStored(readStored()); };
    media.addEventListener('change', onSystem);
    window.addEventListener('storage', onStorage);
    return () => {
      media.removeEventListener('change', onSystem);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    if (document.documentElement.classList.contains('dark') !== dark) apply(dark);
  }, [dark]);

  const toggle = () => {
    const target = !dark;
    const next = target === systemDark ? null : (target ? 'dark' : 'light');
    writeStored(next);
    setStored(next);
  };
  return [dark, toggle];
}

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case 'providers':
      return <ProvidersPage />;
    case 'provider':
      return <ProviderDetailPage key={route.id} id={route.id} refreshOnArrival={route.refresh === true} />;
    case 'models':
      return <ModelsPage />;
    case 'model':
      return <ModelDetailPage key={route.id} id={route.id} />;
    case 'keys':
      return <KeysPage />;
    default:
      return <UsagePage />;
  }
}

export default function GatewayApp() {
  const route = useRoute();
  const section = sectionOf(route);
  const [dark, toggleTheme] = useTheme();
  const [connectOpen, setConnectOpen] = useState(false);

  return (
    <ApiProvider>
      <TooltipProvider delay={150}>
        <div className="flex h-screen min-w-0 bg-background text-foreground">
          <aside className="flex w-52 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground select-none">
            <div className="flex h-16 items-center gap-2.5 px-5">
              <span aria-hidden className="grid size-5 grid-cols-2 gap-0.5">
                <span className="rounded-[2px] bg-foreground" />
                <span className="rounded-[2px] bg-brand" />
                <span className="rounded-[2px] bg-foreground/35" />
                <span className="rounded-[2px] bg-foreground" />
              </span>
              <span className="text-sm font-semibold">API Gateway</span>
            </div>

            <nav className="flex flex-1 flex-col gap-0.5 px-3 py-2">
              {NAV.map(({ section: target, label, icon: Icon }) => {
                const current = section === target;
                return (
                  <a
                    key={target}
                    href={href({ page: target })}
                    aria-current={current ? 'page' : undefined}
                    className={cn(
                      'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
                      current
                        ? 'bg-sidebar-accent font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                    )}
                  >
                    <Icon className={cn('size-4 shrink-0', current && 'text-brand')} />
                    {label}
                  </a>
                );
              })}
            </nav>

            <div className="flex flex-col gap-1 p-3">
              <button
                type="button"
                onClick={() => setConnectOpen(true)}
                className="flex flex-col gap-1 rounded-md px-2.5 py-2 text-left outline-none transition-colors duration-150 hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <TerminalIcon className="size-3.5" />
                  接入
                </span>
                <span className="truncate font-mono text-code" title={`${window.location.host}/v1`}>{window.location.host}/v1</span>
              </button>
              <div className="flex items-center justify-between border-t border-sidebar-border pt-2">
                <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label={dark ? '浅色' : '深色'} title={dark ? '浅色' : '深色'}>
                  {dark ? <SunIcon /> : <MoonIcon />}
                </Button>
                <AuthLogoutButton />
              </div>
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
            <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-10 px-8 pt-8 pb-16">
              <Page route={route} />
            </div>
          </main>
        </div>
        <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
      </TooltipProvider>
    </ApiProvider>
  );
}
