import type { Metadata } from 'next';
import { RefreshCw, TrendingDown, Clock, CircleDollarSign } from 'lucide-react';
import { requireContext, query } from '@/lib/auth/session';
import { listRenewals, getRenewalSummary, renewalListSchema } from '@/lib/services/renewals';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { formatMoney } from '@/lib/util/money';
import { RenewalTable } from './renewal-table';

export const metadata: Metadata = { title: 'Renewals' };
export const dynamic = 'force-dynamic';

export default async function RenewalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireContext();
  const params = await searchParams;

  const parsed = renewalListSchema.safeParse(params);
  const filters = parsed.success ? parsed.data : renewalListSchema.parse({});

  const { rows, summary } = await query(
    ctx,
    async (tx) => {
      const list = await listRenewals(tx, filters);
      return { ...list, summary: await getRenewalSummary(tx, ctx) };
    },
    { readOnly: true },
  );

  const canWork =
    ctx.permissions.has('renewal:update:org') ||
    ctx.permissions.has('renewal:update:team') ||
    ctx.permissions.has('renewal:update:own');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Renewals"
        description="Every executed contract approaching its end date, and what was decided."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Due in 90 days"
          value={formatMoney(summary.upcoming_90d.value, summary.currency, 'en-GB', {
            compact: true,
          })}
          hint={`${summary.upcoming_90d.count} contract${summary.upcoming_90d.count === 1 ? '' : 's'}`}
          icon={Clock}
          tone={summary.upcoming_90d.count > 0 ? 'warning' : 'default'}
          animate={false}
        />
        <StatCard
          label="In progress"
          value={formatMoney(summary.in_progress.value, summary.currency, 'en-GB', {
            compact: true,
          })}
          hint={`${summary.in_progress.count} being worked`}
          icon={RefreshCw}
          animate={false}
        />
        <StatCard
          label="Retained (12m)"
          value={
            summary.retention_rate === null ? 'No data' : `${summary.retention_rate}%`
          }
          hint={`${summary.won_12m.count} renewed, ${summary.lost_12m.count} lost`}
          icon={CircleDollarSign}
          tone={
            summary.retention_rate === null
              ? 'default'
              : summary.retention_rate >= 80
                ? 'success'
                : 'warning'
          }
          animate={false}
        />
        <StatCard
          label="Lost (12m)"
          value={formatMoney(summary.lost_12m.value, summary.currency, 'en-GB', { compact: true })}
          hint={`${summary.lost_12m.count} contract${summary.lost_12m.count === 1 ? '' : 's'}`}
          icon={TrendingDown}
          tone={summary.lost_12m.count > 0 ? 'danger' : 'default'}
          animate={false}
        />
      </div>

      {summary.top_loss_reasons.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Why clients left</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {summary.top_loss_reasons.map((reason) => (
                <li key={reason.reason} className="flex items-baseline justify-between gap-4">
                  <span className="text-sm">{reason.reason}</span>
                  <span className="tabular shrink-0 text-sm font-medium text-muted-foreground">
                    {reason.count}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={RefreshCw}
          title="No renewals to show"
          description="Renewal cycles are opened automatically as executed contracts approach their notice window."
        />
      ) : (
        <RenewalTable
          renewals={JSON.parse(JSON.stringify(rows))}
          currency={summary.currency}
          canWork={canWork}
        />
      )}
    </div>
  );
}
