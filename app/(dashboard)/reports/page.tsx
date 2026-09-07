import type { Metadata } from 'next';
import { requireContext, query } from '@/lib/auth/session';
import { getDashboard, dashboardQuerySchema } from '@/lib/services/reporting';
import { getForecast, getProfitability } from '@/lib/services/forecasting';
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

  // Profitability is behind `cost:read`, not `report:read`: being allowed to
  // see reports is not the same as being allowed to see what delivery costs.
  const canSeeCost = ctx.permissions.has('cost:read:org');

  const { data, forecast, profitability } = await query(
    ctx,
    async (tx) => ({
      data: await getDashboard(tx, ctx, filters),
      forecast: await getForecast(tx, ctx, { horizon: 6 }),
      profitability: canSeeCost ? await getProfitability(tx, ctx) : null,
    }),
    { readOnly: true },
  );
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
      {/* --------------------------------------------------------- forecast */}
      <Card>
        <CardHeader>
          <CardTitle>Forecast — next {forecast.periods.length} months</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            Weighted value is amount × probability. It is shown beside the unweighted open
            value and what is already committed, because on its own it invites more
            confidence than the method supports.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 font-medium">Month</th>
                  <th scope="col" className="py-2 text-right font-medium">Open</th>
                  <th scope="col" className="py-2 text-right font-medium">Weighted</th>
                  <th scope="col" className="py-2 text-right font-medium">Committed</th>
                  <th scope="col" className="py-2 text-right font-medium">Deals</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {forecast.periods.map((period) => (
                  <tr key={period.month}>
                    <td className="py-2.5">{period.month}</td>
                    <td className="tabular py-2.5 text-right">
                      {formatMoney(period.open_value, base, 'en-GB', { compact: true })}
                    </td>
                    <td className="tabular py-2.5 text-right font-medium">
                      {formatMoney(period.weighted_value, base, 'en-GB', { compact: true })}
                    </td>
                    <td className="tabular py-2.5 text-right text-[hsl(var(--success))]">
                      {formatMoney(period.committed_value, base, 'en-GB', { compact: true })}
                    </td>
                    <td className="tabular py-2.5 text-right text-muted-foreground">
                      {period.deal_count}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t font-medium">
                <tr>
                  <td className="py-2.5">Total</td>
                  <td className="tabular py-2.5 text-right">
                    {formatMoney(forecast.totals.open, base, 'en-GB', { compact: true })}
                  </td>
                  <td className="tabular py-2.5 text-right">
                    {formatMoney(forecast.totals.weighted, base, 'en-GB', { compact: true })}
                  </td>
                  <td className="tabular py-2.5 text-right">
                    {formatMoney(forecast.totals.committed, base, 'en-GB', { compact: true })}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {forecast.unconvertible.count > 0 ? (
            <p className="mt-4 rounded-lg bg-[hsl(var(--warning))]/10 p-3 text-xs text-[hsl(var(--warning))]">
              {forecast.unconvertible.count} deal
              {forecast.unconvertible.count === 1 ? ' is' : 's are'} excluded because no FX rate
              to {base} exists for {forecast.unconvertible.currencies.join(', ')}. Load rates to
              include {forecast.unconvertible.count === 1 ? 'it' : 'them'}.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------- profitability */}
      {profitability ? (
        <Card>
          <CardHeader>
            <CardTitle>Delivery profitability</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">
              Invoiced revenue less recorded delivery cost. Unbilled work in progress is not
              revenue, so this answers whether an engagement is worth running rather than
              producing an accounting result.
            </p>

            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                label="Invoiced"
                value={formatMoney(profitability.totals.invoiced, base, 'en-GB', { compact: true })}
                animate={false}
              />
              <StatCard
                label="Cost"
                value={formatMoney(profitability.totals.cost, base, 'en-GB', { compact: true })}
                animate={false}
              />
              <StatCard
                label="Margin"
                value={
                  profitability.totals.margin_percent === null
                    ? 'No data'
                    : `${profitability.totals.margin_percent}%`
                }
                hint={formatMoney(profitability.totals.margin, base, 'en-GB', { compact: true })}
                tone={
                  profitability.totals.margin_percent === null
                    ? 'default'
                    : profitability.totals.margin_percent >= 30
                      ? 'success'
                      : profitability.totals.margin_percent >= 0
                        ? 'warning'
                        : 'danger'
                }
                animate={false}
              />
            </div>

            {profitability.projects.length > 0 ? (
              <div className="mt-5 overflow-x-auto">
                <table className="w-full min-w-[48rem] text-sm">
                  <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th scope="col" className="py-2 font-medium">Project</th>
                      <th scope="col" className="py-2 text-right font-medium">Invoiced</th>
                      <th scope="col" className="py-2 text-right font-medium">Cost</th>
                      <th scope="col" className="py-2 text-right font-medium">Margin</th>
                      <th scope="col" className="py-2 text-right font-medium">Hours used</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {profitability.projects.slice(0, 20).map((project) => (
                      <tr key={project.project_id}>
                        <td className="py-2.5">
                          <span className="font-medium">{project.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {project.company_name}
                          </span>
                        </td>
                        <td className="tabular py-2.5 text-right">
                          {formatMoney(project.invoiced, base, 'en-GB', { compact: true })}
                        </td>
                        <td className="tabular py-2.5 text-right">
                          {formatMoney(project.cost_to_date, base, 'en-GB', { compact: true })}
                        </td>
                        <td className="tabular py-2.5 text-right">
                          {project.margin_percent === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span
                              className={
                                project.margin_percent < 0
                                  ? 'text-destructive'
                                  : project.margin_percent >= 30
                                    ? 'text-[hsl(var(--success))]'
                                    : ''
                              }
                            >
                              {project.margin_percent}%
                            </span>
                          )}
                        </td>
                        <td className="tabular py-2.5 text-right">
                          {project.hours_used_percent === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span
                              className={
                                project.hours_used_percent > 100
                                  ? 'text-destructive'
                                  : undefined
                              }
                            >
                              {project.hours_used_percent}%
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
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
