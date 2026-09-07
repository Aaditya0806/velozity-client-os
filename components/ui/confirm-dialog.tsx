'use client';

import * as React from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from './dialog';
import { Button } from './button';
import { Label } from './label';
import { Textarea } from './input';

/**
 * Confirmation for anything consequential.
 *
 * `requireReason` turns this into the pattern the product uses everywhere an
 * exception is being made - losing a deal, voiding a contract, overriding the
 * legal gate. The reason is not optional decoration; it is what the audit record
 * will contain, so the dialog states the minimum length rather than silently
 * rejecting a short one on submit.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  requireReason = false,
  reasonLabel = 'Reason',
  reasonMinLength = 3,
  reasonHint,
  loading = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  requireReason?: boolean;
  reasonLabel?: string;
  reasonMinLength?: number;
  reasonHint?: string;
  loading?: boolean;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const [reason, setReason] = React.useState('');
  const [touched, setTouched] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
    }
  }, [open]);

  const tooShort = requireReason && reason.trim().length < reasonMinLength;
  const showError = touched && tooShort;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {requireReason ? (
          <div className="space-y-2">
            <Label htmlFor="confirm-reason" required>
              {reasonLabel}
            </Label>
            <Textarea
              id="confirm-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={showError}
              aria-describedby="confirm-reason-hint"
              placeholder={`At least ${reasonMinLength} characters`}
              rows={3}
            />
            <p
              id="confirm-reason-hint"
              className={showError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
            >
              {showError
                ? `Please give a reason of at least ${reasonMinLength} characters.`
                : (reasonHint ?? 'This is recorded permanently in the audit log.')}
            </p>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            loading={loading}
            disabled={tooShort}
            onClick={() => {
              setTouched(true);
              if (!tooShort) void onConfirm(reason.trim());
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
