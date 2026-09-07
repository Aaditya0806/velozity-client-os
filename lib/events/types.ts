/**
 * The domain event vocabulary.
 *
 * Event names are stable public API: automations reference them by string, and
 * a rename breaks a customer's configuration. Add, do not rewrite.
 */
export const EVENT_NAMES = [
  'company.created',
  'company.updated',
  'contact.created',
  'contact.updated',

  'opportunity.created',
  'opportunity.stage_changed',
  'opportunity.won',
  'opportunity.lost',
  'opportunity.updated',
  'opportunity.owner_changed',

  'discovery.updated',
  'discovery.completed',
  'diagnosis.created',
  'diagnosis.approved',

  'solution.created',
  'solution.updated',

  'proposal.created',
  'proposal.version_created',
  'proposal.submitted_for_review',
  'proposal.approved',
  'proposal.rejected',
  'proposal.sent',
  'proposal.viewed',
  'proposal.accepted',
  'proposal.declined',
  'proposal.expired',

  'contract.created',
  'contract.submitted_for_review',
  'contract.approved_to_send',
  'contract.sent',
  'contract.viewed',
  'contract.partially_signed',
  'contract.executed',
  'contract.declined',
  'contract.voided',
  'contract.expired',

  'document.uploaded',
  'document.version_added',
  'document.downloaded',
  'document.hash_mismatch',

  'payment.recorded',
  'payment.allocated',
  'payment_requirement.satisfied',
  'invoice.issued',
  'invoice.paid',

  'onboarding.created',
  'onboarding.unblocked',
  'onboarding.overridden',
  'onboarding.started',
  'onboarding.completed',

  'project.created',
  'project.status_changed',
  'project.health_changed',
  'workstream.created',
  'task.created',
  'task.assigned',
  'task.completed',
  'task.overdue',
  'deliverable.delivered',
  'deliverable.accepted',

  'kpi.created',
  'kpi.measured',
  'report.created',
  'report.published',

  'ai.action_proposed',
  'ai.action_approved',
  'ai.action_rejected',
  'ai.action_executed',

  'email.drafted',
  'email.sent',
  'email.delivered',
  'email.bounced',

  'user.invited',
  'user.deactivated',
  'role.granted',
  'role.revoked',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

// The renewal cycle emits its outcomes so automations can react to churn.
export const RENEWAL_EVENT_NAMES = [
  'renewal.in_progress',
  'renewal.won',
  'renewal.lost',
  'renewal.auto_renewed',
  'renewal.not_renewing',
] as const;

export interface DomainEvent<P = Record<string, unknown>> {
  id: string;
  orgId: string;
  name: EventName | string;
  version: number;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorType: 'user' | 'system' | 'automation' | 'provider' | 'ai';
  payload: P;
  requestId: string | null;
  occurredAt: string;
}

export interface EmitEventInput<P = Record<string, unknown>> {
  name: EventName | string;
  entityType: string;
  entityId?: string | null;
  payload?: P;
  actorUserId?: string | null;
  actorType?: DomainEvent['actorType'];
  version?: number;
  /**
   * Chain depth for automation loop protection. An event emitted as the result
   * of an automation action inherits depth + 1.
   */
  depth?: number;
}
