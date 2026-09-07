import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { acceptVersion, declineVersion, acceptanceSchema } from '@/lib/services/proposals';
import { uuid, meaningfulReason } from '@/lib/validation/common';

const params = z.object({ versionId: uuid });

/**
 * Records the client's decision. Acceptance is the moment the version becomes
 * immutable and becomes the source of truth for any agreement generated later.
 */
export const POST = route(
  {
    anyPermission: ['proposal:update:own', 'proposal:update:team', 'proposal:update:org'],
    params,
    idempotent: true,
    body: z.discriminatedUnion('decision', [
      z.object({ decision: z.literal('accept') }).merge(acceptanceSchema),
      z.object({ decision: z.literal('decline'), reason: meaningfulReason }),
    ]),
  },
  async ({ ctx, params: { versionId }, body, db, requestId }) => {
    const result = await db<Record<string, unknown>>((tx) =>
      body.decision === 'accept'
        ? acceptVersion(tx, ctx, versionId, body)
        : declineVersion(tx, ctx, versionId, body.reason),
    );
    return ok(result, requestId);
  },
);
