import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { uuid } from '@/lib/validation/common';
import { automationSchema } from '@/lib/automation/actions';
import { writeAudit } from '@/lib/audit';
import { AppError } from '@/lib/http/errors';

const params = z.object({ id: uuid });

// Everything is optional on an update, but `is_active` is its own field rather
// than part of the definition: turning an automation on is a different decision
// from changing what it does, and the audit trail should say which happened.
const patchSchema = automationSchema.partial().extend({
  is_active: z.boolean().optional(),
});

export const GET = route(
  { permission: 'automation:read:org', params },
  async ({ params: { id }, db, requestId }) => {
    const automation = await db(
      (tx) =>
        tx.maybeOne<Record<string, unknown>>(
          `select * from automations where id = $1 and deleted_at is null`,
          [id],
        ),
      { readOnly: true },
    );
    if (!automation) throw new AppError('NOT_FOUND', 'That automation was not found.');

    const runs = await db(
      (tx) =>
        tx.many<Record<string, unknown>>(
          `select id, status, created_at, duration_ms, depth, entity_type, entity_id, error
             from automation_runs
            where automation_id = $1
            order by created_at desc
            limit 25`,
          [id],
        ),
      { readOnly: true },
    );

    return ok({ automation, runs }, requestId);
  },
);

export const PATCH = route(
  { permission: 'automation:manage:org', params, body: patchSchema },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const result = await db(async (tx) => {
      const existing = await tx.maybeOne<{ name: string; is_active: boolean }>(
        `select name, is_active from automations where id = $1 and deleted_at is null`,
        [id],
      );
      if (!existing) throw new AppError('NOT_FOUND', 'That automation was not found.');

      // Built as a sparse update so an unmentioned field is left alone rather
      // than reset to a default the caller never asked for.
      const sets: string[] = [];
      const values: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      };

      if (body.name !== undefined) set('name', body.name);
      if (body.description !== undefined) set('description', body.description);
      if (body.is_active !== undefined) set('is_active', body.is_active);
      if (body.trigger_event !== undefined) set('trigger_event', body.trigger_event);
      if (body.trigger_filter !== undefined) set('trigger_filter', JSON.stringify(body.trigger_filter));
      if (body.conditions !== undefined) set('conditions', JSON.stringify(body.conditions));
      if (body.actions !== undefined) set('actions', JSON.stringify(body.actions));
      if (body.max_depth !== undefined) set('max_depth', body.max_depth);
      if (body.cooldown_seconds !== undefined) set('cooldown_seconds', body.cooldown_seconds);

      if (sets.length === 0) return { id, changed: false };

      // Clearing last_error on an edit: the recorded failure belonged to the
      // previous definition and saying otherwise would be misleading.
      await tx.query(
        `update automations set ${sets.join(', ')}, last_error = null where id = $1`,
        values,
      );

      const activationChanged =
        body.is_active !== undefined && body.is_active !== existing.is_active;

      await writeAudit(tx, {
        orgId: ctx.org.id,
        action: activationChanged
          ? body.is_active
            ? 'automation.activated'
            : 'automation.deactivated'
          : 'automation.updated',
        category: 'automation',
        actorUserId: ctx.user.id,
        entityType: 'automation',
        entityId: id,
        summary: activationChanged
          ? `${body.is_active ? 'Activated' : 'Deactivated'} automation "${existing.name}"`
          : `Updated automation "${existing.name}"`,
        metadata: { fields: sets.map((s) => s.split(' = ')[0]) },
        requestId,
      });

      return { id, changed: true };
    });

    return ok(result, requestId);
  },
);

/**
 * Soft-deletes an automation.
 *
 * The run history references it, and a deleted row would take the explanation
 * for every past run with it.
 */
export const DELETE = route(
  { permission: 'automation:manage:org', params },
  async ({ ctx, params: { id }, db, requestId }) => {
    await db(async (tx) => {
      const existing = await tx.maybeOne<{ name: string }>(
        `select name from automations where id = $1 and deleted_at is null`,
        [id],
      );
      if (!existing) throw new AppError('NOT_FOUND', 'That automation was not found.');

      await tx.query(
        `update automations set deleted_at = now(), is_active = false where id = $1`,
        [id],
      );

      await writeAudit(tx, {
        orgId: ctx.org.id,
        action: 'automation.deleted',
        category: 'automation',
        severity: 'warning',
        actorUserId: ctx.user.id,
        entityType: 'automation',
        entityId: id,
        summary: `Deleted automation "${existing.name}"`,
        requestId,
      });
    });

    return ok({ id, deleted: true }, requestId);
  },
);
