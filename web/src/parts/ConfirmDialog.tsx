import React from 'react';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import type { Action } from '../hooks';
import { FormError } from './forms';

/**
 * Ask before an action that cannot be undone. Stays open while the action runs and when the
 * gateway refuses it, showing the refusal; the caller closes it when the action worked.
 */
export function ConfirmDialog({
  title, description, confirmLabel, action, onClose, onConfirm,
}: {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  action: Action;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !action.pending) onClose(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <FormError message={action.error} />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={action.pending} onClick={onClose}>取消</Button>
          <Button
            type="button"
            className="bg-destructive text-primary-foreground hover:bg-destructive/90"
            disabled={action.pending}
            onClick={onConfirm}
          >
            {action.pending && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
