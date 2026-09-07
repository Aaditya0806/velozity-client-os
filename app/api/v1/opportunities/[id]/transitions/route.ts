import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { transitionOpportunity, getTransitionHistory } from '@/lib/services/opportunities';
import { opportunityMachine } from '@/lib/workflows/machines';
import { availableTransitions } from '@/lib/workflows/state-machine';
import { uuid, transitionBody } from '@/lib/validation/common';

const params = z.object({ id: uuid });

/**
 * The transition ledger for this opportunity, plus the moves currently
 * available, so a UI can render the right actions without hardcoding the machine.
 */
export const GET = route(
  { anyPermission: ['opportunity:read:own', 'opportunity:read:team', 'opportunity:read:org'], params },
  async ({ params: { id }, db, requestId }) => {
    const result = await db(
      async (tx) => {
        const current = await tx.one<{ stage: string }>(
          'select stage from opportunities where id = $1 and deleted_at is null',
          [id],
        );
        const history = await getTransitionHistory(tx, 'opportunity', id);
        return {
          current_stage: current.stage,
          available: availableTransitions(opportunityMachine, current.stage),
          history,
        };
      },
      { readOnly: true },
    );
    return ok(result, requestId);
  },
);

export const POST = route(
  {
    anyPermission: ['opportunity:update:own', 'opportunity:update:team', 'opportunity:update:org'],
    params,
    body: transitionBody,
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const result = await db((tx) => transitionOpportunity(tx, ctx, id, body), {
      retryOnConflict: true,
    });
    return ok(
      {
        id,
        from: result.from,
        to: result.to,
        transition_id: result.transitionId,
        entity: result.entity,
      },
      requestId,
    );
  },
);
