#!/usr/bin/env tsx
/**
 * CLI: load development seed data.
 *
 *   npm run db:seed
 *
 * Refuses to run against a production database. Demo rows are marked
 * `is_demo = true`, so a tenant loaded by accident can be found and removed.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { seed, type AuthProvisioner } from '../supabase/seed/seed';
import type { SqlDriver, SqlConnection } from '../lib/db/types';

/**
 * Creates Supabase Auth accounts for the demo users, with a password, so they
 * can actually sign in.
 *
 * Writing `auth.users` directly satisfies the foreign key but not GoTrue, which
 * needs `instance_id`, `aud`, `role` and an identities row. Those are GoTrue's
 * to create, so the admin API creates the account and we adopt the id it
 * assigns.
 */
function makeAuthProvisioner(password: string): AuthProvisioner | undefined {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return undefined;

  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };

  return async ({ email, name }) => {
    const created = await fetch(`${url}/auth/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: name },
      }),
    });

    if (created.ok) {
      const body = (await created.json()) as { id: string };
      return body.id;
    }

    // Already there from an earlier run: adopt it and reset the password so the
    // documented credentials always work.
    const listed = await fetch(
      `${url}/auth/v1/admin/users?page=1&per_page=200`,
      { headers },
    );
    if (listed.ok) {
      const body = (await listed.json()) as { users?: Array<{ id: string; email: string }> };
      const existing = body.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (existing) {
        await fetch(`${url}/auth/v1/admin/users/${existing.id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ password, email_confirm: true }),
        });
        return existing.id;
      }
    }

    const detail = await created.text();
    throw new Error(`Could not create the auth account for ${email}: ${detail.slice(0, 200)}`);
  };
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to load seed data with NODE_ENV=production.');
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ...(process.env.DATABASE_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
  });
  await client.connect();

  const connection: SqlConnection = {
    async query(text, params) {
      const res = await client.query(text, params as unknown[] | undefined);
      return { rows: res.rows, rowCount: res.rowCount ?? 0 };
    },
    release() {},
  };

  const driver: SqlDriver = {
    query: (text, params) => connection.query(text, params),
    connect: async () => connection,
    end: async () => client.end(),
  };

  try {
    const existing = await driver.query<{ c: string }>(
      `select count(*)::text as c from organizations where slug = 'velozity-demo'`,
    );
    if (Number.parseInt(existing.rows[0]?.c ?? '0', 10) > 0) {
      console.log('The demo organisation already exists. Run db:reset first to reload it.');
      process.exit(0);
    }

    const password = process.env.SEED_DEMO_PASSWORD ?? 'Velozity!Demo2026';
    const provisionAuthUser = makeAuthProvisioner(password);

    const result = await seed(driver, { provisionAuthUser });

    console.log('\nSeed data loaded.\n');
    console.log(`  Organisation: velozity-demo (${result.orgId})`);
    console.log(`  Clients:      ${Object.keys(result.companies).length}`);
    console.log(`  Services:     ${result.serviceIds.length}\n`);
    console.log('  Demo users:');
    for (const [key, user] of Object.entries(result.users)) {
      console.log(`    ${key.padEnd(12)} ${user.email}`);
    }

    if (result.authProvisioned) {
      console.log(`\n  Password for every account: ${password}`);
      console.log('  Sign in at /sign-in. Try admin, then sales, then legal — the');
      console.log('  differences between them are the point of the demo data.\n');
    } else {
      console.log(
        `\n  SUPABASE_SERVICE_ROLE_KEY is not set, so no Supabase Auth accounts were\n` +
          `  created and nobody can sign in yet. Set it and re-run, or create the\n` +
          `  accounts by hand. See README "Seed process".\n`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
