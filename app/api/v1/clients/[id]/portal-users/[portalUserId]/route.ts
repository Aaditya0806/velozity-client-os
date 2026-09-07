import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { uuid } from '@/lib/validation/common';
import { writeAudit } from '@/lib/audit';

const params = z.object({ id: uuid, portalUserId: uuid });

const body = z.object({
  can_view_invoices: z.boolean(),
  can_view_documents: z.boolean(),
  can_approve_deliverables: z.boolean(),
});

/** Changes what an existing portal user may see. */
export const PATCH = route(
  {
    anyPermission: ['company:update:own', 'company:update:team', 'company:update:org'],
    params,
    body,
  },
  async ({ ctx, params: { id, portalUserId }, body: input, db, requestId }) => {
    const result = await db(async (tx) => {
      const row = await tx.one<{ result: unknown }>(
        `select app.set_portal_access($1, $2, $3, $4) as result`,
        [
          portalUserId,
          input.can_view_invoices,
          input.can_view_documents,
          input.can_approve_deliverables,
        ],
      );

      await writeAudit(tx, {
        orgId: ctx.org.id,
        action: 'portal.access_changed',
        category: 'security',
        actorUserId: ctx.user.id,
        entityType: 'company',
        entityId: id,
        summary: 'Changed portal access',
        metadata: { portal_user_id: portalUserId, ...input },
        requestId,
      });

      return row.result;
    });

    return ok(result, requestId);
  },
);

/**
 * Revokes access.
 *
 * The row is marked revoked rather than deleted. "Who could see our invoices,
 * and until when" is a question asked during an access review, and a deleted
 * row answers it with silence.
 */
export const DELETE = route(
  {
    anyPermission: ['company:update:own', 'company:update:team', 'company:update:org'],
    params,
  },
  async ({ ctx, params: { id, portalUserId }, db, requestId }) => {
    const result = await db(async (tx) => {
      const row = await tx.one<{ result: unknown }>(
        `select app.revoke_portal_access($1) as result`,
        [portalUserId],
      );

      await writeAudit(tx, {
        orgId: ctx.org.id,
        action: 'portal.access_revoked',
        category: 'security',
        severity: 'warning',
        actorUserId: ctx.user.id,
        entityType: 'company',
        entityId: id,
        summary: 'Revoked portal access',
        metadata: { portal_user_id: portalUserId },
        requestId,
      });

      return row.result;
    });

    return ok(result, requestId);
  },
);
