/**
 * Proposal service.
 *
 * Two rules shape everything here:
 *
 *   1. A version is immutable once accepted. The client accepted a specific
 *      document and that document must remain reproducible.
 *   2. The accepted version — not the live opportunity — is the source of truth
 *      for the agreement generated afterwards.
 *
 * Concurrent editing uses optimistic concurrency on `revision`. A caller must
 * present the revision it read; a mismatch is a 409 carrying both versions so
 * the UI can show a conflict rather than silently overwriting a colleague.
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
import { proposalMachine, proposalVersionMachine } from '@/lib/workflows/machines';
import { nextReference, resolveFxRate } from './opportunities';
import { getSolution } from './solutions';
import {
  uuid, shortText, nullableText, currencyCode, meaningfulReason,
  listQuery, safeOrderBy, paginationMeta,
} from '@/lib/validation/common';

export const proposalSectionSchema = z.object({
  id: z.string().max(64),
  type: z.enum(['heading', 'text', 'bullets', 'pricing_table', 'timeline', 'terms', 'signature']),
  heading: z.string().max(300).nullable().optional(),
  body: z.string().max(50_000).nullable().optional(),
  items: z.array(z.string().max(2000)).max(100).optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const proposalCreateSchema = z.object({
  opportunity_id: uuid,
  title: shortText(250),
  solution_id: uuid.nullable().optional(),
  currency: currencyCode.optional(),
  executive_summary: nullableText(),
  sections: z.array(proposalSectionSchema).default([]),
  payment_terms: nullableText(2000),
  validity_days: z.number().int().positive().max(365).default(30),
  terms: z.record(z.unknown()).default({}),
  owner_user_id: uuid.nullable().optional(),
  team_id: uuid.nullable().optional(),
});

export const versionUpdateSchema = z.object({
  /** The revision the client last read. Required: silent overwrites are the bug. */
  revision: z.number().int().min(1),
  title: shortText(250).optional(),
  executive_summary: nullableText().optional(),
  sections: z.array(proposalSectionSchema).optional(),
  payment_terms: nullableText(2000).optional(),
  validity_days: z.number().int().positive().max(365).optional(),
  terms: z.record(z.unknown()).optional(),
  solution_id: uuid.nullable().optional(),
});

export const acceptanceSchema = z.object({
  accepted_by_contact_id: uuid.nullable().optional(),
  note: nullableText(2000),
  accepted_at: z.string().datetime({ offset: true }).optional(),
});

export const PROPOSAL_SORT_COLUMNS = ['created_at', 'updated_at', 'title', 'status'] as const;

export const proposalListSchema = listQuery(PROPOSAL_SORT_COLUMNS, 'updated_at', {
  opportunity_id: uuid.optional(),
  company_id: uuid.optional(),
  status: z.string().optional(),
});

export type ProposalCreate = z.infer<typeof proposalCreateSchema>;

export async function listProposals(
  tx: Tx,
  ctx: RequestContext,
  query: z.infer<typeof proposalListSchema>,
) {
  const f = filters('p.deleted_at is null');
  if (query.q) {
    const pat = likePattern(query.q);
    f.where('(p.title ilike ? or p.reference ilike ? or c.name ilike ?)', pat, pat, pat);
  }
  f.whereIf(query.opportunity_id, 'p.opportunity_id = ?');
  f.whereIf(query.company_id, 'p.company_id = ?');
  f.whereIf(query.status, 'p.status = ?');

  const totalRow = await tx.one<{ count: string }>(
    `select count(*)::text as count from proposals p join companies c on c.id = p.company_id where ${f.sql}`,
    f.params,
  );

  const order = safeOrderBy(query.sort, query.direction, PROPOSAL_SORT_COLUMNS, 'updated_at');
  const limit = f.bind(query.page_size);
  const offset = f.bind((query.page - 1) * query.page_size);

  const rows = await tx.many<Record<string, unknown>>(
    `select p.*, c.name as company_name, o.name as opportunity_name, o.reference as opportunity_reference,
            v.version_no as current_version_no, v.total as current_total, v.valid_until,
            owner.full_name as owner_name,
            (select count(*) from proposal_versions pv where pv.proposal_id = p.id) as version_count
     from proposals p
     join companies c on c.id = p.company_id
     join opportunities o on o.id = p.opportunity_id
     left join proposal_versions v on v.id = p.current_version_id
     left join user_profiles owner on owner.id = p.owner_user_id
     where ${f.sql}
     order by p.${order}
     limit ${limit} offset ${offset}`,
    f.params,
  );

  return {
    rows: redactMany(rows, ctx.permissions),
    pagination: paginationMeta(query.page, query.page_size, Number.parseInt(totalRow.count, 10)),
  };
}

export interface ProposalDetail extends Record<string, unknown> {
  id: string;
  reference: string;
  status: string;
  currency: string;
  versions: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
}

export async function getProposal(
  tx: Tx,
  ctx: RequestContext,
  id: string,
): Promise<ProposalDetail> {
  const proposal = await tx.maybeOne<Record<string, unknown>>(
    `select p.*, c.name as company_name, o.name as opportunity_name, o.reference as opportunity_reference
     from proposals p
     join companies c on c.id = p.company_id
     join opportunities o on o.id = p.opportunity_id
     where p.id = $1 and p.deleted_at is null`,
    [id],
  );
  if (!proposal) throw new AppError('NOT_FOUND', 'This proposal was not found.');

  const versions = await tx.many<Record<string, unknown>>(
    `select v.*, creator.full_name as created_by_name, approver.full_name as approved_by_name
     from proposal_versions v
     left join user_profiles creator on creator.id = v.created_by
     left join user_profiles approver on approver.id = v.approved_by
     where v.proposal_id = $1 order by v.version_no desc`,
    [id],
  );

  const approvals = await tx.many(
    `select a.*, u.full_name as reviewer_name from proposal_approvals a
     join user_profiles u on u.id = a.reviewer_id
     where a.version_id = any (
       select id from proposal_versions where proposal_id = $1
     ) order by a.decided_at desc`,
    [id],
  );

  return {
    ...redactSensitiveFields(proposal, ctx.permissions),
    versions: versions.map((v) => redactSensitiveFields(v, ctx.permissions)),
    approvals,
  } as ProposalDetail;
}

export async function createProposal(tx: Tx, ctx: RequestContext, input: ProposalCreate) {
  const opportunity = await tx.maybeOne<{
    id: string; company_id: string; currency: string; owner_user_id: string | null; team_id: string | null;
  }>(
    `select id, company_id, currency, owner_user_id, team_id from opportunities
     where id = $1 and deleted_at is null`,
    [input.opportunity_id],
  );
  if (!opportunity) throw new AppError('NOT_FOUND', 'This opportunity was not found.');

  const currency = input.currency ?? opportunity.currency;
  const reference = await nextReference(tx, ctx.org.id, 'proposal', 'PRO');

  const proposal = await tx.one<{ id: string; reference: string }>(
    `insert into proposals (org_id, opportunity_id, company_id, reference, title, currency,
                            owner_user_id, team_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id, reference`,
    [
      ctx.org.id, input.opportunity_id, opportunity.company_id, reference, input.title,
      currency, input.owner_user_id ?? opportunity.owner_user_id ?? ctx.user.id,
      input.team_id ?? opportunity.team_id, ctx.user.id,
    ],
  );

  const version = await createVersion(tx, ctx, proposal.id, {
    title: input.title,
    executive_summary: input.executive_summary ?? null,
    sections: input.sections,
    solution_id: input.solution_id ?? null,
    payment_terms: input.payment_terms ?? null,
    validity_days: input.validity_days,
    terms: input.terms,
    currency,
  });

  await tx.query(`update proposals set current_version_id = $2 where id = $1`, [
    proposal.id,
    version.id,
  ]);

  const event = await emitEvent(tx, {
    name: 'proposal.created',
    entityType: 'proposal',
    entityId: proposal.id,
    payload: { reference: proposal.reference, opportunity_id: input.opportunity_id, currency },
  });

  await recordActivity(tx, {
    entityType: 'proposal',
    entityId: proposal.id,
    companyId: opportunity.company_id,
    activityType: 'proposal',
    title: `Proposal ${proposal.reference} created`,
    eventId: event.id,
  });

  return getProposal(tx, ctx, proposal.id);
}

interface VersionContent {
  title: string;
  executive_summary: string | null;
  sections: unknown[];
  solution_id: string | null;
  payment_terms: string | null;
  validity_days: number;
  terms: Record<string, unknown>;
  currency: string;
}

/**
 * Creates a new version, snapshotting the priced solution into it.
 *
 * The snapshot is the mechanism that makes an accepted proposal reproducible:
 * whatever happens to the solution afterwards, the version still holds the
 * numbers the client saw.
 */
async function createVersion(
  tx: Tx,
  ctx: RequestContext,
  proposalId: string,
  content: VersionContent,
) {
  const last = await tx.maybeOne<{ version_no: number }>(
    `select version_no from proposal_versions where proposal_id = $1
     order by version_no desc limit 1`,
    [proposalId],
  );
  const versionNo = (last?.version_no ?? 0) + 1;

  let snapshot: Record<string, unknown> = {};
  let subtotal = '0';
  let discountTotal = '0';
  let taxTotal = '0';
  let total = '0';

  if (content.solution_id) {
    const solution = await getSolution(tx, ctx, content.solution_id);
    snapshot = solution as unknown as Record<string, unknown>;
    subtotal = String(solution.subtotal ?? '0');
    discountTotal = String(solution.discount_total ?? '0');
    taxTotal = String(solution.tax_total ?? '0');
    total = String(solution.total ?? '0');
    await tx.query(`update solutions set status = 'used' where id = $1`, [content.solution_id]);
  }

  const fxRate = await resolveFxRate(tx, ctx.org.id, content.currency, ctx.org.baseCurrency);

  return tx.one<{ id: string; version_no: number }>(
    `insert into proposal_versions (
       org_id, proposal_id, version_no, title, executive_summary, sections,
       solution_id, solution_snapshot, currency, subtotal, discount_total, tax_total, total,
       fx_rate_to_base, payment_terms, validity_days, valid_until, terms, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               -- $16 is an integer here and would otherwise be inferred as text
               -- by the interval expression, so the cast is explicit.
               current_date + make_interval(days => $16::int), $17, $18)
     returning id, version_no`,
    [
      ctx.org.id, proposalId, versionNo, content.title, content.executive_summary,
      JSON.stringify(content.sections), content.solution_id,
      JSON.stringify(snapshot), content.currency,
      subtotal, discountTotal, taxTotal, total, fxRate,
      content.payment_terms, content.validity_days,
      JSON.stringify(content.terms), ctx.user.id,
    ],
  );
}

/** Cuts a new draft version from the current one. */
export async function createNewVersion(tx: Tx, ctx: RequestContext, proposalId: string) {
  const proposal = await tx.maybeOne<{ id: string; current_version_id: string | null; currency: string }>(
    `select id, current_version_id, currency from proposals where id = $1 and deleted_at is null for update`,
    [proposalId],
  );
  if (!proposal) throw new AppError('NOT_FOUND', 'This proposal was not found.');

  const current = proposal.current_version_id
    ? await tx.one<Record<string, unknown>>(
        `select * from proposal_versions where id = $1`,
        [proposal.current_version_id],
      )
    : null;

  const version = await createVersion(tx, ctx, proposalId, {
    title: String(current?.title ?? 'Proposal'),
    executive_summary: (current?.executive_summary as string) ?? null,
    sections: (current?.sections as unknown[]) ?? [],
    solution_id: (current?.solution_id as string) ?? null,
    payment_terms: (current?.payment_terms as string) ?? null,
    validity_days: Number(current?.validity_days ?? 30),
    terms: (current?.terms as Record<string, unknown>) ?? {},
    currency: proposal.currency,
  });

  if (current && current.status !== 'accepted') {
    await tx.enterTransition();
    await tx.query(`update proposal_versions set status = 'superseded' where id = $1`, [
      current.id,
    ]);
  }

  await tx.query(`update proposals set current_version_id = $2 where id = $1`, [
    proposalId,
    version.id,
  ]);

  await emitEvent(tx, {
    name: 'proposal.version_created',
    entityType: 'proposal',
    entityId: proposalId,
    payload: { version_id: version.id, version_no: version.version_no },
  });

  return version;
}

/**
 * Edits a draft version under optimistic concurrency.
 */
export async function updateVersion(
  tx: Tx,
  ctx: RequestContext,
  versionId: string,
  input: z.infer<typeof versionUpdateSchema>,
) {
  const current = await tx.maybeOne<{
    id: string; proposal_id: string; revision: string | number; status: string;
    version_no: number; updated_at: string; created_by: string | null;
  }>(
    `select id, proposal_id, revision, status, version_no, updated_at, created_by
     from proposal_versions where id = $1 for update`,
    [versionId],
  );
  if (!current) throw new AppError('NOT_FOUND', 'This proposal version was not found.');

  if (current.status === 'accepted') {
    throw new AppError(
      'PROPOSAL_VERSION_IMMUTABLE',
      'This version has been accepted by the client and cannot be edited. Create a new version instead.',
    );
  }
  if (current.status === 'sent') {
    throw new AppError(
      'INVALID_STATE',
      'This version has been sent. Create a new version to make changes.',
    );
  }

  const currentRevision = Number(current.revision);
  if (input.revision !== currentRevision) {
    // Hand back everything the UI needs to render a conflict rather than a
    // bare error: who changed it, when, and what the current content is.
    const latest = await tx.one<Record<string, unknown>>(
      `select v.*, u.full_name as last_editor_name
       from proposal_versions v
       left join user_profiles u on u.id = v.created_by
       where v.id = $1`,
      [versionId],
    );
    throw new AppError(
      'PROPOSAL_VERSION_CONFLICT',
      'This proposal was changed by someone else while you were editing.',
      {
        details: {
          your_revision: input.revision,
          current_revision: currentRevision,
          updated_at: current.updated_at,
          current: redactSensitiveFields(latest, ctx.permissions),
        },
      },
    );
  }

  const { revision: _revision, sections, terms, ...rest } = input;
  const updates: Record<string, unknown> = { ...rest };
  if (sections !== undefined) updates.sections = JSON.stringify(sections);
  if (terms !== undefined) updates.terms = JSON.stringify(terms);

  const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return current;

  const assignments = entries.map(([k], i) => `${quote(k)} = $${i + 3}`).join(', ');

  // The revision is advanced explicitly and the WHERE clause re-checks it, so
  // two concurrent writers cannot both succeed even if they pass the read above.
  const updated = await tx.maybeOne<Record<string, unknown>>(
    `update proposal_versions
     set ${assignments}, revision = revision + 1
     where id = $1 and revision = $2
     returning *`,
    [versionId, currentRevision, ...entries.map(([, v]) => v)],
  );

  if (!updated) {
    throw new AppError(
      'PROPOSAL_VERSION_CONFLICT',
      'This proposal was changed by someone else while you were editing.',
      { details: { your_revision: input.revision } },
    );
  }

  return updated;
}

export async function submitForReview(tx: Tx, ctx: RequestContext, versionId: string) {
  const version = await tx.one<{ proposal_id: string; version_no: number }>(
    `select proposal_id, version_no from proposal_versions where id = $1`,
    [versionId],
  );

  await performTransition(
    tx,
    proposalVersionMachine,
    versionId,
    { to: 'internal_review', payload: {} },
    { userId: ctx.user.id },
  );
  await tx.query(
    `update proposal_versions set submitted_for_review_at = now(), submitted_by = $2 where id = $1`,
    [versionId, ctx.user.id],
  );

  const proposal = await tx.one<{ status: string; reference: string }>(
    `select status, reference from proposals where id = $1`,
    [version.proposal_id],
  );
  if (proposal.status === 'draft') {
    await performTransition(
      tx,
      proposalMachine,
      version.proposal_id,
      { to: 'internal_review', payload: {} },
      { userId: ctx.user.id },
    );
  }

  await emitEvent(tx, {
    name: 'proposal.submitted_for_review',
    entityType: 'proposal',
    entityId: version.proposal_id,
    payload: { version_id: versionId, version_no: version.version_no },
  });

  // Everyone who can approve gets told there is something waiting.
  const approvers = await tx.many<{ user_id: string }>(
    `select distinct ur.user_id from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     join permissions p on p.id = rp.permission_id
     where ur.org_id = $1 and p.key = 'proposal:approve:org'`,
    [ctx.org.id],
  );
  for (const approver of approvers) {
    if (approver.user_id === ctx.user.id) continue;
    await notify(tx, {
      userId: approver.user_id,
      category: 'approval',
      title: 'Proposal awaiting your review',
      body: `${proposal.reference} v${version.version_no}`,
      entityType: 'proposal',
      entityId: version.proposal_id,
      linkUrl: `/pipeline/proposals/${version.proposal_id}`,
      priority: 'high',
      dedupeKey: `proposal-review:${versionId}`,
    });
  }

  return { versionId, status: 'internal_review' };
}

/**
 * Internal approval. Requires `proposal:approve:org`, checked by the API and
 * again by the RLS policy on `proposal_approvals`, which additionally forbids
 * recording an approval in someone else's name.
 */
export async function approveVersion(
  tx: Tx,
  ctx: RequestContext,
  versionId: string,
  comment: string | null,
) {
  ctx.permissions.require('proposal:approve:org');

  const version = await tx.one<{ proposal_id: string; version_no: number; status: string }>(
    `select proposal_id, version_no, status from proposal_versions where id = $1 for update`,
    [versionId],
  );

  await performTransition(
    tx,
    proposalVersionMachine,
    versionId,
    { to: 'approved', payload: {} },
    { userId: ctx.user.id },
  );
  await tx.query(
    `update proposal_versions set approved_by = $2, approved_at = now() where id = $1`,
    [versionId, ctx.user.id],
  );

  await tx.query(
    `insert into proposal_approvals (org_id, version_id, reviewer_id, decision, comment)
     values ($1,$2,$3,'approved',$4)`,
    [ctx.org.id, versionId, ctx.user.id, comment],
  );

  const proposal = await tx.one<{ status: string; reference: string; company_id: string }>(
    `select status, reference, company_id from proposals where id = $1`,
    [version.proposal_id],
  );
  if (proposal.status === 'internal_review') {
    await performTransition(
      tx,
      proposalMachine,
      version.proposal_id,
      { to: 'approved', payload: {} },
      { userId: ctx.user.id },
    );
  }

  const event = await emitEvent(tx, {
    name: 'proposal.approved',
    entityType: 'proposal',
    entityId: version.proposal_id,
    payload: { version_id: versionId, version_no: version.version_no, approved_by: ctx.user.id },
  });

  await recordActivity(tx, {
    entityType: 'proposal',
    entityId: version.proposal_id,
    companyId: proposal.company_id,
    activityType: 'proposal',
    title: `Version ${version.version_no} approved internally`,
    body: comment,
    eventId: event.id,
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'proposal.approved',
    category: 'proposal',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'proposal_version',
    entityId: versionId,
    summary: `Approved ${proposal.reference} v${version.version_no} for sending`,
    metadata: { comment },
    requestId: ctx.requestId,
  });

  return { versionId, status: 'approved' };
}

export async function rejectVersion(
  tx: Tx,
  ctx: RequestContext,
  versionId: string,
  reason: string,
) {
  ctx.permissions.require('proposal:approve:org');
  meaningfulReason.parse(reason);

  const version = await tx.one<{ proposal_id: string; version_no: number }>(
    `select proposal_id, version_no from proposal_versions where id = $1`,
    [versionId],
  );

  await performTransition(
    tx,
    proposalVersionMachine,
    versionId,
    { to: 'rejected', reason, payload: {} },
    { userId: ctx.user.id },
  );
  await tx.query(
    `update proposal_versions set rejected_by = $2, rejected_at = now(), rejection_reason = $3
     where id = $1`,
    [versionId, ctx.user.id, reason],
  );
  await tx.query(
    `insert into proposal_approvals (org_id, version_id, reviewer_id, decision, comment)
     values ($1,$2,$3,'rejected',$4)`,
    [ctx.org.id, versionId, ctx.user.id, reason],
  );

  await emitEvent(tx, {
    name: 'proposal.rejected',
    entityType: 'proposal',
    entityId: version.proposal_id,
    payload: { version_id: versionId, reason },
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'proposal.rejected',
    category: 'proposal',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'proposal_version',
    entityId: versionId,
    summary: `Rejected proposal version ${version.version_no}`,
    reason,
    requestId: ctx.requestId,
  });

  return { versionId, status: 'rejected' };
}

/**
 * Marks a version as sent. Requires an internally approved version — the same
 * rule the opportunity's `proposal_sent` guard enforces.
 */
export async function markVersionSent(
  tx: Tx,
  ctx: RequestContext,
  versionId: string,
  recipients: Array<{ contact_id?: string; email: string; name?: string }>,
) {
  ctx.permissions.require('proposal:send:org');

  const version = await tx.one<{ proposal_id: string; version_no: number; status: string; approved_at: string | null }>(
    `select proposal_id, version_no, status, approved_at from proposal_versions where id = $1 for update`,
    [versionId],
  );

  if (version.status !== 'approved') {
    throw new AppError(
      'PROPOSAL_NOT_APPROVED',
      'An internally approved proposal version is required before sending.',
      { details: { current_status: version.status } },
    );
  }

  await performTransition(
    tx,
    proposalVersionMachine,
    versionId,
    { to: 'sent', payload: {} },
    { userId: ctx.user.id },
  );
  await tx.query(
    `update proposal_versions
     set sent_at = now(), sent_by = $2, sent_to = $3,
         expires_at = now() + (validity_days || ' days')::interval
     where id = $1`,
    [versionId, ctx.user.id, JSON.stringify(recipients)],
  );

  const proposal = await tx.one<{ status: string; reference: string; company_id: string }>(
    `select status, reference, company_id from proposals where id = $1`,
    [version.proposal_id],
  );
  if (proposal.status === 'approved') {
    await performTransition(
      tx,
      proposalMachine,
      version.proposal_id,
      { to: 'sent', payload: {} },
      { userId: ctx.user.id },
    );
  }

  const event = await emitEvent(tx, {
    name: 'proposal.sent',
    entityType: 'proposal',
    entityId: version.proposal_id,
    payload: { version_id: versionId, recipients: recipients.map((r) => r.email) },
  });

  await recordActivity(tx, {
    entityType: 'proposal',
    entityId: version.proposal_id,
    companyId: proposal.company_id,
    activityType: 'proposal',
    title: `Proposal ${proposal.reference} v${version.version_no} sent`,
    body: recipients.map((r) => r.email).join(', '),
    eventId: event.id,
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'proposal.sent',
    category: 'proposal',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'proposal_version',
    entityId: versionId,
    summary: `Sent ${proposal.reference} v${version.version_no}`,
    metadata: { recipients },
    requestId: ctx.requestId,
  });

  return { versionId, status: 'sent' };
}

/**
 * Client acceptance. This is the moment the version becomes immutable and
 * becomes the source of truth for the agreement.
 */
export async function acceptVersion(
  tx: Tx,
  ctx: RequestContext,
  versionId: string,
  input: z.infer<typeof acceptanceSchema>,
) {
  const version = await tx.one<{
    proposal_id: string; version_no: number; status: string; total: string; currency: string;
  }>(
    `select proposal_id, version_no, status, total, currency
     from proposal_versions where id = $1 for update`,
    [versionId],
  );

  if (version.status !== 'sent') {
    throw new AppError(
      'INVALID_STATE',
      'Only a proposal that has been sent to the client can be accepted.',
      { details: { current_status: version.status } },
    );
  }

  // Stamp the acceptance columns first: once status flips to `accepted`, the
  // immutability trigger refuses further content writes including accepted_at.
  await tx.query(
    `update proposal_versions
     set accepted_at = coalesce($2::timestamptz, now()),
         accepted_by_contact_id = $3,
         accepted_note = $4
     where id = $1`,
    [versionId, input.accepted_at ?? null, input.accepted_by_contact_id ?? null, input.note ?? null],
  );

  await performTransition(
    tx,
    proposalVersionMachine,
    versionId,
    { to: 'accepted', payload: {} },
    { userId: ctx.user.id },
  );

  const proposal = await tx.one<{ status: string; reference: string; company_id: string; opportunity_id: string }>(
    `select status, reference, company_id, opportunity_id from proposals where id = $1`,
    [version.proposal_id],
  );

  await tx.query(`update proposals set accepted_version_id = $2 where id = $1`, [
    version.proposal_id,
    versionId,
  ]);
  await performTransition(
    tx,
    proposalMachine,
    version.proposal_id,
    { to: 'accepted', payload: {} },
    { userId: ctx.user.id },
  );

  // Every other live version is superseded, so there is exactly one accepted
  // document and no ambiguity about which one an agreement derives from.
  const others = await tx.many<{ id: string }>(
    `select id from proposal_versions
     where proposal_id = $1 and id <> $2 and status in ('draft','internal_review','approved','sent')`,
    [version.proposal_id, versionId],
  );
  await tx.enterTransition();
  for (const other of others) {
    await tx.query(`update proposal_versions set status = 'superseded' where id = $1`, [other.id]);
  }

  const event = await emitEvent(tx, {
    name: 'proposal.accepted',
    entityType: 'proposal',
    entityId: version.proposal_id,
    payload: {
      version_id: versionId,
      version_no: version.version_no,
      opportunity_id: proposal.opportunity_id,
      company_id: proposal.company_id,
      total: version.total,
      currency: version.currency,
    },
  });

  await recordActivity(tx, {
    entityType: 'proposal',
    entityId: version.proposal_id,
    companyId: proposal.company_id,
    activityType: 'proposal',
    title: `Proposal ${proposal.reference} accepted`,
    body: input.note ?? null,
    eventId: event.id,
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'proposal.accepted',
    category: 'proposal',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'proposal_version',
    entityId: versionId,
    summary: `${proposal.reference} v${version.version_no} accepted by the client`,
    after: { total: version.total, currency: version.currency },
    requestId: ctx.requestId,
  });

  return { versionId, proposalId: version.proposal_id, opportunityId: proposal.opportunity_id };
}

export async function declineVersion(
  tx: Tx,
  ctx: RequestContext,
  versionId: string,
  reason: string,
) {
  const version = await tx.one<{ proposal_id: string }>(
    `select proposal_id from proposal_versions where id = $1`,
    [versionId],
  );

  await tx.query(
    `update proposal_versions set rejected_at = now(), rejection_reason = $2 where id = $1`,
    [versionId, reason],
  );
  await performTransition(
    tx,
    proposalVersionMachine,
    versionId,
    { to: 'rejected', reason, payload: {} },
    { userId: ctx.user.id },
  );
  await performTransition(
    tx,
    proposalMachine,
    version.proposal_id,
    { to: 'rejected', reason, payload: {} },
    { userId: ctx.user.id },
  );

  await emitEvent(tx, {
    name: 'proposal.declined',
    entityType: 'proposal',
    entityId: version.proposal_id,
    payload: { version_id: versionId, reason },
  });

  return { versionId, status: 'rejected' };
}

/** Expires sent versions past their validity. Called by a scheduled job. */
export async function expireStaleVersions(tx: Tx): Promise<number> {
  const stale = await tx.many<{ id: string; proposal_id: string }>(
    `select id, proposal_id from proposal_versions
     where status = 'sent' and expires_at is not null and expires_at < now()`,
  );

  await tx.enterTransition();
  for (const version of stale) {
    await tx.query(`update proposal_versions set status = 'expired' where id = $1`, [version.id]);
    await tx.query(
      `update proposals set status = 'expired' where id = $1 and status = 'sent'`,
      [version.proposal_id],
    );
  }
  return stale.length;
}

function quote(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe column: ${name}`);
  return `"${name}"`;
}
