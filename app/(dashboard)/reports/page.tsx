import type { Metadata } from 'next';
import { requireContext, query } from '@/lib/auth/session';
import { getDashboard, dashboardQuerySchema } from '@/lib/services/reporting';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { PipelineFunnel } from '@/components/dashboard/pipeline-funnel';
import { Badge } from '@/components/ui/badge';
import { statusLabel } from '@/components/ui/status-badge';
import { formatMoney, formatPercent } from '@/lib/util/format';
import { ReportFilters } from './report-filters';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireContext();
  const params = await searchParams;

  const parsed = dashboardQuerySchema.safeParse(params);
  const filters = parsed.success ? parsed.data : dashboardQuerySchema.parse({});

  const data = await query(ctx, (tx) => getDashboard(tx, ctx, filters), { readOnly: true });
  const base = ctx.org.baseCurrency;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description={`Period ${data.period.from} to ${data.period.to}. Amounts in ${base}.`}
      />

      <ReportFilters from={data.period.from} to={data.period.to} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Won"
          value={formatMoney(data.pipeline.won_value, base, 'en-GB', { compact: true })}
          hint={`${data.pipeline.won_count} deals`}
          tone="success"
        />
        <StatCard
          label="Lost"
          value={formatMoney(data.pipeline.lost_value, base, 'en-GB', { compact: true })}
          hint={`${data.pipeline.lost_count} deals`}
        />
        <StatCard
          label="Win rate"
          value={
            data.pipeline.conversion_rate === null
              ? '—'
              : formatPercent(data.pipeline.conversion_rate)
          }
          hint="Of deals closed in the period"
        />
        <StatCard
          label="Average time to close"
          value={
            data.pipeline.avg_days_to_close === null
              ? '—'
              : `${data.pipeline.avg_days_to_close} days`
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Open pipeline by stage</CardTitle>
        </CardHeader>
        <CardContent>
          <PipelineFunnel stages={data.pipeline.by_stage} currency={base} />
        </CardContent>
      </Card>

      {data.revenue.permitted && data.revenue.by_month.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Revenue received by month</CardTitle>
          </CardHeader>
          <CardContent>
            <MonthlyBars rows={data.revenue.by_month} currency={base} />
          </CardContent>
        </Card>
      ) : null}

      {data.pipeline.lost_reasons.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Loss reasons</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {data.pipeline.lost_reasons.map((reason) => (
                <Badge key={reason.lost_reason} variant="outline">
                  {statusLabel(reason.lost_reason)}
                  <span className="ml-1.5 text-muted-foreground">{reason.count}</span>
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function MonthlyBars({
  rows,
  currency,
}: {
  rows: Array<{ month: string; amount: string }>;
  currency: string;
}) {
  const max = Math.max(...rows.map((r) => Number.parseFloat(r.amount)), 1);

  return (
    <dl className="space-y-2">
      {rows.map((row) => {
        const value = Number.parseFloat(row.amount);
        return (
          <div key={row.month} className="grid grid-cols-[5rem_1fr_auto] items-center gap-3">
            <dt className="text-sm text-muted-foreground">{row.month}</dt>
            <dd>
              <div className="h-5 overflow-hidden rounded bg-muted">
                <div
                  className="h-full rounded bg-primary/70"
                  style={{ width: `${Math.max(1, Math.round((value / max) * 100))}%` }}
                />
              </div>
            </dd>
            <dd className="tabular w-24 text-right text-sm">
              {formatMoney(value, currency, 'en-GB', { compact: true })}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
