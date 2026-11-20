import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** Copies `text`; the icon confirms for a moment. `label` adds a word next to the icon. */
export function CopyButton({
  text, label, variant = 'ghost',
}: {
  text: string;
  label?: string;
  variant?: 'ghost' | 'outline' | 'default';
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (await copyToClipboard(text)) setCopied(true);
    else toast.error('复制失败');
  };

  const Icon = copied ? CheckIcon : CopyIcon;
  return (
    <Button
      type="button"
      variant={variant}
      size={label ? 'sm' : 'icon-sm'}
      aria-label={label ? undefined : '复制'}
      onClick={() => void copy()}
    >
      <Icon data-icon={label ? 'inline-start' : undefined} />
      {label && (copied ? '已复制' : label)}
    </Button>
  );
}
