'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { FileCheck, Send, Ban, RefreshCw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';

interface MissingVariable {
  key: string;
  label: string;
  source_hint: string | null;
}

/**
 * The actions available on a contract, and the authority each one needs.
 *
 * These are deliberately separate buttons with separate permissions rather than
 * a single "advance" control: approving a contract for sending and actually
 * sending it are different decisions, held by different people in most
 * organisations, and the interface should say so.
 *
 * Nothing here can mark a contract executed. That happens only when a verified
 * webhook arrives and the executed document has been downloaded, hashed and
 * stored — there is no button for it because there is no code path for it.
 */
export function ContractActions({
  contractId,
  status,
  ready,
  reference,
  canApprove,
  canSend,
  canVoid,
  canEdit,
  signerCount,
}: {
  contractId: string;
  status: string;
  ready: boolean;
  reference: string;
  canApprove: boolean;
  canSend: boolean;
  canVoid: boolean;
  canEdit: boolean;
  signerCount: number;
}) {
  const router = useRouter();
  const [loading, setLoading] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState<'send' | 'void' | null>(null);

  const call = async (
    action: string,
    url: string,
    body: Record<string, unknown>,
    successMessage: string,
  ) => {
    setLoading(action);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Sending a contract reaches an external provider, so a retried
          // submission must not create a second signature request.
          ...(action === 'send' ? { 'idempotency-key': `send-${contractId}-${Date.now()}` } : {}),
        },
        body: JSON.stringify(body),
      });

      const payload = (await response.json()) as {
        error?: { message: string; details?: { missing?: MissingVariable[] } };
        request_id: string;
      };

      if (!response.ok) {
        toast.error(payload.error?.message ?? 'That action was refused.', {
          description: payload.error?.details?.missing
            ? `Missing: ${payload.error.details.missing.map((m) => m.label).join(', ')}`
            : `Reference ${payload.request_id}`,
          duration: 8000,
        });
        return false;
      }

      toast.success(successMessage);
      router.refresh();
      return true;
    } catch {
      toast.error('Could not reach the server.');
      return false;
    } finally {
      setLoading(null);
    }
  };

  const render = () =>
    call('render', `/api/v1/contracts/${contractId}/render`, { variable_values: {} }, 'Document produced');

  const submitForReview = () =>
    call(
      'review',
      `/api/v1/contracts/${contractId}/transitions`,
      { to: 'internal_review', payload: {} },
      'Sent for legal review',
    );

  const approve = () =>
    call(
      'approve',
      `/api/v1/contracts/${contractId}/transitions`,
      { to: 'approved_to_send', payload: {} },
      'Approved for sending',
    );

  const terminal = status === 'fully_executed' || status === 'voided';

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (status === 'draft' || status === 'internal_review') ? (
          <Button
            variant="outline"
            loading={loading === 'render'}
            onClick={() => void render()}
          >
            <RefreshCw className="h-4 w-4" />
            {ready ? 'Re-render' : 'Produce document'}
          </Button>
        ) : null}

        {canEdit && status === 'draft' ? (
          <Button
            variant="outline"
            loading={loading === 'review'}
            disabled={!ready}
            title={!ready ? 'Produce the document first' : undefined}
            onClick={() => void submitForReview()}
          >
            Send for legal review
          </Button>
        ) : null}

        {status === 'internal_review' ? (
          canApprove ? (
            <Button loading={loading === 'approve'} onClick={() => void approve()}>
              <FileCheck className="h-4 w-4" />
              Approve for sending
            </Button>
          ) : (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              Awaiting legal approval
            </p>
          )
        ) : null}

        {status === 'approved_to_send' ? (
          canSend ? (
            <Button
              loading={loading === 'send'}
              disabled={signerCount < 2}
              title={signerCount < 2 ? 'Add a signer from each side first' : undefined}
              onClick={() => setConfirming('send')}
            >
              <Send className="h-4 w-4" />
              Send for signature
            </Button>
          ) : (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              Approved — awaiting someone with send authority
            </p>
          )
        ) : null}

        {canVoid && !terminal && status !== 'draft' ? (
          <Button variant="outline" onClick={() => setConfirming('void')}>
            <Ban className="h-4 w-4" />
            Void
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming === 'send'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Send ${reference} for signature`}
        description="This delivers the contract to every signer through the signature provider. It cannot be unsent — a contract in flight can only be voided."
        confirmLabel="Send for signature"
        loading={loading === 'send'}
        onConfirm={async () => {
          const ok = await call(
            'send',
            '/api/v1/signature-requests',
            { contract_id: contractId },
            'Sent for signature',
          );
          if (ok) setConfirming(null);
        }}
      />

      <ConfirmDialog
        open={confirming === 'void'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Void ${reference}`}
        description="The signature request is cancelled with the provider and the contract becomes final in a voided state. A replacement must be drafted separately."
        confirmLabel="Void contract"
        destructive
        requireReason
        reasonLabel="Why is this being voided?"
        loading={loading === 'void'}
        onConfirm={async (reason) => {
          const ok = await call(
            'void',
            `/api/v1/contracts/${contractId}/transitions`,
            { to: 'voided', reason, payload: {} },
            'Contract voided',
          );
          if (ok) setConfirming(null);
        }}
      />
    </>
  );
}
