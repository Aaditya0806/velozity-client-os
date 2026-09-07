import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { setSigners, signerSchema } from '@/lib/services/contracts';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const PUT = route(
  {
    anyPermission: ['contract:update:own', 'contract:update:team', 'contract:update:org'],
    params,
    body: z.object({ signers: z.array(signerSchema).min(2) }),
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const result = await db((tx) => setSigners(tx, ctx, id, body.signers));
    return ok(result, requestId);
  },
);
