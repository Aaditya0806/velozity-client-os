/**
 * Executive reporting.
 *
 * Every figure here respects the caller's permissions and their row scope: a
 * salesperson's pipeline total covers their own deals, a manager's covers the
 * organisation, and neither sees margin without `margin:read`. That falls out of
 * running these queries inside the caller's tenant transaction, where RLS
 * decides which rows exist.
 *
 * Historical amounts convert using the FX rate captured on each transaction, not
 * today's rate, so a closed quarter does not change value when the market moves.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { filters } from '@/lib/db/filters';
import type { RequestContext } from '@/lib/auth/session';
import { isoDate, uuid } from '@/lib/validation/common';

export const dashboardQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  owner_user_id: uuid.optional(),
  company_id: uuid.optional(),
  service_id: uuid.optional(),
  project_id: uuid.optional(),
  currency: z.string().length(3).optional(),
});

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

function periodBounds(query: DashboardQuery): { from: string; to: string } {
  const to = query.to ?? new Date().toISOString().slice(0, 10);
  const from =
    query.from ??
    new Date(new Date(`${to}T00:00:00Z`).getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

export async function getDashboard(tx: Tx, ctx: RequestContext, query: DashboardQuery) {
  const { from, to } = periodBounds(query);

  const [pipeline, revenue, delivery, contracts, tasks, renewals] = await Promise.all([
    pipelineSummary(tx, query, from, to),
    revenueSummary(tx, ctx, query, from, to),
    deliverySummary(tx, query),
    contractSummary(tx, ctx),
    taskSummary(tx, ctx),
    renewalsDue(tx, 90),
  ]);

  return {
    period: { from, to },
    base_currency: ctx.org.baseCurrency,
    pipeline,
    revenue,
    delivery,
    contracts,
    tasks,
    renewals,
  };
}

export async function pipelineSummary(
  tx: Tx,
  query: DashboardQuery,
  from: string,
  to: string,
) {
  const f = filters('o.deleted_at is null');
  f.whereIf(query.owner_user_id, 'o.owner_user_id = ?');
  f.whereIf(query.company_id, 'o.company_id = ?');

  const byStage = await tx.many<{
    stage: string; count: string; value_base: string;
  }>(
    `select o.stage,
            count(*)::text as count,
            coalesce(sum(coalesce(o.amount_base, o.amount)), 0)::text as value_base
     from opportunities o
     where ${f.sql}
       and o.stage not in ('won','lost','closed')
     group by o.stage`,
    f.params,
  );

  const g = filters('o.deleted_at is null');
  g.whereIf(query.owner_user_id, 'o.owner_user_id = ?');
  g.whereIf(query.company_id, 'o.company_id = ?');
  const fromParam = g.bind(from);
  const toParam = g.bind(to);

  const outcomes = await tx.one<{
    won_count: string; won_value: string; lost_count: string; lost_value: string;
    avg_days_to_close: string | null;
  }>(
    `select
       count(*) filter (where o.stage = 'won')::text as won_count,
       coalesce(sum(coalesce(o.amount_base, o.amount)) filter (where o.stage = 'won'), 0)::text as won_value,
       count(*) filter (where o.stage = 'lost')::text as lost_count,
       coalesce(sum(coalesce(o.amount_base, o.amount)) filter (where o.stage = 'lost'), 0)::text as lost_value,
       round(avg(extract(epoch from (coalesce(o.won_at, o.closed_at) - o.created_at)) / 86400)
             filter (where o.stage in ('won','lost')))::text as avg_days_to_close
     from opportunities o
     where ${g.sql}
       and coalesce(o.won_at, o.closed_at)::date between ${fromParam}::date and ${toParam}::date`,
    g.params,
  );

  const won = Number.parseInt(outcomes.won_count, 10);
  const lost = Number.parseInt(outcomes.lost_count, 10);

  const lostReasons = await tx.many<{ lost_reason: string; count: string }>(
    `select lost_reason, count(*)::text as count
     from opportunities
     where deleted_at is null and stage = 'lost' and lost_reason is not null
       and closed_at::date between $1::date and $2::date
     group by lost_reason order by count(*) desc`,
    [from, to],
  );

  return {
    by_stage: byStage,
    open_total: byStage.reduce((sum, s) => sum + Number.parseFloat(s.value_base), 0).toFixed(2),
    open_count: byStage.reduce((sum, s) => sum + Number.parseInt(s.count, 10), 0),
    won_count: won,
    won_value: outcomes.won_value,
    lost_count: lost,
    lost_value: outcomes.lost_value,
    conversion_rate: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null,
    avg_days_to_close: outcomes.avg_days_to_close ? Number.parseInt(outcomes.avg_days_to_close, 10) : null,
    lost_reasons: lostReasons,
  };
}

/**
 * Revenue is recognised from payments actually received, converted at the rate
 * captured on each payment. A report of a past month therefore does not change
 * when exchange rates move.
 */
export async function revenueSummary(
  tx: Tx,
  ctx: RequestContext,
  query: DashboardQuery,
  from: string,
  to: string,
) {
  if (!ctx.permissions.has('finance:read:org')) {
    return { permitted: false as const };
  }

  const f = filters('p.deleted_at is null', `p.status in ('received','cleared')`);
  f.whereIf(query.company_id, 'p.company_id = ?');
  const fromParam = f.bind(from);
  const toParam = f.bind(to);

  const totals = await tx.one<{ received: string; payment_count: string }>(
    `select coalesce(sum(p.amount_base), 0)::text as received,
            count(*)::text as payment_count
     from payments p
     where ${f.sql} and p.transaction_date between ${fromParam}::date and ${toParam}::date`,
    f.params,
  );

  const byMonth = await tx.many<{ month: string; amount: string }>(
    `select to_char(date_trunc('month', p.transaction_date), 'YYYY-MM') as month,
            coalesce(sum(p.amount_base), 0)::text as amount
     from payments p
     where p.deleted_at is null and p.status in ('received','cleared')
       and p.transaction_date between $1::date and $2::date
     group by 1 order by 1`,
    [from, to],
  );

  const outstanding = await tx.one<{ outstanding: string; overdue: string }>(
    `select
       coalesce(sum(balance_due) filter (where status not in ('draft','cancelled','written_off')), 0)::text as outstanding,
       coalesce(sum(balance_due) filter (where due_date < current_date
         and status not in ('draft','paid','cancelled','written_off')), 0)::text as overdue
     from invoices where deleted_at is null`,
  );

  return {
    permitted: true as const,
    received: totals.received,
    payment_count: Number.parseInt(totals.payment_count, 10),
    by_month: byMonth,
    outstanding: outstanding.outstanding,
    overdue: outstanding.overdue,
  };
}

export async function deliverySummary(tx: Tx, query: DashboardQuery) {
  const f = filters('p.deleted_at is null');
  f.whereIf(query.company_id, 'p.company_id = ?');
  f.whereIf(query.project_id, 'p.id = ?');

  const projects = await tx.one<{
    active: string; on_hold: string; delivered: string; at_risk: string; off_track: string;
  }>(
    `select
       count(*) filter (where p.status = 'active')::text as active,
       count(*) filter (where p.status = 'on_hold')::text as on_hold,
       count(*) filter (where p.status = 'delivered')::text as delivered,
       count(*) filter (where p.health = 'at_risk')::text as at_risk,
       count(*) filter (where p.health = 'off_track')::text as off_track
     from projects p where ${f.sql}`,
    f.params,
  );

  const kpis = await tx.one<{
    total: string; on_track: string; at_risk: string; achieved: string; missed: string;
  }>(
    `select count(*)::text as total,
            count(*) filter (where status = 'on_track')::text as on_track,
            count(*) filter (where status = 'at_risk')::text as at_risk,
            count(*) filter (where status = 'achieved')::text as achieved,
            count(*) filter (where status in ('off_track','missed'))::text as missed
     from kpis where deleted_at is null`,
  );

  return { projects, kpis };
}

export async function contractSummary(tx: Tx, ctx: RequestContext) {
  if (!ctx.permissions.can('contract', 'read')) {
    return { permitted: false as const };
  }

  const byStatus = await tx.many<{ status: string; count: string }>(
    `select status, count(*)::text as count from contracts
     where deleted_at is null group by status`,
  );

  const awaiting = await tx.many<{
    id: string; reference: string; title: string; status: string; sent_at: string | null;
    company_name: string; days_waiting: string;
  }>(
    `select c.id, c.reference, c.title, c.status, c.sent_at, co.name as company_name,
            greatest(0, extract(day from now() - c.sent_at))::text as days_waiting
     from contracts c
     join companies co on co.id = c.company_id
     where c.deleted_at is null and c.status in ('sent','viewed','partially_signed')
     order by c.sent_at asc nulls last
     limit 20`,
  );

  const blockedOnboardings = await tx.many<{
    id: string; company_name: string; blocked_reasons: unknown; override_active: boolean;
  }>(
    `select o.id, c.name as company_name, o.blocked_reasons, o.legal_override_active as override_active
     from onboardings o
     join companies c on c.id = o.company_id
     where o.status = 'blocked' and o.deleted_at is null
     order by o.created_at`,
  );

  return { permitted: true as const, by_status: byStatus, awaiting_signature: awaiting, blocked_onboardings: blockedOnboardings };
}

export async function taskSummary(tx: Tx, ctx: RequestContext) {
  return tx.one<{
    mine_open: string; mine_overdue: string; mine_due_soon: string;
    team_open: string; org_overdue: string;
  }>(
    `select
       count(*) filter (where assignee_user_id = $1 and status not in ('done','cancelled'))::text as mine_open,
       count(*) filter (where assignee_user_id = $1 and status not in ('done','cancelled')
                          and due_date < current_date)::text as mine_overdue,
       count(*) filter (where assignee_user_id = $1 and status not in ('done','cancelled')
                          and due_date between current_date and current_date + interval '7 days')::text as mine_due_soon,
       count(*) filter (where status not in ('done','cancelled'))::text as team_open,
       count(*) filter (where status not in ('done','cancelled') and due_date < current_date)::text as org_overdue
     from tasks where deleted_at is null`,
    [ctx.user.id],
  );
}

export async function renewalsDue(tx: Tx, days: number) {
  return tx.many<{
    id: string; reference: string; title: string; company_name: string;
    expiry_date: string; auto_renews: boolean; days_remaining: string;
  }>(
    `select c.id, c.reference, c.title, co.name as company_name,
            c.expiry_date::text, c.auto_renews,
            (c.expiry_date - current_date)::text as days_remaining
     from contracts c
     join companies co on co.id = c.company_id
     where c.deleted_at is null
       and c.status = 'fully_executed'
       and c.expiry_date is not null
       and c.expiry_date between current_date and current_date + make_interval(days => $1)
     order by c.expiry_date`,
    [days],
  );
}

/**
 * Global search across the entities a user can see.
 *
 * Each branch is a separate query against a table whose RLS already restricts
 * rows, so a user cannot find something in search that they could not open.
 */
export async function globalSearch(tx: Tx, ctx: RequestContext, term: string, limit = 8) {
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  const [companies, contacts, opportunities, projects, tasks, contracts] = await Promise.all([
    ctx.permissions.can('company', 'read')
      ? tx.many(
          `select id, name as title, lifecycle_stage as subtitle from companies
           where deleted_at is null and name ilike $1 order by name limit $2`,
          [pattern, limit],
        )
      : [],
    ctx.permissions.can('contact', 'read')
      ? tx.many(
          `select ct.id, ct.full_name as title, coalesce(c.name, ct.email::text) as subtitle
           from contacts ct left join companies c on c.id = ct.company_id
           where ct.deleted_at is null and (ct.full_name ilike $1 or ct.email ilike $1)
           order by ct.full_name limit $2`,
          [pattern, limit],
        )
      : [],
    ctx.permissions.can('opportunity', 'read')
      ? tx.many(
          `select o.id, o.name as title, o.reference || ' · ' || o.stage as subtitle
           from opportunities o
           where o.deleted_at is null and (o.name ilike $1 or o.reference ilike $1)
           order by o.updated_at desc limit $2`,
          [pattern, limit],
        )
      : [],
    ctx.permissions.can('project', 'read')
      ? tx.many(
          `select id, name as title, code || ' · ' || status as subtitle from projects
           where deleted_at is null and (name ilike $1 or code ilike $1)
           order by updated_at desc limit $2`,
          [pattern, limit],
        )
      : [],
    ctx.permissions.can('task', 'read')
      ? tx.many(
          `select id, title, status as subtitle from tasks
           where deleted_at is null and title ilike $1
           order by updated_at desc limit $2`,
          [pattern, limit],
        )
      : [],
    ctx.permissions.can('contract', 'read')
      ? tx.many(
          `select id, title, reference || ' · ' || status as subtitle from contracts
           where deleted_at is null and (title ilike $1 or reference ilike $1)
           order by updated_at desc limit $2`,
          [pattern, limit],
        )
      : [],
  ]);

  return { companies, contacts, opportunities, projects, tasks, contracts };
}
