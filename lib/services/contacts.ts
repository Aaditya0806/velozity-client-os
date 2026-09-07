/**
 * Contact service.
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
  uuid, shortText, nullableText, email as emailSchema, tags, listQuery, safeOrderBy, paginationMeta,
} from '@/lib/validation/common';

export const CONTACT_ROLES = [
  'decision_maker', 'economic_buyer', 'champion', 'influencer',
  'technical', 'legal', 'finance', 'end_user', 'other',
] as const;

export const contactCreateSchema = z.object({
  company_id: uuid.nullable().optional(),
  first_name: shortText(100),
  last_name: z.string().trim().max(100).default(''),
  email: emailSchema.nullable().optional(),
  phone: nullableText(40),
  mobile: nullableText(40),
  job_title: nullableText(150),
  department: nullableText(120),
  linkedin_url: z.string().trim().url().max(500).nullable().optional(),
  timezone: nullableText(60),
  contact_role: z.enum(CONTACT_ROLES).default('other'),
  is_primary: z.boolean().default(false),
  is_billing: z.boolean().default(false),
  is_signatory: z.boolean().default(false),
  owner_user_id: uuid.nullable().optional(),
  team_id: uuid.nullable().optional(),
  source: nullableText(120),
  tags,
  internal_notes: nullableText(),
});

export const contactUpdateSchema = contactCreateSchema.partial().extend({
  status: z.enum(['active', 'inactive', 'left_company', 'bounced']).optional(),
  email_opt_out: z.boolean().optional(),
});

export const CONTACT_SORT_COLUMNS = ['full_name', 'created_at', 'updated_at', 'job_title'] as const;

export const contactListSchema = listQuery(CONTACT_SORT_COLUMNS, 'full_name', {
  company_id: uuid.optional(),
  contact_role: z.enum(CONTACT_ROLES).optional(),
  status: z.string().optional(),
  is_signatory: z.enum(['true', 'false']).optional(),
});

export type ContactCreate = z.infer<typeof contactCreateSchema>;
export type ContactUpdate = z.infer<typeof contactUpdateSchema>;
export type ContactListQuery = z.infer<typeof contactListSchema>;

export interface ContactRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  company_id: string | null;
  full_name: string;
  email: string | null;
  is_primary: boolean;
}

export async function listContacts(tx: Tx, ctx: RequestContext, query: ContactListQuery) {
  const f = filters('ct.deleted_at is null');

  if (query.q) {
    const p = likePattern(query.q);
    f.where('(ct.full_name ilike ? or ct.email ilike ? or ct.job_title ilike ?)', p, p, p);
  }
  f.whereIf(query.company_id, 'ct.company_id = ?');
  f.whereIf(query.contact_role, 'ct.contact_role = ?');
  f.whereIf(query.status, 'ct.status = ?');
  if (query.is_signatory) f.where('ct.is_signatory = ?', query.is_signatory === 'true');

  const totalRow = await tx.one<{ count: string }>(
    `select count(*)::text as count from contacts ct where ${f.sql}`,
    f.params,
  );

  const order = safeOrderBy(query.sort, query.direction, CONTACT_SORT_COLUMNS, 'full_name');
  const limit = f.bind(query.page_size);
  const offset = f.bind((query.page - 1) * query.page_size);

  const rows = await tx.many<ContactRow>(
    `select ct.*, c.name as company_name, owner.full_name as owner_name
     from contacts ct
     left join companies c on c.id = ct.company_id
     left join user_profiles owner on owner.id = ct.owner_user_id
     where ${f.sql}
     order by ct.${order}
     limit ${limit} offset ${offset}`,
    f.params,
  );

  return {
    rows: redactMany(rows, ctx.permissions),
    pagination: paginationMeta(query.page, query.page_size, Number.parseInt(totalRow.count, 10)),
  };
}

export async function getContact(tx: Tx, ctx: RequestContext, id: string) {
  const row = await tx.maybeOne<ContactRow>(
    `select ct.*, c.name as company_name from contacts ct
     left join companies c on c.id = ct.company_id
     where ct.id = $1 and ct.deleted_at is null`,
    [id],
  );
  if (!row) throw new AppError('NOT_FOUND', 'This contact was not found.');
  return redactSensitiveFields(row, ctx.permissions);
}

export async function createContact(
  tx: Tx,
  ctx: RequestContext,
  input: ContactCreate,
): Promise<ContactRow> {
  // Exactly one primary contact per company; promoting a new one demotes the old.
  if (input.is_primary && input.company_id) {
    await tx.query(
      `update contacts set is_primary = false
       where company_id = $1 and is_primary and deleted_at is null`,
      [input.company_id],
    );
  }

  const row = await tx.one<ContactRow>(
    `insert into contacts (
       org_id, company_id, first_name, last_name, email, phone, mobile, job_title, department,
       linkedin_url, timezone, contact_role, is_primary, is_billing, is_signatory,
       owner_user_id, team_id, source, tags, internal_notes, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     returning *`,
    [
      ctx.org.id, input.company_id ?? null, input.first_name, input.last_name,
      input.email ?? null, input.phone ?? null, input.mobile ?? null,
      input.job_title ?? null, input.department ?? null, input.linkedin_url ?? null,
      input.timezone ?? null, input.contact_role, input.is_primary, input.is_billing,
      input.is_signatory, input.owner_user_id ?? ctx.user.id, input.team_id ?? null,
      input.source ?? null, input.tags, input.internal_notes ?? null, ctx.user.id,
    ],
  );

  const event = await emitEvent(tx, {
    name: 'contact.created',
    entityType: 'contact',
    entityId: row.id,
    payload: { full_name: row.full_name, company_id: row.company_id },
  });

  if (row.company_id) {
    await recordActivity(tx, {
      entityType: 'contact',
      entityId: row.id,
      companyId: row.company_id,
      activityType: 'created',
      title: `Contact ${row.full_name} added`,
      eventId: event.id,
    });
  }

  return row;
}

export async function updateContact(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  input: ContactUpdate,
): Promise<ContactRow> {
  const before = await tx.maybeOne<ContactRow>(
    `select * from contacts where id = $1 and deleted_at is null for update`,
    [id],
  );
  if (!before) throw new AppError('NOT_FOUND', 'This contact was not found.');

  if (input.internal_notes !== undefined && !ctx.permissions.has('internal_note:read:org')) {
    throw new AppError('FORBIDDEN', 'You do not have permission to edit internal notes.');
  }

  if (input.is_primary && (input.company_id ?? before.company_id)) {
    await tx.query(
      `update contacts set is_primary = false
       where company_id = $1 and is_primary and deleted_at is null and id <> $2`,
      [input.company_id ?? before.company_id, id],
    );
  }

  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return before;

  const assignments = entries.map(([k], i) => `${quote(k)} = $${i + 2}`).join(', ');
  const after = await tx.one<ContactRow>(
    `update contacts set ${assignments} where id = $1 returning *`,
    [id, ...entries.map(([, v]) => v)],
  );

  const diff = diffRows(before, after);
  await emitEvent(tx, {
    name: 'contact.updated',
    entityType: 'contact',
    entityId: id,
    payload: { changed: Object.keys(diff.after) },
  });
  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'contact.updated',
    category: 'admin',
    actorUserId: ctx.user.id,
    entityType: 'contact',
    entityId: id,
    summary: `Updated contact ${after.full_name}`,
    before: diff.before,
    after: diff.after,
    requestId: ctx.requestId,
  });

  return after;
}

export async function archiveContact(tx: Tx, ctx: RequestContext, id: string, reason: string) {
  const row = await tx.one<ContactRow>(
    `update contacts set deleted_at = now(), status = 'inactive'
     where id = $1 and deleted_at is null returning *`,
    [id],
  );
  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'contact.archived',
    category: 'admin',
    actorUserId: ctx.user.id,
    entityType: 'contact',
    entityId: id,
    summary: `Archived contact ${row.full_name}`,
    reason,
    requestId: ctx.requestId,
  });
  return row;
}

function quote(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe column: ${name}`);
  return `"${name}"`;
}
