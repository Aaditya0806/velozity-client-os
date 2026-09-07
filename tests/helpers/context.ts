/**
 * Builds a RequestContext for tests without going through Supabase Auth.
 * Permissions are read from the database exactly as the real resolver does, so
 * a test cannot accidentally grant itself rights the role does not have.
 */
import type { SqlDriver } from '@/lib/db/types';
import type { RequestContext } from '@/lib/auth/session';
import { buildPermissionSet } from '@/lib/permissions';

export async function testContext(
  db: SqlDriver,
  userId: string,
  orgId: string,
  requestId = 'req_test',
): Promise<RequestContext> {
  const profile = await db.query<{ email: string; full_name: string; timezone: string; status: string }>(
    `select email, full_name, timezone, status from user_profiles where id = $1`,
    [userId],
  );
  const org = await db.query<{
    name: string; slug: string; base_currency: string; timezone: string;
    ai_enabled: boolean; is_demo: boolean;
  }>(
    `select name, slug, base_currency, timezone, ai_enabled, is_demo from organizations where id = $1`,
    [orgId],
  );
  const perms = await db.query<{ key: string }>(
    `select distinct p.key from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     join permissions p on p.id = rp.permission_id
     where ur.org_id = $1 and ur.user_id = $2`,
    [orgId, userId],
  );
  const roles = await db.query<{ key: string }>(
    `select r.key from user_roles ur join roles r on r.id = ur.role_id
     where ur.org_id = $1 and ur.user_id = $2`,
    [orgId, userId],
  );
  const teams = await db.query<{ team_id: string }>(
    `select team_id from team_members where org_id = $1 and user_id = $2`,
    [orgId, userId],
  );

  const p = profile.rows[0];
  const o = org.rows[0];
  if (!p || !o) throw new Error('testContext: unknown user or organisation');

  return {
    requestId,
    user: {
      id: userId,
      email: p.email,
      fullName: p.full_name,
      avatarUrl: null,
      jobTitle: null,
      timezone: p.timezone,
      status: p.status,
    },
    org: {
      id: orgId,
      name: o.name,
      slug: o.slug,
      baseCurrency: o.base_currency,
      timezone: o.timezone,
      aiEnabled: o.ai_enabled,
      isDemo: o.is_demo,
    },
    permissions: buildPermissionSet(perms.rows.map((r) => r.key)),
    teamIds: teams.rows.map((r) => r.team_id),
    roleKeys: roles.rows.map((r) => r.key),
    isOwner: false,
    memberships: [{ id: orgId, name: o.name, slug: o.slug }],
  };
}
