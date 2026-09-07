import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { markReady, evaluateGate } from '@/lib/services/onboarding';
import { performTransition } from '@/lib/workflows/state-machine';
import { onboardingMachine } from '@/lib/workflows/machines';
import { AppError } from '@/lib/http/errors';
import { uuid, transitionBody } from '@/lib/validation/common';

const params = z.object({ id: uuid });

/** The current gate evaluation, so the UI can list exactly what is outstanding. */
export const GET = route(
  { permission: 'onboarding:read:org', params },
  async ({ params: { id }, db, requestId }) => {
    const gate = await db((tx) => evaluateGate(tx, id));
    return ok(gate, requestId);
  },
);

export const POST = route(
  { permission: 'onboarding:manage:org', params, body: transitionBody },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const result = await db(async (tx) => {
      if (body.to === 'ready') {
        // The gate lives here. It is evaluated again by a database trigger.
        return markReady(tx, ctx, id);
      }
      if (body.to === 'blocked') {
        throw new AppError(
          'INVALID_TRANSITION',
          'Onboarding cannot be moved back to blocked. Raise the requirement that is missing instead.',
        );
      }
      return performTransition(tx, onboardingMachine, id, body, { userId: ctx.user.id });
    });
    return ok({ from: result.from, to: result.to, entity: result.entity }, requestId);
  },
);
