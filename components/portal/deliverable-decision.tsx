'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

/**
 * Accept or reject a deliverable.
 *
 * Rejection asks for a reason before it will send, because the team on the other
 * end can do nothing with "rejected" on its own — and because the database
 * refuses it anyway, so asking here turns a constraint violation into a
 * sentence.
 */
export function DeliverableDecision({
  deliverableId,
  name,
}: {
  deliverableId: string;
  name: string;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<'accepted' | 'rejected' | null>(null);
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState('');

  const decide = async (decision: 'accepted' | 'rejected', why?: string) => {
    setPending(decision);
    try {
      const response = await fetch(`/api/v1/portal/deliverables/${deliverableId}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, ...(why ? { reason: why } : {}) }),
      });

      const body = (await response.json()) as { error?: { message: string } };
      if (!response.ok) {
        toast.error(body.error?.message ?? 'That could not be recorded.');
        return;
      }

      toast.success(
        decision === 'accepted' ? `Accepted “${name}”` : `Sent your feedback on “${name}”`,
      );
      setRejecting(false);
      setReason('');
      router.refresh();
    } catch {
      toast.error('Could not reach the server. Please try again.');
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          onClick={() => void decide('accepted')}
          disabled={pending !== null}
        >
          {pending === 'accepted' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Check className="h-3.5 w-3.5" aria-hidden />
          )}
          Accept
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRejecting(true)}
          disabled={pending !== null}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Request changes
        </Button>
      </div>

      <Dialog open={rejecting} onOpenChange={setRejecting}>
        <DialogContent className="max-w-lg">
          <DialogTitle>Request changes to “{name}”</DialogTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Tell the team what needs to change. They will see this on the deliverable.
          </p>

          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={5}
            className="mt-3 w-full resize-y rounded-lg border bg-background p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="What needs to change, and why?"
            aria-label="What needs to change"
          />

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void decide('rejected', reason)}
              disabled={reason.trim().length === 0 || pending !== null}
            >
              {pending === 'rejected' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : null}
              Send feedback
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
