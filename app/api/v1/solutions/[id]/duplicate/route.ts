import { z } from 'zod';
import { route } from '@/lib/http/api';
import { created } from '@/lib/http/response';
import { duplicateSolution } from '@/lib/services/solutions';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const POST = route(
  {
    anyPermission: ['opportunity:update:own', 'opportunity:update:team', 'opportunity:update:org'],
    params,
  },
  async ({ ctx, params: { id }, db, requestId }) => {
    const copy = await db((tx) => duplicateSolution(tx, ctx, id));
    return created(copy, requestId, `/api/v1/solutions/${copy.id}`);
  },
);
