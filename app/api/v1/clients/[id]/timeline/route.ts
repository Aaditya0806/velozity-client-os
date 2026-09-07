import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { getClientTimeline } from '@/lib/services/client360';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });
const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime({ offset: true }).optional(),
  types: z.string().optional(),
});

export const GET = route(
  { anyPermission: ['company:read:own', 'company:read:team', 'company:read:org'], params, query },
  async ({ ctx, params: { id }, query: q, db, requestId }) => {
    const timeline = await db(
      (tx) =>
        getClientTimeline(tx, ctx, id, {
          limit: q.limit,
          before: q.before,
          types: q.types ? q.types.split(',').filter(Boolean) : undefined,
        }),
      { readOnly: true },
    );
    return ok(timeline, requestId);
  },
);
