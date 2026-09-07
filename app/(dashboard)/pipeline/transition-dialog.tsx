'use client';

import * as React from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input, Textarea } from '@/components/ui/input';
import { statusLabel } from '@/components/ui/status-badge';

const LOST_REASONS = [
  { value: 'price', label: 'Price' },
  { value: 'timing', label: 'Timing' },
  { value: 'no_budget', label: 'No budget' },
  { value: 'competitor', label: 'Lost to a competitor' },
  { value: 'no_decision', label: 'No decision made' },
  { value: 'lost_contact', label: 'Lost contact' },
  { value: 'not_a_fit', label: 'Not a fit' },
  { value: 'internal_capacity', label: 'We lacked capacity' },
  { value: 'other', label: 'Other' },
];

/**
 * Collects what a transition needs before it is attempted.
 *
 * A lost deal requires a categorised reason and a written explanation, because
 * "why did we lose?" is the most useful question the pipeline can answer, and it
 * cannot be answered retrospectively if the data was never collected.
 */
export function TransitionDialog({
  open,
  onOpenChange,
  to,
  opportunityName,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  to: string;
  opportunityName: string;
  onConfirm: (reason: string, payload: Record<string, unknown>) => Promise<void>;
}) {
  const [lostReason, setLostReason] = React.useState('');
  const [competitor, setCompetitor] = React.useState('');
  const [until, setUntil] = React.useState('');
  const [detail, setDetail] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [touched, setTouched] = React.useState(false);

  const isLost = to === 'lost';
  const detailTooShort = detail.trim().length < 3;
  const reasonMissing = isLost && lostReason === '';
  const invalid = detailTooShort || reasonMissing;

  const submit = async () => {
    setTouched(true);
    if (invalid) return;
    setLoading(true);
    try {
      await onConfirm(detail.trim(), {
        ...(isLost ? { lost_reason: lostReason } : {}),
        ...(isLost && competitor ? { lost_to_competitor: competitor } : {}),
        ...(!isLost && until ? { dormant_until: until } : {}),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to {statusLabel(to)}</DialogTitle>
          <DialogDescription>{opportunityName}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isLost ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="lost-reason" required>
                  Why was it lost?
                </Label>
                <select
                  id="lost-reason"
                  value={lostReason}
                  onChange={(e) => setLostReason(e.target.value)}
                  aria-invalid={touched && reasonMissing}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select a reason…</option>
                  {LOST_REASONS.map((reason) => (
                    <option key={reason.value} value={reason.value}>
                      {reason.label}
                    </option>
                  ))}
                </select>
                {touched && reasonMissing ? (
                  <p className="text-xs text-destructive">A reason is required.</p>
                ) : null}
              </div>

              {lostReason === 'competitor' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="competitor">Which competitor?</Label>
                  <Input
                    id="competitor"
                    value={competitor}
                    onChange={(e) => setCompetitor(e.target.value)}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="dormant-until">Revisit on</Label>
              <Input
                id="dormant-until"
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The deal keeps its current stage and returns to it when reactivated.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="transition-detail" required>
              Detail
            </Label>
            <Textarea
              id="transition-detail"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={touched && detailTooShort}
              rows={3}
              placeholder="What happened, in a sentence."
            />
            <p className={touched && detailTooShort ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
              {touched && detailTooShort
                ? 'Please write at least a few words.'
                : 'Recorded on the transition ledger and the deal timeline.'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={isLost ? 'destructive' : 'default'}
            loading={loading}
            onClick={() => void submit()}
          >
            Move to {statusLabel(to)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
