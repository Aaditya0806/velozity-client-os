import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok, created } from '@/lib/http/response';
import { getProposal, createNewVersion } from '@/lib/services/proposals';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { anyPermission: ['proposal:read:own', 'proposal:read:team', 'proposal:read:org'], params },
  async ({ ctx, params: { id }, db, requestId }) => {
    const proposal = await db((tx) => getProposal(tx, ctx, id), { readOnly: true });
    return ok(proposal, requestId);
  },
);

/** Cuts a new draft version from the current one. */
export const POST = route(
  {
    anyPermission: ['proposal:update:own', 'proposal:update:team', 'proposal:update:org'],
    params,
  },
  async ({ ctx, params: { id }, db, requestId }) => {
    const version = await db((tx) => createNewVersion(tx, ctx, id));
    return created(version, requestId);
  },
);
