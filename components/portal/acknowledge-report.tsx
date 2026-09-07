'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

/** Records that the client has read this report. Idempotent on the server. */
export function AcknowledgeReport({
  reportId,
  acknowledgedAt,
}: {
  reportId: string;
  acknowledgedAt: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  if (acknowledgedAt) {
    return (
      <span className="flex items-center gap-1.5 text-sm text-[hsl(var(--success))]">
        <Check className="h-4 w-4" aria-hidden />
        You marked this as read
      </span>
    );
  }

  const acknowledge = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/portal/reports/${reportId}/acknowledge`, {
        method: 'POST',
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: { message: string } };
        toast.error(body.error?.message ?? 'That could not be recorded.');
        return;
      }
      toast.success('Marked as read');
      router.refresh();
    } catch {
      toast.error('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button size="sm" variant="outline" onClick={() => void acknowledge()} disabled={busy}>
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <Check className="h-3.5 w-3.5" aria-hidden />
      )}
      Mark as read
    </Button>
  );
}
