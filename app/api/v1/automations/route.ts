import { route } from '@/lib/http/api';
import { ok, created } from '@/lib/http/response';
import { automationSchema } from '@/lib/automation/actions';
import { writeAudit } from '@/lib/audit';
import { newId } from '@/lib/util/ids';

export const GET = route(
  { permission: 'automation:read:org' },
  async ({ db, requestId }) => {
    const automations = await db(
      (tx) =>
        tx.many<Record<string, unknown>>(
          `select id, name, description, is_active, trigger_event, trigger_filter,
                  conditions, actions, max_depth, cooldown_seconds,
                  run_count, last_run_at, last_error, created_at, updated_at
             from automations
            where deleted_at is null
            order by is_active desc, name`,
        ),
      { readOnly: true },
    );
    return ok({ automations }, requestId);
  },
);

/**
 * Creates an automation.
 *
 * The body is validated against the same `automationSchema` the engine uses, so
 * an automation that would not run cannot be saved. In particular the action
 * enumeration is closed and contains no `send_email` — a rule that lives in the
 * schema rather than in a check here, because a rule enforced in one place is a
 * rule and a rule enforced in two is a coincidence.
 *
 * New automations are created inactive whatever the body says. Switching one on
 * is a separate, deliberate act.
 */
export const POST = route(
  { permission: 'automation:manage:org', body: automationSchema },
  async ({ ctx, body, db, requestId }) => {
    const id = newId();

    await db(async (tx) => {
      await tx.query(
        `insert into automations (
           id, org_id, name, description, is_active, trigger_event, trigger_filter,
           conditions, actions, max_depth, cooldown_seconds, created_by
         ) values ($1,$2,$3,$4,false,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id, ctx.org.id, body.name, body.description ?? null,
          body.trigger_event, JSON.stringify(body.trigger_filter),
          JSON.stringify(body.conditions), JSON.stringify(body.actions),
          body.max_depth, body.cooldown_seconds, ctx.user.id,
        ],
      );

      await writeAudit(tx, {
        orgId: ctx.org.id,
        action: 'automation.created',
        category: 'automation',
        actorUserId: ctx.user.id,
        entityType: 'automation',
        entityId: id,
        summary: `Created automation "${body.name}"`,
        metadata: { trigger_event: body.trigger_event, action_count: body.actions.length },
        requestId,
      });
    });

    return created({ id, is_active: false }, requestId);
  },
);
