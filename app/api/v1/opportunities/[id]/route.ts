import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import {
  getOpportunity, updateOpportunity, opportunityUpdateSchema,
} from '@/lib/services/opportunities';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { anyPermission: ['opportunity:read:own', 'opportunity:read:team', 'opportunity:read:org'], params },
  async ({ ctx, params: { id }, db, requestId }) => {
    const opportunity = await db((tx) => getOpportunity(tx, ctx, id), { readOnly: true });
    return ok(opportunity, requestId);
  },
);

/**
 * Note the absence of `stage` from the update schema. Moving an opportunity
 * between stages is a transition, not a field edit, and goes through
 * POST /api/v1/opportunities/{id}/transitions. The database rejects it here too.
 */
export const PATCH = route(
  {
    anyPermission: ['opportunity:update:own', 'opportunity:update:team', 'opportunity:update:org'],
    params,
    body: opportunityUpdateSchema,
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const opportunity = await db((tx) => updateOpportunity(tx, ctx, id, body));
    return ok(opportunity, requestId);
  },
);
