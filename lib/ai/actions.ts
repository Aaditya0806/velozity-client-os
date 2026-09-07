/**
 * The AI action framework.
 *
 * The rule this module exists to enforce: **the model never writes to the
 * database.** The flow is
 *
 *   assemble context -> call model -> validate against a schema ->
 *   store an ai_action -> human reviews -> approve / edit / reject ->
 *   the application executes -> activity -> audit
 *
 * Every step is separately recorded. `ai_actions.status` cannot reach `executed`
 * without passing through `approved` — enforced by a database trigger, not only
 * by this code — and anything the model produced that fails schema validation is
 * rejected before it is stored at all.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { AppError } from '@/lib/http/errors';
import { emitEvent, recordActivity, notify } from '@/lib/events';
import { writeAudit } from '@/lib/audit';
import type { RequestContext } from '@/lib/auth/session';
import { PROMPT_VERSION } from './prompts';
import { sha256Hex } from '@/lib/util/ids';
import type { ModelUsage } from './client';

export const AI_ACTION_TYPES = [
  'draft_diagnosis',
  'draft_proposal_section',
  'draft_email',
  'suggest_contract_variables',
  'summarize_discovery',
  'extract_meeting_notes',
  'suggest_tasks',
  'suggest_kpis',
  'draft_client_report',
  'classify_activity',
] as const;

export type AiActionType = (typeof AI_ACTION_TYPES)[number];

// -----------------------------------------------------------------------------
// Output schemas
//
// The model's output is parsed against these before anything is stored. Anything
// outside the schema is rejected - there is no "best effort" path that saves a
// partially-understood response.
// -----------------------------------------------------------------------------

export const claimSchema = z
  .object({
    text: z.string().trim().min(1).max(2000),
    // No default. An unlabelled claim fails validation and is never persisted,
    // which is the specification's requirement made mechanical.
    type: z.enum(['client_provided', 'ai_inference', 'ai_recommendation']),
    category: z.string().max(80).optional(),
    source: z
      .object({
        kind: z.enum(['discovery_field', 'document', 'contact', 'metric', 'email', 'meeting']),
        id: z.string().max(120),
        field: z.string().max(120).optional(),
        quote: z.string().max(2000).optional(),
      })
      .optional(),
    confidence: z.number().min(0).max(1).optional(),
    impact: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  })
  .superRefine((claim, ctx) => {
    if (claim.type === 'client_provided' && !claim.source) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A claim attributed to the client must cite where it came from.',
        path: ['source'],
      });
    }
    if (claim.type === 'ai_inference' && claim.confidence === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An inference must carry a confidence between 0 and 1.',
        path: ['confidence'],
      });
    }
  });

export const diagnosisOutputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(5000),
  claims: z.array(claimSchema).min(1).max(60),
  /** Instruction-like passages spotted in untrusted input, reported not obeyed. */
  observed_instructions: z.array(z.string().max(1000)).max(20).default([]),
});

export const emailDraftOutputSchema = z.object({
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
  tone: z.enum(['formal', 'friendly', 'direct']).default('formal'),
  observed_instructions: z.array(z.string().max(1000)).max(20).default([]),
});

/**
 * Contract variable *values* only.
 *
 * The model may suggest what goes in a placeholder. It may never produce clause
 * text: the keys are constrained to declared variables and the renderer accepts
 * nothing else.
 */
export const contractVariablesOutputSchema = z.object({
  values: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.null()])),
  uncertain: z.array(z.string().max(64)).max(30).default([]),
  observed_instructions: z.array(z.string().max(1000)).max(20).default([]),
});

export const taskSuggestionsOutputSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        description: z.string().max(2000).optional(),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
        estimated_hours: z.number().min(0).max(1000).optional(),
        rationale: z.string().max(1000).optional(),
      }),
    )
    .min(1)
    .max(30),
  observed_instructions: z.array(z.string().max(1000)).max(20).default([]),
});

export const summaryOutputSchema = z.object({
  summary: z.string().trim().min(1).max(10_000),
  key_points: z.array(z.string().max(500)).max(20).default([]),
  observed_instructions: z.array(z.string().max(1000)).max(20).default([]),
});

export const OUTPUT_SCHEMAS = {
  draft_diagnosis: diagnosisOutputSchema,
  draft_proposal_section: summaryOutputSchema,
  draft_email: emailDraftOutputSchema,
  suggest_contract_variables: contractVariablesOutputSchema,
  summarize_discovery: summaryOutputSchema,
  extract_meeting_notes: summaryOutputSchema,
  suggest_tasks: taskSuggestionsOutputSchema,
  suggest_kpis: taskSuggestionsOutputSchema,
  draft_client_report: summaryOutputSchema,
  classify_activity: summaryOutputSchema,
} as const satisfies Record<AiActionType, z.ZodTypeAny>;

/**
 * Actions whose subject matter is contractual, commercial or scope-defining.
 * These always require explicit human confirmation of each field, never a
 * blanket "accept all".
 */
export const HIGH_STAKES_ACTIONS = new Set<AiActionType>([
  'suggest_contract_variables',
  'draft_proposal_section',
]);

export function validateOutput(
  actionType: AiActionType,
  raw: unknown,
): { ok: true; data: unknown } | { ok: false; issues: Array<{ path: string; message: string }> } {
  const schema = OUTPUT_SCHEMAS[actionType];
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  };
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

export interface ProposeInput {
  actionType: AiActionType;
  entityType: string;
  entityId: string | null;
  companyId?: string | null;
  proposedPayload: unknown;
  provenance?: Record<string, unknown>;
  usage: ModelUsage;
  promptText?: string;
}

export async function proposeAction(
  tx: Tx,
  ctx: RequestContext,
  input: ProposeInput,
): Promise<{ id: string }> {
  const validation = validateOutput(input.actionType, input.proposedPayload);
  if (!validation.ok) {
    // Nothing is stored. A response we do not fully understand is not a draft
    // for a human to fix; it is a failed generation.
    throw new AppError(
      'VALIDATION_ERROR',
      'The AI response did not match the expected structure and was rejected.',
      { details: { issues: validation.issues } },
    );
  }

  const row = await tx.one<{ id: string }>(
    `insert into ai_actions (
       org_id, action_type, entity_type, entity_id, company_id, status,
       proposed_payload, provenance, model, prompt_version, prompt_hash,
       input_tokens, output_tokens, cost_usd, latency_ms, requested_by, request_id
     ) values ($1,$2,$3,$4,$5,'pending_approval',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning id`,
    [
      ctx.org.id, input.actionType, input.entityType, input.entityId ?? null,
      input.companyId ?? null, JSON.stringify(validation.data),
      JSON.stringify(input.provenance ?? {}),
      input.usage.model, PROMPT_VERSION,
      input.promptText ? sha256Hex(input.promptText) : null,
      input.usage.inputTokens, input.usage.outputTokens, input.usage.costUsd,
      input.usage.latencyMs, ctx.user.id, ctx.requestId ?? null,
    ],
  );

  await emitEvent(tx, {
    name: 'ai.action_proposed',
    entityType: 'ai_action',
    entityId: row.id,
    payload: { action_type: input.actionType, target: input.entityType },
    actorType: 'ai',
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'ai.action_proposed',
    category: 'ai',
    actorUserId: ctx.user.id,
    actorType: 'ai',
    entityType: 'ai_action',
    entityId: row.id,
    summary: `AI proposed a ${input.actionType.replace(/_/g, ' ')} for review`,
    metadata: {
      model: input.usage.model,
      prompt_version: PROMPT_VERSION,
      cost_usd: input.usage.costUsd,
      tokens: input.usage.inputTokens + input.usage.outputTokens,
    },
    requestId: ctx.requestId,
  });

  return row;
}

export const approvalSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  /** The reviewer's edits. When present, this is what gets executed. */
  edited_payload: z.unknown().optional(),
  reason: z.string().trim().max(2000).optional(),
});

/**
 * Records a human decision.
 *
 * An edited payload is re-validated against the same schema, because a reviewer
 * hand-editing JSON can break it just as easily as a model can.
 */
export async function decideAction(
  tx: Tx,
  ctx: RequestContext,
  actionId: string,
  input: z.infer<typeof approvalSchema>,
): Promise<{ id: string; status: string }> {
  ctx.permissions.require('ai:approve:org', 'Approving an AI action requires review authority.');

  const action = await tx.maybeOne<{
    id: string; action_type: AiActionType; status: string; entity_type: string;
    entity_id: string | null; company_id: string | null; proposed_payload: unknown;
  }>(
    `select id, action_type, status, entity_type, entity_id, company_id, proposed_payload
     from ai_actions where id = $1 for update`,
    [actionId],
  );
  if (!action) throw new AppError('NOT_FOUND', 'This AI action was not found.');

  if (action.status !== 'pending_approval') {
    throw new AppError(
      'AI_ACTION_NOT_PENDING',
      `This action is ${action.status} and can no longer be decided.`,
    );
  }

  if (input.decision === 'reject') {
    if (!input.reason) {
      throw new AppError('VALIDATION_ERROR', 'Rejecting an AI action requires a reason.');
    }
    await tx.query(
      `update ai_actions set status = 'rejected', rejected_by = $2, rejected_at = now(),
              rejection_reason = $3
       where id = $1`,
      [actionId, ctx.user.id, input.reason],
    );

    await emitEvent(tx, {
      name: 'ai.action_rejected',
      entityType: 'ai_action',
      entityId: actionId,
      payload: { action_type: action.action_type, reason: input.reason },
    });

    await writeAudit(tx, {
      orgId: ctx.org.id,
      action: 'ai.action_rejected',
      category: 'ai',
      actorUserId: ctx.user.id,
      entityType: 'ai_action',
      entityId: actionId,
      summary: `Rejected an AI ${action.action_type.replace(/_/g, ' ')}`,
      reason: input.reason,
      requestId: ctx.requestId,
    });

    return { id: actionId, status: 'rejected' };
  }

  let approvedPayload = action.proposed_payload;
  if (input.edited_payload !== undefined) {
    const revalidated = validateOutput(action.action_type, input.edited_payload);
    if (!revalidated.ok) {
      throw new AppError('VALIDATION_ERROR', 'The edited content is not valid.', {
        details: { issues: revalidated.issues },
      });
    }
    approvedPayload = revalidated.data;
  }

  await tx.query(
    `update ai_actions set status = 'approved', approved_by = $2, approved_at = now(),
            approved_payload = $3
     where id = $1`,
    [actionId, ctx.user.id, JSON.stringify(approvedPayload)],
  );

  await emitEvent(tx, {
    name: 'ai.action_approved',
    entityType: 'ai_action',
    entityId: actionId,
    payload: { action_type: action.action_type, edited: input.edited_payload !== undefined },
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'ai.action_approved',
    category: 'ai',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'ai_action',
    entityId: actionId,
    summary: `Approved an AI ${action.action_type.replace(/_/g, ' ')}${
      input.edited_payload !== undefined ? ' (edited before approval)' : ''
    }`,
    after: approvedPayload,
    requestId: ctx.requestId,
  });

  return { id: actionId, status: 'approved' };
}

/**
 * Applies an approved action.
 *
 * This is the only code that turns AI output into business data, and it runs
 * only after `decideAction` has recorded an approval. The database refuses the
 * `executed` status from anything but `approved`.
 */
export async function executeAction(
  tx: Tx,
  ctx: RequestContext,
  actionId: string,
): Promise<{ id: string; result: unknown }> {
  const action = await tx.maybeOne<{
    id: string; action_type: AiActionType; status: string; entity_type: string;
    entity_id: string | null; company_id: string | null;
    approved_payload: unknown; provenance: Record<string, unknown>;
  }>(
    `select id, action_type, status, entity_type, entity_id, company_id,
            approved_payload, provenance
     from ai_actions where id = $1 for update`,
    [actionId],
  );
  if (!action) throw new AppError('NOT_FOUND', 'This AI action was not found.');

  if (action.status !== 'approved') {
    throw new AppError(
      'AI_ACTION_NOT_APPROVED',
      `An AI action must be approved before it is applied (this one is ${action.status}).`,
    );
  }

  let result: unknown;

  switch (action.action_type) {
    case 'draft_diagnosis':
      result = await applyDiagnosis(tx, ctx, action);
      break;
    case 'suggest_tasks':
      result = await applyTaskSuggestions(tx, ctx, action);
      break;
    default:
      // Drafts (emails, proposal sections, summaries) are handed back to the UI
      // for the reviewer to place; there is nothing to write automatically.
      result = { applied: false, reason: 'This action type is applied by the user in context.' };
  }

  await tx.query(
    `update ai_actions set status = 'executed', executed_at = now(), execution_result = $2
     where id = $1`,
    [actionId, JSON.stringify(result)],
  );

  await emitEvent(tx, {
    name: 'ai.action_executed',
    entityType: 'ai_action',
    entityId: actionId,
    payload: { action_type: action.action_type },
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'ai.action_executed',
    category: 'ai',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'ai_action',
    entityId: actionId,
    summary: `Applied an approved AI ${action.action_type.replace(/_/g, ' ')}`,
    after: result,
    requestId: ctx.requestId,
  });

  return { id: actionId, result };
}

async function applyDiagnosis(
  tx: Tx,
  ctx: RequestContext,
  action: { id: string; entity_id: string | null; company_id: string | null; approved_payload: unknown },
): Promise<unknown> {
  if (!action.entity_id) {
    throw new AppError('VALIDATION_ERROR', 'This diagnosis has no opportunity to attach to.');
  }

  const payload = diagnosisOutputSchema.parse(action.approved_payload);

  const last = await tx.maybeOne<{ version: number }>(
    `select version from diagnoses where opportunity_id = $1 order by version desc limit 1`,
    [action.entity_id],
  );
  const version = (last?.version ?? 0) + 1;

  const opportunity = await tx.one<{ company_id: string }>(
    `select company_id from opportunities where id = $1`,
    [action.entity_id],
  );

  const diagnosis = await tx.one<{ id: string }>(
    `insert into diagnoses (
       org_id, opportunity_id, company_id, title, summary, status, version,
       generated_by, ai_action_id, created_by
     ) values ($1,$2,$3,$4,$5,'in_review',$6,'ai_assisted',$7,$8)
     returning id`,
    [
      ctx.org.id, action.entity_id, opportunity.company_id, payload.title,
      payload.summary, version, action.id, ctx.user.id,
    ],
  );

  for (const [index, claim] of payload.claims.entries()) {
    await tx.query(
      `insert into diagnosis_claims (
         org_id, diagnosis_id, claim_type, text, category, position,
         source_kind, source_id, source_field, source_quote, confidence, impact
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        ctx.org.id, diagnosis.id, claim.type, claim.text, claim.category ?? null, index,
        claim.source?.kind ?? null,
        claim.source?.id ?? null,
        claim.source?.field ?? null,
        claim.source?.quote ?? null,
        claim.confidence ?? null,
        claim.impact ?? null,
      ],
    );
  }

  await recordActivity(tx, {
    entityType: 'opportunity',
    entityId: action.entity_id,
    companyId: opportunity.company_id,
    activityType: 'ai',
    title: `Diagnosis v${version} created from an approved AI draft`,
    body: payload.summary.slice(0, 500),
    isInternal: true,
  });

  return {
    diagnosis_id: diagnosis.id,
    version,
    claims: payload.claims.length,
    by_type: {
      client_provided: payload.claims.filter((c) => c.type === 'client_provided').length,
      ai_inference: payload.claims.filter((c) => c.type === 'ai_inference').length,
      ai_recommendation: payload.claims.filter((c) => c.type === 'ai_recommendation').length,
    },
  };
}

async function applyTaskSuggestions(
  tx: Tx,
  ctx: RequestContext,
  action: { entity_id: string | null; approved_payload: unknown },
): Promise<unknown> {
  const payload = taskSuggestionsOutputSchema.parse(action.approved_payload);
  const created: string[] = [];

  for (const task of payload.tasks) {
    const reference = await tx.one<{ reference: string }>(
      `select app.next_reference($1, 'task', 'TSK') as reference`,
      [ctx.org.id],
    );
    const row = await tx.one<{ id: string }>(
      `insert into tasks (org_id, project_id, reference, title, description, priority,
                          estimated_hours, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id`,
      [
        ctx.org.id, action.entity_id, reference.reference, task.title,
        task.description ?? null, task.priority, task.estimated_hours ?? null, ctx.user.id,
      ],
    );
    created.push(row.id);
  }

  return { created_task_ids: created, count: created.length };
}

/** Notifies reviewers that something is waiting. */
export async function notifyReviewers(
  tx: Tx,
  ctx: RequestContext,
  actionId: string,
  actionType: string,
): Promise<void> {
  const reviewers = await tx.many<{ user_id: string }>(
    `select distinct ur.user_id from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     join permissions p on p.id = rp.permission_id
     where ur.org_id = $1 and p.key = 'ai:approve:org' and ur.user_id <> $2`,
    [ctx.org.id, ctx.user.id],
  );

  for (const reviewer of reviewers) {
    await notify(tx, {
      userId: reviewer.user_id,
      category: 'approval',
      title: 'An AI draft is waiting for review',
      body: actionType.replace(/_/g, ' '),
      entityType: 'ai_action',
      entityId: actionId,
      linkUrl: `/ai/actions/${actionId}`,
      dedupeKey: `ai-review:${actionId}`,
    });
  }
}
