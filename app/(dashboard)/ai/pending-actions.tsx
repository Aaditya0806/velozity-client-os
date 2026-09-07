'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, X, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';
import { formatRelative } from '@/lib/util/format';

interface Claim {
  text: string;
  type: 'client_provided' | 'ai_inference' | 'ai_recommendation';
  confidence?: number;
  source?: { kind: string; field?: string };
}

interface AiAction {
  id: string;
  action_type: string;
  entity_type: string;
  status: string;
  proposed_payload: Record<string, unknown>;
  model: string;
  cost_usd: string;
  requested_at: string;
  requested_by_name: string | null;
  company_name: string | null;
}

/**
 * The three claim types, visually distinguished.
 *
 * This is the point of the whole provenance model: a reader must be able to tell
 * at a glance what the client actually said from what the model concluded. The
 * distinction is carried by a label and a border colour, not by colour alone.
 */
const CLAIM_STYLES = {
  client_provided: {
    label: 'Client stated',
    className: 'border-l-[hsl(var(--info))] bg-[hsl(var(--info))]/[0.05]',
    badge: 'info' as const,
  },
  ai_inference: {
    label: 'AI inference',
    className: 'border-l-[hsl(var(--warning))] bg-[hsl(var(--warning))]/[0.05]',
    badge: 'warning' as const,
  },
  ai_recommendation: {
    label: 'AI recommendation',
    className: 'border-l-primary bg-primary/[0.05]',
    badge: 'default' as const,
  },
};

export function PendingActions({
  actions,
  canApprove,
}: {
  actions: AiAction[];
  canApprove: boolean;
}) {
  const router = useRouter();
  const [rejecting, setRejecting] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<string | null>(null);

  const decide = async (id: string, decision: 'approve' | 'reject', reason?: string) => {
    setLoading(id);
    try {
      const response = await fetch(`/api/v1/ai/actions/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, reason }),
      });

      const body = (await response.json()) as { error?: { message: string } };

      if (!response.ok) {
        toast.error(body.error?.message ?? 'Could not record that decision.');
        return false;
      }

      toast.success(decision === 'approve' ? 'Approved and applied' : 'Rejected');
      router.refresh();
      return true;
    } finally {
      setLoading(null);
    }
  };

  if (actions.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="Nothing awaiting review"
        description="Anything the model drafts arrives here for a person to approve before it takes effect."
      />
    );
  }

  return (
    <>
      <ul className="space-y-4">
        {actions.map((action) => {
          const payload = action.proposed_payload;
          const claims = Array.isArray(payload.claims) ? (payload.claims as Claim[]) : [];

          return (
            <li key={action.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {action.action_type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {action.company_name ? `${action.company_name} · ` : ''}
                    {action.requested_by_name ? `${action.requested_by_name} · ` : ''}
                    {formatRelative(action.requested_at)} · {action.model}
                  </p>
                </div>
                {canApprove ? (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRejecting(action.id)}
                      disabled={loading === action.id}
                    >
                      <X className="h-3.5 w-3.5" />
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      loading={loading === action.id}
                      onClick={() => void decide(action.id, 'approve')}
                    >
                      <Check className="h-3.5 w-3.5" />
                      Approve
                    </Button>
                  </div>
                ) : (
                  <Badge variant="neutral">Awaiting an approver</Badge>
                )}
              </div>

              {typeof payload.summary === 'string' ? (
                <p className="mt-3 text-sm">{payload.summary}</p>
              ) : null}

              {claims.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {claims.map((claim, index) => {
                    const style = CLAIM_STYLES[claim.type];
                    return (
                      <li
                        key={index}
                        className={`rounded-r border-l-2 px-3 py-2 text-sm ${style.className}`}
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <Badge variant={style.badge}>{style.label}</Badge>
                          {claim.type === 'ai_inference' && claim.confidence !== undefined ? (
                            <span className="text-2xs text-muted-foreground">
                              confidence {Math.round(claim.confidence * 100)}%
                            </span>
                          ) : null}
                          {claim.type === 'client_provided' && claim.source ? (
                            <span className="text-2xs text-muted-foreground">
                              from {claim.source.kind.replace(/_/g, ' ')}
                              {claim.source.field ? ` · ${claim.source.field}` : ''}
                            </span>
                          ) : null}
                        </div>
                        <p>{claim.text}</p>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && setRejecting(null)}
        title="Reject this draft"
        description="The draft is discarded and the reason is recorded. Nothing is applied."
        confirmLabel="Reject"
        destructive
        requireReason
        reasonLabel="Why is this being rejected?"
        loading={loading === rejecting}
        onConfirm={async (reason) => {
          if (!rejecting) return;
          const ok = await decide(rejecting, 'reject', reason);
          if (ok) setRejecting(null);
        }}
      />
    </>
  );
}
