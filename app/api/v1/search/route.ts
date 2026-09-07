import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { globalSearch } from '@/lib/services/reporting';

export const GET = route(
  {
    query: z.object({
      q: z.string().trim().min(2).max(120),
      limit: z.coerce.number().int().min(1).max(20).default(8),
    }),
  },
  async ({ ctx, query, db, requestId }) => {
    const results = await db((tx) => globalSearch(tx, ctx, query.q, query.limit), {
      readOnly: true,
    });
    return ok(results, requestId);
  },
);
