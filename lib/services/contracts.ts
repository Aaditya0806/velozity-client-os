/**
 * Contract service.
 *
 * The legal spine of the product. Three rules are enforced here and again in the
 * database:
 *
 *   1. Approval and sending are separate authorities, and neither belongs to the
 *      deal owner by default.
 *   2. A contract is generated from the *accepted proposal version*, and the
 *      variable values used are stored so the render is reproducible.
 *   3. `fully_executed` is reached only from a verified webhook, with the
 *      executed document downloaded, hashed and stored immutably first.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { likePattern } from '@/lib/db';
import { filters } from '@/lib/db/filters';
import { AppError } from '@/lib/http/errors';
import { emitEvent, recordActivity, notify } from '@/lib/events';
import { writeAudit } from '@/lib/audit';
import type { RequestContext } from '@/lib/auth/session';
import { redactSensitiveFields, redactMany } from '@/lib/permissions';
import { performTransition } from '@/lib/workflows/state-machine';
import { contractMachine } from '@/lib/workflows/machines';
import { renderTemplate, missingRequired, type TemplateVariable } from '@/lib/contracts/renderer';
import { nextReference, resolveFxRate } from './opportunities';
import { uploadDocument } from '@/lib/documents';
import {
  uuid, shortText, nullableText, currencyCode, moneyAmount, isoDate, meaningfulReason,
  listQuery, safeOrderBy, paginationMeta,
} from '@/lib/validation/common';

export const CONTRACT_TYPES = ['nda', 'msa', 'sow', 'addendum', 'amendment', 'other'] as const;

export const contractCreateSchema = z.object({
  company_id: uuid,
  legal_entity_id: uuid.nullable().optional(),
  opportunity_id: uuid.nullable().optional(),
  project_id: uuid.nullable().optional(),
  parent_contract_id: uuid.nullable().optional(),
  title: shortText(250),
  contract_type: z.enum(CONTRACT_TYPES),
  origin: z.enum(['our_template', 'client_paper', 'negotiated']).default('our_template'),
  template_id: uuid.nullable().optional(),
  template_version_id: uuid.nullable().optional(),
  variable_values: z.record(z.unknown()).default({}),
  source_proposal_version_id: uuid.nullable().optional(),
  currency: currencyCode.nullable().optional(),
  contract_value: moneyAmount.nullable().optional(),
  effective_date: isoDate.nullable().optional(),
  expiry_date: isoDate.nullable().optional(),
  auto_renews: z.boolean().default(false),
  renewal_notice_days: z.number().int().positive().nullable().optional(),
  owner_user_id: uuid.nullable().optional(),
  notes: nullableText(),
});

export const signerSchema = z.object({
  party: z.enum(['internal', 'counterparty', 'witness']),
  contact_id: uuid.nullable().optional(),
  user_id: uuid.nullable().optional(),
  name: shortText(200),
  email: z.string().email(),
  role_label: nullableText(120),
  signing_order: z.number().int().min(1).default(1),
});

export const CONTRACT_SORT_COLUMNS = [
  'created_at', 'updated_at', 'title', 'status', 'contract_type', 'expiry_date',
] as const;

export const contractListSchema = listQuery(CONTRACT_SORT_COLUMNS, 'updated_at', {
  company_id: uuid.optional(),
  opportunity_id: uuid.optional(),
  status: z.string().optional(),
  contract_type: z.enum(CONTRACT_TYPES).optional(),
  awaiting_signature: z.enum(['true', 'false']).optional(),
});

export type ContractCreate = z.infer<typeof contractCreateSchema>;

export async function listContracts(
  tx: Tx,
  ctx: RequestContext,
  query: z.infer<typeof contractListSchema>,
) {
  const f = filters('ct.deleted_at is null');
  if (query.q) {
    const p = likePattern(query.q);
    f.where('(ct.title ilike ? or ct.reference ilike ? or c.name ilike ?)', p, p, p);
  }
  f.whereIf(query.company_id, 'ct.company_id = ?');
  f.whereIf(query.opportunity_id, 'ct.opportunity_id = ?');
  f.whereIf(query.status, 'ct.status = ?');
  f.whereIf(query.contract_type, 'ct.contract_type = ?');
  if (query.awaiting_signature === 'true') {
    f.where('ct.status = any (?)', ['sent', 'viewed', 'partially_signed']);
  }

  const totalRow = await tx.one<{ count: string }>(
    `select count(*)::text as count from contracts ct
     join companies c on c.id = ct.company_id where ${f.sql}`,
    f.params,
  );

  const order = safeOrderBy(query.sort, query.direction, CONTRACT_SORT_COLUMNS, 'updated_at');
  const limit = f.bind(query.page_size);
  const offset = f.bind((query.page - 1) * query.page_size);

  const rows = await tx.many<Record<string, unknown>>(
    `select ct.*, c.name as company_name, o.reference as opportunity_reference,
            approver.full_name as approved_by_name, sender.full_name as sent_by_name,
            (select count(*) from contract_signers s where s.contract_id = ct.id) as signer_count,
            (select count(*) from contract_signers s where s.contract_id = ct.id and s.status = 'signed') as signed_count
     from contracts ct
     join companies c on c.id = ct.company_id
     left join opportunities o on o.id = ct.opportunity_id
     left join user_profiles approver on approver.id = ct.approved_by
     left join user_profiles sender on sender.id = ct.sent_by
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

export interface ContractDetail extends Record<string, unknown> {
  id: string;
  reference: string;
  title: string;
  status: string;
  contract_type: string;
  company_id: string;
  company_name: string;
  origin: string;
  signers: Record<string, unknown>[];
  signature_requests: Record<string, unknown>[];
  amendments: Record<string, unknown>[];
}

export async function getContract(
  tx: Tx,
  ctx: RequestContext,
  id: string,
): Promise<ContractDetail> {
  const contract = await tx.maybeOne<Record<string, unknown>>(
    `select ct.*, c.name as company_name, le.name as legal_entity_name,
            o.reference as opportunity_reference,
            approver.full_name as approved_by_name, sender.full_name as sent_by_name,
            parent.reference as parent_contract_reference
     from contracts ct
     join companies c on c.id = ct.company_id
     left join companies le on le.id = ct.legal_entity_id
     left join opportunities o on o.id = ct.opportunity_id
     left join contracts parent on parent.id = ct.parent_contract_id
     left join user_profiles approver on approver.id = ct.approved_by
     left join user_profiles sender on sender.id = ct.sent_by
     where ct.id = $1 and ct.deleted_at is null`,
    [id],
  );
  if (!contract) throw new AppError('NOT_FOUND', 'This contract was not found.');

  const [signers, signatureRequests, amendments] = await Promise.all([
    tx.many(`select * from contract_signers where contract_id = $1 order by signing_order, party`, [id]),
    tx.many(
      `select sr.*, (select count(*) from signature_events e where e.signature_request_id = sr.id) as event_count
       from signature_requests sr where sr.contract_id = $1 order by sr.created_at desc`,
      [id],
    ),
    tx.many(
      `select id, reference, title, contract_type, status, created_at
       from contracts where parent_contract_id = $1 and deleted_at is null order by created_at`,
      [id],
    ),
  ]);

  return {
    ...redactSensitiveFields(contract, ctx.permissions),
    signers,
    signature_requests: signatureRequests,
    amendments,
  } as ContractDetail;
}

/**
 * Creates a contract, rendering it from a template version if one is given.
 *
 * When generated from an opportunity, the *accepted proposal version* is the
 * source: its frozen totals and currency become the contract's, regardless of
 * what the opportunity says now.
 */
export async function createContract(tx: Tx, ctx: RequestContext, input: ContractCreate) {
  ctx.permissions.requireAny('contract', 'create');

  if (input.contract_type === 'addendum' || input.contract_type === 'amendment') {
    if (!input.parent_contract_id) {
      throw new AppError(
        'VALIDATION_ERROR',
        'An amendment or addendum must reference the contract it modifies.',
        { details: { field: 'parent_contract_id' } },
      );
    }
    const parent = await tx.maybeOne<{ id: string; status: string }>(
      `select id, status from contracts where id = $1 and deleted_at is null`,
      [input.parent_contract_id],
    );
    if (!parent) throw new AppError('NOT_FOUND', 'The parent contract was not found.');
    if (parent.status !== 'fully_executed') {
      throw new AppError(
        'INVALID_STATE',
        'Only a fully executed contract can be amended. Edit the original instead.',
        { details: { parent_status: parent.status } },
      );
    }
  }

  let currency = input.currency ?? null;
  let contractValue = input.contract_value ?? null;
  let sourceVersionId = input.source_proposal_version_id ?? null;

  // Derive commercials from the accepted proposal version, never from the
  // opportunity's current state.
  if (input.opportunity_id && !sourceVersionId) {
    const opportunity = await tx.maybeOne<{ accepted_proposal_version_id: string | null }>(
      `select accepted_proposal_version_id from opportunities where id = $1 and deleted_at is null`,
      [input.opportunity_id],
    );
    sourceVersionId = opportunity?.accepted_proposal_version_id ?? null;
  }

  if (sourceVersionId) {
    const version = await tx.maybeOne<{ total: string; currency: string; status: string }>(
      `select total, currency, status from proposal_versions where id = $1`,
      [sourceVersionId],
    );
    if (!version) throw new AppError('NOT_FOUND', 'The source proposal version was not found.');
    if (version.status !== 'accepted') {
      throw new AppError(
        'PROPOSAL_NOT_ACCEPTED',
        'An agreement can only be generated from an accepted proposal version.',
        { details: { version_status: version.status } },
      );
    }
    currency ??= version.currency;
    contractValue ??= version.total;
  }

  const reference = await nextReference(
    tx,
    ctx.org.id,
    `contract_${input.contract_type}`,
    input.contract_type.toUpperCase(),
  );

  const fxRate = currency ? await resolveFxRate(tx, ctx.org.id, currency, ctx.org.baseCurrency) : null;

  const contract = await tx.one<{ id: string; reference: string }>(
    `insert into contracts (
       org_id, company_id, legal_entity_id, opportunity_id, project_id, parent_contract_id,
       reference, title, contract_type, origin, template_version_id, variable_values,
       source_proposal_version_id, currency, contract_value, fx_rate_to_base,
       effective_date, expiry_date, auto_renews, renewal_notice_days,
       owner_user_id, notes, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     returning id, reference`,
    [
      ctx.org.id, input.company_id, input.legal_entity_id ?? null, input.opportunity_id ?? null,
      input.project_id ?? null, input.parent_contract_id ?? null, reference, input.title,
      input.contract_type, input.origin, input.template_version_id ?? null,
      JSON.stringify(input.variable_values), sourceVersionId, currency, contractValue, fxRate,
      input.effective_date ?? null, input.expiry_date ?? null, input.auto_renews,
      input.renewal_notice_days ?? null, input.owner_user_id ?? ctx.user.id,
      input.notes ?? null, ctx.user.id,
    ],
  );

  const event = await emitEvent(tx, {
    name: 'contract.created',
    entityType: 'contract',
    entityId: contract.id,
    payload: {
      reference: contract.reference,
      contract_type: input.contract_type,
      company_id: input.company_id,
      source_proposal_version_id: sourceVersionId,
    },
  });

  await recordActivity(tx, {
    entityType: 'contract',
    entityId: contract.id,
    companyId: input.company_id,
    activityType: 'contract',
    title: `${input.contract_type.toUpperCase()} ${contract.reference} drafted`,
    eventId: event.id,
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'contract.created',
    category: 'contract',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'contract',
    entityId: contract.id,
    summary: `Drafted ${input.contract_type.toUpperCase()} ${contract.reference}`,
    metadata: { source_proposal_version_id: sourceVersionId, origin: input.origin },
    requestId: ctx.requestId,
  });

  return contract;
}

/**
 * Renders the contract body from its template and stores the result as the
 * draft document. A missing required variable fails here, before anything is
 * shown to a client.
 */
export async function renderContractDocument(
  tx: Tx,
  ctx: RequestContext,
  contractId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ documentId: string; body: string }> {
  const contract = await tx.maybeOne<{
    id: string; reference: string; title: string; company_id: string;
    template_version_id: string | null; variable_values: Record<string, unknown>;
    status: string; is_immutable?: boolean;
  }>(
    `select id, reference, title, company_id, template_version_id, variable_values, status
     from contracts where id = $1 and deleted_at is null for update`,
    [contractId],
  );
  if (!contract) throw new AppError('NOT_FOUND', 'This contract was not found.');

  if (contract.status !== 'draft' && contract.status !== 'internal_review') {
    throw new AppError(
      'INVALID_STATE',
      'Only a draft or in-review contract can be re-rendered.',
      { details: { status: contract.status } },
    );
  }

  if (!contract.template_version_id) {
    throw new AppError(
      'VALIDATION_ERROR',
      'This contract has no template. Attach a template version or upload client paper instead.',
    );
  }

  const templateVersion = await tx.one<{ body: string; variables: TemplateVariable[]; status: string }>(
    `select body, variables, status from contract_template_versions where id = $1`,
    [contract.template_version_id],
  );

  const values = { ...contract.variable_values, ...overrides };
  const variables = normaliseVariables(templateVersion.variables);

  // Fails loudly on a missing required value rather than producing a document
  // with a hole in it.
  const rendered = renderTemplate(templateVersion.body, variables, values);

  const html = wrapAsDocument(contract.title, rendered.body);

  const uploaded = await uploadDocument(tx, ctx, {
    document: {
      name: `${contract.reference} — ${contract.title}.html`,
      description: 'Generated contract draft',
      category: 'contract',
      company_id: contract.company_id,
      contract_id: contract.id,
      opportunity_id: null,
      project_id: null,
      proposal_version_id: null,
      is_client_visible: false,
      is_confidential: true,
      tags: ['generated', 'contract-draft'],
    },
    file: {
      name: `${contract.reference}.html`,
      mimeType: 'text/plain',
      body: Buffer.from(html, 'utf8'),
    },
    source: 'generated',
  });

  await tx.query(
    `update contracts set draft_document_id = $2, variable_values = $3 where id = $1`,
    [contractId, uploaded.documentId, JSON.stringify(rendered.used)],
  );

  return { documentId: uploaded.documentId, body: rendered.body };
}

export interface ContractReadiness {
  ready: boolean;
  missing: Array<{ key: string; label: string; source_hint: string | null }>;
  reason: 'no_template' | 'missing_variables' | null;
}

/** What a person still needs to supply before this contract can be produced. */
export async function contractReadiness(
  tx: Tx,
  contractId: string,
): Promise<ContractReadiness> {
  const contract = await tx.one<{
    template_version_id: string | null;
    variable_values: Record<string, unknown>;
    draft_document_id: string | null;
  }>(
    `select template_version_id, variable_values, draft_document_id
     from contracts where id = $1`,
    [contractId],
  );

  if (!contract.template_version_id) {
    return { ready: false, missing: [], reason: 'no_template' as const };
  }

  const version = await tx.one<{ variables: TemplateVariable[] }>(
    `select variables from contract_template_versions where id = $1`,
    [contract.template_version_id],
  );

  const missing = missingRequired(
    normaliseVariables(version.variables),
    contract.variable_values ?? {},
  );

  return {
    ready: missing.length === 0 && Boolean(contract.draft_document_id),
    missing: missing.map((v) => ({
      key: v.key,
      label: v.label,
      source_hint: v.source_hint ?? null,
    })),
    reason: missing.length > 0 ? 'missing_variables' : null,
  };
}

export async function setSigners(
  tx: Tx,
  ctx: RequestContext,
  contractId: string,
  signers: z.infer<typeof signerSchema>[],
) {
  const contract = await tx.maybeOne<{ status: string }>(
    `select status from contracts where id = $1 and deleted_at is null`,
    [contractId],
  );
  if (!contract) throw new AppError('NOT_FOUND', 'This contract was not found.');
  if (['sent', 'viewed', 'partially_signed', 'fully_executed'].includes(contract.status)) {
    throw new AppError(
      'INVALID_STATE',
      'Signers cannot be changed once a contract has been sent. Void it and start again.',
      { details: { status: contract.status } },
    );
  }

  const hasInternal = signers.some((s) => s.party === 'internal');
  const hasCounterparty = signers.some((s) => s.party === 'counterparty');
  if (!hasInternal || !hasCounterparty) {
    throw new AppError(
      'VALIDATION_ERROR',
      'A contract needs at least one signer from each side.',
      { details: { internal: hasInternal, counterparty: hasCounterparty } },
    );
  }

  await tx.query(`delete from contract_signers where contract_id = $1`, [contractId]);
  for (const signer of signers) {
    await tx.query(
      `insert into contract_signers (
         org_id, contract_id, party, contact_id, user_id, name, email, role_label, signing_order
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        ctx.org.id, contractId, signer.party, signer.contact_id ?? null,
        signer.user_id ?? null, signer.name, signer.email.toLowerCase(),
        signer.role_label ?? null, signer.signing_order,
      ],
    );
  }

  return { contractId, signerCount: signers.length };
}

export async function submitForLegalReview(tx: Tx, ctx: RequestContext, contractId: string) {
  const result = await performTransition(
    tx,
    contractMachine,
    contractId,
    { to: 'internal_review', payload: {} },
    { userId: ctx.user.id },
  );

  await tx.query(
    `update contracts set submitted_for_review_at = now(), submitted_by = $2 where id = $1`,
    [contractId, ctx.user.id],
  );

  await emitEvent(tx, {
    name: 'contract.submitted_for_review',
    entityType: 'contract',
    entityId: contractId,
    payload: { reference: result.entity.reference },
  });

  const reviewers = await tx.many<{ user_id: string }>(
    `select distinct ur.user_id from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     join permissions p on p.id = rp.permission_id
     where ur.org_id = $1 and p.key = 'contract:approve:org'`,
    [ctx.org.id],
  );
  for (const reviewer of reviewers) {
    if (reviewer.user_id === ctx.user.id) continue;
    await notify(tx, {
      userId: reviewer.user_id,
      category: 'approval',
      title: 'Contract awaiting legal review',
      body: String(result.entity.reference),
      entityType: 'contract',
      entityId: contractId,
      linkUrl: `/legal/contracts/${contractId}`,
      priority: 'high',
      dedupeKey: `contract-review:${contractId}`,
    });
  }

  return result;
}

/**
 * Legal approval. Requires `contract:approve:org` — checked here, and again by a
 * database trigger that also verifies an approver was recorded.
 */
export async function approveContract(
  tx: Tx,
  ctx: RequestContext,
  contractId: string,
  note: string | null,
) {
  ctx.permissions.require(
    'contract:approve:org',
    'Approving a contract for sending requires legal approval authority.',
  );

  const readiness = await contractReadiness(tx, contractId);
  if (!readiness.ready && readiness.reason === 'missing_variables') {
    throw new AppError(
      'MISSING_TEMPLATE_VARIABLE',
      'This contract still has unfilled required values.',
      { details: { missing: readiness.missing } },
    );
  }

  const result = await performTransition(
    tx,
    contractMachine,
    contractId,
    { to: 'approved_to_send', payload: {} },
    { userId: ctx.user.id },
  );

  await emitEvent(tx, {
    name: 'contract.approved_to_send',
    entityType: 'contract',
    entityId: contractId,
    payload: { reference: result.entity.reference, approved_by: ctx.user.id },
  });

  await recordActivity(tx, {
    entityType: 'contract',
    entityId: contractId,
    companyId: String(result.entity.company_id),
    activityType: 'contract',
    title: `Contract ${result.entity.reference} approved for sending`,
    body: note,
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'contract.approved_to_send',
    category: 'contract',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'contract',
    entityId: contractId,
    summary: `Approved ${result.entity.reference} for sending`,
    metadata: { note },
    requestId: ctx.requestId,
  });

  return result;
}

export async function voidContract(
  tx: Tx,
  ctx: RequestContext,
  contractId: string,
  reason: string,
) {
  ctx.permissions.require('contract:void:org');
  meaningfulReason.parse(reason);

  const result = await performTransition(
    tx,
    contractMachine,
    contractId,
    { to: 'voided', reason, payload: {} },
    { userId: ctx.user.id },
  );

  await emitEvent(tx, {
    name: 'contract.voided',
    entityType: 'contract',
    entityId: contractId,
    payload: { reference: result.entity.reference, reason },
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'contract.voided',
    category: 'contract',
    severity: 'warning',
    actorUserId: ctx.user.id,
    entityType: 'contract',
    entityId: contractId,
    summary: `Voided contract ${result.entity.reference}`,
    reason,
    requestId: ctx.requestId,
  });

  return result;
}

// -----------------------------------------------------------------------------

function normaliseVariables(raw: unknown): TemplateVariable[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((v) => {
    const item = v as Partial<TemplateVariable>;
    return {
      key: String(item.key ?? ''),
      label: String(item.label ?? item.key ?? ''),
      type: (item.type ?? 'string') as TemplateVariable['type'],
      required: item.required !== false,
      description: item.description,
      source_hint: item.source_hint,
    };
  });
}

/** Minimal, dependency-free document wrapper. Escaped, never interpolated raw. */
function wrapAsDocument(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>body{font-family:Georgia,serif;line-height:1.6;max-width:46rem;margin:3rem auto;padding:0 1.5rem;color:#111}h1{font-size:1.5rem}pre{white-space:pre-wrap;font-family:inherit}</style>',
    '</head><body>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<pre>${escapeHtml(body)}</pre>`,
    '</body></html>',
  ].join('\n');
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
