'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { statusLabel } from '@/components/ui/status-badge';
import { toast } from '@/components/ui/toast';
import { TransitionDialog } from '../transition-dialog';

/**
 * The stage moves currently available.
 *
 * The list comes from the server's own state machine rather than being
 * hardcoded here, so the UI cannot offer a move the server would reject as
 * undefined. It can still offer one a *guard* refuses — which is correct: the
 * user should be told what is missing, not have the option quietly hidden.
 */
export function StageActions({
  opportunityId,
  currentStage,
  available,
  opportunityName,
}: {
  opportunityId: string;
  currentStage: string;
  available: string[];
  opportunityName: string;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const transition = async (to: string, reason?: string, payload?: Record<string, unknown>) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/opportunities/${opportunityId}/transitions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, reason: reason ?? null, payload: payload ?? {} }),
      });

      const body = (await response.json()) as {
        error?: { message: string; details?: { missing?: string[]; allowed?: string[] } };
        request_id: string;
      };

      if (!response.ok) {
        const missing = body.error?.details?.missing;
        toast.error(body.error?.message ?? 'That move was refused.', {
          description: missing ? `Missing: ${missing.join(', ')}` : `Reference ${body.request_id}`,
          duration: 8000,
        });
        return false;
      }

      toast.success(`Moved to ${statusLabel(to)}`);
      router.refresh();
      return true;
    } finally {
      setLoading(false);
    }
  };

  const needsDialog = (stage: string) => stage === 'lost' || stage === 'dormant';

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button loading={loading}>
            Move stage
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 w-52 rounded-lg border bg-popover p-1 shadow-lg"
          >
            <DropdownMenu.Label className="px-3 py-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              From {statusLabel(currentStage)}
            </DropdownMenu.Label>
            {available.map((stage) => (
              <DropdownMenu.Item
                key={stage}
                onSelect={(event) => {
                  event.preventDefault();
                  if (needsDialog(stage)) setPending(stage);
                  else void transition(stage);
                }}
                className="cursor-pointer rounded px-3 py-2 text-sm outline-none data-[highlighted]:bg-accent"
              >
                {statusLabel(stage)}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {pending ? (
        <TransitionDialog
          open
          onOpenChange={(open) => !open && setPending(null)}
          to={pending}
          opportunityName={opportunityName}
          onConfirm={async (reason, payload) => {
            const ok = await transition(pending, reason, payload);
            if (ok) setPending(null);
          }}
        />
      ) : null}
    </>
  );
}
