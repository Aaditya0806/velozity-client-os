import type { Metadata } from 'next';
import { Wallet } from 'lucide-react';
import { requireContext, query } from '@/lib/auth/session';
import { listPayments, paymentListSchema } from '@/lib/services/payments';
import { revenueSummary } from '@/lib/services/reporting';
import { PageHeader } from '@/components/layout/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatMoney, formatDate } from '@/lib/util/format';

export const metadata: Metadata = { title: 'Finance' };
export const dynamic = 'force-dynamic';

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireContext();
  const params = await searchParams;

  const parsed = paymentListSchema.safeParse(params);
  const listQuery = parsed.success ? parsed.data : paymentListSchema.parse({});

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);

  const { payments, revenue } = await query(
    ctx,
    async (tx) => ({
      payments: await listPayments(tx, ctx, listQuery),
      revenue: await revenueSummary(tx, ctx, {}, from, to),
    }),
    { readOnly: true },
  );

  const base = ctx.org.baseCurrency;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finance"
        description="Money in, money owed, and what delivery is waiting on."
      />

      {revenue.permitted ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Received (12 months)"
            value={formatMoney(revenue.received, base, 'en-GB', { compact: true })}
            hint={`${revenue.payment_count} payments`}
          />
          <StatCard
            label="Outstanding"
            value={formatMoney(revenue.outstanding, base, 'en-GB', { compact: true })}
          />
          <StatCard
            label="Overdue"
            value={formatMoney(revenue.overdue, base, 'en-GB', { compact: true })}
            tone={Number.parseFloat(revenue.overdue) > 0 ? 'danger' : 'default'}
          />
          <StatCard
            label="Payments listed"
            value={formatMoney(payments.summary.total_base, base, 'en-GB', { compact: true })}
            hint="Converted at the rate captured on each payment"
          />
        </div>
      ) : null}

      {payments.rows.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="No payments recorded"
          description="Recording a payment against a requirement is what satisfies the payment part of the onboarding gate."
        />
      ) : (
        <div className="rounded-lg border divide-y">
          {(payments.rows as Array<Record<string, unknown>>).map((payment) => (
            <div
              key={String(payment.id)}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{String(payment.company_name)}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {String(payment.reference)} · {formatDate(payment.transaction_date as string)} ·{' '}
                  {String(payment.method).replace(/_/g, ' ')}
                  {payment.recorded_by_name ? ` · ${String(payment.recorded_by_name)}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="tabular text-sm font-medium">
                  {formatMoney(String(payment.amount), String(payment.currency))}
                </span>
                <StatusBadge status={String(payment.status)} />
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Base-currency figures use the exchange rate captured when each payment was recorded,
        not today&rsquo;s rate, so a closed period does not change value when the market moves.
      </p>
    </div>
  );
}
