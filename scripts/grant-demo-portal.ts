#!/usr/bin/env tsx
/**
 * CLI: give the demo tenant's contacts portal logins.
 *
 *   npm run db:portal-demo
 *
 * `db:seed` refuses to run twice, and `db:reset` throws away everything — so an
 * existing demo tenant had no way to acquire the portal users the seed now
 * creates. This tops them up instead, which is the difference between trying
 * the portal and rebuilding the database to try the portal.
 *
 * Idempotent, and additive only: it creates nothing but auth users, profiles and
 * portal_users rows, and never deletes or resets anything.
 */
import 'dotenv/config';
import { Client } from 'pg';

const PEOPLE = [
  {
    email: 'priya@northwind.example.com',
    name: 'Priya Anand',
    company: 'Northwind Analytics',
    invoices: true,
    approve: true,
  },
  {
    email: 'aisha@meridian.example.com',
    name: 'Aisha Okonkwo',
    company: 'Meridian Health Group',
    invoices: false,
    approve: false,
  },
] as const;

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const databaseUrl = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;

  if (!supabaseUrl || !serviceKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    process.exit(1);
  }
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }

  const headers = {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    'content-type': 'application/json',
  };
  const password = process.env.SEED_DEMO_PASSWORD ?? 'Velozity!Demo2026';

  /** Creates the auth account, or adopts and re-passwords an existing one. */
  async function authUser(email: string, name: string): Promise<string> {
    const created = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: name, portal: true },
      }),
    });
    if (created.ok) return ((await created.json()) as { id: string }).id;

    const listed = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=200`, {
      headers,
    });
    const body = (await listed.json()) as { users?: Array<{ id: string; email: string }> };
    const existing = body.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!existing) throw new Error(`Could not create or find an account for ${email}`);

    await fetch(`${supabaseUrl}/auth/v1/admin/users/${existing.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ password, email_confirm: true }),
    });
    return existing.id;
  }

  const db = new Client({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'false' ? undefined : { rejectUnauthorized: false },
  });
  await db.connect();

  try {
    const org = await db.query<{ id: string }>(
      `select id from organizations where slug = 'velozity-demo'`,
    );
    const orgId = org.rows[0]?.id;
    if (!orgId) {
      console.error('No demo organisation found. Run `npm run db:seed` first.');
      process.exit(1);
    }

    for (const person of PEOPLE) {
      const contact = await db.query<{ id: string; company_id: string }>(
        `select ct.id, ct.company_id
           from contacts ct
           join companies c on c.id = ct.company_id
          where ct.org_id = $1 and c.name = $2 and ct.email = $3
            and ct.deleted_at is null`,
        [orgId, person.company, person.email],
      );

      const row = contact.rows[0];
      if (!row) {
        console.log(`  skipped  ${person.email} — no matching contact in the demo data`);
        continue;
      }

      const userId = await authUser(person.email, person.name);

      await db.query(
        `insert into user_profiles (id, email, full_name, timezone, status, is_demo)
         values ($1,$2,$3,'Europe/London','active',true)
         on conflict (id) do nothing`,
        [userId, person.email, person.name],
      );

      // Pointedly no org_memberships row: a portal user with one would satisfy
      // requireContext() and land in the internal application instead.
      await db.query(
        `insert into portal_users (
           org_id, company_id, contact_id, user_id, status,
           can_view_invoices, can_view_documents, can_approve_deliverables, invited_at
         ) values ($1,$2,$3,$4,'active',$5,true,$6, now())
         on conflict (org_id, company_id, user_id) do update
           set status = 'active',
               can_view_invoices = excluded.can_view_invoices,
               can_approve_deliverables = excluded.can_approve_deliverables,
               revoked_at = null`,
        [orgId, row.company_id, row.id, userId, person.invoices, person.approve],
      );

      console.log(
        `  ok       ${person.email}  (${person.company}` +
          `${person.invoices ? ', invoices' : ''}${person.approve ? ', can approve' : ''})`,
      );
    }

    console.log(`\nSign in at /portal with the demo password.`);
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
