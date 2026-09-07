/**
 * The lifecycle definitions.
 *
 * Each machine declares its legal edges and the guards that must hold before an
 * entity may enter a state. The guards duplicate rules that the database also
 * enforces by trigger - deliberately. The trigger makes the rule impossible to
 * violate; the guard makes the failure explainable.
 */
import type { StateMachine, Guard } from './state-machine';
import { AppError } from '@/lib/http/errors';

// =============================================================================
// OPPORTUNITY
// =============================================================================

export interface OpportunityRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  stage: string;
  business_problem: string | null;
  budget_indication: string | null;
  decision_maker_contact_id: string | null;
  accepted_proposal_version_id: string | null;
  dormant_from_stage: string | null;
  owner_user_id: string | null;
}

const OPPORTUNITY_ACTIVE_STAGES = [
  'lead',
  'qualified',
  'discovery',
  'diagnosis',
  'solution',
  'proposal_sent',
  'negotiation',
] as const;

/**
 * Qualification evidence. The rule the business actually cares about: nothing
 * advances past `lead` without a stated problem, a budget signal and a named
 * decision maker.
 */
const requireQualification: Guard<OpportunityRow> = ({ entity, to }) => {
  const missing: string[] = [];
  if (!entity.business_problem || entity.business_problem.trim().length < 10) {
    missing.push('business_problem');
  }
  if (entity.budget_indication === null || entity.budget_indication === undefined) {
    missing.push('budget_indication');
  }
  if (!entity.decision_maker_contact_id) {
    missing.push('decision_maker');
  }

  if (missing.length > 0) {
    throw new AppError(
      'OPPORTUNITY_QUALIFICATION_INCOMPLETE',
      `This opportunity cannot move to "${to}" until the qualification details are complete.`,
      { details: { missing } },
    );
  }
};

const requireApprovedProposal: Guard<OpportunityRow> = async ({ tx, entity }) => {
  const row = await tx.maybeOne<{ ok: boolean }>(
    `select app.opportunity_has_approved_proposal($1) as ok`,
    [entity.id],
  );
  if (!row?.ok) {
    throw new AppError(
      'PROPOSAL_NOT_APPROVED',
      'An internally approved proposal version is required before sending.',
    );
  }
};

const requireAcceptedProposal: Guard<OpportunityRow> = async ({ tx, entity }) => {
  const accepted = await tx.maybeOne<{ version_id: string }>(
    `select v.id as version_id
     from proposal_versions v
     join proposals p on p.id = v.proposal_id
     where p.opportunity_id = $1 and p.deleted_at is null
       and v.status = 'accepted' and v.accepted_at is not null
     order by v.accepted_at desc
     limit 1`,
    [entity.id],
  );

  if (!accepted) {
    throw new AppError(
      'PROPOSAL_NOT_ACCEPTED',
      'An accepted proposal is required before an opportunity can be won.',
    );
  }

  // Freeze the accepted version onto the opportunity as part of the transition.
  // Everything downstream - the agreement, the project, the invoice - reads
  // this and not the live opportunity.
  if (entity.accepted_proposal_version_id) {
    return {};
  }
  return { accepted_proposal_version_id: accepted.version_id };
};

const requireLostReason: Guard<OpportunityRow> = ({ request }) => {
  const reason = request.payload?.lost_reason;
  const valid = [
    'price', 'timing', 'no_budget', 'competitor', 'no_decision',
    'lost_contact', 'not_a_fit', 'internal_capacity', 'other',
  ];
  if (typeof reason !== 'string' || !valid.includes(reason)) {
    throw new AppError('VALIDATION_ERROR', 'A lost opportunity must record why it was lost.', {
      details: { field: 'lost_reason', validValues: valid },
    });
  }
  return {
    lost_reason: reason,
    lost_reason_detail: request.reason ?? null,
    lost_to_competitor:
      typeof request.payload?.lost_to_competitor === 'string'
        ? request.payload.lost_to_competitor
        : null,
  };
};

/** Parking a deal remembers where it was so reactivation restores it. */
const rememberStageForDormancy: Guard<OpportunityRow> = ({ entity, request }) => ({
  dormant_from_stage: entity.stage,
  dormant_until:
    typeof request.payload?.dormant_until === 'string' ? request.payload.dormant_until : null,
});

export const opportunityMachine: StateMachine<OpportunityRow> = {
  entityType: 'opportunity',
  table: 'opportunities',
  column: 'stage',
  states: [...OPPORTUNITY_ACTIVE_STAGES, 'won', 'closed', 'lost', 'dormant'],
  transitions: {
    lead: ['qualified', 'lost', 'dormant'],
    qualified: ['discovery', 'solution', 'lost', 'dormant'],
    discovery: ['diagnosis', 'solution', 'qualified', 'lost', 'dormant'],
    diagnosis: ['solution', 'discovery', 'lost', 'dormant'],
    solution: ['proposal_sent', 'diagnosis', 'lost', 'dormant'],
    proposal_sent: ['negotiation', 'won', 'solution', 'lost', 'dormant'],
    negotiation: ['won', 'proposal_sent', 'lost', 'dormant'],
    // A won deal can still be lost - the client walks before signing. It is not
    // terminal for that reason, and the lost reason is still mandatory.
    won: ['closed', 'lost'],
    closed: [],
    lost: ['qualified', 'dormant'],
    // Reactivating a parked deal returns it to the funnel.
    dormant: ['lead', 'qualified', 'discovery', 'diagnosis', 'solution', 'proposal_sent', 'negotiation', 'lost'],
  },
  terminal: ['closed'],
  requiresReason: ['lost', 'dormant'],
  guards: {
    qualified: requireQualification,
    discovery: requireQualification,
    diagnosis: requireQualification,
    solution: requireQualification,
    proposal_sent: async (ctx) => {
      await requireQualification(ctx);
      await requireApprovedProposal(ctx);
    },
    negotiation: requireQualification,
    won: async (ctx) => {
      await requireQualification(ctx);
      return requireAcceptedProposal(ctx);
    },
    lost: requireLostReason,
    dormant: rememberStageForDormancy,
  },
};

// =============================================================================
// PROPOSAL
// =============================================================================

export interface ProposalRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  status: string;
  current_version_id: string | null;
  accepted_version_id: string | null;
}

export const proposalMachine: StateMachine<ProposalRow> = {
  entityType: 'proposal',
  table: 'proposals',
  column: 'status',
  states: ['draft', 'internal_review', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'withdrawn'],
  transitions: {
    draft: ['internal_review', 'withdrawn'],
    internal_review: ['approved', 'draft', 'withdrawn'],
    approved: ['sent', 'draft', 'withdrawn'],
    sent: ['accepted', 'rejected', 'expired', 'internal_review'],
    // A rejected proposal is revised and re-reviewed rather than resent as-is.
    rejected: ['draft', 'internal_review'],
    expired: ['draft', 'internal_review'],
    accepted: [],
    withdrawn: [],
  },
  terminal: ['accepted', 'withdrawn'],
  requiresReason: ['rejected', 'withdrawn'],
};

export const proposalVersionMachine: StateMachine = {
  entityType: 'proposal_version',
  table: 'proposal_versions',
  column: 'status',
  states: ['draft', 'internal_review', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'superseded'],
  transitions: {
    draft: ['internal_review', 'superseded'],
    internal_review: ['approved', 'rejected', 'draft'],
    approved: ['sent', 'draft', 'superseded'],
    sent: ['accepted', 'rejected', 'expired'],
    rejected: ['draft', 'superseded'],
    expired: ['superseded'],
    accepted: [],
    superseded: [],
  },
  terminal: ['accepted', 'superseded'],
  requiresReason: ['rejected'],
};

// =============================================================================
// CONTRACT
// =============================================================================

export interface ContractRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  status: string;
  contract_type: string;
  template_version_id: string | null;
  draft_document_id: string | null;
  executed_document_id: string | null;
  approved_by: string | null;
  origin: string;
}

/**
 * Legal review is complete. The approver is stamped here; `contract:approve:org`
 * is checked by the API and again by a database trigger.
 */
const stampApproval: Guard<ContractRow> = ({ actor }) => ({
  approved_by: actor.userId,
  approved_at: new Date().toISOString(),
});

const requireSendableDocument: Guard<ContractRow> = ({ entity }) => {
  if (!entity.draft_document_id) {
    throw new AppError(
      'INVALID_STATE',
      'A contract must have a rendered document before it can be approved for sending.',
      { details: { contractId: entity.id } },
    );
  }
};

const stampSend: Guard<ContractRow> = async ({ tx, entity, actor }) => {
  const signers = await tx.many<{ id: string }>(
    `select id from contract_signers where contract_id = $1`,
    [entity.id],
  );
  if (signers.length < 2) {
    throw new AppError(
      'INVALID_STATE',
      'A contract needs at least one signer from each side before it can be sent.',
      { details: { signerCount: signers.length } },
    );
  }
  return { sent_by: actor.userId, sent_at: new Date().toISOString() };
};

/**
 * Only reached from the verified-webhook pipeline, which has already downloaded
 * the executed file, verified its hash and stored it immutably.
 */
const requireExecutedDocument: Guard<ContractRow> = ({ entity, request }) => {
  const documentId = request.payload?.executed_document_id ?? entity.executed_document_id;
  if (!documentId || typeof documentId !== 'string') {
    throw new AppError(
      'EXECUTED_DOCUMENT_REQUIRED',
      'A contract cannot be marked fully executed without its stored executed document.',
    );
  }
  return { executed_document_id: documentId, executed_at: new Date().toISOString() };
};

export const contractMachine: StateMachine<ContractRow> = {
  entityType: 'contract',
  table: 'contracts',
  column: 'status',
  states: [
    'draft', 'internal_review', 'approved_to_send', 'sent', 'viewed',
    'partially_signed', 'fully_executed', 'declined', 'expired', 'voided',
  ],
  transitions: {
    draft: ['internal_review', 'voided'],
    internal_review: ['approved_to_send', 'draft', 'voided'],
    approved_to_send: ['sent', 'internal_review', 'voided'],
    sent: ['viewed', 'partially_signed', 'fully_executed', 'declined', 'expired', 'voided'],
    viewed: ['partially_signed', 'fully_executed', 'declined', 'expired', 'voided'],
    partially_signed: ['fully_executed', 'declined', 'expired', 'voided'],
    // Terminal. Anything further is an amendment referencing this contract.
    fully_executed: [],
    declined: ['draft'],
    expired: ['draft'],
    voided: [],
  },
  terminal: ['fully_executed', 'voided'],
  requiresReason: ['declined', 'voided'],
  guards: {
    approved_to_send: async (ctx) => {
      await requireSendableDocument(ctx);
      return stampApproval(ctx);
    },
    sent: stampSend,
    fully_executed: requireExecutedDocument,
    declined: ({ request }) => ({
      declined_at: new Date().toISOString(),
      decline_reason: request.reason ?? 'Declined by counterparty',
    }),
    voided: ({ request }) => ({
      voided_at: new Date().toISOString(),
      void_reason: request.reason ?? 'Voided',
    }),
  },
};

// =============================================================================
// ONBOARDING
// =============================================================================

export interface OnboardingRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  company_id: string;
  status: string;
  legal_override_active: boolean;
}

/**
 * The legal gate. Evaluated here for a helpful message, and enforced again by
 * app.enforce_legal_gate() on the way through the database - which is what
 * actually makes it unbypassable.
 */
const requireLegalGate: Guard<OnboardingRow> = async ({ tx, entity }) => {
  if (entity.legal_override_active) return {};

  const row = await tx.one<{ unmet: unknown[] }>(
    `select app.assert_legal_gate($1, false) as unmet`,
    [entity.id],
  );
  const unmet = Array.isArray(row.unmet) ? row.unmet : JSON.parse(String(row.unmet ?? '[]'));

  if (unmet.length > 0) {
    throw new AppError(
      'LEGAL_GATE_BLOCKED',
      `Onboarding is blocked by ${unmet.length} outstanding legal requirement(s).`,
      { details: { unmet } },
    );
  }
  return { blocked_reasons: JSON.stringify([]), ready_at: new Date().toISOString() };
};

export const onboardingMachine: StateMachine<OnboardingRow> = {
  entityType: 'onboarding',
  table: 'onboardings',
  column: 'status',
  states: ['blocked', 'ready', 'in_progress', 'complete', 'cancelled'],
  transitions: {
    blocked: ['ready', 'cancelled'],
    ready: ['in_progress', 'blocked', 'cancelled'],
    in_progress: ['complete', 'ready', 'cancelled'],
    complete: [],
    cancelled: [],
  },
  terminal: ['complete', 'cancelled'],
  requiresReason: ['cancelled'],
  guards: {
    ready: requireLegalGate,
    in_progress: ({ }) => ({ started_at: new Date().toISOString() }),
    complete: ({ }) => ({ completed_at: new Date().toISOString() }),
  },
};

// =============================================================================
// PROJECT
// =============================================================================

export const projectMachine: StateMachine = {
  entityType: 'project',
  table: 'projects',
  column: 'status',
  states: ['not_started', 'active', 'on_hold', 'delivered', 'closed', 'cancelled'],
  transitions: {
    not_started: ['active', 'cancelled'],
    active: ['on_hold', 'delivered', 'cancelled'],
    on_hold: ['active', 'cancelled'],
    delivered: ['closed', 'active'],
    closed: [],
    cancelled: [],
  },
  terminal: ['closed', 'cancelled'],
  requiresReason: ['on_hold', 'cancelled'],
  guards: {
    on_hold: ({ request }) => ({ on_hold_reason: request.reason ?? 'On hold' }),
    active: () => ({ on_hold_reason: null }),
    delivered: () => ({ actual_end_date: new Date().toISOString().slice(0, 10) }),
  },
};

export const MACHINES = {
  opportunity: opportunityMachine,
  proposal: proposalMachine,
  proposal_version: proposalVersionMachine,
  contract: contractMachine,
  onboarding: onboardingMachine,
  project: projectMachine,
} as const;

export type MachineName = keyof typeof MACHINES;
