import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';

/**
 * The signed-in user, their organisation and their effective permissions.
 * The client uses the permission list to decide what to render; the server
 * re-checks everything regardless.
 */
export const GET = route({ rateLimit: false }, async ({ ctx, requestId }) => {
  return ok(
    {
      user: ctx.user,
      organization: ctx.org,
      permissions: ctx.permissions.toArray(),
      roles: ctx.roleKeys,
      team_ids: ctx.teamIds,
      is_owner: ctx.isOwner,
      memberships: ctx.memberships,
    },
    requestId,
  );
});
