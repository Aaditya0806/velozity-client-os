'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { formatDate } from '@/lib/util/format';
import { formatMoney } from '@/lib/util/money';

interface Renewal {
  id: string;
  contract_id: string;
  contract_reference: string;
  company_id: string;
  company_name: string;
  period_end: string;
  status: string;
  currency: string | null;
  value_at_risk: string | null;
  owner_name: string | null;
  loss_reason: string | null;
  days_remaining: number;
}

/** Mirrors the server's transition table. The server is authoritative. */
const NEXT: Record<string, string[]> = {
  upcoming: ['in_progress', 'won', 'lost', 'auto_renewed', 'not_renewing'],
  in_progress: ['won', 'lost', 'auto_renewed', 'not_renewing'],
};

const LABELS: Record<string, string> = {
  in_progress: 'Start working',
  won: 'Renewed',
  lost: 'Lost',
  auto_renewed: 'Auto-renewed',
  not_renewing: 'Not renewing',
};

export function RenewalTable({
  renewals,
  currency,
  canWork,
}: {
  renewals: Renewal[];
  currency: string;
  canWork: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<{ renewal: Renewal; to: string } | null>(null);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const move = async (renewal: Renewal, to: string, lossReason?: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/renewals/${renewal.id}/transitions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, ...(lossReason ? { loss_reason: lossReason } : {}) }),
      });
      const body = (await response.json()) as { error?: { message: string } };

      if (!response.ok) {
        toast.error(body.error?.message ?? 'That change was refused.');
        return;
      }

      toast.success(`${renewal.contract_reference} · ${LABELS[to] ?? to}`);
      setPending(null);
      setReason('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const start = (renewal: Renewal, to: string) => {
    // A loss needs a reason, and asking for it here means the server's refusal
    // is never what the user finds out first.
    if (to === 'lost') {
      setPending({ renewal, to });
      return;
    }
    void move(renewal, to);
  };

  return (
    <>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">Contract</th>
                <th scope="col" className="px-5 py-3 font-medium">Client</th>
                <th scope="col" className="px-5 py-3 font-medium">Ends</th>
                <th scope="col" className="px-5 py-3 text-right font-medium">At risk</th>
                <th scope="col" className="px-5 py-3 font-medium">Owner</th>
                <th scope="col" className="px-5 py-3 font-medium">Status</th>
                {canWork ? <th scope="col" className="px-5 py-3 font-medium">Decide</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y">
              {renewals.map((renewal) => {
                const options = NEXT[renewal.status] ?? [];
                const soon = renewal.days_remaining <= 30 && renewal.days_remaining >= 0;
                const passed = renewal.days_remaining < 0;

                return (
                  <tr key={renewal.id} className="hover:bg-accent/40">
                    <td className="px-5 py-3.5">
                      <Link
                        href={`/legal/contracts/${renewal.contract_id}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {renewal.contract_reference}
                      </Link>
                    </td>
                    <td className="px-5 py-3.5">
                      <Link
                        href={`/clients/${renewal.company_id}`}
                        className="hover:underline"
                      >
                        {renewal.company_name}
                      </Link>
                    </td>
                    <td className="px-5 py-3.5">
                      {formatDate(renewal.period_end)}
                      {passed ? (
                        <span className="ml-1.5 text-xs font-medium text-destructive">
                          {Math.abs(renewal.days_remaining)}d ago
                        </span>
                      ) : soon ? (
                        <span className="ml-1.5 text-xs font-medium text-[hsl(var(--warning))]">
                          in {renewal.days_remaining}d
                        </span>
                      ) : null}
                    </td>
                    <td className="tabular px-5 py-3.5 text-right">
                      {renewal.value_at_risk
                        ? formatMoney(renewal.value_at_risk, renewal.currency ?? currency)
                        : '—'}
                    </td>
                    <td className="px-5 py-3.5 text-muted-foreground">
                      {renewal.owner_name ?? 'Unassigned'}
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={renewal.status} />
                      {renewal.loss_reason ? (
                        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                          {renewal.loss_reason}
                        </p>
                      ) : null}
                    </td>
                    {canWork ? (
                      <td className="px-5 py-3.5">
                        <div className="flex flex-wrap gap-1.5">
                          {options.map((option) => (
                            <Button
                              key={option}
                              size="sm"
                              variant={option === 'lost' ? 'outline' : 'secondary'}
                              disabled={busy}
                              onClick={() => start(renewal, option)}
                            >
                              {LABELS[option] ?? option}
                            </Button>
                          ))}
                          {options.length === 0 ? (
                            <span className="text-xs text-muted-foreground">Closed</span>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={pending !== null} onOpenChange={() => setPending(null)}>
        <DialogContent className="max-w-lg">
          <DialogTitle>
            Why was {pending?.renewal.contract_reference} lost?
          </DialogTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            This is counted on the renewals dashboard. It is the one field that tells you
            anything you can act on.
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            className="mt-3 w-full resize-y rounded-lg border bg-background p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Price, a competitor, a change of sponsor, budget cut…"
            aria-label="Reason this renewal was lost"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              disabled={reason.trim().length < 3 || busy}
              onClick={() => pending && void move(pending.renewal, 'lost', reason)}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Record as lost
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
