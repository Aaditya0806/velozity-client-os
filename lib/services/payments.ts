/**
 * Payments and payment requirements.
 *
 * "Advance received" is never a stored boolean. A requirement is satisfied when
 * settled allocations reach its threshold, computed in SQL by
 * `app.payment_requirement_is_satisfied`. Partial payments, milestone payments
 * and several payments against one requirement are therefore ordinary cases
 * rather than special ones.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { filters } from '@/lib/db/filters';
import { AppError } from '@/lib/http/errors';
import { emitEvent, recordActivity } from '@/lib/events';
import { writeAudit } from '@/lib/audit';
import type { RequestContext } from '@/lib/auth/session';
import { nextReference, resolveFxRate } from './opportunities';
import {
  uuid, shortText, nullableText, currencyCode, moneyAmount, percentage, isoDate,
  listQuery, safeOrderBy, paginationMeta,
} from '@/lib/validation/common';

export const paymentRequirementSchema = z
  .object({
    company_id: uuid,
    opportunity_id: uuid.nullable().optional(),
    contract_id: uuid.nullable().optional(),
    project_id: uuid.nullable().optional(),
    name: shortText(200),
    description: nullableText(),
    requirement_type: z
      .enum(['advance', 'milestone', 'recurring', 'final', 'full'])
      .default('advance'),
    amount: moneyAmount.nullable().optional(),
    percent_of_value: percentage.nullable().optional(),
    currency: currencyCode,
    due_rule: z
      .enum(['on_signature', 'on_kickoff', 'on_delivery', 'days_after_signature', 'fixed_date', 'monthly'])
      .default('on_signature'),
    due_offset_days: z.number().int().nullable().optional(),
    due_date: isoDate.nullable().optional(),
    blocks_onboarding: z.boolean().default(false),
    position: z.number().int().default(0),
  })
  .refine((r) => (r.amount != null) !== (r.percent_of_value != null), {
    message: 'A requirement must specify exactly one of amount or percent_of_value.',
  })
  .refine((r) => r.percent_of_value == null || r.contract_id != null, {
    message: 'A percentage requirement needs a contract to take its percentage of.',
  });

export const paymentSchema = z.object({
  company_id: uuid,
  invoice_id: uuid.nullable().optional(),
  contract_id: uuid.nullable().optional(),
  project_id: uuid.nullable().optional(),
  amount: moneyAmount,
  currency: currencyCode,
  method: z
    .enum(['bank_transfer', 'card', 'cheque', 'cash', 'upi', 'direct_debit', 'other'])
    .default('bank_transfer'),
  status: z.enum(['pending', 'received', 'cleared']).default('received'),
  transaction_date: isoDate,
  external_ref: nullableText(120),
  notes: nullableText(),
  /** Where this money is applied. Amounts must not exceed the payment. */
  allocations: z
    .array(
      z.object({
        payment_requirement_id: uuid.nullable().optional(),
        invoice_id: uuid.nullable().optional(),
        amount: moneyAmount,
      }),
    )
    .default([]),
});

export const PAYMENT_SORT_COLUMNS = ['transaction_date', 'amount', 'created_at', 'status'] as const;

export const paymentListSchema = listQuery(PAYMENT_SORT_COLUMNS, 'transaction_date', {
  company_id: uuid.optional(),
  status: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export async function createPaymentRequirement(
  tx: Tx,
  ctx: RequestContext,
  input: z.infer<typeof paymentRequirementSchema>,
) {
  const row = await tx.one<{ id: string; name: string }>(
    `insert into payment_requirements (
       org_id, company_id, opportunity_id, contract_id, project_id, name, description,
       requirement_type, amount, percent_of_value, currency, due_rule, due_offset_days,
       due_date, blocks_onboarding, position, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     returning id, name`,
    [
      ctx.org.id, input.company_id, input.opportunity_id ?? null, input.contract_id ?? null,
      input.project_id ?? null, input.name, input.description ?? null,
      input.requirement_type, input.amount ?? null, input.percent_of_value ?? null,
      input.currency, input.due_rule, input.due_offset_days ?? null,
      input.due_date ?? null, input.blocks_onboarding, input.position, ctx.user.id,
    ],
  );

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'payment_requirement.created',
    category: 'payment',
    actorUserId: ctx.user.id,
    entityType: 'payment_requirement',
    entityId: row.id,
    summary: `Created payment requirement "${row.name}"`,
    metadata: { blocks_onboarding: input.blocks_onboarding },
    requestId: ctx.requestId,
  });

  return row;
}

export async function recordPayment(
  tx: Tx,
  ctx: RequestContext,
  input: z.infer<typeof paymentSchema>,
) {
  const reference = await nextReference(tx, ctx.org.id, 'payment', 'PAY');
  const fxRate = await resolveFxRate(tx, ctx.org.id, input.currency, ctx.org.baseCurrency);

  if (!fxRate) {
    throw new AppError(
      'VALIDATION_ERROR',
      `No exchange rate is on file for ${input.currency} to ${ctx.org.baseCurrency}. Add one before recording this payment.`,
      { details: { from: input.currency, to: ctx.org.baseCurrency } },
    );
  }

  const payment = await tx.one<{ id: string; reference: string }>(
    `insert into payments (
       org_id, company_id, invoice_id, contract_id, project_id, reference, external_ref,
       amount, currency, fx_rate_to_base, method, status, transaction_date, notes, recorded_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     returning id, reference`,
    [
      ctx.org.id, input.company_id, input.invoice_id ?? null, input.contract_id ?? null,
      input.project_id ?? null, reference, input.external_ref ?? null,
      input.amount, input.currency, fxRate, input.method, input.status,
      input.transaction_date, input.notes ?? null, ctx.user.id,
    ],
  );

  // Unallocated money against a single invoice is a common case; apply it.
  const allocations = input.allocations.length > 0
    ? input.allocations
    : input.invoice_id
      ? [{ invoice_id: input.invoice_id, amount: input.amount }]
      : [];

  for (const allocation of allocations) {
    await tx.query(
      `insert into payment_allocations (
         org_id, payment_id, payment_requirement_id, invoice_id, amount, currency, created_by
       ) values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        ctx.org.id, payment.id, allocation.payment_requirement_id ?? null,
        allocation.invoice_id ?? null, allocation.amount, input.currency, ctx.user.id,
      ],
    );
  }

  const event = await emitEvent(tx, {
    name: 'payment.recorded',
    entityType: 'payment',
    entityId: payment.id,
    payload: {
      reference: payment.reference,
      company_id: input.company_id,
      amount: input.amount,
      currency: input.currency,
    },
  });

  await recordActivity(tx, {
    entityType: 'payment',
    entityId: payment.id,
    companyId: input.company_id,
    activityType: 'payment',
    title: `Payment ${payment.reference} recorded`,
    body: `${input.currency} ${input.amount} via ${input.method.replace('_', ' ')}`,
    eventId: event.id,
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'payment.recorded',
    category: 'payment',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'payment',
    entityId: payment.id,
    summary: `Recorded ${input.currency} ${input.amount} from a client`,
    after: { amount: input.amount, currency: input.currency, method: input.method },
    metadata: { allocations: allocations.length },
    requestId: ctx.requestId,
  });

  // A satisfied requirement may have unblocked an onboarding. Re-evaluate rather
  // than assume, so the same rule decides in every case.
  const satisfied = await tx.many<{ id: string; name: string; onboarding_id: string | null }>(
    `select r.id, r.name,
            (select o.id from onboardings o
             where o.company_id = r.company_id and o.status = 'blocked' and o.deleted_at is null
             limit 1) as onboarding_id
     from payment_requirements r
     where r.id = any (
       select payment_requirement_id from payment_allocations
       where payment_id = $1 and payment_requirement_id is not null
     )
     and r.status = 'satisfied'`,
    [payment.id],
  );

  for (const requirement of satisfied) {
    await emitEvent(tx, {
      name: 'payment_requirement.satisfied',
      entityType: 'payment_requirement',
      entityId: requirement.id,
      payload: { name: requirement.name, onboarding_id: requirement.onboarding_id },
    });
  }

  return { ...payment, allocations: allocations.length, satisfied_requirements: satisfied.length };
}

export async function listPayments(
  tx: Tx,
  _ctx: RequestContext,
  query: z.infer<typeof paymentListSchema>,
) {
  const f = filters('p.deleted_at is null');
  f.whereIf(query.company_id, 'p.company_id = ?');
  f.whereIf(query.status, 'p.status = ?');
  f.whereIf(query.from, 'p.transaction_date >= ?');
  f.whereIf(query.to, 'p.transaction_date <= ?');
  if (query.q) f.where('(p.reference ilike ? or p.external_ref ilike ?)', `%${query.q}%`, `%${query.q}%`);

  const totalRow = await tx.one<{ count: string; total: string }>(
    `select count(*)::text as count, coalesce(sum(p.amount_base), 0)::text as total
     from payments p where ${f.sql}`,
    f.params,
  );

  const order = safeOrderBy(query.sort, query.direction, PAYMENT_SORT_COLUMNS, 'transaction_date');
  const limit = f.bind(query.page_size);
  const offset = f.bind((query.page - 1) * query.page_size);

  const rows = await tx.many(
    `select p.*, c.name as company_name, u.full_name as recorded_by_name
     from payments p
     join companies c on c.id = p.company_id
     left join user_profiles u on u.id = p.recorded_by
     where ${f.sql}
     order by p.${order}
     limit ${limit} offset ${offset}`,
    f.params,
  );

  return {
    rows,
    pagination: paginationMeta(query.page, query.page_size, Number.parseInt(totalRow.count, 10)),
    summary: { total_base: totalRow.total },
  };
}

/** Waiving a requirement is permissioned and reasoned, like every other exception. */
export async function waiveRequirement(
  tx: Tx,
  ctx: RequestContext,
  requirementId: string,
  reason: string,
) {
  ctx.permissions.require('finance:manage:org');

  const row = await tx.one<{ id: string; name: string; company_id: string }>(
    `update payment_requirements
     set status = 'waived', waived_by = $2, waived_at = now(), waiver_reason = $3
     where id = $1 and deleted_at is null
     returning id, name, company_id`,
    [requirementId, ctx.user.id, reason],
  );

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'payment_requirement.waived',
    category: 'payment',
    severity: 'warning',
    actorUserId: ctx.user.id,
    entityType: 'payment_requirement',
    entityId: requirementId,
    summary: `Waived payment requirement "${row.name}"`,
    reason,
    requestId: ctx.requestId,
  });

  return row;
}
