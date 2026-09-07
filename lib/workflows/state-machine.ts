/**
 * The generic lifecycle engine.
 *
 * Every state change in the product runs through `performTransition`. Direct
 * `UPDATE ... SET status = ...` is rejected by the database (see
 * app.guard_state_column), so this is not merely the recommended path - it is
 * the only one that works.
 *
 * A transition:
 *   1. locks the row, so two concurrent transitions serialise;
 *   2. checks the edge exists in the declared machine;
 *   3. refuses to leave a terminal state;
 *   4. demands a reason where the machine says one is required;
 *   5. runs the domain guards, which may query anything they need;
 *   6. marks the transaction as a transition and performs the update;
 *   7. appends to the immutable transition ledger.
 *
 * All of that is one transaction. A guard failure leaves nothing behind.
 */
import type { Tx } from '@/lib/db';
import { AppError } from '@/lib/http/errors';

export interface TransitionRequest {
  to: string;
  reason?: string | null;
  payload?: Record<string, unknown>;
}

export interface TransitionActor {
  /**
   * NULL when the actor is not a person - a provider webhook, a scheduled job,
   * an automation. The columns that record an actor are nullable references to
   * user_profiles precisely so that a synthetic "system user" row is never
   * needed, and never has to be protected from deletion.
   */
  userId: string | null;
  actorType?: 'user' | 'system' | 'automation' | 'provider' | 'ai';
}

export interface GuardContext<Row = Record<string, unknown>> {
  tx: Tx;
  entity: Row;
  from: string;
  to: string;
  request: TransitionRequest;
  actor: TransitionActor;
}

/**
 * A guard either returns nothing (allow) or throws an AppError explaining
 * exactly what is missing. It may also return column updates to apply as part
 * of the same transition - for instance stamping `lost_reason` when moving to
 * `lost`.
 */
export type Guard<Row = Record<string, unknown>> = (
  ctx: GuardContext<Row>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export interface StateMachine<Row = Record<string, unknown>> {
  /** Used in the transition ledger and in events. */
  entityType: string;
  table: string;
  /** Name of the lifecycle column. */
  column: string;
  states: readonly string[];
  /** Allowed edges. A state absent from the map has no outgoing transitions. */
  transitions: Readonly<Record<string, readonly string[]>>;
  /** States that can never be left. */
  terminal?: readonly string[];
  /** Target states that must be accompanied by a reason. */
  requiresReason?: readonly string[];
  /** Guards run when entering the keyed state. */
  guards?: Readonly<Record<string, Guard<Row>>>;
  /** Guards run for any transition, before the state-specific one. */
  globalGuard?: Guard<Row>;
}

export interface TransitionResult<Row = Record<string, unknown>> {
  entity: Row;
  from: string;
  to: string;
  transitionId: string;
}

/**
 * The transition map alone. Guards make StateMachine contravariant in its row
 * type, so these read-only helpers take just the part they use and work with
 * any concrete machine.
 */
export type TransitionMap = Pick<StateMachine<never>, 'transitions' | 'terminal'>;

export function canTransition(machine: TransitionMap, from: string, to: string): boolean {
  if (machine.terminal?.includes(from)) return false;
  return (machine.transitions[from] ?? []).includes(to);
}

/** The states reachable from `from`, for rendering the available actions. */
export function availableTransitions(machine: TransitionMap, from: string): string[] {
  if (machine.terminal?.includes(from)) return [];
  return [...(machine.transitions[from] ?? [])];
}

export async function performTransition<Row extends Record<string, unknown>>(
  tx: Tx,
  machine: StateMachine<Row>,
  entityId: string,
  request: TransitionRequest,
  actor: TransitionActor,
): Promise<TransitionResult<Row>> {
  const orgId = tx.context.orgId;
  if (!orgId) throw new AppError('ORG_CONTEXT_REQUIRED', 'No organisation context for this request.');

  if (!machine.states.includes(request.to)) {
    throw new AppError('INVALID_TRANSITION', `"${request.to}" is not a valid ${machine.entityType} state.`, {
      details: { validStates: machine.states },
    });
  }

  // Lock the row. Two users clicking "Mark won" at the same moment serialise
  // here, and the second one sees the state the first produced.
  const entity = await tx.maybeOne<Row>(
    `select * from ${machine.table} where id = $1 for update`,
    [entityId],
  );

  if (!entity) {
    // RLS may also have filtered it; from the caller's side these are the same.
    throw new AppError('NOT_FOUND', `${machine.entityType} was not found.`);
  }

  const from = String(entity[machine.column] ?? '');

  if (from === request.to) {
    throw new AppError('INVALID_TRANSITION', `This ${machine.entityType} is already ${request.to}.`, {
      details: { from, to: request.to },
    });
  }

  if (machine.terminal?.includes(from)) {
    throw new AppError(
      'INVALID_TRANSITION',
      `A ${machine.entityType} in state "${from}" is final and cannot be changed.`,
      { details: { from, to: request.to, terminal: true } },
    );
  }

  if (!canTransition(machine, from, request.to)) {
    throw new AppError(
      'INVALID_TRANSITION',
      `A ${machine.entityType} cannot move from "${from}" to "${request.to}".`,
      { details: { from, to: request.to, allowed: availableTransitions(machine, from) } },
    );
  }

  if (machine.requiresReason?.includes(request.to)) {
    const reason = request.reason?.trim() ?? '';
    if (reason.length < 3) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Moving to "${request.to}" requires a reason.`,
        { details: { field: 'reason' } },
      );
    }
  }

  const guardContext: GuardContext<Row> = { tx, entity, from, to: request.to, request, actor };

  let updates: Record<string, unknown> = {};
  if (machine.globalGuard) {
    const result = await machine.globalGuard(guardContext);
    if (result) updates = { ...updates, ...result };
  }
  const guard = machine.guards?.[request.to];
  if (guard) {
    const result = await guard(guardContext);
    if (result) updates = { ...updates, ...result };
  }

  // From here the transaction is authorised to move a lifecycle column.
  await tx.enterTransition();

  const setColumns = [machine.column, ...Object.keys(updates)];
  const setValues = [request.to, ...Object.values(updates)];
  const assignments = setColumns.map((c, i) => `${quoteIdent(c)} = $${i + 2}`).join(', ');

  const updated = await tx.one<Row>(
    `update ${machine.table} set ${assignments} where id = $1 returning *`,
    [entityId, ...setValues],
  );

  const ledger = await tx.one<{ id: string }>(
    `insert into state_transitions
       (org_id, entity_type, entity_id, from_state, to_state, reason, metadata, actor_user_id, actor_type, request_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning id`,
    [
      orgId,
      machine.entityType,
      entityId,
      from,
      request.to,
      request.reason ?? null,
      JSON.stringify(request.payload ?? {}),
      actor.userId ?? null,
      actor.actorType ?? 'user',
      tx.context.requestId ?? null,
    ],
  );

  return { entity: updated, from, to: request.to, transitionId: ledger.id };
}

/**
 * Only identifiers we generate reach here, but the update statement is built by
 * string concatenation, so validate rather than trust.
 */
function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe column identifier: ${name}`);
  }
  return `"${name}"`;
}
