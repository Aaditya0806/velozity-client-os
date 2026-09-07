import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { getProfitability } from '@/lib/services/forecasting';

/**
 * Cost and margin, so the permission is `cost:read` rather than `report:read`.
 * Being allowed to see reports is not the same as being allowed to see what
 * delivery costs.
 */
export const GET = route({ permission: 'cost:read:org' }, async ({ ctx, db, requestId }) => {
  const report = await db((tx) => getProfitability(tx, ctx), { readOnly: true });
  return ok(report, requestId);
});
