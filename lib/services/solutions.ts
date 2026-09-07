/**
 * Solution builder.
 *
 * Prices a deal from catalogue services plus custom lines. All arithmetic is
 * performed by PostgreSQL in `numeric`: the generated columns on
 * `solution_line_items` compute each line, and `app.recalculate_solution_totals`
 * rolls them up. Nothing here does money maths in JavaScript, so the totals a
 * user sees and the totals stored on an accepted proposal cannot disagree.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { AppError } from '@/lib/http/errors';
import { emitEvent } from '@/lib/events';
import type { RequestContext } from '@/lib/auth/session';
import { redactSensitiveFields } from '@/lib/permissions';
import { uuid, shortText, nullableText, currencyCode, moneyAmount, isoDate } from '@/lib/validation/common';

export const lineItemSchema = z.object({
  service_id: uuid.nullable().optional(),
  name: shortText(200),
  description: nullableText(),
  pricing_model: z.string().max(40).default('fixed'),
  unit_label: z.string().max(40).default('unit'),
  quantity: z.string().default('1'),
  unit_price: moneyAmount.default('0'),
  unit_cost: moneyAmount.default('0'),
  discount_type: z.enum(['none', 'percent', 'amount']).default('none'),
  discount_value: moneyAmount.default('0'),
  tax_rate: z.string().default('0'),
  is_optional: z.boolean().default(false),
  is_custom: z.boolean().default(false),
  position: z.number().int().default(0),
});

export const milestoneSchema = z
  .object({
    name: shortText(200),
    description: nullableText(),
    percent: z.string().nullable().optional(),
    amount: moneyAmount.nullable().optional(),
    due_rule: z
      .enum(['on_signature', 'on_kickoff', 'on_delivery', 'days_after_signature', 'fixed_date', 'monthly'])
      .default('on_signature'),
    due_offset_days: z.number().int().nullable().optional(),
    due_date: isoDate.nullable().optional(),
    is_advance: z.boolean().default(false),
    position: z.number().int().default(0),
  })
  .refine((m) => (m.percent != null) !== (m.amount != null), {
    message: 'A milestone must specify exactly one of percent or amount.',
  });

export const solutionCreateSchema = z.object({
  opportunity_id: uuid,
  name: shortText(200).default('Solution'),
  summary: nullableText(),
  currency: currencyCode.optional(),
  discount_type: z.enum(['percent', 'amount']).nullable().optional(),
  discount_value: moneyAmount.default('0'),
  line_items: z.array(lineItemSchema).default([]),
  milestones: z.array(milestoneSchema).default([]),
  notes: nullableText(),
  internal_notes: nullableText(),
});

export const solutionUpdateSchema = solutionCreateSchema.partial().omit({ opportunity_id: true });

export type SolutionCreate = z.infer<typeof solutionCreateSchema>;
export type LineItem = z.infer<typeof lineItemSchema>;

export async function createSolution(tx: Tx, ctx: RequestContext, input: SolutionCreate) {
  const opportunity = await tx.maybeOne<{ id: string; company_id: string; currency: string }>(
    `select id, company_id, currency from opportunities
     where id = $1 and deleted_at is null`,
    [input.opportunity_id],
  );
  if (!opportunity) throw new AppError('NOT_FOUND', 'This opportunity was not found.');

  const currency = input.currency ?? opportunity.currency;

  const solution = await tx.one<{ id: string }>(
    `insert into solutions (org_id, opportunity_id, company_id, name, summary, currency,
                            discount_type, discount_value, notes, internal_notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning id`,
    [
      ctx.org.id, input.opportunity_id, opportunity.company_id, input.name,
      input.summary ?? null, currency, input.discount_type ?? null, input.discount_value,
      input.notes ?? null, input.internal_notes ?? null, ctx.user.id,
    ],
  );

  await replaceLineItems(tx, ctx, solution.id, input.line_items);
  await replaceMilestones(tx, ctx, solution.id, input.milestones);

  await emitEvent(tx, {
    name: 'solution.created',
    entityType: 'solution',
    entityId: solution.id,
    payload: { opportunity_id: input.opportunity_id, currency },
  });

  return getSolution(tx, ctx, solution.id);
}

export interface SolutionDetail extends Record<string, unknown> {
  id: string;
  currency: string;
  subtotal: string;
  discount_total: string;
  tax_total: string;
  total: string;
  line_items: Record<string, unknown>[];
  milestones: Record<string, unknown>[];
}

export async function getSolution(
  tx: Tx,
  ctx: RequestContext,
  id: string,
): Promise<SolutionDetail> {
  const solution = await tx.maybeOne<Record<string, unknown>>(
    `select * from solutions where id = $1 and deleted_at is null`,
    [id],
  );
  if (!solution) throw new AppError('NOT_FOUND', 'This solution was not found.');

  const [lineItems, milestones] = await Promise.all([
    tx.many<Record<string, unknown>>(
      `select li.*, s.code as service_code from solution_line_items li
       left join services s on s.id = li.service_id
       where li.solution_id = $1 order by li.position, li.created_at`,
      [id],
    ),
    tx.many(`select * from solution_milestones where solution_id = $1 order by position`, [id]),
  ]);

  return {
    ...redactSensitiveFields(solution, ctx.permissions),
    line_items: lineItems.map((li) => redactSensitiveFields(li, ctx.permissions)),
    milestones,
  } as SolutionDetail;
}

export async function replaceLineItems(
  tx: Tx,
  ctx: RequestContext,
  solutionId: string,
  items: LineItem[],
) {
  await tx.query(`delete from solution_line_items where solution_id = $1`, [solutionId]);

  for (const [index, item] of items.entries()) {
    // Snapshot the catalogue values so a later price change never rewrites a
    // quote that has already been shown to a client.
    let snapshot = item;
    if (item.service_id) {
      const service = await tx.maybeOne<{
        name: string; base_price: string; unit_cost: string | null;
        unit_label: string; pricing_model: string;
      }>(
        `select name, base_price, unit_cost, unit_label, pricing_model
         from services where id = $1 and deleted_at is null`,
        [item.service_id],
      );
      if (!service) {
        throw new AppError('VALIDATION_ERROR', 'A selected service no longer exists.', {
          details: { service_id: item.service_id },
        });
      }
      snapshot = {
        ...item,
        name: item.name || service.name,
        unit_price: item.unit_price ?? service.base_price,
        unit_cost: item.unit_cost ?? service.unit_cost ?? '0',
        unit_label: item.unit_label || service.unit_label,
        pricing_model: item.pricing_model || service.pricing_model,
      };
    }

    await tx.query(
      `insert into solution_line_items (
         org_id, solution_id, service_id, name, description, pricing_model, unit_label,
         quantity, unit_price, unit_cost, discount_type, discount_value, tax_rate,
         is_optional, is_custom, position
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        ctx.org.id, solutionId, snapshot.service_id ?? null, snapshot.name,
        snapshot.description ?? null, snapshot.pricing_model, snapshot.unit_label,
        snapshot.quantity, snapshot.unit_price, snapshot.unit_cost,
        snapshot.discount_type, snapshot.discount_value, snapshot.tax_rate,
        snapshot.is_optional, snapshot.is_custom || !snapshot.service_id,
        snapshot.position || index,
      ],
    );
  }
}

export async function replaceMilestones(
  tx: Tx,
  ctx: RequestContext,
  solutionId: string,
  milestones: z.infer<typeof milestoneSchema>[],
) {
  await tx.query(`delete from solution_milestones where solution_id = $1`, [solutionId]);
  for (const [index, m] of milestones.entries()) {
    await tx.query(
      `insert into solution_milestones (
         org_id, solution_id, name, description, percent, amount, due_rule,
         due_offset_days, due_date, is_advance, position
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        ctx.org.id, solutionId, m.name, m.description ?? null, m.percent ?? null,
        m.amount ?? null, m.due_rule, m.due_offset_days ?? null, m.due_date ?? null,
        m.is_advance, m.position || index,
      ],
    );
  }
}

export async function updateSolution(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  input: z.infer<typeof solutionUpdateSchema>,
) {
  const existing = await tx.maybeOne<{ id: string; status: string }>(
    `select id, status from solutions where id = $1 and deleted_at is null for update`,
    [id],
  );
  if (!existing) throw new AppError('NOT_FOUND', 'This solution was not found.');
  if (existing.status === 'used') {
    throw new AppError(
      'CONFLICT',
      'This solution has been used on a proposal. Duplicate it to make changes.',
    );
  }

  const { line_items, milestones, ...header } = input;
  const entries = Object.entries(header).filter(([, v]) => v !== undefined);
  if (entries.length > 0) {
    const assignments = entries.map(([k], i) => `${quote(k)} = $${i + 2}`).join(', ');
    await tx.query(`update solutions set ${assignments} where id = $1`, [
      id,
      ...entries.map(([, v]) => v),
    ]);
  }

  if (line_items) await replaceLineItems(tx, ctx, id, line_items);
  if (milestones) await replaceMilestones(tx, ctx, id, milestones);

  return getSolution(tx, ctx, id);
}

/** Deep copy, used when a used solution needs revising. */
export async function duplicateSolution(tx: Tx, ctx: RequestContext, id: string) {
  const source = await getSolution(tx, ctx, id);

  const copy = await tx.one<{ id: string }>(
    `insert into solutions (org_id, opportunity_id, company_id, name, summary, currency,
                            discount_type, discount_value, notes, internal_notes, version, created_by)
     select org_id, opportunity_id, company_id, name || ' (copy)', summary, currency,
            discount_type, discount_value, notes, internal_notes, version + 1, $2
     from solutions where id = $1
     returning id`,
    [id, ctx.user.id],
  );

  await tx.query(
    `insert into solution_line_items (
       org_id, solution_id, service_id, name, description, pricing_model, unit_label,
       quantity, unit_price, unit_cost, discount_type, discount_value, tax_rate,
       is_optional, is_custom, position)
     select org_id, $2, service_id, name, description, pricing_model, unit_label,
            quantity, unit_price, unit_cost, discount_type, discount_value, tax_rate,
            is_optional, is_custom, position
     from solution_line_items where solution_id = $1`,
    [id, copy.id],
  );

  await tx.query(
    `insert into solution_milestones (
       org_id, solution_id, name, description, percent, amount, due_rule,
       due_offset_days, due_date, is_advance, position)
     select org_id, $2, name, description, percent, amount, due_rule,
            due_offset_days, due_date, is_advance, position
     from solution_milestones where solution_id = $1`,
    [id, copy.id],
  );

  void source;
  return getSolution(tx, ctx, copy.id);
}

function quote(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe column: ${name}`);
  return `"${name}"`;
}
