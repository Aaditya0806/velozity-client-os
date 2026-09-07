import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { markVersionSent } from '@/lib/services/proposals';
import { uuid } from '@/lib/validation/common';

const params = z.object({ versionId: uuid });

export const POST = route(
  {
    permission: 'proposal:send:org',
    params,
    idempotent: true,
    body: z.object({
      recipients: z
        .array(
          z.object({
            contact_id: uuid.optional(),
            email: z.string().email(),
            name: z.string().max(200).optional(),
          }),
        )
        .min(1),
    }),
  },
  async ({ ctx, params: { versionId }, body, db, requestId }) => {
    const result = await db((tx) => markVersionSent(tx, ctx, versionId, body.recipients));
    return ok(result, requestId);
  },
);
