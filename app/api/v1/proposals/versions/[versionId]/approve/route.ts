import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { approveVersion, rejectVersion } from '@/lib/services/proposals';
import { uuid, meaningfulReason, nullableText } from '@/lib/validation/common';

const params = z.object({ versionId: uuid });

/**
 * Internal approval. `proposal:approve:org` is required here, and the RLS policy
 * on proposal_approvals additionally forbids recording a decision in anyone
 * else's name.
 */
export const POST = route(
  {
    permission: 'proposal:approve:org',
    params,
    body: z.object({
      decision: z.enum(['approve', 'reject']),
      comment: nullableText(2000),
      reason: meaningfulReason.optional(),
    }),
  },
  async ({ ctx, params: { versionId }, body, db, requestId }) => {
    const result = await db((tx) =>
      body.decision === 'approve'
        ? approveVersion(tx, ctx, versionId, body.comment ?? null)
        : rejectVersion(tx, ctx, versionId, body.reason ?? body.comment ?? ''),
    );
    return ok(result, requestId);
  },
);
