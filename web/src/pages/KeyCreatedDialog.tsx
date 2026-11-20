import type { KeyCreatedResponse } from '@shared/api';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { CopyButton } from '../parts/CopyButton';

/**
 * The one time a key's token is shown. Only the button closes it, so a stray click outside
 * does not lose the token.
 */
export function KeyCreatedDialog({ created, onClose }: { created: KeyCreatedResponse; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>密钥「{created.key.name}」已创建</DialogTitle>
          <DialogDescription>只显示这一次，关闭后无法再查看。</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg bg-muted py-1.5 pr-1.5 pl-3">
          <code className="min-w-0 flex-1 font-mono text-code break-all select-all">{created.token}</code>
          <CopyButton text={created.token} label="复制" variant="outline" />
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
