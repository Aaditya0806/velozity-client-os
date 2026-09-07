import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { submitForReview } from '@/lib/services/proposals';
import { uuid } from '@/lib/validation/common';

const params = z.object({ versionId: uuid });

export const POST = route(
  {
    anyPermission: ['proposal:update:own', 'proposal:update:team', 'proposal:update:org'],
    params,
  },
  async ({ ctx, params: { versionId }, db, requestId }) => {
    const result = await db((tx) => submitForReview(tx, ctx, versionId));
    return ok(result, requestId);
  },
);
