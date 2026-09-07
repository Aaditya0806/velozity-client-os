/**
 * Company (client) service.
 *
 * Queries run inside the caller's tenant transaction, so RLS decides row
 * visibility. The permission checks here shape the *query* - which columns to
 * return, whether to include sensitive figures - rather than repeating the
 * row filter that RLS already applies.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { likePattern } from '@/lib/db';
import { filters } from '@/lib/db/filters';
import { AppError } from '@/lib/http/errors';
import { emitEvent, recordActivity } from '@/lib/events';
import { writeAudit, diffRows } from '@/lib/audit';
import type { RequestContext } from '@/lib/auth/session';
import { redactSensitiveFields, redactMany } from '@/lib/permissions';
import {
  uuid, shortText, nullableText, currencyCode, countryCode, email, tags, listQuery, safeOrderBy, paginationMeta,
} from '@/lib/validation/common';

export const companyCreateSchema = z.object({
  name: shortText(200),
  legal_name: nullableText(200),
  parent_company_id: uuid.nullable().optional(),
  is_legal_entity: z.boolean().default(true),
  registration_no: nullableText(80),
  tax_id: nullableText(80),
  lifecycle_stage: z
    .enum(['prospect', 'client', 'former_client', 'partner', 'disqualified'])
    .default('prospect'),
  industry: nullableText(120),
  website: z.string().trim().url().max(500).nullable().optional(),
  employee_count: z.number().int().min(0).nullable().optional(),
  annual_revenue: z.string().nullable().optional(),
  currency: currencyCode.nullable().optional(),
  timezone: nullableText(60),
  address_line1: nullableText(200),
  address_line2: nullableText(200),
  city: nullableText(120),
  state: nullableText(120),
  postal_code: nullableText(30),
  country: countryCode.nullable().optional(),
  phone: nullableText(40),
  email: email.nullable().optional(),
  linkedin_url: z.string().trim().url().max(500).nullable().optional(),
  owner_user_id: uuid.nullable().optional(),
  team_id: uuid.nullable().optional(),
  source: nullableText(120),
  tags,
  internal_notes: nullableText(),
});

export const companyUpdateSchema = companyCreateSchema.partial();

export const COMPANY_SORT_COLUMNS = [
  'name', 'created_at', 'updated_at', 'lifecycle_stage', 'health_score',
] as const;

export const companyListSchema = listQuery(COMPANY_SORT_COLUMNS, 'name', {
  lifecycle_stage: z.string().optional(),
  owner_user_id: uuid.optional(),
  team_id: uuid.optional(),
  health_status: z.string().optional(),
  parent_company_id: uuid.optional(),
  tag: z.string().optional(),
});

export type CompanyCreate = z.infer<typeof companyCreateSchema>;
export type CompanyUpdate = z.infer<typeof companyUpdateSchema>;
export type CompanyListQuery = z.infer<typeof companyListSchema>;

export interface CompanyRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  name: string;
  lifecycle_stage: string;
  owner_user_id: string | null;
  team_id: string | null;
}

export async function listCompanies(tx: Tx, ctx: RequestContext, query: CompanyListQuery) {
  const f = filters('c.deleted_at is null');

  if (query.q) {
    const pattern = likePattern(query.q);
    f.where('(c.name ilike ? or c.legal_name ilike ? or c.email ilike ?)', pattern, pattern, pattern);
  }
  f.whereIf(query.lifecycle_stage, 'c.lifecycle_stage = ?');
  f.whereIf(query.owner_user_id, 'c.owner_user_id = ?');
  f.whereIf(query.team_id, 'c.team_id = ?');
  f.whereIf(query.health_status, 'c.health_status = ?');
  f.whereIf(query.parent_company_id, 'c.parent_company_id = ?');
  f.whereIf(query.tag, '? = any (c.tags)');

  const totalRow = await tx.one<{ count: string }>(
    `select count(*)::text as count from companies c where ${f.sql}`,
    f.params,
  );
  const total = Number.parseInt(totalRow.count, 10);

  const order = safeOrderBy(query.sort, query.direction, COMPANY_SORT_COLUMNS, 'name');
  const limit = f.bind(query.page_size);
  const offset = f.bind((query.page - 1) * query.page_size);

  const rows = await tx.many<CompanyRow>(
    `select c.*,
            owner.full_name as owner_name,
            parent.name as parent_company_name,
            (select count(*) from opportunities o
              where o.company_id = c.id and o.deleted_at is null
                and o.stage not in ('won','lost','closed')) as open_opportunity_count,
            (select count(*) from projects p
              where p.company_id = c.id and p.deleted_at is null
                and p.status in ('active','on_hold')) as active_project_count
     from companies c
     left join user_profiles owner on owner.id = c.owner_user_id
     left join companies parent on parent.id = c.parent_company_id
     where ${f.sql}
     order by c.${order}
     limit ${limit} offset ${offset}`,
    f.params,
  );

  return {
    rows: redactMany(rows, ctx.permissions),
    pagination: paginationMeta(query.page, query.page_size, total),
  };
}

export async function getCompany(tx: Tx, ctx: RequestContext, id: string) {
  const row = await tx.maybeOne<CompanyRow>(
    `select c.*, owner.full_name as owner_name, owner.email as owner_email,
            parent.name as parent_company_name, t.name as team_name
     from companies c
     left join user_profiles owner on owner.id = c.owner_user_id
     left join companies parent on parent.id = c.parent_company_id
     left join teams t on t.id = c.team_id
     where c.id = $1 and c.deleted_at is null`,
    [id],
  );
  if (!row) throw new AppError('NOT_FOUND', 'This client was not found.');
  return redactSensitiveFields(row, ctx.permissions);
}

export async function createCompany(
  tx: Tx,
  ctx: RequestContext,
  input: CompanyCreate,
): Promise<CompanyRow> {
  const row = await tx.one<CompanyRow>(
    `insert into companies (
       org_id, name, legal_name, parent_company_id, is_legal_entity, registration_no, tax_id,
       lifecycle_stage, industry, website, employee_count, annual_revenue, currency, timezone,
       address_line1, address_line2, city, state, postal_code, country,
       phone, email, linkedin_url, owner_user_id, team_id, source, tags, internal_notes, created_by
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29
     ) returning *`,
    [
      ctx.org.id, input.name, input.legal_name ?? null, input.parent_company_id ?? null,
      input.is_legal_entity, input.registration_no ?? null, input.tax_id ?? null,
      input.lifecycle_stage, input.industry ?? null, input.website ?? null,
      input.employee_count ?? null, input.annual_revenue ?? null,
      input.currency ?? ctx.org.baseCurrency, input.timezone ?? null,
      input.address_line1 ?? null, input.address_line2 ?? null, input.city ?? null,
      input.state ?? null, input.postal_code ?? null, input.country ?? null,
      input.phone ?? null, input.email ?? null, input.linkedin_url ?? null,
      input.owner_user_id ?? ctx.user.id, input.team_id ?? null, input.source ?? null,
      input.tags, input.internal_notes ?? null, ctx.user.id,
    ],
  );

  const event = await emitEvent(tx, {
    name: 'company.created',
    entityType: 'company',
    entityId: row.id,
    payload: { name: row.name, lifecycle_stage: row.lifecycle_stage },
  });

  await recordActivity(tx, {
    entityType: 'company',
    entityId: row.id,
    companyId: row.id,
    activityType: 'created',
    title: `Client "${row.name}" created`,
    eventId: event.id,
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'company.created',
    category: 'admin',
    actorUserId: ctx.user.id,
    entityType: 'company',
    entityId: row.id,
    summary: `Created client ${row.name}`,
    after: { name: row.name, lifecycle_stage: row.lifecycle_stage },
    requestId: ctx.requestId,
  });

  return row;
}

export async function updateCompany(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  input: CompanyUpdate,
): Promise<CompanyRow> {
  const before = await tx.maybeOne<CompanyRow>(
    `select * from companies where id = $1 and deleted_at is null for update`,
    [id],
  );
  if (!before) throw new AppError('NOT_FOUND', 'This client was not found.');

  // internal_notes is behind its own permission, on write as well as read.
  if (input.internal_notes !== undefined && !ctx.permissions.has('internal_note:read:org')) {
    throw new AppError('FORBIDDEN', 'You do not have permission to edit internal notes.');
  }

  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return before;

  const assignments = entries.map(([k], i) => `${quote(k)} = $${i + 2}`).join(', ');
  const after = await tx.one<CompanyRow>(
    `update companies set ${assignments} where id = $1 returning *`,
    [id, ...entries.map(([, v]) => v)],
  );

  const diff = diffRows(before, after);

  await emitEvent(tx, {
    name: 'company.updated',
    entityType: 'company',
    entityId: id,
    payload: { changed: Object.keys(diff.after) },
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'company.updated',
    category: 'admin',
    actorUserId: ctx.user.id,
    entityType: 'company',
    entityId: id,
    summary: `Updated client ${after.name}`,
    before: diff.before,
    after: diff.after,
    requestId: ctx.requestId,
  });

  return after;
}

/** Soft delete. Critical business data is never removed. */
export async function archiveCompany(tx: Tx, ctx: RequestContext, id: string, reason: string) {
  const open = await tx.one<{ count: string }>(
    `select count(*)::text as count from opportunities
     where company_id = $1 and deleted_at is null and stage not in ('won','lost','closed')`,
    [id],
  );
  if (Number.parseInt(open.count, 10) > 0) {
    throw new AppError(
      'CONFLICT',
      'This client still has open opportunities. Close or reassign them first.',
      { details: { open_opportunities: Number.parseInt(open.count, 10) } },
    );
  }

  const row = await tx.one<CompanyRow>(
    `update companies set deleted_at = now(), status = 'archived'
     where id = $1 and deleted_at is null returning *`,
    [id],
  );

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'company.archived',
    category: 'admin',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'company',
    entityId: id,
    summary: `Archived client ${row.name}`,
    reason,
    requestId: ctx.requestId,
  });

  return row;
}

function quote(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe column: ${name}`);
  return `"${name}"`;
}
