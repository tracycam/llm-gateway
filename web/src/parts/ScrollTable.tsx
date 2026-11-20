import React from 'react';
import { cn } from '@/lib/utils';

/**
 * A framed table that scrolls inside its own box with the column headings kept in view, for
 * the one list that runs to hundreds of rows (a provider's discovered models). Takes the same
 * `Table*` parts as `Table`.
 */
export function ScrollTable({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('relative w-full min-w-0 overflow-y-auto overscroll-contain rounded-lg border', className)}>
      <table
        className={cn(
          'w-full caption-bottom text-sm',
          '[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-[color-mix(in_oklch,var(--muted)_40%,var(--background))] [&_th]:shadow-[inset_0_-1px_0_var(--border)]',
          '[&_thead_tr]:border-0',
        )}
      >
        {children}
      </table>
    </div>
  );
}
