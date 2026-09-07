import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { getClientBilling } from '@/lib/services/client360';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

// Seeing a client does not imply seeing their money.
export const GET = route(
  { permission: 'finance:read:org', params },
  async ({ ctx, params: { id }, db, requestId }) => {
    const billing = await db((tx) => getClientBilling(tx, ctx, id), { readOnly: true });
    return ok(billing, requestId);
  },
);
