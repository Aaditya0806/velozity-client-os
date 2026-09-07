/**
 * The automation engine.
 *
 * WHEN an event fires, IF the conditions hold against a snapshot, THEN a fixed
 * set of actions runs. Every run is recorded with its input snapshot, its
 * condition results and a per-action outcome, so "why did this happen?" is
 * always answerable from the database.
 *
 * Loop protection has two independent parts:
 *   - depth, so a chain A→B→A stops at max_depth;
 *   - a cooldown, so the same automation cannot re-fire on the same entity
 *     within its configured window.
 * Both are checked before any action runs, and a suppressed run is still
 * recorded — silence would be indistinguishable from a bug.
 */
import { randomUUID } from 'node:crypto';
import type { Tx } from '@/lib/db';
import { withService } from '@/lib/db';
import { emitEvent, recordActivity, notify } from '@/lib/events';
import { writeAudit } from '@/lib/audit';
import { logger } from '@/lib/util/logger';
import { evaluateConditions, matchesTriggerFilter, type ConditionResult } from './conditions';
import { actionSchema, type AutomationAction, type Condition } from './actions';
import { buildSnapshot } from './snapshot';
import { executeAction } from './executors';

export interface AutomationRow {
  id: string;
  org_id: string;
  name: string;
  trigger_event: string;
  trigger_filter: Record<string, unknown>;
  conditions: Condition[];
  actions: unknown[];
  max_depth: number;
  cooldown_seconds: number;
}

export interface EventRow {
  id: string;
  org_id: string;
  name: string;
  entity_type: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
  actor_user_id: string | null;
  depth: number;
}

/**
 * Dispatches one event: runs every matching automation, then marks the event
 * processed. Called by the worker.
 */
export async function dispatchEvent(eventId: string): Promise<void> {
  await withService('dispatch domain event', async (tx) => {
    const event = await tx.maybeOne<EventRow & { status: string; attempts: number }>(
      `select id, org_id, name, entity_type, entity_id, payload, actor_user_id, depth,
              status, attempts
       from events where id = $1 for update`,
      [eventId],
    );
    if (!event) return;
    if (event.status === 'processed') return;

    await tx.bindOrg(event.org_id);
    await tx.query(
      `update events set status = 'processing', attempts = attempts + 1 where id = $1`,
      [eventId],
    );

    try {
      const automations = await tx.many<AutomationRow>(
        `select id, org_id, name, trigger_event, trigger_filter, conditions, actions,
                max_depth, cooldown_seconds
         from automations
         where org_id = $1 and trigger_event = $2 and is_active and deleted_at is null`,
        [event.org_id, event.name],
      );

      for (const automation of automations) {
        await runAutomation(tx, automation, event);
      }

      await tx.query(
        `update events set status = 'processed', processed_at = now(), last_error = null
         where id = $1`,
        [eventId],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Event dispatch failed', { event_id: eventId, error });
      await tx.query(
        `update events set status = 'failed', last_error = $2 where id = $1`,
        [eventId, message.slice(0, 2000)],
      );
      throw error;
    }
  });
}

export async function runAutomation(
  tx: Tx,
  automation: AutomationRow,
  event: EventRow,
): Promise<void> {
  const runId = randomUUID();
  const startedAt = Date.now();

  const record = async (
    status: string,
    snapshot: unknown,
    conditionResults: ConditionResult[],
    error?: string,
  ) => {
    await tx.query(
      `insert into automation_runs (
         id, org_id, automation_id, event_id, entity_type, entity_id, status,
         input_snapshot, condition_results, depth, started_at, finished_at, duration_ms, error
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11 / 1000.0),now(),$12,$13)`,
      [
        runId, automation.org_id, automation.id, event.id, event.entity_type,
        event.entity_id, status, JSON.stringify(snapshot ?? {}),
        JSON.stringify(conditionResults), event.depth, startedAt,
        Date.now() - startedAt, error ?? null,
      ],
    );
  };

  // Trigger filter first: it is the cheapest test and needs no snapshot.
  if (!matchesTriggerFilter(event.payload ?? {}, automation.trigger_filter ?? {})) {
    return;
  }

  // Depth. An event produced by an automation carries depth + 1.
  if (event.depth >= automation.max_depth) {
    logger.warn('Automation suppressed: chain depth exceeded', {
      automation_id: automation.id,
      depth: event.depth,
      max_depth: automation.max_depth,
    });
    await record('skipped_depth', { event }, []);
    return;
  }

  // Cooldown. Prevents the same automation firing repeatedly on one entity.
  const cooling = await tx.one<{ in_cooldown: boolean }>(
    `select app.automation_in_cooldown($1, $2, $3) as in_cooldown`,
    [automation.id, event.entity_id, automation.cooldown_seconds],
  );
  if (cooling.in_cooldown) {
    logger.info('Automation suppressed: within cooldown', {
      automation_id: automation.id,
      entity_id: event.entity_id,
      cooldown_seconds: automation.cooldown_seconds,
    });
    await record('skipped_cooldown', { event }, []);
    return;
  }

  // The snapshot is assembled once and stored, so the run history shows exactly
  // what the conditions were judged against.
  const snapshot = await buildSnapshot(tx, event);
  const { passed, results } = evaluateConditions(snapshot, automation.conditions ?? []);

  if (!passed) {
    await record('conditions_failed', snapshot, results);
    return;
  }

  await record('running', snapshot, results);

  let failures = 0;
  let succeeded = 0;

  for (const [index, raw] of (automation.actions ?? []).entries()) {
    const parsed = actionSchema.safeParse(raw);

    if (!parsed.success) {
      // A stored action that no longer validates is a configuration error, not
      // something to guess about.
      await recordActionResult(tx, automation.org_id, runId, index, 'unknown', 'failed', raw, null,
        'This action is not a valid action definition.');
      failures++;
      continue;
    }

    const action: AutomationAction = parsed.data;
    const actionStarted = Date.now();

    try {
      const result = await executeAction(tx, {
        action,
        automation,
        event,
        snapshot,
        runId,
      });
      await recordActionResult(
        tx, automation.org_id, runId, index, action.type, 'succeeded',
        action.params, result, null, Date.now() - actionStarted,
      );
      succeeded++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Automation action failed', {
        automation_id: automation.id,
        run_id: runId,
        action_type: action.type,
        error,
      });
      await recordActionResult(
        tx, automation.org_id, runId, index, action.type, 'failed',
        action.params, null, message, Date.now() - actionStarted,
      );
      failures++;
      // Later actions still run: a failed notification should not prevent a
      // contract being drafted.
    }
  }

  const finalStatus =
    failures === 0 ? 'succeeded' : succeeded === 0 ? 'failed' : 'partially_failed';

  await tx.query(
    `update automation_runs set status = $2, finished_at = now(), duration_ms = $3 where id = $1`,
    [runId, finalStatus, Date.now() - startedAt],
  );

  await tx.query(
    `update automations set run_count = run_count + 1, last_run_at = now(),
            last_error = $2
     where id = $1`,
    [automation.id, failures > 0 ? `${failures} action(s) failed` : null],
  );

  await writeAudit(tx, {
    orgId: automation.org_id,
    action: 'automation.executed',
    category: 'automation',
    severity: failures > 0 ? 'warning' : 'info',
    actorType: 'automation',
    actorLabel: automation.name,
    entityType: event.entity_type,
    entityId: event.entity_id,
    summary: `Automation "${automation.name}" ran: ${succeeded} succeeded, ${failures} failed`,
    metadata: { run_id: runId, event: event.name, depth: event.depth },
  });
}

async function recordActionResult(
  tx: Tx,
  orgId: string,
  runId: string,
  index: number,
  actionType: string,
  status: 'succeeded' | 'failed' | 'skipped',
  params: unknown,
  result: unknown,
  error: string | null,
  durationMs?: number,
): Promise<void> {
  await tx.query(
    `insert into automation_action_results (
       org_id, run_id, action_index, action_type, status, params, result, error, duration_ms
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (run_id, action_index) do nothing`,
    [
      orgId, runId, index, actionType, status,
      JSON.stringify(params ?? {}),
      result === null || result === undefined ? null : JSON.stringify(result),
      error, durationMs ?? null,
    ],
  );
}

export { emitEvent, recordActivity, notify };
