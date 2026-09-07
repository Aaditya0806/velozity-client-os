/**
 * Renewals.
 *
 * A renewal is a decision with an owner and an outcome, not a reminder. Each
 * executed contract with an expiry date opens exactly one row per cycle; that
 * row is worked to `won`, `lost`, `auto_renewed` or `not_renewing`, and the
 * reason a client left is recorded where it can be counted.
 *
 * The transition function is the only way `status` moves — the column is guarded
 * by `renewals_00_state_channel`, so a stray UPDATE is refused by the database
 * rather than by convention.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import type { RequestContext } from '@/lib/auth/session';
import { AppError } from '@/lib/http/errors';
import { emitEvent } from '@/lib/events';
import { writeAudit } from '@/lib/audit';

export const RENEWAL_STATUSES = [
  'upcoming',
  'in_progress',
  'won',
  'lost',
  'auto_renewed',
  'not_renewing',
] as const;
export type RenewalStatus = (typeof RENEWAL_STATUSES)[number];

/**
 * Which moves are legal.
 *
 * `upcoming` and `in_progress` may both go straight to an outcome: a client who
 * confirms early should not have to be dragged through a stage first. Terminal
 * states have no exits — a renewal that was lost and then won is next year's
 * cycle, which is its own row.
 */
const TRANSITIONS: Record<RenewalStatus, readonly RenewalStatus[]> = {
  upcoming: ['in_progress', 'won', 'lost', 'auto_renewed', 'not_renewing'],
  in_progress: ['won', 'lost', 'auto_renewed', 'not_renewing'],
  won: [],
  lost: [],
  auto_renewed: [],
  not_renewing: [],
};

const TERMINAL: readonly RenewalStatus[] = ['won', 'lost', 'auto_renewed', 'not_renewing'];

export const renewalListSchema = z.object({
  status: z.enum(RENEWAL_STATUSES).optional(),
  within_days: z.coerce.number().int().min(1).max(730).optional(),
  company_id: z.string().uuid().optional(),
  owner_user_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});
export type RenewalListQuery = z.infer<typeof renewalListSchema>;

export const renewalTransitionSchema = z.object({
  to: z.enum(RENEWAL_STATUSES),
  loss_reason: z.string().trim().min(3).max(500).optional(),
  outcome_note: z.string().trim().max(2000).optional(),
  opportunity_id: z.string().uuid().optional(),
});
export type RenewalTransition = z.infer<typeof renewalTransitionSchema>;

export interface RenewalRow {
  id: string;
  contract_id: string;
  contract_reference: string;
  company_id: string;
  company_name: string;
  period_end: string;
  notice_date: string | null;
  status: RenewalStatus;
  currency: string | null;
  value_at_risk: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  opportunity_id: string | null;
  loss_reason: string | null;
  days_remaining: number;
}

export async function listRenewals(
  tx: Tx,
  query: RenewalListQuery,
): Promise<{ rows: RenewalRow[]; total: number }> {
  const where: string[] = ['r.deleted_at is null'];
  const params: unknown[] = [];

  if (query.status) {
    params.push(query.status);
    where.push(`r.status = $${params.length}`);
  }
  if (query.company_id) {
    params.push(query.company_id);
    where.push(`r.company_id = $${params.length}`);
  }
  if (query.owner_user_id) {
    params.push(query.owner_user_id);
    where.push(`r.owner_user_id = $${params.length}`);
  }
  if (query.within_days !== undefined) {
    params.push(query.within_days);
    where.push(
      `r.period_end <= current_date + make_interval(days => $${params.length}::int)`,
    );
  }

  params.push(query.page_size, (query.page - 1) * query.page_size);

  // One query, not two: `count(*) over ()` gives the total alongside the page,
  // which matters when a round trip costs more than the query does.
  const rows = await tx.many<RenewalRow & { total: string }>(
    `select r.id, r.contract_id, ct.reference as contract_reference,
            r.company_id, c.name as company_name,
            r.period_end, r.notice_date, r.status, r.currency, r.value_at_risk,
            r.owner_user_id, u.full_name as owner_name, r.opportunity_id, r.loss_reason,
            (r.period_end - current_date) as days_remaining,
            count(*) over () as total
       from renewals r
       join contracts ct on ct.id = r.contract_id
       join companies c  on c.id = r.company_id
       left join user_profiles u on u.id = r.owner_user_id
      where ${where.join(' and ')}
      order by r.period_end
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );

  return {
    rows: rows.map(({ total: _total, ...row }) => row),
    total: rows.length > 0 ? Number(rows[0]!.total) : 0,
  };
}

/**
 * Moves a renewal to its next state.
 *
 * Everything that makes this safe is enforced twice: the legal-move table here,
 * and the state-channel trigger in the database that refuses the write unless it
 * arrives through `enterTransition()`.
 */
export async function transitionRenewal(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  input: RenewalTransition,
): Promise<{ id: string; from: RenewalStatus; to: RenewalStatus }> {
  const current = await tx.maybeOne<{
    status: RenewalStatus;
    company_id: string;
    contract_id: string;
    value_at_risk: string | null;
    currency: string | null;
  }>(
    `select status, company_id, contract_id, value_at_risk, currency
       from renewals where id = $1 and deleted_at is null`,
    [id],
  );

  if (!current) throw new AppError('NOT_FOUND', 'That renewal was not found.');

  const allowed = TRANSITIONS[current.status];
  if (!allowed.includes(input.to)) {
    throw new AppError(
      'INVALID_TRANSITION',
      `A renewal cannot move from ${current.status} to ${input.to}.`,
      { details: { from: current.status, to: input.to, allowed } },
    );
  }

  if (input.to === 'lost' && !input.loss_reason) {
    // Counting churn without reasons tells you that it happened and nothing
    // about why, which is the only part anyone can act on.
    throw new AppError('VALIDATION_ERROR', 'A lost renewal must record why it was lost.');
  }

  await tx.enterTransition();

  await tx.query(
    `update renewals
        set status       = $2,
            loss_reason  = $3,
            outcome_note = coalesce($4, outcome_note),
            opportunity_id = coalesce($5, opportunity_id),
            decided_at   = case when $2 = any($6::text[]) then now() else decided_at end,
            decided_by   = case when $2 = any($6::text[]) then $7 else decided_by end
      where id = $1`,
    [
      id,
      input.to,
      input.to === 'lost' ? input.loss_reason : null,
      input.outcome_note ?? null,
      input.opportunity_id ?? null,
      TERMINAL,
      ctx.user.id,
    ],
  );

  await emitEvent(tx, {
    name: `renewal.${input.to}`,
    entityType: 'renewal',
    entityId: id,
    actorUserId: ctx.user.id,
    payload: {
      from: current.status,
      to: input.to,
      company_id: current.company_id,
      contract_id: current.contract_id,
      value_at_risk: current.value_at_risk,
      currency: current.currency,
      ...(input.loss_reason ? { loss_reason: input.loss_reason } : {}),
    },
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'renewal.transitioned',
    category: 'state_change',
    actorUserId: ctx.user.id,
    entityType: 'renewal',
    entityId: id,
    summary: `Renewal moved from ${current.status} to ${input.to}`,
    metadata: { from: current.status, to: input.to },
    requestId: ctx.requestId,
  });

  return { id, from: current.status, to: input.to };
}

export interface RenewalSummary {
  currency: string;
  upcoming_90d: { count: number; value: string };
  in_progress: { count: number; value: string };
  won_12m: { count: number; value: string };
  lost_12m: { count: number; value: string };
  /** Retained value as a share of value that reached a decision. */
  retention_rate: number | null;
  top_loss_reasons: Array<{ reason: string; count: number }>;
}

/**
 * The renewal picture, in the organisation's base currency.
 *
 * Values are converted through `app.fx_rate_at`, which returns NULL rather than
 * assuming parity when a rate is missing — so an unconverted contract is
 * excluded from a total instead of silently distorting it.
 */
export async function getRenewalSummary(
  tx: Tx,
  ctx: RequestContext,
): Promise<RenewalSummary> {
  const base = ctx.org.baseCurrency;

  const totals = await tx.one<{
    upcoming_count: string;
    upcoming_value: string;
    in_progress_count: string;
    in_progress_value: string;
    won_count: string;
    won_value: string;
    lost_count: string;
    lost_value: string;
  }>(
    `with converted as (
       select r.status,
              r.period_end,
              r.decided_at,
              r.value_at_risk * coalesce(app.fx_rate_at($1, r.currency, $2, r.period_end), 0)
                as value_base,
              app.fx_rate_at($1, r.currency, $2, r.period_end) is not null as convertible
         from renewals r
        where r.deleted_at is null
     )
     select
       count(*) filter (
         where status = 'upcoming'
           and period_end between current_date and current_date + 90
       )::text as upcoming_count,
       coalesce(sum(value_base) filter (
         where status = 'upcoming' and convertible
           and period_end between current_date and current_date + 90
       ), 0)::text as upcoming_value,

       count(*) filter (where status = 'in_progress')::text as in_progress_count,
       coalesce(sum(value_base) filter (
         where status = 'in_progress' and convertible
       ), 0)::text as in_progress_value,

       count(*) filter (
         where status in ('won', 'auto_renewed')
           and decided_at >= now() - interval '12 months'
       )::text as won_count,
       coalesce(sum(value_base) filter (
         where status in ('won', 'auto_renewed') and convertible
           and decided_at >= now() - interval '12 months'
       ), 0)::text as won_value,

       count(*) filter (
         where status in ('lost', 'not_renewing')
           and decided_at >= now() - interval '12 months'
       )::text as lost_count,
       coalesce(sum(value_base) filter (
         where status in ('lost', 'not_renewing') and convertible
           and decided_at >= now() - interval '12 months'
       ), 0)::text as lost_value
     from converted`,
    [ctx.org.id, base],
  );

  const reasons = await tx.many<{ reason: string; count: string }>(
    `select loss_reason as reason, count(*)::text as count
       from renewals
      where deleted_at is null
        and status = 'lost'
        and loss_reason is not null
        and decided_at >= now() - interval '12 months'
      group by loss_reason
      order by count(*) desc
      limit 5`,
  );

  const won = Number(totals.won_value);
  const lost = Number(totals.lost_value);
  const decided = won + lost;

  return {
    currency: base,
    upcoming_90d: { count: Number(totals.upcoming_count), value: totals.upcoming_value },
    in_progress: { count: Number(totals.in_progress_count), value: totals.in_progress_value },
    won_12m: { count: Number(totals.won_count), value: totals.won_value },
    lost_12m: { count: Number(totals.lost_count), value: totals.lost_value },
    // Undefined rather than 100% when nothing has been decided: a rate computed
    // from no decisions is not a good result, it is an absence of data.
    retention_rate: decided > 0 ? Math.round((won / decided) * 1000) / 10 : null,
    top_loss_reasons: reasons.map((r) => ({ reason: r.reason, count: Number(r.count) })),
  };
}
