import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { voidSignatureRequest } from '@/lib/services/signature-requests';
import { uuid, meaningfulReason } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const POST = route(
  {
    permission: 'contract:void:org',
    params,
    idempotent: true,
    body: z.object({ reason: meaningfulReason }),
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const result = await db((tx) => voidSignatureRequest(tx, ctx, id, body.reason));
    return ok(result, requestId);
  },
);
