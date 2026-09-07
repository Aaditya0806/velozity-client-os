/**
 * Forecasting and delivery profitability.
 *
 * Two questions the data model has always been able to answer and nothing has
 * been asking: what is likely to close, and whether the work already sold is
 * making money.
 *
 * Both are reported in the organisation's base currency through
 * `app.fx_rate_at`, which returns NULL rather than assuming parity. Amounts that
 * cannot be converted are counted separately and reported as such — a total
 * that quietly drops a currency is worse than one that says what it left out.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import type { RequestContext } from '@/lib/auth/session';

export const forecastQuerySchema = z.object({
  /** Months ahead to project. */
  horizon: z.coerce.number().int().min(1).max(24).default(6),
});
export type ForecastQuery = z.infer<typeof forecastQuerySchema>;

export interface ForecastPeriod {
  month: string;
  open_value: string;
  weighted_value: string;
  committed_value: string;
  deal_count: number;
}

export interface Forecast {
  currency: string;
  periods: ForecastPeriod[];
  totals: { open: string; weighted: string; committed: string };
  /** Deals excluded because no FX rate was available. */
  unconvertible: { count: number; currencies: string[] };
}

/**
 * Weighted pipeline by expected close month.
 *
 * "Weighted" is amount × probability, which is the standard construction and a
 * genuinely weak predictor — it is reported next to the unweighted open value
 * and the already-committed value rather than on its own, because a single
 * number here invites more confidence than the method supports.
 */
export async function getForecast(
  tx: Tx,
  ctx: RequestContext,
  query: ForecastQuery,
): Promise<Forecast> {
  const base = ctx.org.baseCurrency;

  const rows = await tx.many<{
    month: string;
    open_value: string;
    weighted_value: string;
    committed_value: string;
    deal_count: string;
  }>(
    `with months as (
       select generate_series(
                date_trunc('month', current_date),
                date_trunc('month', current_date) + make_interval(months => $3::int - 1),
                interval '1 month'
              )::date as month
     ),
     deals as (
       select date_trunc('month', o.expected_close_date)::date as month,
              o.stage,
              o.probability,
              o.amount * app.fx_rate_at($1, o.currency, $2, o.expected_close_date) as value_base
         from opportunities o
        where o.deleted_at is null
          and o.expected_close_date is not null
          and o.stage not in ('lost', 'closed', 'dormant')
          and app.fx_rate_at($1, o.currency, $2, o.expected_close_date) is not null
     )
     select to_char(m.month, 'YYYY-MM') as month,
            coalesce(sum(d.value_base) filter (where d.stage <> 'won'), 0)::text as open_value,
            coalesce(sum(d.value_base * d.probability / 100.0)
                     filter (where d.stage <> 'won'), 0)::text as weighted_value,
            coalesce(sum(d.value_base) filter (where d.stage = 'won'), 0)::text as committed_value,
            count(d.*)::text as deal_count
       from months m
       left join deals d on d.month = m.month
      group by m.month
      order by m.month`,
    [ctx.org.id, base, query.horizon],
  );

  const unconvertible = await tx.one<{ count: string; currencies: string[] }>(
    `select count(*)::text as count,
            coalesce(array_agg(distinct o.currency), '{}') as currencies
       from opportunities o
      where o.deleted_at is null
        and o.expected_close_date is not null
        and o.stage not in ('lost', 'closed', 'dormant')
        and app.fx_rate_at($1, o.currency, $2, o.expected_close_date) is null`,
    [ctx.org.id, base],
  );

  const sum = (key: keyof ForecastPeriod) =>
    rows.reduce((total, row) => total + Number(row[key as keyof typeof row]), 0).toFixed(2);

  return {
    currency: base,
    periods: rows.map((row) => ({
      month: row.month,
      open_value: row.open_value,
      weighted_value: row.weighted_value,
      committed_value: row.committed_value,
      deal_count: Number(row.deal_count),
    })),
    totals: {
      open: sum('open_value'),
      weighted: sum('weighted_value'),
      committed: sum('committed_value'),
    },
    unconvertible: {
      count: Number(unconvertible.count),
      currencies: unconvertible.currencies,
    },
  };
}

export interface ProjectProfitability {
  project_id: string;
  code: string;
  name: string;
  company_name: string;
  status: string;
  currency: string;
  budget: string | null;
  invoiced: string;
  collected: string;
  cost_to_date: string;
  margin: string;
  margin_percent: number | null;
  estimated_hours: string;
  actual_hours: string;
  /** Actual hours as a share of estimate; over 100 means overrun. */
  hours_used_percent: number | null;
}

export interface ProfitabilityReport {
  currency: string;
  projects: ProjectProfitability[];
  totals: { invoiced: string; cost: string; margin: string; margin_percent: number | null };
}

/**
 * Delivery profitability, per project.
 *
 * Margin here is invoiced revenue minus recorded cost, not an accounting
 * result: `cost_to_date` is what delivery has booked, and unbilled work in
 * progress is not revenue. It answers "is this engagement worth running",
 * which is the question delivery leads actually ask.
 *
 * Every figure is behind `cost:read` and `margin:read`. The caller checks that;
 * this function assumes it has been checked, and the portal projections cannot
 * reach it at all.
 */
export async function getProfitability(
  tx: Tx,
  ctx: RequestContext,
): Promise<ProfitabilityReport> {
  const base = ctx.org.baseCurrency;

  const projects = await tx.many<{
    project_id: string;
    code: string;
    name: string;
    company_name: string;
    status: string;
    budget: string | null;
    invoiced: string;
    collected: string;
    cost_to_date: string;
    estimated_hours: string;
    actual_hours: string;
  }>(
    `select p.id as project_id, p.code, p.name, c.name as company_name, p.status,
            (p.budget_amount * app.fx_rate_at($1, p.currency, $2, current_date))::text as budget,
            coalesce((
              select sum(i.total * app.fx_rate_at($1, i.currency, $2, coalesce(i.issue_date, current_date)))
                from invoices i
               where i.project_id = p.id
                 and i.deleted_at is null
                 and i.status <> 'draft'
                 and app.fx_rate_at($1, i.currency, $2, coalesce(i.issue_date, current_date)) is not null
            ), 0)::text as invoiced,
            coalesce((
              select sum(i.amount_paid * app.fx_rate_at($1, i.currency, $2, coalesce(i.issue_date, current_date)))
                from invoices i
               where i.project_id = p.id
                 and i.deleted_at is null
                 and app.fx_rate_at($1, i.currency, $2, coalesce(i.issue_date, current_date)) is not null
            ), 0)::text as collected,
            coalesce(p.cost_to_date * app.fx_rate_at($1, p.currency, $2, current_date), 0)::text
              as cost_to_date,
            coalesce((
              select sum(t.estimated_hours) from tasks t
               where t.project_id = p.id and t.deleted_at is null
            ), 0)::text as estimated_hours,
            coalesce((
              select sum(t.actual_hours) from tasks t
               where t.project_id = p.id and t.deleted_at is null
            ), 0)::text as actual_hours
       from projects p
       join companies c on c.id = p.company_id
      where p.deleted_at is null
      order by p.start_date desc nulls last`,
    [ctx.org.id, base],
  );

  let totalInvoiced = 0;
  let totalCost = 0;

  const rows: ProjectProfitability[] = projects.map((row) => {
    const invoiced = Number(row.invoiced);
    const cost = Number(row.cost_to_date);
    const margin = invoiced - cost;
    const estimated = Number(row.estimated_hours);
    const actual = Number(row.actual_hours);

    totalInvoiced += invoiced;
    totalCost += cost;

    return {
      project_id: row.project_id,
      code: row.code,
      name: row.name,
      company_name: row.company_name,
      status: row.status,
      currency: base,
      budget: row.budget,
      invoiced: invoiced.toFixed(2),
      collected: Number(row.collected).toFixed(2),
      cost_to_date: cost.toFixed(2),
      margin: margin.toFixed(2),
      // Margin on nothing invoiced is not 0% or -100%; it is not yet a number.
      margin_percent: invoiced > 0 ? Math.round((margin / invoiced) * 1000) / 10 : null,
      estimated_hours: estimated.toFixed(2),
      actual_hours: actual.toFixed(2),
      hours_used_percent: estimated > 0 ? Math.round((actual / estimated) * 1000) / 10 : null,
    };
  });

  const totalMargin = totalInvoiced - totalCost;

  return {
    currency: base,
    projects: rows,
    totals: {
      invoiced: totalInvoiced.toFixed(2),
      cost: totalCost.toFixed(2),
      margin: totalMargin.toFixed(2),
      margin_percent:
        totalInvoiced > 0 ? Math.round((totalMargin / totalInvoiced) * 1000) / 10 : null,
    },
  };
}
