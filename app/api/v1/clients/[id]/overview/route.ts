import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { getClientOverview } from '@/lib/services/client360';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { anyPermission: ['company:read:own', 'company:read:team', 'company:read:org'], params },
  async ({ ctx, params: { id }, db, requestId }) => {
    const overview = await db((tx) => getClientOverview(tx, ctx, id), { readOnly: true });
    return ok(overview, requestId);
  },
);
