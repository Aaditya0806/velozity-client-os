/**
 * Onboarding and the legal gate.
 *
 * The gate is the rule that keeps delivery honest: work does not begin before
 * the paperwork is executed and the agreed money has arrived. It is evaluated
 * here for a good error message, and enforced by `app.enforce_legal_gate()` in
 * the database, which is what makes it unbypassable.
 *
 * The only way past a failing gate is an override by a holder of
 * `legal:override:org`, which demands a written reason, writes an immutable
 * record, and leaves a permanent banner on the client.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { AppError } from '@/lib/http/errors';
import { emitEvent, recordActivity, notify } from '@/lib/events';
import { writeAudit } from '@/lib/audit';
import type { RequestContext } from '@/lib/auth/session';
import { performTransition } from '@/lib/workflows/state-machine';
import { onboardingMachine } from '@/lib/workflows/machines';
import { uuid, overrideReason, nullableText, isoDate } from '@/lib/validation/common';

export interface UnmetRequirement {
  requirement_id: string;
  label: string;
  kind: 'document' | 'payment';
  contract_type: string | null;
  payment_requirement_id: string | null;
}

export const onboardingCreateSchema = z.object({
  company_id: uuid,
  opportunity_id: uuid.nullable().optional(),
  owner_user_id: uuid.nullable().optional(),
  target_kickoff_date: isoDate.nullable().optional(),
  notes: nullableText(),
});

export const overrideSchema = z.object({
  reason: overrideReason,
});

/**
 * Creates the onboarding record and materialises its requirement list from the
 * services that were sold.
 *
 * The list is materialised rather than computed on the fly so that a later edit
 * to the service catalogue cannot silently change what an in-flight onboarding
 * is blocked on.
 */
export async function createOnboarding(
  tx: Tx,
  ctx: RequestContext,
  input: z.infer<typeof onboardingCreateSchema>,
): Promise<{ onboardingId: string; requirements: number }> {
  if (input.opportunity_id) {
    const existing = await tx.maybeOne<{ id: string }>(
      `select id from onboardings where opportunity_id = $1 and deleted_at is null`,
      [input.opportunity_id],
    );
    if (existing) {
      return { onboardingId: existing.id, requirements: 0 };
    }
  }

  const onboarding = await tx.one<{ id: string }>(
    `insert into onboardings (org_id, company_id, opportunity_id, owner_user_id,
                              target_kickoff_date, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id`,
    [
      ctx.org.id, input.company_id, input.opportunity_id ?? null,
      input.owner_user_id ?? ctx.user.id, input.target_kickoff_date ?? null,
      input.notes ?? null, ctx.user.id,
    ],
  );

  const requirements = await materialiseRequirements(tx, ctx, onboarding.id, input.opportunity_id ?? null);

  await emitEvent(tx, {
    name: 'onboarding.created',
    entityType: 'onboarding',
    entityId: onboarding.id,
    payload: { company_id: input.company_id, opportunity_id: input.opportunity_id, requirements },
  });

  await recordActivity(tx, {
    entityType: 'onboarding',
    entityId: onboarding.id,
    companyId: input.company_id,
    activityType: 'created',
    title: 'Onboarding started',
    body: `${requirements} legal requirement(s) must be satisfied before delivery can begin.`,
  });

  return { onboardingId: onboarding.id, requirements };
}

/**
 * Builds the concrete requirement list.
 *
 * Sources, in order:
 *   - the required documents of every service on the accepted proposal;
 *   - an NDA, always, unless one is already executed for this client;
 *   - any payment requirement flagged as blocking.
 */
async function materialiseRequirements(
  tx: Tx,
  ctx: RequestContext,
  onboardingId: string,
  opportunityId: string | null,
): Promise<number> {
  const onboarding = await tx.one<{ company_id: string }>(
    `select company_id from onboardings where id = $1`,
    [onboardingId],
  );

  let position = 0;
  const seen = new Set<string>();

  // An NDA is always required unless the client already has one executed.
  const existingNda = await tx.maybeOne<{ id: string }>(
    `select id from contracts
     where company_id = $1 and contract_type = 'nda'
       and status = 'fully_executed' and deleted_at is null
     limit 1`,
    [onboarding.company_id],
  );

  await tx.query(
    `insert into onboarding_requirements (
       org_id, onboarding_id, requirement_kind, contract_type, label,
       is_required, blocks_onboarding, satisfied_contract_id, satisfied_at, position
     ) values ($1,$2,'document','nda','Executed non-disclosure agreement',true,true,$3,$4,$5)`,
    [ctx.org.id, onboardingId, existingNda?.id ?? null, existingNda ? new Date().toISOString() : null, position++],
  );
  seen.add('nda:Executed non-disclosure agreement');

  // Requirements declared by the services actually sold.
  if (opportunityId) {
    const serviceRequirements = await tx.many<{
      service_id: string; contract_type: string; document_label: string;
      is_required: boolean; blocks_onboarding: boolean;
    }>(
      `select distinct srd.service_id, srd.contract_type, srd.document_label,
              srd.is_required, srd.blocks_onboarding
       from opportunities o
       join proposal_versions pv on pv.id = o.accepted_proposal_version_id
       join solution_line_items li on li.solution_id = pv.solution_id
       join service_required_documents srd on srd.service_id = li.service_id
       where o.id = $1
       order by srd.contract_type`,
      [opportunityId],
    );

    for (const requirement of serviceRequirements) {
      const key = `${requirement.contract_type}:${requirement.document_label}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const satisfied = await tx.maybeOne<{ id: string }>(
        `select id from contracts
         where company_id = $1 and contract_type = $2
           and status = 'fully_executed' and deleted_at is null
         limit 1`,
        [onboarding.company_id, requirement.contract_type],
      );

      await tx.query(
        `insert into onboarding_requirements (
           org_id, onboarding_id, service_id, requirement_kind, contract_type, label,
           is_required, blocks_onboarding, satisfied_contract_id, satisfied_at, position
         ) values ($1,$2,$3,'document',$4,$5,$6,$7,$8,$9,$10)`,
        [
          ctx.org.id, onboardingId, requirement.service_id, requirement.contract_type,
          requirement.document_label, requirement.is_required, requirement.blocks_onboarding,
          satisfied?.id ?? null, satisfied ? new Date().toISOString() : null, position++,
        ],
      );
    }

    // Blocking payment requirements for this deal.
    const paymentRequirements = await tx.many<{ id: string; name: string }>(
      `select id, name from payment_requirements
       where opportunity_id = $1 and blocks_onboarding and deleted_at is null`,
      [opportunityId],
    );

    for (const requirement of paymentRequirements) {
      await tx.query(
        `insert into onboarding_requirements (
           org_id, onboarding_id, requirement_kind, label, payment_requirement_id,
           is_required, blocks_onboarding, position
         ) values ($1,$2,'payment',$3,$4,true,true,$5)`,
        [ctx.org.id, onboardingId, requirement.name, requirement.id, position++],
      );
    }
  }

  await evaluateGate(tx, onboardingId);
  return position;
}

/**
 * Evaluates the gate and refreshes the stored blocked reasons.
 *
 * Read-only with respect to the lifecycle: it never moves the onboarding. That
 * is `transitionOnboarding`'s job, and only after this returns clean.
 */
export async function evaluateGate(
  tx: Tx,
  onboardingId: string,
): Promise<{ satisfied: boolean; unmet: UnmetRequirement[]; overrideActive: boolean }> {
  // Re-link any requirement that a newly executed contract now satisfies.
  await tx.query(
    `update onboarding_requirements r
     set satisfied_contract_id = c.id, satisfied_at = coalesce(r.satisfied_at, now())
     from contracts c, onboardings o
     where r.onboarding_id = $1
       and o.id = r.onboarding_id
       and r.requirement_kind = 'document'
       and r.satisfied_contract_id is null
       and c.company_id = o.company_id
       and c.contract_type = r.contract_type
       and c.status = 'fully_executed'
       and c.deleted_at is null`,
    [onboardingId],
  );

  const row = await tx.one<{ unmet: unknown; override_active: boolean }>(
    `select app.assert_legal_gate($1, false) as unmet,
            coalesce((select legal_override_active from onboardings where id = $1), false) as override_active`,
    [onboardingId],
  );

  const unmet: UnmetRequirement[] = Array.isArray(row.unmet)
    ? (row.unmet as UnmetRequirement[])
    : JSON.parse(String(row.unmet ?? '[]'));

  await tx.query(
    `update onboardings set blocked_reasons = $2, gate_evaluated_at = now() where id = $1`,
    [onboardingId, JSON.stringify(unmet)],
  );

  return { satisfied: unmet.length === 0, unmet, overrideActive: row.override_active };
}

export async function getOnboarding(tx: Tx, _ctx: RequestContext, id: string) {
  const onboarding = await tx.maybeOne<Record<string, unknown>>(
    `select o.*, c.name as company_name, u.full_name as owner_name,
            ov.full_name as override_by_name
     from onboardings o
     join companies c on c.id = o.company_id
     left join user_profiles u on u.id = o.owner_user_id
     left join user_profiles ov on ov.id = o.legal_override_by
     where o.id = $1 and o.deleted_at is null`,
    [id],
  );
  if (!onboarding) throw new AppError('NOT_FOUND', 'This onboarding was not found.');

  const [requirements, tasks, gate] = await Promise.all([
    tx.many(
      `select r.*, c.reference as contract_reference, c.status as contract_status,
              pr.name as payment_requirement_name, pr.status as payment_status,
              app.onboarding_requirement_satisfied(r.id) as is_satisfied
       from onboarding_requirements r
       left join contracts c on c.id = r.satisfied_contract_id
       left join payment_requirements pr on pr.id = r.payment_requirement_id
       where r.onboarding_id = $1 order by r.position`,
      [id],
    ),
    tx.many(
      `select t.*, u.full_name as assignee_name from onboarding_tasks t
       left join user_profiles u on u.id = t.assignee_user_id
       where t.onboarding_id = $1 order by t.position`,
      [id],
    ),
    evaluateGate(tx, id),
  ]);

  const overrides = await tx.many(
    `select o.*, u.full_name as overridden_by_name from legal_overrides o
     join user_profiles u on u.id = o.overridden_by
     where o.onboarding_id = $1 order by o.overridden_at desc`,
    [id],
  );

  return { ...onboarding, requirements, tasks, gate, overrides };
}

/**
 * Moves the onboarding out of `blocked`.
 *
 * Both this and the database trigger evaluate the gate. The duplication is
 * intentional: this one produces a message a user can act on, the trigger makes
 * the rule true even for a code path that forgets to call this.
 */
export async function markReady(tx: Tx, ctx: RequestContext, onboardingId: string) {
  const gate = await evaluateGate(tx, onboardingId);

  if (!gate.satisfied && !gate.overrideActive) {
    throw new AppError(
      'LEGAL_GATE_BLOCKED',
      `Onboarding is blocked by ${gate.unmet.length} outstanding legal requirement(s).`,
      { details: { unmet: gate.unmet } },
    );
  }

  const result = await performTransition(
    tx,
    onboardingMachine,
    onboardingId,
    { to: 'ready', payload: {} },
    { userId: ctx.user.id },
  );

  const event = await emitEvent(tx, {
    name: 'onboarding.unblocked',
    entityType: 'onboarding',
    entityId: onboardingId,
    payload: {
      company_id: result.entity.company_id,
      opportunity_id: result.entity.opportunity_id,
      via_override: gate.overrideActive,
    },
  });

  await recordActivity(tx, {
    entityType: 'onboarding',
    entityId: onboardingId,
    companyId: String(result.entity.company_id),
    activityType: 'state_changed',
    title: gate.overrideActive
      ? 'Onboarding unblocked by legal override'
      : 'Onboarding unblocked — all legal requirements satisfied',
    eventId: event.id,
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'onboarding.unblocked',
    category: 'state_change',
    severity: gate.overrideActive ? 'warning' : 'notice',
    actorUserId: ctx.user.id,
    entityType: 'onboarding',
    entityId: onboardingId,
    summary: gate.overrideActive
      ? 'Onboarding unblocked under an active legal override'
      : 'Onboarding unblocked; legal gate satisfied',
    metadata: { via_override: gate.overrideActive },
    requestId: ctx.requestId,
  });

  return result;
}

/**
 * Forces onboarding past the legal gate.
 *
 * Requires `legal:override:org`, a written reason of at least 20 characters, and
 * produces an immutable `legal_overrides` row plus a permanent flag on the
 * onboarding. The Client 360 banner is driven by that flag and cannot be cleared.
 */
export async function overrideLegalGate(
  tx: Tx,
  ctx: RequestContext,
  onboardingId: string,
  reason: string,
) {
  ctx.permissions.require(
    'legal:override:org',
    'Forcing onboarding past the legal gate requires legal override authority.',
  );
  overrideReason.parse(reason);

  const onboarding = await tx.maybeOne<{
    id: string; company_id: string; status: string; legal_override_active: boolean;
  }>(
    `select id, company_id, status, legal_override_active
     from onboardings where id = $1 and deleted_at is null for update`,
    [onboardingId],
  );
  if (!onboarding) throw new AppError('NOT_FOUND', 'This onboarding was not found.');

  if (onboarding.legal_override_active) {
    throw new AppError('CONFLICT', 'This onboarding already has an active legal override.');
  }

  const gate = await evaluateGate(tx, onboardingId);
  if (gate.satisfied) {
    throw new AppError(
      'VALIDATION_ERROR',
      'The legal gate is already satisfied; no override is needed.',
    );
  }

  await tx.query(
    `insert into legal_overrides (
       org_id, company_id, onboarding_id, entity_type, entity_id, reason,
       unmet_requirements, overridden_by, request_id
     ) values ($1,$2,$3,'onboarding',$3,$4,$5,$6,$7)`,
    [
      ctx.org.id, onboarding.company_id, onboardingId, reason,
      JSON.stringify(gate.unmet), ctx.user.id, ctx.requestId ?? null,
    ],
  );

  await tx.query(
    `update onboardings
     set legal_override_active = true, legal_override_by = $2,
         legal_override_at = now(), legal_override_reason = $3
     where id = $1`,
    [onboardingId, ctx.user.id, reason],
  );

  const event = await emitEvent(tx, {
    name: 'onboarding.overridden',
    entityType: 'onboarding',
    entityId: onboardingId,
    payload: {
      company_id: onboarding.company_id,
      unmet: gate.unmet,
      overridden_by: ctx.user.id,
    },
  });

  await recordActivity(tx, {
    entityType: 'onboarding',
    entityId: onboardingId,
    companyId: onboarding.company_id,
    activityType: 'system',
    title: 'Legal gate overridden',
    body: reason,
    eventId: event.id,
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'onboarding.legal_override',
    category: 'legal_override',
    severity: 'critical',
    actorUserId: ctx.user.id,
    entityType: 'onboarding',
    entityId: onboardingId,
    summary: `Legal gate overridden with ${gate.unmet.length} requirement(s) outstanding`,
    reason,
    metadata: { unmet: gate.unmet },
    requestId: ctx.requestId,
  });

  // Everyone with override authority is told, because this is the kind of act
  // that should never happen unnoticed.
  const watchers = await tx.many<{ user_id: string }>(
    `select distinct ur.user_id from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     join permissions p on p.id = rp.permission_id
     where ur.org_id = $1 and p.key = 'legal:override:org' and ur.user_id <> $2`,
    [ctx.org.id, ctx.user.id],
  );
  for (const watcher of watchers) {
    await notify(tx, {
      userId: watcher.user_id,
      category: 'security',
      title: 'Legal gate overridden',
      body: `${ctx.user.fullName} unblocked onboarding with ${gate.unmet.length} requirement(s) outstanding.`,
      entityType: 'onboarding',
      entityId: onboardingId,
      linkUrl: `/clients/${onboarding.company_id}?tab=legal`,
      priority: 'urgent',
      dedupeKey: `override:${onboardingId}`,
    });
  }

  return { onboardingId, overridden: true, unmet: gate.unmet };
}

/** Standing warnings for a client, rendered as a permanent banner on Client 360. */
export async function clientLegalWarnings(tx: Tx, companyId: string) {
  return tx.many<{
    id: string; reason: string; overridden_at: string; overridden_by_name: string;
    unmet_requirements: unknown;
  }>(
    `select lo.id, lo.reason, lo.overridden_at, u.full_name as overridden_by_name,
            lo.unmet_requirements
     from legal_overrides lo
     join user_profiles u on u.id = lo.overridden_by
     where lo.company_id = $1
     order by lo.overridden_at desc`,
    [companyId],
  );
}

export async function addOnboardingTasks(
  tx: Tx,
  ctx: RequestContext,
  onboardingId: string,
  tasks: Array<{
    title: string;
    description?: string | null;
    category?: string;
    assignee_user_id?: string | null;
    due_date?: string | null;
    is_required?: boolean;
  }>,
) {
  for (const [index, task] of tasks.entries()) {
    await tx.query(
      `insert into onboarding_tasks (
         org_id, onboarding_id, title, description, category,
         assignee_user_id, due_date, is_required, position
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        ctx.org.id, onboardingId, task.title, task.description ?? null,
        task.category ?? 'general', task.assignee_user_id ?? null,
        task.due_date ?? null, task.is_required !== false, index,
      ],
    );
  }
  return { added: tasks.length };
}

/** The default checklist created for every onboarding. */
export const DEFAULT_ONBOARDING_TASKS = [
  { title: 'Confirm signed agreement is filed', category: 'legal' },
  { title: 'Raise the advance invoice', category: 'finance' },
  { title: 'Collect client brand assets and access credentials', category: 'access' },
  { title: 'Set up shared workspace and communication channel', category: 'access' },
  { title: 'Confirm delivery team and assign the project manager', category: 'delivery' },
  { title: 'Agree the reporting cadence with the client', category: 'delivery' },
  { title: 'Schedule the kickoff call', category: 'kickoff' },
] as const;
