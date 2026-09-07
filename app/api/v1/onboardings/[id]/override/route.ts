import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { overrideLegalGate } from '@/lib/services/onboarding';
import { uuid, overrideReason } from '@/lib/validation/common';

const params = z.object({ id: uuid });

/**
 * Forces onboarding past the legal gate.
 *
 * Requires `legal:override:org` - held only by Legal/Admin and Super Admin - and
 * a written justification of at least 20 characters. The result is an immutable
 * record and a permanent banner on the client. There is no endpoint to undo it.
 */
export const POST = route(
  {
    permission: 'legal:override:org',
    params,
    idempotent: true,
    body: z.object({ reason: overrideReason }),
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const result = await db((tx) => overrideLegalGate(tx, ctx, id, body.reason));
    return ok(result, requestId);
  },
);
