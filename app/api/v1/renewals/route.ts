import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { listRenewals, renewalListSchema, getRenewalSummary } from '@/lib/services/renewals';

export const GET = route(
  {
    anyPermission: ['renewal:read:own', 'renewal:read:team', 'renewal:read:org'],
    query: renewalListSchema,
  },
  async ({ ctx, query, db, requestId }) => {
    const { rows, total, summary } = await db(
      async (tx) => {
        const list = await listRenewals(tx, query);
        return { ...list, summary: await getRenewalSummary(tx, ctx) };
      },
      { readOnly: true },
    );

    return ok({ renewals: rows, summary }, requestId, {
      page: query.page,
      page_size: query.page_size,
      total,
    });
  },
);
