/**
 * Test data factories.
 *
 * These insert directly as the owning superuser so that *setup* is never the
 * thing under test. Every assertion afterwards runs through withTenant() as the
 * `authenticated` role, which is where RLS applies.
 */
import { randomUUID } from 'node:crypto';
import type { SqlDriver } from '@/lib/db/types';

export interface SeedOrg {
  id: string;
  slug: string;
  name: string;
}

export interface SeedUser {
  id: string;
  email: string;
}

export async function createOrg(
  db: SqlDriver,
  overrides: Partial<{ name: string; slug: string; baseCurrency: string; timezone: string }> = {},
): Promise<SeedOrg> {
  const id = randomUUID();
  const slug = overrides.slug ?? `org-${id.slice(0, 8)}`;
  const name = overrides.name ?? `Test Org ${slug}`;
  await db.query(
    `insert into organizations (id, name, slug, base_currency, timezone)
     values ($1, $2, $3, $4, $5)`,
    [id, name, slug, overrides.baseCurrency ?? 'USD', overrides.timezone ?? 'UTC'],
  );
  return { id, slug, name };
}

export async function createUser(
  db: SqlDriver,
  overrides: Partial<{ email: string; fullName: string; status: string }> = {},
): Promise<SeedUser> {
  const id = randomUUID();
  const email = overrides.email ?? `user-${id.slice(0, 8)}@example.test`;
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  await db.query(
    `insert into user_profiles (id, email, full_name, status) values ($1, $2, $3, $4)`,
    [id, email, overrides.fullName ?? 'Test User', overrides.status ?? 'active'],
  );
  return { id, email };
}

export async function addMember(
  db: SqlDriver,
  orgId: string,
  userId: string,
  options: { isOwner?: boolean; status?: string } = {},
): Promise<void> {
  await db.query(
    `insert into org_memberships (org_id, user_id, status, is_owner, joined_at)
     values ($1, $2, $3, $4, now())`,
    [orgId, userId, options.status ?? 'active', options.isOwner ?? false],
  );
}

/** Assigns a system role by key. */
export async function assignRole(
  db: SqlDriver,
  orgId: string,
  userId: string,
  roleKey: string,
): Promise<void> {
  const res = await db.query<{ id: string }>(
    `select id from roles where key = $1 and org_id is null`,
    [roleKey],
  );
  const role = res.rows[0];
  if (!role) throw new Error(`Unknown system role: ${roleKey}`);
  await db.query(
    `insert into user_roles (org_id, user_id, role_id) values ($1, $2, $3)
     on conflict do nothing`,
    [orgId, userId, role.id],
  );
}

/** Creates an org with an owner who holds super_admin. The common starting point. */
export async function createOrgWithAdmin(
  db: SqlDriver,
  overrides: Partial<{ name: string; slug: string; email: string }> = {},
): Promise<{ org: SeedOrg; admin: SeedUser }> {
  const org = await createOrg(db, overrides);
  const admin = await createUser(db, { email: overrides.email });
  await addMember(db, org.id, admin.id, { isOwner: true });
  await assignRole(db, org.id, admin.id, 'super_admin');
  return { org, admin };
}

export async function createUserWithRole(
  db: SqlDriver,
  orgId: string,
  roleKey: string,
  overrides: Partial<{ email: string; fullName: string }> = {},
): Promise<SeedUser> {
  const user = await createUser(db, overrides);
  await addMember(db, orgId, user.id);
  await assignRole(db, orgId, user.id, roleKey);
  return user;
}

export async function createTeam(
  db: SqlDriver,
  orgId: string,
  name = 'Test Team',
): Promise<{ id: string }> {
  const id = randomUUID();
  await db.query(`insert into teams (id, org_id, name, slug) values ($1, $2, $3, $4)`, [
    id,
    orgId,
    name,
    name.toLowerCase().replace(/\s+/g, '-'),
  ]);
  return { id };
}

export async function addToTeam(
  db: SqlDriver,
  orgId: string,
  teamId: string,
  userId: string,
): Promise<void> {
  await db.query(
    `insert into team_members (org_id, team_id, user_id) values ($1, $2, $3)
     on conflict do nothing`,
    [orgId, teamId, userId],
  );
}

export async function createCompany(
  db: SqlDriver,
  orgId: string,
  overrides: Partial<{ name: string; ownerUserId: string; teamId: string; stage: string }> = {},
): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const name = overrides.name ?? `Company ${id.slice(0, 8)}`;
  await db.query(
    `insert into companies (id, org_id, name, owner_user_id, team_id, lifecycle_stage, currency)
     values ($1, $2, $3, $4, $5, $6, 'USD')`,
    [
      id,
      orgId,
      name,
      overrides.ownerUserId ?? null,
      overrides.teamId ?? null,
      overrides.stage ?? 'prospect',
    ],
  );
  return { id, name };
}
