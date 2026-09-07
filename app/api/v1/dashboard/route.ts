import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { getDashboard, dashboardQuerySchema } from '@/lib/services/reporting';

export const GET = route(
  { query: dashboardQuerySchema },
  async ({ ctx, query, db, requestId }) => {
    const data = await db((tx) => getDashboard(tx, ctx, query), { readOnly: true });
    return ok(data, requestId);
  },
);
