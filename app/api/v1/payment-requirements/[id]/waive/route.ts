import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { waiveRequirement } from '@/lib/services/payments';
import { uuid, meaningfulReason } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const POST = route(
  {
    permission: 'finance:manage:org',
    params,
    body: z.object({ reason: meaningfulReason }),
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const result = await db((tx) => waiveRequirement(tx, ctx, id, body.reason));
    return ok(result, requestId);
  },
);
