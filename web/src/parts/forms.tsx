import React from 'react';
import { Loader2Icon } from 'lucide-react';
import type { Price } from '@shared/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** An empty field is null; a number of at least 0 is itself; anything else is undefined. */
export function parseAmount(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** An empty field is null; a whole number of at least `minimum` is itself; else undefined. */
export function parseWhole(text: string, minimum: number): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

export function numberText(value: number | null): string {
  return value === null ? '' : String(value);
}

export function Field({
  label, htmlFor, hint, className, muted = false, children,
}: {
  label: string;
  htmlFor?: string;
  /** Shown to the right of the label, muted: a unit, or what an empty field means. */
  hint?: string;
  className?: string;
  /** A field inside a group whose legend carries the weight: its label is set lighter. */
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={htmlFor} className={cn(muted && 'text-xs font-normal text-muted-foreground')}>{label}</Label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** The reason a submission was refused, in the server's words. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive">
      {message}
    </p>
  );
}

export function SubmitButton({
  pending, disabled, children, variant,
}: {
  pending: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  variant?: 'default' | 'destructive';
}) {
  return (
    <Button type="submit" variant={variant} disabled={pending || disabled}>
      {pending && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
      {children}
    </Button>
  );
}

export interface PriceDraft {
  input: string;
  output: string;
  cacheRead: string;
}

export function priceDraft(price: Price | null): PriceDraft {
  return {
    input: numberText(price?.input ?? null),
    output: numberText(price?.output ?? null),
    cacheRead: numberText(price?.cacheRead ?? null),
  };
}

/** The price a draft spells; undefined when a field is not a number of at least 0. */
export function readPriceDraft(draft: PriceDraft): Price | undefined {
  const input = parseAmount(draft.input);
  const output = parseAmount(draft.output);
  const cacheRead = parseAmount(draft.cacheRead);
  if (input === undefined || output === undefined || cacheRead === undefined) return undefined;
  return { input, output, cacheRead };
}

export function samePrice(a: Price, b: Price): boolean {
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead;
}

const PRICE_FIELDS: { key: keyof PriceDraft; label: string; base: boolean }[] = [
  { key: 'input', label: '输入', base: true },
  { key: 'output', label: '输出', base: true },
  { key: 'cacheRead', label: '缓存读', base: false },
];

/** Three prices in USD per 1M tokens. An empty cache price is charged at the input price. */
export function PriceFields({
  idPrefix, value, onChange, disabled, required = false, legend = '价格',
}: {
  idPrefix: string;
  value: PriceDraft;
  onChange: (next: PriceDraft) => void;
  disabled?: boolean;
  /** True where input and output must both be given (a route's own price). */
  required?: boolean;
  /** What the fields are, above them; null leaves it to the caller. */
  legend?: string | null;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      {legend !== null && (
        <legend className="mb-2 flex w-full items-baseline justify-between gap-2 text-sm font-medium">
          {legend}
          <span className="text-xs font-normal text-muted-foreground">$/1M Token</span>
        </legend>
      )}
      {/* Three prices, three equal columns: the same grid as the fields around them. */}
      <div className="grid grid-cols-3 gap-4">
        {PRICE_FIELDS.map(({ key, label, base }) => (
          <Field key={key} label={label} htmlFor={`${idPrefix}-${key}`} muted>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <Input
                id={`${idPrefix}-${key}`}
                inputMode="decimal"
                autoComplete="off"
                className="pl-6 tabular-nums"
                placeholder={base ? (required ? '必填' : '未知') : '同输入'}
                value={value[key]}
                disabled={disabled}
                aria-invalid={parseAmount(value[key]) === undefined || undefined}
                onChange={(event) => onChange({ ...value, [key]: event.target.value })}
              />
            </div>
          </Field>
        ))}
      </div>
    </fieldset>
  );
}
