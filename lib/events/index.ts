/**
 * The event service.
 *
 * The `events` table IS the transactional outbox. An event row is written in the
 * same transaction as the business change that produced it, carrying its own
 * dispatch status, so an opportunity cannot be marked won without its
 * `opportunity.won` event also existing, and no event can survive a rollback.
 *
 * A background dispatcher running as service_role polls for pending rows and
 * fans each one out to notifications and the automation engine. Deliberately
 * there is no second queue row: a user transaction has no INSERT privilege on
 * `jobs`, and adding one to satisfy the outbox would have widened the write
 * surface of every request path for no gain. Fan-out is at-least-once, so every
 * consumer is written to be idempotent.
 */
import { randomUUID } from 'node:crypto';
import type { Tx } from '@/lib/db';
import type { DomainEvent, EmitEventInput } from './types';

export * from './types';

export interface EmitOptions {
  /**
   * Marks the event as already handled. Used when an event is recorded purely
   * for the timeline and has no consumers to run.
   */
  skipDispatch?: boolean;
}

/**
 * Records a domain event. Returns the stored row so callers can reference the
 * event id from an activity or an automation run.
 */
export async function emitEvent<P extends Record<string, unknown>>(
  tx: Tx,
  input: EmitEventInput<P>,
  options: EmitOptions = {},
): Promise<DomainEvent<P>> {
  const orgId = tx.context.orgId;
  if (!orgId) {
    throw new Error('emitEvent requires an organisation-scoped transaction');
  }

  // The id is generated here rather than by the database, deliberately.
  //
  // PostgreSQL evaluates a RETURNING clause against the table's SELECT policy,
  // so `insert ... returning *` would demand read access to the events table.
  // Reading the event stream requires `audit:read:org`, which most users do not
  // hold - and there is no reason a salesperson should need permission to read
  // the audit stream in order to create a client. Writing must not imply
  // reading, so the row is fully determined before it is inserted.
  const id = randomUUID();
  const occurredAt = new Date().toISOString();
  const actorUserId = input.actorUserId === null
    ? null
    : (input.actorUserId ?? tx.context.userId ?? null);
  const payload = (input.payload ?? {}) as P;

  await tx.query(
    `insert into events (id, org_id, name, version, entity_type, entity_id,
                         actor_user_id, actor_type, payload, request_id,
                         status, depth, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      orgId,
      input.name,
      input.version ?? 1,
      input.entityType,
      input.entityId ?? null,
      actorUserId,
      input.actorType ?? 'user',
      JSON.stringify(payload),
      tx.context.requestId ?? null,
      options.skipDispatch ? 'processed' : 'pending',
      input.depth ?? 0,
      occurredAt,
    ],
  );

  return {
    id,
    orgId,
    name: input.name,
    version: input.version ?? 1,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    actorUserId,
    actorType: input.actorType ?? 'user',
    payload,
    requestId: tx.context.requestId ?? null,
    occurredAt,
  };
}

// -----------------------------------------------------------------------------
// Activities
//
// The timeline is written through this service rather than by database triggers.
// A trigger cannot know the actor's intent, cannot phrase a human title, and
// makes the write path invisible to anyone reading the domain code.
// -----------------------------------------------------------------------------

export type ActivityType =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'state_changed'
  | 'note'
  | 'call'
  | 'meeting'
  | 'email'
  | 'comment'
  | 'assignment'
  | 'document'
  | 'contract'
  | 'proposal'
  | 'payment'
  | 'system'
  | 'ai'
  | 'automation';

export interface RecordActivityInput {
  entityType: string;
  entityId: string;
  companyId?: string | null;
  activityType: ActivityType;
  title: string;
  body?: string | null;
  /** Internal activity is hidden without internal_note:read and never reaches the portal. */
  isInternal?: boolean;
  actorUserId?: string | null;
  actorType?: DomainEvent['actorType'];
  metadata?: Record<string, unknown>;
  eventId?: string | null;
  occurredAt?: Date | string;
}

export async function recordActivity(tx: Tx, input: RecordActivityInput): Promise<string> {
  const orgId = tx.context.orgId;
  if (!orgId) throw new Error('recordActivity requires an organisation-scoped transaction');

  // Id generated here for the same reason as in emitEvent: an internal activity
  // is invisible to a user without `internal_note:read`, so a RETURNING clause
  // would fail for the very person recording it.
  const id = randomUUID();

  await tx.query(
    `insert into activities (
       id, org_id, entity_type, entity_id, company_id, activity_type, title, body,
       is_internal, actor_user_id, actor_type, metadata, event_id, occurred_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, coalesce($14, now()))`,
    [
      id,
      orgId,
      input.entityType,
      input.entityId,
      input.companyId ?? null,
      input.activityType,
      input.title,
      input.body ?? null,
      input.isInternal ?? false,
      input.actorUserId ?? tx.context.userId ?? null,
      input.actorType ?? 'user',
      JSON.stringify(input.metadata ?? {}),
      input.eventId ?? null,
      input.occurredAt ? new Date(input.occurredAt).toISOString() : null,
    ],
  );

  return id;
}

// -----------------------------------------------------------------------------
// Notifications
// -----------------------------------------------------------------------------

export type NotificationCategory =
  | 'assignment'
  | 'contract'
  | 'approval'
  | 'task'
  | 'automation'
  | 'proposal'
  | 'payment'
  | 'system'
  | 'mention'
  | 'security';

export interface NotifyInput {
  userId: string;
  category: NotificationCategory;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  linkUrl?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  eventId?: string | null;
  /** Collapses duplicates from a retried dispatch. */
  dedupeKey?: string | null;
}

export async function notify(tx: Tx, input: NotifyInput): Promise<void> {
  const orgId = tx.context.orgId;
  if (!orgId) throw new Error('notify requires an organisation-scoped transaction');

  // Delivery goes through app.deliver_notification rather than a plain
  // `insert ... on conflict do nothing`.
  //
  // PostgreSQL applies the SELECT policy to an ON CONFLICT clause, and the
  // notifications SELECT policy restricts rows to their recipient. Written the
  // obvious way, this function could only ever notify the caller - which is the
  // opposite of what a notification is for. See migration 0018.
  await tx.query(
    `select app.deliver_notification($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      randomUUID(),
      orgId,
      input.userId,
      input.category,
      input.title,
      input.body ?? null,
      input.entityType ?? null,
      input.entityId ?? null,
      input.linkUrl ?? null,
      input.priority ?? 'normal',
      input.eventId ?? null,
      input.dedupeKey ?? null,
    ],
  );
}

export async function notifyMany(tx: Tx, userIds: readonly string[], input: Omit<NotifyInput, 'userId'>): Promise<void> {
  for (const userId of new Set(userIds)) {
    await notify(tx, { ...input, userId });
  }
}
