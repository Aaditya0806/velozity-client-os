import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { uuid } from '@/lib/validation/common';
import { transitionRenewal, renewalTransitionSchema } from '@/lib/services/renewals';

const params = z.object({ id: uuid });

/**
 * The only way a renewal's status changes.
 *
 * Same shape as every other lifecycle in the product, and for the same reason:
 * the `status` column is guarded by a trigger that refuses any write not made
 * through the transition channel, so this is not merely the preferred route —
 * it is the only one that works.
 */
export const POST = route(
  {
    anyPermission: ['renewal:update:own', 'renewal:update:team', 'renewal:update:org'],
    params,
    body: renewalTransitionSchema,
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const result = await db((tx) => transitionRenewal(tx, ctx, id, body));
    return ok(result, requestId);
  },
);
