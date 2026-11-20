import { cn } from '@/lib/utils';

/** A row of mutually exclusive choices; exactly one is always selected. */
export function Segmented<T extends string>({
  label, value, options, onChange, disabled,
}: {
  /** What the choice is about, for assistive technology. */
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-8 w-fit shrink-0 items-center rounded-lg bg-muted p-0.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-full rounded-sm px-2.5 text-sm whitespace-nowrap outline-none transition-colors duration-150',
              'focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
              selected
                ? 'bg-background text-foreground shadow-xs ring-1 ring-foreground/5 dark:bg-input/60'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
