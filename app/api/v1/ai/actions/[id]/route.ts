import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { decideAction, executeAction, approvalSchema } from '@/lib/ai/actions';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

/**
 * Records a human decision on an AI draft, and applies it on approval.
 *
 * Both happen in one transaction so an approved action cannot be left approved
 * but unapplied, and the database refuses `executed` from anything that has not
 * passed through `approved`.
 */
export const POST = route(
  { permission: 'ai:approve:org', params, body: approvalSchema },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const result = await db(async (tx) => {
      const decision = await decideAction(tx, ctx, id, body);
      if (decision.status !== 'approved') return decision;
      const executed = await executeAction(tx, ctx, id);
      return { ...decision, status: 'executed', result: executed.result };
    });

    return ok(result, requestId);
  },
);
