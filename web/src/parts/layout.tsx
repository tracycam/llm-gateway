import React from 'react';
import { ChevronRightIcon, Loader2Icon, RefreshCwIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Table, TableCell, TableRow } from '@/components/ui/table';
import { href, navigate, type Route } from '../router';

/** Right-aligned figures in a table. */
export const NUM = 'text-right tabular-nums';
/**
 * The cell that names a row. It takes the width the figures leave and cuts a long name with an
 * ellipsis; the full name is in its `title` and on the record's own page.
 */
export const NAME = 'max-w-0 w-full';
/** The last cell of a row, holding its switch and menu; as narrow as they are. */
export const ACTIONS = 'w-px';

export function PageHeader({
  title, count, crumb, children,
}: {
  title: React.ReactNode;
  /** How many records the page lists; omitted while unknown. */
  count?: number;
  /** The list this page was opened from. */
  crumb?: { label: string; to: Route };
  children?: React.ReactNode;
}) {
  return (
    <header className="flex min-h-9 flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        {crumb && (
          <a
            href={href(crumb.to)}
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {crumb.label}
            <ChevronRightIcon className="size-3" />
          </a>
        )}
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="min-w-0 text-title font-semibold [overflow-wrap:anywhere]">{title}</h1>
          {count !== undefined && (
            <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
          )}
        </div>
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

/** A titled part of a page; its controls sit on the title's line. */
export function Section({
  title, count, aside, actions, children, className,
}: {
  title: React.ReactNode;
  count?: React.ReactNode;
  /** Muted text after the count, such as when a list was fetched. */
  aside?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-base font-semibold">{title}</h2>
          {count !== undefined && <span className="text-sm text-muted-foreground tabular-nums">{count}</span>}
          {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A table in its one frame. */
export function Frame({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('min-w-0 overflow-hidden rounded-lg border', className)}>
      <Table className="table-auto">{children}</Table>
    </div>
  );
}

/**
 * A table row that opens a record. The record's name inside it is the real link; a click
 * anywhere else on the row follows it too, except on the row's own controls.
 */
export function LinkRow({ to, className, children }: { to: Route; className?: string; children: React.ReactNode }) {
  return (
    <TableRow
      className={cn('cursor-pointer', className)}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('a, button, [role="switch"], [role="menuitem"], input, label')) return;
        if (window.getSelection()?.toString()) return;
        navigate(to);
      }}
    >
      {children}
    </TableRow>
  );
}

/** Stops a click on a row's controls from opening the row. */
export function RowControls({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
      {children}
    </div>
  );
}

export function RefreshButton({ loading, onClick, label = '刷新' }: { loading: boolean; onClick: () => void; label?: string }) {
  return (
    <Button variant="outline" disabled={loading} onClick={onClick}>
      <RefreshCwIcon className={cn(loading && 'animate-spin')} data-icon="inline-start" />
      {label}
    </Button>
  );
}

/** A table's single row when it has nothing to list yet, is loading, or failed to load. */
export function TableNote({
  colSpan, loading, error, empty, onRetry,
}: {
  colSpan: number;
  loading: boolean;
  error: string | null;
  /** What to show when the list loaded and is empty. */
  empty: React.ReactNode;
  onRetry: () => void;
}) {
  let content: React.ReactNode;
  if (error) {
    content = (
      <div role="alert" className="flex flex-col items-center gap-3">
        <span className="text-destructive">{error}</span>
        <Button variant="outline" size="sm" disabled={loading} onClick={onRetry}>重试</Button>
      </div>
    );
  } else if (loading) {
    content = (
      <span className="inline-flex items-center gap-2">
        <Loader2Icon className="size-4 animate-spin" />
        加载中
      </span>
    );
  } else {
    content = empty;
  }
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="h-32 text-center whitespace-normal text-muted-foreground">
        {content}
      </TableCell>
    </TableRow>
  );
}

/** A reload that failed while the last answer is still shown. */
export function StaleNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
      <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
      {error}
    </p>
  );
}

/** A page that could not load its record: the reason, and a way to try again. */
export function LoadFailure({ error, loading, onRetry }: { error: string; loading: boolean; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border px-5 py-6">
      <span className="text-sm text-destructive">{error}</span>
      <Button variant="outline" disabled={loading} onClick={onRetry}>
        {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
        重试
      </Button>
    </div>
  );
}

/** Label–value pairs set in one quiet row, as a record page states its facts. */
export function Facts({ items }: { items: { label: string; value: React.ReactNode; wide?: boolean }[] }) {
  return (
    <dl className="flex flex-wrap gap-x-10 gap-y-4">
      {items.map((item) => (
        <div key={item.label} className={cn('flex min-w-0 flex-col gap-1', item.wide && 'max-w-full')}>
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A short state word beside a name, shown only when something is wrong. */
export function Tag({ tone, className, title, children }: {
  tone: 'danger' | 'warn' | 'muted';
  className?: string;
  /** The full reason, on hover. */
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs whitespace-nowrap',
        className,
        tone === 'danger' && 'bg-destructive/10 text-destructive',
        tone === 'warn' && 'bg-warn/12 text-warn',
        tone === 'muted' && 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

/** How much of a limit is used, as a thin bar; red once the limit is reached. */
export function Meter({ used, label, className }: { used: number; label: string; className?: string }) {
  const percent = Math.min(100, Math.max(0, used * 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className={cn('h-1 overflow-hidden rounded-full bg-muted', className)}
    >
      <div
        className={cn('h-full rounded-full', used >= 1 ? 'bg-destructive' : used >= 0.8 ? 'bg-warn' : 'bg-brand')}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** What an empty list says: that it is empty, and the one action that fills it. */
export function EmptyNote({ text, action }: { text: string; action?: { label: string; onClick: () => void; disabled?: boolean } }) {
  return (
    <span className="flex flex-col items-center gap-3">
      <span>{text}</span>
      {action && (
        <Button variant="outline" disabled={action.disabled} onClick={action.onClick}>{action.label}</Button>
      )}
    </span>
  );
}
