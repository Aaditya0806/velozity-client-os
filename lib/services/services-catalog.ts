/**
 * Service catalogue.
 *
 * The catalogue is the source for pricing defaults, delivery shape, SLA and —
 * critically — which executed documents a service demands before delivery may
 * start. That last list is what the onboarding legal gate is built from.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { likePattern } from '@/lib/db';
import { filters } from '@/lib/db/filters';
import { AppError } from '@/lib/http/errors';
import { writeAudit } from '@/lib/audit';
import type { RequestContext } from '@/lib/auth/session';
import { redactMany, redactSensitiveFields } from '@/lib/permissions';
import {
  uuid, shortText, nullableText, currencyCode, moneyAmount, tags,
  listQuery, safeOrderBy, paginationMeta,
} from '@/lib/validation/common';

export const PRICING_MODELS = [
  'fixed', 'hourly', 'daily', 'monthly_retainer', 'per_unit', 'milestone', 'usage', 'custom',
] as const;

export const CONTRACT_TYPES = ['nda', 'msa', 'sow', 'addendum', 'amendment', 'other'] as const;

export const serviceCreateSchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, dash and underscore only.'),
  name: shortText(200),
  category_id: uuid.nullable().optional(),
  short_description: nullableText(300),
  description: nullableText(),
  pricing_model: z.enum(PRICING_MODELS).default('fixed'),
  base_price: moneyAmount.default('0'),
  currency: currencyCode.optional(),
  unit_label: z.string().trim().max(40).default('unit'),
  min_quantity: z.string().default('1'),
  unit_cost: moneyAmount.nullable().optional(),
  sla_response_hours: z.number().int().positive().nullable().optional(),
  sla_resolution_hours: z.number().int().positive().nullable().optional(),
  default_duration_days: z.number().int().positive().nullable().optional(),
  delivery_config: z.record(z.unknown()).default({}),
  is_active: z.boolean().default(true),
  position: z.number().int().default(0),
  tags,
});

export const serviceUpdateSchema = serviceCreateSchema.partial();

export const defaultTaskSchema = z.object({
  workstream_name: nullableText(120),
  title: shortText(300),
  description: nullableText(),
  position: z.number().int().default(0),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  estimated_hours: z.string().nullable().optional(),
  offset_days: z.number().int().default(0),
  duration_days: z.number().int().positive().default(1),
  is_deliverable: z.boolean().default(false),
});

export const defaultKpiSchema = z.object({
  name: shortText(200),
  description: nullableText(),
  unit: z.enum(['number', 'percent', 'currency', 'ratio', 'days', 'hours', 'score']).default('number'),
  target_value: z.string().nullable().optional(),
  direction: z.enum(['higher_is_better', 'lower_is_better', 'target_band']).default('higher_is_better'),
  period: z.enum(['weekly', 'monthly', 'quarterly', 'annual', 'project']).default('monthly'),
  position: z.number().int().default(0),
});

export const requiredDocumentSchema = z.object({
  contract_type: z.enum(CONTRACT_TYPES),
  document_label: shortText(200),
  is_required: z.boolean().default(true),
  blocks_onboarding: z.boolean().default(true),
  notes: nullableText(),
});

export const SERVICE_SORT_COLUMNS = ['name', 'code', 'base_price', 'position', 'created_at'] as const;

export const serviceListSchema = listQuery(SERVICE_SORT_COLUMNS, 'position', {
  category_id: uuid.optional(),
  is_active: z.enum(['true', 'false']).optional(),
  pricing_model: z.enum(PRICING_MODELS).optional(),
});

export type ServiceCreate = z.infer<typeof serviceCreateSchema>;
export type ServiceUpdate = z.infer<typeof serviceUpdateSchema>;

export async function listServices(
  tx: Tx,
  ctx: RequestContext,
  query: z.infer<typeof serviceListSchema>,
) {
  const f = filters('s.deleted_at is null');
  if (query.q) {
    const p = likePattern(query.q);
    f.where('(s.name ilike ? or s.code ilike ? or s.short_description ilike ?)', p, p, p);
  }
  f.whereIf(query.category_id, 's.category_id = ?');
  f.whereIf(query.pricing_model, 's.pricing_model = ?');
  if (query.is_active) f.where('s.is_active = ?', query.is_active === 'true');

  const totalRow = await tx.one<{ count: string }>(
    `select count(*)::text as count from services s where ${f.sql}`,
    f.params,
  );

  const order = safeOrderBy(query.sort, query.direction, SERVICE_SORT_COLUMNS, 'position');
  const limit = f.bind(query.page_size);
  const offset = f.bind((query.page - 1) * query.page_size);

  const rows = await tx.many(
    `select s.*, cat.name as category_name,
            (select count(*) from service_default_tasks t where t.service_id = s.id) as default_task_count,
            (select count(*) from service_default_kpis k where k.service_id = s.id) as default_kpi_count,
            (select count(*) from service_required_documents d where d.service_id = s.id) as required_document_count
     from services s
     left join service_categories cat on cat.id = s.category_id
     where ${f.sql}
     order by s.${order}, s.name asc
     limit ${limit} offset ${offset}`,
    f.params,
  );

  return {
    rows: redactMany(rows as Record<string, unknown>[], ctx.permissions),
    pagination: paginationMeta(query.page, query.page_size, Number.parseInt(totalRow.count, 10)),
  };
}

export async function getService(tx: Tx, ctx: RequestContext, id: string) {
  const service = await tx.maybeOne<Record<string, unknown>>(
    `select s.*, cat.name as category_name from services s
     left join service_categories cat on cat.id = s.category_id
     where s.id = $1 and s.deleted_at is null`,
    [id],
  );
  if (!service) throw new AppError('NOT_FOUND', 'This service was not found.');

  const [defaultTasks, defaultKpis, requiredDocuments] = await Promise.all([
    tx.many(`select * from service_default_tasks where service_id = $1 order by position`, [id]),
    tx.many(`select * from service_default_kpis where service_id = $1 order by position`, [id]),
    tx.many(`select * from service_required_documents where service_id = $1 order by contract_type`, [id]),
  ]);

  return {
    ...redactSensitiveFields(service, ctx.permissions),
    default_tasks: defaultTasks,
    default_kpis: defaultKpis,
    required_documents: requiredDocuments,
  };
}

export async function createService(tx: Tx, ctx: RequestContext, input: ServiceCreate) {
  const row = await tx.one<{ id: string; name: string; code: string }>(
    `insert into services (
       org_id, category_id, code, name, short_description, description, pricing_model,
       base_price, currency, unit_label, min_quantity, unit_cost,
       sla_response_hours, sla_resolution_hours, default_duration_days,
       delivery_config, is_active, position, tags, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     returning *`,
    [
      ctx.org.id, input.category_id ?? null, input.code, input.name,
      input.short_description ?? null, input.description ?? null, input.pricing_model,
      input.base_price, input.currency ?? ctx.org.baseCurrency, input.unit_label,
      input.min_quantity, input.unit_cost ?? null,
      input.sla_response_hours ?? null, input.sla_resolution_hours ?? null,
      input.default_duration_days ?? null, JSON.stringify(input.delivery_config),
      input.is_active, input.position, input.tags, ctx.user.id,
    ],
  );

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'service.created',
    category: 'admin',
    actorUserId: ctx.user.id,
    entityType: 'service',
    entityId: row.id,
    summary: `Created service ${row.code} — ${row.name}`,
    requestId: ctx.requestId,
  });

  return row;
}

export async function updateService(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  input: ServiceUpdate,
) {
  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return getService(tx, ctx, id);

  const values = entries.map(([k, v]) => (k === 'delivery_config' ? JSON.stringify(v) : v));
  const assignments = entries.map(([k], i) => `${quote(k)} = $${i + 2}`).join(', ');

  const row = await tx.one<{ id: string; code: string; name: string }>(
    `update services set ${assignments} where id = $1 and deleted_at is null returning *`,
    [id, ...values],
  );

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'service.updated',
    category: 'admin',
    actorUserId: ctx.user.id,
    entityType: 'service',
    entityId: id,
    summary: `Updated service ${row.code}`,
    after: Object.fromEntries(entries),
    requestId: ctx.requestId,
  });

  return row;
}

/**
 * Archive rather than delete. A service referenced by a signed contract or a
 * running project must remain resolvable forever.
 */
export async function archiveService(tx: Tx, ctx: RequestContext, id: string) {
  const row = await tx.one<{ id: string; code: string }>(
    `update services set is_active = false, archived_at = now()
     where id = $1 and deleted_at is null returning *`,
    [id],
  );
  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'service.archived',
    category: 'admin',
    actorUserId: ctx.user.id,
    entityType: 'service',
    entityId: id,
    summary: `Archived service ${row.code}`,
    requestId: ctx.requestId,
  });
  return row;
}

export async function replaceDefaultTasks(
  tx: Tx,
  ctx: RequestContext,
  serviceId: string,
  tasks: z.infer<typeof defaultTaskSchema>[],
) {
  await tx.query(`delete from service_default_tasks where service_id = $1`, [serviceId]);
  for (const [index, task] of tasks.entries()) {
    await tx.query(
      `insert into service_default_tasks (
         org_id, service_id, workstream_name, title, description, position, priority,
         estimated_hours, offset_days, duration_days, is_deliverable
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        ctx.org.id, serviceId, task.workstream_name ?? null, task.title,
        task.description ?? null, task.position || index, task.priority,
        task.estimated_hours ?? null, task.offset_days, task.duration_days, task.is_deliverable,
      ],
    );
  }
}

export async function replaceDefaultKpis(
  tx: Tx,
  ctx: RequestContext,
  serviceId: string,
  kpis: z.infer<typeof defaultKpiSchema>[],
) {
  await tx.query(`delete from service_default_kpis where service_id = $1`, [serviceId]);
  for (const [index, kpi] of kpis.entries()) {
    await tx.query(
      `insert into service_default_kpis (
         org_id, service_id, name, description, unit, target_value, direction, period, position
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        ctx.org.id, serviceId, kpi.name, kpi.description ?? null, kpi.unit,
        kpi.target_value ?? null, kpi.direction, kpi.period, kpi.position || index,
      ],
    );
  }
}

export async function replaceRequiredDocuments(
  tx: Tx,
  ctx: RequestContext,
  serviceId: string,
  documents: z.infer<typeof requiredDocumentSchema>[],
) {
  await tx.query(`delete from service_required_documents where service_id = $1`, [serviceId]);
  for (const doc of documents) {
    await tx.query(
      `insert into service_required_documents (
         org_id, service_id, contract_type, document_label, is_required, blocks_onboarding, notes
       ) values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        ctx.org.id, serviceId, doc.contract_type, doc.document_label,
        doc.is_required, doc.blocks_onboarding, doc.notes ?? null,
      ],
    );
  }

  // Changing the legal requirements of a service is a consequential act: it
  // changes what future onboardings will be blocked on.
  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'service.required_documents_changed',
    category: 'admin',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'service',
    entityId: serviceId,
    summary: `Updated required documents for a service (${documents.length} requirement(s))`,
    after: documents,
    requestId: ctx.requestId,
  });
}

function quote(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe column: ${name}`);
  return `"${name}"`;
}
