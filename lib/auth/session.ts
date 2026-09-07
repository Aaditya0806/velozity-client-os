/**
 * Session resolution and the request context every server path builds on.
 *
 * `requireContext()` answers three separate questions in order, and stops at
 * the first failure:
 *   1. Who is this?            (Supabase session -> user id)
 *   2. Is the account live?    (profile status, session watermark)
 *   3. What may they do here?  (membership in the active org, permission set)
 *
 * Nothing downstream re-derives any of this, and nothing downstream may skip it.
 */
import 'server-only';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { createSupabaseServerClient } from './supabase';
import { withTenant, withService } from '@/lib/db';
import { buildPermissionSet, type PermissionSet } from '@/lib/permissions';
import { AppError } from '@/lib/http/errors';
import { newRequestId } from '@/lib/util/ids';

export const ORG_COOKIE = 'velozity_org';

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  jobTitle: string | null;
  timezone: string;
  status: string;
}

export interface OrgContext {
  id: string;
  name: string;
  slug: string;
  baseCurrency: string;
  timezone: string;
  aiEnabled: boolean;
  isDemo: boolean;
}

export interface RequestContext {
  requestId: string;
  user: AuthenticatedUser;
  org: OrgContext;
  permissions: PermissionSet;
  teamIds: string[];
  roleKeys: string[];
  isOwner: boolean;
  /** All organisations this user belongs to, for the org switcher. */
  memberships: Array<{ id: string; name: string; slug: string }>;
}

interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
  job_title: string | null;
  timezone: string;
  status: string;
  sessions_valid_from: string;
}

/**
 * The Supabase Auth user for this request, or null.
 * Memoised per request so several Server Components do not each round-trip.
 */
export const getAuthUser = cache(
  async (): Promise<{ id: string; email: string; issuedAt: number } | null> => {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user?.id) return null;

    const { data: sessionData } = await supabase.auth.getSession();
    const issuedAt = sessionData.session?.expires_at
      ? // expires_at is seconds; derive issuance from the token payload instead
        decodeIssuedAt(sessionData.session.access_token)
      : Math.floor(Date.now() / 1000);

    return { id: data.user.id, email: data.user.email ?? '', issuedAt };
  },
);

function decodeIssuedAt(accessToken: string | undefined): number {
  if (!accessToken) return Math.floor(Date.now() / 1000);
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return Math.floor(Date.now() / 1000);
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      iat?: number;
    };
    return decoded.iat ?? Math.floor(Date.now() / 1000);
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

interface IdentityRow {
  profile: ProfileRow | null;
  memberships: Array<{
    org_id: string;
    name: string;
    slug: string;
    base_currency: string;
    timezone: string;
    ai_enabled: boolean;
    is_demo: boolean;
    is_owner: boolean;
  }>;
  active: {
    org_id: string;
    name: string;
    slug: string;
    base_currency: string;
    timezone: string;
    ai_enabled: boolean;
    is_demo: boolean;
    is_owner: boolean;
  } | null;
  permissions: string[];
  roles: string[];
  teams: string[];
}

/**
 * Loads the profile, membership and permission set for a user.
 *
 * One query, not five.
 *
 * This runs on every authenticated page load, and the database is typically in
 * another region — 178ms per round trip in the deployment this was tuned
 * against. Five sequential queries cost most of a second before the page even
 * began its own work, which is the difference between a navigation that feels
 * instant and one that feels broken. The dependency between them is real (the
 * permissions depend on which organisation is active), so they are expressed as
 * CTEs rather than as separate awaits.
 *
 * It runs as service_role because it *is* the membership lookup that every RLS
 * policy depends on. It reads nothing but identity and authorisation rows, and
 * it is the only such read in a request path.
 *
 * Memoised per request with React's cache(), so several Server Components in
 * one render share a single execution.
 */
const loadIdentity = cache(async (userId: string, requestedOrgSlug: string | null) => {
  return withService('resolve request identity and permissions', async (tx) => {
    const row = await tx.one<IdentityRow>(
      `with profile as (
         select id, email, full_name, avatar_url, job_title, timezone, status,
                sessions_valid_from
         from user_profiles
         where id = $1 and deleted_at is null
       ),
       memberships as (
         select o.id as org_id, o.name, o.slug, o.base_currency, o.timezone,
                o.ai_enabled, o.is_demo, m.is_owner
         from org_memberships m
         join organizations o on o.id = m.org_id
         where m.user_id = $1
           and m.status = 'active'
           and m.deleted_at is null
           and o.status = 'active'
           and o.deleted_at is null
       ),
       active as (
         -- The requested organisation when the user is a member of it,
         -- otherwise the first alphabetically. coalesce() guards the NULL that
         -- a missing cookie would otherwise produce, which sorts first on DESC.
         select * from memberships
         order by coalesce(slug = $2, false) desc, name
         limit 1
       )
       select
         (select row_to_json(p) from profile p) as profile,
         (select coalesce(json_agg(row_to_json(m) order by m.name), '[]'::json)
            from memberships m) as memberships,
         (select row_to_json(a) from active a) as active,
         (select coalesce(json_agg(distinct perm.key), '[]'::json)
            from user_roles ur
            join role_permissions rp on rp.role_id = ur.role_id
            join permissions perm on perm.id = rp.permission_id
            where ur.user_id = $1
              and ur.org_id = (select org_id from active)) as permissions,
         (select coalesce(json_agg(r.key order by r.rank), '[]'::json)
            from user_roles ur
            join roles r on r.id = ur.role_id
            where ur.user_id = $1
              and ur.org_id = (select org_id from active)) as roles,
         (select coalesce(json_agg(tm.team_id), '[]'::json)
            from team_members tm
            where tm.user_id = $1
              and tm.org_id = (select org_id from active)) as teams`,
      [userId, requestedOrgSlug],
    );

    if (!row.profile) return null;

    return {
      profile: row.profile,
      memberships: row.memberships ?? [],
      active: row.active,
      permissionKeys: row.permissions ?? [],
      roleKeys: row.roles ?? [],
      teamIds: row.teams ?? [],
    };
  });
});

/**
 * Full request context. Throws rather than returning null, so a handler that
 * forgets to check cannot proceed unauthenticated.
 */
export async function requireContext(): Promise<RequestContext> {
  const auth = await getAuthUser();
  if (!auth) throw new AppError('UNAUTHENTICATED', 'You must sign in to continue.');

  const cookieStore = await cookies();
  const requestedOrg = cookieStore.get(ORG_COOKIE)?.value ?? null;
  const headerList = await headers();
  const requestId = headerList.get('x-request-id') ?? newRequestId();

  const identity = await loadIdentity(auth.id, requestedOrg);
  if (!identity) {
    throw new AppError('UNAUTHENTICATED', 'Your account could not be found.');
  }

  const { profile } = identity;

  if (profile.status === 'deactivated') {
    throw new AppError('ACCOUNT_DEACTIVATED', 'This account has been deactivated.');
  }

  // Session invalidation: a token issued before the watermark is refused, which
  // is how deactivation and forced logout take effect immediately rather than
  // whenever the access token happens to expire.
  const watermark = Math.floor(new Date(profile.sessions_valid_from).getTime() / 1000);
  if (auth.issuedAt < watermark) {
    throw new AppError('SESSION_EXPIRED', 'Your session is no longer valid. Please sign in again.');
  }

  if (!identity.active) {
    throw new AppError(
      'NOT_A_MEMBER',
      'Your account is not a member of any active organisation.',
    );
  }

  const active = identity.active;

  return {
    requestId,
    user: {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      avatarUrl: profile.avatar_url,
      jobTitle: profile.job_title,
      timezone: profile.timezone,
      status: profile.status,
    },
    org: {
      id: active.org_id,
      name: active.name,
      slug: active.slug,
      baseCurrency: active.base_currency,
      timezone: active.timezone,
      aiEnabled: active.ai_enabled,
      isDemo: active.is_demo,
    },
    permissions: buildPermissionSet(identity.permissionKeys ?? []),
    teamIds: identity.teamIds ?? [],
    roleKeys: identity.roleKeys ?? [],
    isOwner: active.is_owner,
    memberships: identity.memberships.map((m) => ({
      id: m.org_id,
      name: m.name,
      slug: m.slug,
    })),
  };
}

/** Non-throwing variant for layouts that render differently when signed out. */
export async function getContext(): Promise<RequestContext | null> {
  try {
    return await requireContext();
  } catch {
    return null;
  }
}

/** Runs a query in the caller's tenant transaction. The default data path. */
export async function query<T>(
  ctx: RequestContext,
  fn: Parameters<typeof withTenant<T>>[1],
  options?: Parameters<typeof withTenant<T>>[2],
): Promise<T> {
  return withTenant<T>(
    { userId: ctx.user.id, orgId: ctx.org.id, requestId: ctx.requestId },
    fn,
    options,
  );
}
