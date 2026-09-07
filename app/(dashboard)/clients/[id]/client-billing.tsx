'use client';

import * as React from 'react';
import { Wallet, CheckCircle2, Circle, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { formatMoney, formatDate } from '@/lib/util/format';

interface Billing {
  invoices: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  requirements: Array<Record<string, unknown>>;
}

export function ClientBilling({ clientId, currency }: { clientId: string; currency: string }) {
  const [data, setData] = React.useState<Billing | null>(null);
  const [forbidden, setForbidden] = React.useState(false);

  React.useEffect(() => {
    void fetch(`/api/v1/clients/${clientId}/billing`).then(async (response) => {
      if (response.status === 403) {
        setForbidden(true);
        return;
      }
      if (!response.ok) return;
      const body = (await response.json()) as { data: Billing };
      setData(body.data);
    });
  }, [clientId]);

  if (forbidden) {
    return (
      <EmptyState
        icon={Wallet}
        title="Not available to you"
        description="Viewing billing requires finance permission."
      />
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/*
        Payment requirements, showing settled against required.
        The satisfied flag is computed from allocations in SQL, never stored as a
        boolean, so a partial payment reads as partial rather than as done.
      */}
      <Card>
        <CardHeader>
          <CardTitle>Payment requirements</CardTitle>
        </CardHeader>
        <CardContent>
          {data.requirements.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No payment requirements are set for this client.
            </p>
          ) : (
            <ul className="divide-y">
              {data.requirements.map((requirement) => {
                const required = Number.parseFloat(String(requirement.required_amount ?? '0'));
                const settled = Number.parseFloat(String(requirement.settled_amount ?? '0'));
                const satisfied = requirement.is_satisfied === true;
                const percent = required > 0 ? Math.min(100, Math.round((settled / required) * 100)) : 0;

                return (
                  <li key={String(requirement.id)} className="py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2">
                        {satisfied ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--success))]" aria-hidden />
                        ) : requirement.blocks_onboarding ? (
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--warning))]" aria-hidden />
                        ) : (
                          <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{String(requirement.name)}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatMoney(settled, String(requirement.currency))} of{' '}
                            {formatMoney(required, String(requirement.currency))}
                            {requirement.blocks_onboarding ? ' · blocks onboarding' : ''}
                          </p>
                        </div>
                      </div>
                      <StatusBadge status={String(requirement.status)} />
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={satisfied ? 'h-full bg-[hsl(var(--success))]' : 'h-full bg-primary'}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Invoices</CardTitle>
          </CardHeader>
          <CardContent>
            {data.invoices.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No invoices raised.</p>
            ) : (
              <ul className="divide-y">
                {data.invoices.map((invoice) => (
                  <li key={String(invoice.id)} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{String(invoice.reference)}</p>
                      <p className="text-xs text-muted-foreground">
                        {invoice.issue_date ? formatDate(invoice.issue_date as string) : 'Not issued'}
                        {invoice.due_date ? ` · due ${formatDate(invoice.due_date as string)}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="tabular text-sm">
                        {formatMoney(String(invoice.total), String(invoice.currency))}
                      </span>
                      <StatusBadge status={String(invoice.status)} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payments received</CardTitle>
          </CardHeader>
          <CardContent>
            {data.payments.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No payments recorded.</p>
            ) : (
              <ul className="divide-y">
                {data.payments.map((payment) => (
                  <li key={String(payment.id)} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{String(payment.reference)}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(payment.transaction_date as string)} ·{' '}
                        {String(payment.method).replace(/_/g, ' ')}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="tabular text-sm">
                        {formatMoney(String(payment.amount), String(payment.currency))}
                      </span>
                      <Badge variant={payment.status === 'cleared' ? 'success' : 'info'}>
                        {String(payment.status)}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Amounts are shown in the currency of each transaction. Totals elsewhere convert
        using the rate captured when the payment was recorded, not today&rsquo;s rate.
        Base currency: {currency}.
      </p>
    </div>
  );
}
