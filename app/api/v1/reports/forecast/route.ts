import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { getForecast, forecastQuerySchema } from '@/lib/services/forecasting';

export const GET = route(
  { permission: 'report:read:org', query: forecastQuerySchema },
  async ({ ctx, query, db, requestId }) => {
    const forecast = await db((tx) => getForecast(tx, ctx, query), { readOnly: true });
    return ok(forecast, requestId);
  },
);
