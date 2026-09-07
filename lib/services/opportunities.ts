/**
 * Opportunity service — the sales pipeline.
 *
 * One table covers the whole funnel, so "converting a lead" is a stage
 * transition rather than a copy between tables. Nothing is lost at conversion
 * and there is no second identifier to reconcile.
 *
 * Stage changes never happen here: they go through `transitionOpportunity`,
 * which runs the state machine. The database refuses a stage write from any
 * other path.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { likePattern } from '@/lib/db';
import { filters } from '@/lib/db/filters';
import { AppError } from '@/lib/http/errors';
import { emitEvent, recordActivity, notify } from '@/lib/events';
import { writeAudit, diffRows } from '@/lib/audit';
import type { RequestContext } from '@/lib/auth/session';
import { redactSensitiveFields, redactMany } from '@/lib/permissions';
import { performTransition, type TransitionRequest } from '@/lib/workflows/state-machine';
import { opportunityMachine, type OpportunityRow } from '@/lib/workflows/machines';
import {
  uuid, shortText, nullableText, currencyCode, moneyAmount, isoDate, tags,
  listQuery, safeOrderBy, paginationMeta,
} from '@/lib/validation/common';

export const OPPORTUNITY_STAGES = [
  'lead', 'qualified', 'discovery', 'diagnosis', 'solution',
  'proposal_sent', 'negotiation', 'won', 'closed', 'lost', 'dormant',
] as const;

export const OPEN_STAGES = [
  'lead', 'qualified', 'discovery', 'diagnosis', 'solution', 'proposal_sent', 'negotiation',
] as const;

export const opportunityCreateSchema = z.object({
  company_id: uuid,
  primary_contact_id: uuid.nullable().optional(),
  name: shortText(200),
  description: nullableText(),
  amount: moneyAmount.default('0'),
  currency: currencyCode.optional(),
  probability: z.number().int().min(0).max(100).default(0),
  expected_close_date: isoDate.nullable().optional(),
  business_problem: nullableText(),
  budget_indication: moneyAmount.nullable().optional(),
  budget_currency: currencyCode.nullable().optional(),
  decision_maker_contact_id: uuid.nullable().optional(),
  owner_user_id: uuid.nullable().optional(),
  team_id: uuid.nullable().optional(),
  source: nullableText(120),
  campaign: nullableText(120),
  tags,
  internal_notes: nullableText(),
});

export const opportunityUpdateSchema = opportunityCreateSchema
  .partial()
  .omit({ company_id: true })
  // Stage is intentionally absent. Attempting to set it is a client bug and is
  // rejected by the schema before the database gets the chance.
  .strict();

export const OPPORTUNITY_SORT_COLUMNS = [
  'name', 'amount', 'created_at', 'updated_at', 'expected_close_date', 'probability', 'stage',
] as const;

export const opportunityListSchema = listQuery(OPPORTUNITY_SORT_COLUMNS, 'updated_at', {
  stage: z.string().optional(),
  stages: z.string().optional(),
  company_id: uuid.optional(),
  owner_user_id: uuid.optional(),
  team_id: uuid.optional(),
  open_only: z.enum(['true', 'false']).optional(),
  close_from: isoDate.optional(),
  close_to: isoDate.optional(),
});

export type OpportunityCreate = z.infer<typeof opportunityCreateSchema>;
export type OpportunityUpdate = z.infer<typeof opportunityUpdateSchema>;
export type OpportunityListQuery = z.infer<typeof opportunityListSchema>;

export async function listOpportunities(
  tx: Tx,
  ctx: RequestContext,
  query: OpportunityListQuery,
) {
  const f = filters('o.deleted_at is null');

  if (query.q) {
    const p = likePattern(query.q);
    f.where('(o.name ilike ? or o.reference ilike ? or c.name ilike ?)', p, p, p);
  }
  f.whereIf(query.stage, 'o.stage = ?');
  if (query.stages) {
    f.where('o.stage = any (?)', query.stages.split(',').map((s) => s.trim()).filter(Boolean));
  }
  if (query.open_only === 'true') f.where('o.stage = any (?)', [...OPEN_STAGES]);
  f.whereIf(query.company_id, 'o.company_id = ?');
  f.whereIf(query.owner_user_id, 'o.owner_user_id = ?');
  f.whereIf(query.team_id, 'o.team_id = ?');
  f.whereIf(query.close_from, 'o.expected_close_date >= ?');
  f.whereIf(query.close_to, 'o.expected_close_date <= ?');

  const totalRow = await tx.one<{ count: string; total_amount: string }>(
    `select count(*)::text as count, coalesce(sum(o.amount), 0)::text as total_amount
     from opportunities o join companies c on c.id = o.company_id
     where ${f.sql}`,
    f.params,
  );

  const order = safeOrderBy(query.sort, query.direction, OPPORTUNITY_SORT_COLUMNS, 'updated_at');
  // Bound explicitly rather than assumed by position: an "overdue" deal is one
  // still open past its expected close date.
  const openStages = f.bind([...OPEN_STAGES]);
  const limit = f.bind(query.page_size);
  const offset = f.bind((query.page - 1) * query.page_size);

  const rows = await tx.many<OpportunityRow>(
    `select o.*, c.name as company_name, owner.full_name as owner_name,
            ct.full_name as primary_contact_name,
            (o.expected_close_date is not null and o.expected_close_date < current_date
             and o.stage = any (${openStages}::text[])) as is_overdue
     from opportunities o
     join companies c on c.id = o.company_id
     left join user_profiles owner on owner.id = o.owner_user_id
     left join contacts ct on ct.id = o.primary_contact_id
     where ${f.sql}
     order by o.${order}
     limit ${limit} offset ${offset}`,
    f.params,
  );

  return {
    rows: redactMany(rows, ctx.permissions),
    pagination: paginationMeta(query.page, query.page_size, Number.parseInt(totalRow.count, 10)),
    summary: { total_amount: totalRow.total_amount },
  };
}

export async function getOpportunity(tx: Tx, ctx: RequestContext, id: string) {
  const row = await tx.maybeOne<OpportunityRow>(
    `select o.*, c.name as company_name, owner.full_name as owner_name,
            ct.full_name as primary_contact_name,
            dm.full_name as decision_maker_name,
            d.id as discovery_id, d.status as discovery_status
     from opportunities o
     join companies c on c.id = o.company_id
     left join user_profiles owner on owner.id = o.owner_user_id
     left join contacts ct on ct.id = o.primary_contact_id
     left join contacts dm on dm.id = o.decision_maker_contact_id
     left join discoveries d on d.opportunity_id = o.id and d.deleted_at is null
     where o.id = $1 and o.deleted_at is null`,
    [id],
  );
  if (!row) throw new AppError('NOT_FOUND', 'This opportunity was not found.');
  return redactSensitiveFields(row, ctx.permissions);
}

export async function createOpportunity(
  tx: Tx,
  ctx: RequestContext,
  input: OpportunityCreate,
): Promise<OpportunityRow> {
  const reference = await nextReference(tx, ctx.org.id, 'opportunity', 'OPP');
  const currency = input.currency ?? ctx.org.baseCurrency;
  const fxRate = await resolveFxRate(tx, ctx.org.id, currency, ctx.org.baseCurrency);

  const row = await tx.one<OpportunityRow>(
    `insert into opportunities (
       org_id, company_id, primary_contact_id, reference, name, description,
       amount, currency, fx_rate_to_base, amount_base, probability, expected_close_date,
       business_problem, budget_indication, budget_currency, decision_maker_contact_id,
       owner_user_id, team_id, source, campaign, tags, internal_notes, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     returning *`,
    [
      ctx.org.id, input.company_id, input.primary_contact_id ?? null, reference,
      input.name, input.description ?? null, input.amount, currency, fxRate,
      fxRate ? (Number.parseFloat(input.amount) * Number.parseFloat(fxRate)).toFixed(2) : null,
      input.probability, input.expected_close_date ?? null,
      input.business_problem ?? null, input.budget_indication ?? null,
      input.budget_indication ? (input.budget_currency ?? currency) : null,
      input.decision_maker_contact_id ?? null,
      input.owner_user_id ?? ctx.user.id, input.team_id ?? null,
      input.source ?? null, input.campaign ?? null, input.tags,
      input.internal_notes ?? null, ctx.user.id,
    ],
  );

  const event = await emitEvent(tx, {
    name: 'opportunity.created',
    entityType: 'opportunity',
    entityId: row.id,
    payload: {
      reference: row.reference,
      company_id: row.company_id,
      amount: row.amount,
      currency: row.currency,
      stage: row.stage,
    },
  });

  await recordActivity(tx, {
    entityType: 'opportunity',
    entityId: row.id,
    companyId: String(row.company_id),
    activityType: 'created',
    title: `Opportunity ${row.reference} created`,
    body: String(row.name),
    eventId: event.id,
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'opportunity.created',
    category: 'admin',
    actorUserId: ctx.user.id,
    entityType: 'opportunity',
    entityId: row.id,
    summary: `Created opportunity ${row.reference}`,
    after: { name: row.name, amount: row.amount, currency: row.currency },
    requestId: ctx.requestId,
  });

  return row;
}

/**
 * Lead capture: company, contact and opportunity created together.
 *
 * One transaction, so an inbound lead never lands as a company with no
 * opportunity, or an opportunity pointing at a contact that failed to save.
 */
export const leadCaptureSchema = z.object({
  company: z.object({
    name: shortText(200),
    website: z.string().trim().url().max(500).nullable().optional(),
    industry: nullableText(120),
    country: z.string().length(2).nullable().optional(),
    phone: nullableText(40),
  }),
  contact: z.object({
    first_name: shortText(100),
    last_name: z.string().trim().max(100).default(''),
    email: z.string().email().nullable().optional(),
    phone: nullableText(40),
    job_title: nullableText(150),
    contact_role: z
      .enum(['decision_maker', 'economic_buyer', 'champion', 'influencer', 'technical', 'legal', 'finance', 'end_user', 'other'])
      .default('other'),
  }),
  opportunity: z.object({
    name: shortText(200).optional(),
    description: nullableText(),
    amount: moneyAmount.default('0'),
    currency: currencyCode.optional(),
    expected_close_date: isoDate.nullable().optional(),
    source: nullableText(120),
    campaign: nullableText(120),
  }),
  owner_user_id: uuid.nullable().optional(),
  team_id: uuid.nullable().optional(),
});

export type LeadCapture = z.infer<typeof leadCaptureSchema>;

export async function captureLead(tx: Tx, ctx: RequestContext, input: LeadCapture) {
  const owner = input.owner_user_id ?? ctx.user.id;

  // An inbound lead for a company we already know must not create a duplicate.
  const existing = await tx.maybeOne<{ id: string }>(
    `select id from companies
     where org_id = $1 and lower(name) = lower($2) and deleted_at is null`,
    [ctx.org.id, input.company.name],
  );

  let companyId: string;
  if (existing) {
    companyId = existing.id;
  } else {
    const company = await tx.one<{ id: string }>(
      `insert into companies (org_id, name, website, industry, country, phone,
                              lifecycle_stage, owner_user_id, team_id, currency, source, created_by)
       values ($1,$2,$3,$4,$5,$6,'prospect',$7,$8,$9,$10,$11)
       returning id`,
      [
        ctx.org.id, input.company.name, input.company.website ?? null,
        input.company.industry ?? null, input.company.country ?? null,
        input.company.phone ?? null, owner, input.team_id ?? null,
        input.opportunity.currency ?? ctx.org.baseCurrency,
        input.opportunity.source ?? null, ctx.user.id,
      ],
    );
    companyId = company.id;
    await emitEvent(tx, {
      name: 'company.created',
      entityType: 'company',
      entityId: companyId,
      payload: { name: input.company.name, source: 'lead_capture' },
    });
  }

  // Reuse an existing contact with the same email at the same company.
  let contactId: string;
  const existingContact = input.contact.email
    ? await tx.maybeOne<{ id: string }>(
        `select id from contacts
         where org_id = $1 and company_id = $2 and lower(email) = lower($3) and deleted_at is null`,
        [ctx.org.id, companyId, input.contact.email],
      )
    : null;

  if (existingContact) {
    contactId = existingContact.id;
  } else {
    const hasPrimary = await tx.maybeOne<{ id: string }>(
      `select id from contacts where company_id = $1 and is_primary and deleted_at is null`,
      [companyId],
    );
    const contact = await tx.one<{ id: string }>(
      `insert into contacts (org_id, company_id, first_name, last_name, email, phone,
                             job_title, contact_role, is_primary, owner_user_id, team_id,
                             source, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       returning id`,
      [
        ctx.org.id, companyId, input.contact.first_name, input.contact.last_name,
        input.contact.email ?? null, input.contact.phone ?? null,
        input.contact.job_title ?? null, input.contact.contact_role,
        !hasPrimary, owner, input.team_id ?? null,
        input.opportunity.source ?? null, ctx.user.id,
      ],
    );
    contactId = contact.id;
    await emitEvent(tx, {
      name: 'contact.created',
      entityType: 'contact',
      entityId: contactId,
      payload: { company_id: companyId, source: 'lead_capture' },
    });
  }

  const opportunity = await createOpportunity(tx, ctx, {
    company_id: companyId,
    primary_contact_id: contactId,
    name: input.opportunity.name ?? `${input.company.name} — new enquiry`,
    description: input.opportunity.description ?? null,
    amount: input.opportunity.amount,
    currency: input.opportunity.currency,
    probability: 0,
    expected_close_date: input.opportunity.expected_close_date ?? null,
    business_problem: null,
    budget_indication: null,
    budget_currency: null,
    decision_maker_contact_id:
      input.contact.contact_role === 'decision_maker' ? contactId : null,
    owner_user_id: owner,
    team_id: input.team_id ?? null,
    source: input.opportunity.source ?? null,
    campaign: input.opportunity.campaign ?? null,
    tags: [],
    internal_notes: null,
  });

  if (owner !== ctx.user.id) {
    await notify(tx, {
      userId: owner,
      category: 'assignment',
      title: 'New lead assigned to you',
      body: `${input.company.name} — ${opportunity.name}`,
      entityType: 'opportunity',
      entityId: opportunity.id,
      linkUrl: `/pipeline/${opportunity.id}`,
    });
  }

  return { companyId, contactId, opportunity };
}

export async function updateOpportunity(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  input: OpportunityUpdate,
): Promise<OpportunityRow> {
  const before = await tx.maybeOne<OpportunityRow>(
    `select * from opportunities where id = $1 and deleted_at is null for update`,
    [id],
  );
  if (!before) throw new AppError('NOT_FOUND', 'This opportunity was not found.');

  if (input.internal_notes !== undefined && !ctx.permissions.has('internal_note:read:org')) {
    throw new AppError('FORBIDDEN', 'You do not have permission to edit internal notes.');
  }

  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return before;

  const assignments = entries.map(([k], i) => `${quote(k)} = $${i + 2}`).join(', ');
  const after = await tx.one<OpportunityRow>(
    `update opportunities set ${assignments} where id = $1 returning *`,
    [id, ...entries.map(([, v]) => v)],
  );

  const diff = diffRows(before, after);

  if (diff.after.owner_user_id && after.owner_user_id) {
    await emitEvent(tx, {
      name: 'opportunity.owner_changed',
      entityType: 'opportunity',
      entityId: id,
      payload: { from: before.owner_user_id, to: after.owner_user_id },
    });
    await notify(tx, {
      userId: String(after.owner_user_id),
      category: 'assignment',
      title: 'An opportunity was assigned to you',
      body: String(after.name),
      entityType: 'opportunity',
      entityId: id,
      linkUrl: `/pipeline/${id}`,
    });
  }

  await emitEvent(tx, {
    name: 'opportunity.updated',
    entityType: 'opportunity',
    entityId: id,
    payload: { changed: Object.keys(diff.after) },
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'opportunity.updated',
    category: 'admin',
    actorUserId: ctx.user.id,
    entityType: 'opportunity',
    entityId: id,
    summary: `Updated opportunity ${after.reference}`,
    before: diff.before,
    after: diff.after,
    requestId: ctx.requestId,
  });

  return after;
}

/**
 * The only way an opportunity's stage moves.
 */
export async function transitionOpportunity(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  request: TransitionRequest,
) {
  const result = await performTransition(tx, opportunityMachine, id, request, {
    userId: ctx.user.id,
  });

  const opp = result.entity;

  const event = await emitEvent(tx, {
    name: 'opportunity.stage_changed',
    entityType: 'opportunity',
    entityId: id,
    payload: {
      from: result.from,
      to: result.to,
      reason: request.reason ?? null,
      amount: opp.amount,
      currency: opp.currency,
      company_id: opp.company_id,
    },
  });

  // Won and lost are significant enough to carry their own event names, so an
  // automation can subscribe to the outcome without inspecting the payload.
  if (result.to === 'won') {
    await emitEvent(tx, {
      name: 'opportunity.won',
      entityType: 'opportunity',
      entityId: id,
      payload: {
        company_id: opp.company_id,
        amount: opp.amount,
        currency: opp.currency,
        accepted_proposal_version_id: opp.accepted_proposal_version_id,
      },
    });
  } else if (result.to === 'lost') {
    await emitEvent(tx, {
      name: 'opportunity.lost',
      entityType: 'opportunity',
      entityId: id,
      payload: {
        company_id: opp.company_id,
        lost_reason: opp.lost_reason,
        amount: opp.amount,
        currency: opp.currency,
      },
    });
  }

  await recordActivity(tx, {
    entityType: 'opportunity',
    entityId: id,
    companyId: String(opp.company_id),
    activityType: 'state_changed',
    title: `Stage changed from ${label(result.from)} to ${label(result.to)}`,
    body: request.reason ?? null,
    eventId: event.id,
    metadata: { from: result.from, to: result.to },
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: `opportunity.stage_changed`,
    category: 'state_change',
    severity: result.to === 'won' || result.to === 'lost' ? 'notice' : 'info',
    actorUserId: ctx.user.id,
    entityType: 'opportunity',
    entityId: id,
    summary: `Opportunity ${opp.reference}: ${result.from} → ${result.to}`,
    before: { stage: result.from },
    after: { stage: result.to },
    reason: request.reason ?? null,
    metadata: { transition_id: result.transitionId },
    requestId: ctx.requestId,
  });

  return result;
}

export async function getTransitionHistory(tx: Tx, entityType: string, entityId: string) {
  return tx.many(
    `select st.*, u.full_name as actor_name
     from state_transitions st
     left join user_profiles u on u.id = st.actor_user_id
     where st.entity_type = $1 and st.entity_id = $2
     order by st.occurred_at desc`,
    [entityType, entityId],
  );
}

// -----------------------------------------------------------------------------

export async function nextReference(
  tx: Tx,
  orgId: string,
  entity: string,
  prefix: string,
): Promise<string> {
  const row = await tx.one<{ reference: string }>(
    `select app.next_reference($1, $2, $3) as reference`,
    [orgId, entity, prefix],
  );
  return row.reference;
}

/**
 * FX rate at transaction time. Returns null when no rate is on file, which
 * callers must treat as "cannot report in base currency" rather than silently
 * assuming parity.
 */
export async function resolveFxRate(
  tx: Tx,
  orgId: string,
  from: string,
  to: string,
): Promise<string | null> {
  if (from === to) return '1';
  const row = await tx.maybeOne<{ rate: string | null }>(
    `select app.fx_rate_at($1, $2, $3, current_date) as rate`,
    [orgId, from, to],
  );
  return row?.rate ?? null;
}

const STAGE_LABELS: Record<string, string> = {
  lead: 'Lead',
  qualified: 'Qualified',
  discovery: 'Discovery',
  diagnosis: 'Diagnosis',
  solution: 'Solution',
  proposal_sent: 'Proposal sent',
  negotiation: 'Negotiation',
  won: 'Won',
  closed: 'Closed',
  lost: 'Lost',
  dormant: 'Dormant',
};

export const label = (stage: string): string => STAGE_LABELS[stage] ?? stage;

function quote(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe column: ${name}`);
  return `"${name}"`;
}
