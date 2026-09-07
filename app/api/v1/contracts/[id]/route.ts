import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { getContract, contractReadiness } from '@/lib/services/contracts';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { anyPermission: ['contract:read:own', 'contract:read:team', 'contract:read:org'], params },
  async ({ ctx, params: { id }, db, requestId }) => {
    const result = await db(
      async (tx) => ({
        ...(await getContract(tx, ctx, id)),
        readiness: await contractReadiness(tx, id),
      }),
      { readOnly: true },
    );
    return ok(result, requestId);
  },
);
