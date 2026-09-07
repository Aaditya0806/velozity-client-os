import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { getSolution, updateSolution, solutionUpdateSchema } from '@/lib/services/solutions';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { anyPermission: ['opportunity:read:own', 'opportunity:read:team', 'opportunity:read:org'], params },
  async ({ ctx, params: { id }, db, requestId }) => {
    const solution = await db((tx) => getSolution(tx, ctx, id), { readOnly: true });
    return ok(solution, requestId);
  },
);

export const PATCH = route(
  {
    anyPermission: ['opportunity:update:own', 'opportunity:update:team', 'opportunity:update:org'],
    params,
    body: solutionUpdateSchema,
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const solution = await db((tx) => updateSolution(tx, ctx, id, body));
    return ok(solution, requestId);
  },
);
