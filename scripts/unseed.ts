#!/usr/bin/env tsx
/**
 * CLI: remove the demo tenant.
 *
 *   npm run db:unseed
 *
 * Deleting the demo organisation cascades into the append-only ledgers — the
 * audit log, the transition ledger, legal overrides — and those refuse DELETE by
 * design. That refusal is correct: it is what makes the audit trail an audit
 * trail. So this is a deliberate administrative operation that suspends those
 * guards for one transaction, removes the tenant, and restores them.
 *
 * It refuses to run against a production database, and it only ever touches rows
 * belonging to the demo organisation.
 */
import 'dotenv/config';
import { Client } from 'pg';

// The tables whose triggers block a cascading delete. Listing them explicitly,
// rather than disabling triggers globally, keeps the blast radius visible.
const APPEND_ONLY_TABLES = [
  // Not append-only, but its constraint trigger insists an organisation keeps an
  // active owner — which a cascading delete necessarily violates on the way out.
  'org_memberships',
  'audit_log',
  'state_transitions',
  'proposal_approvals',
  'document_versions',
  'document_access_log',
  'legal_overrides',
  'signature_events',
  'email_events',
  'webhook_events',
];

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to remove seed data with NODE_ENV=production.');
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

  try {
    const org = await client.query<{ id: string }>(
      `select id from organizations where slug = 'velozity-demo'`,
    );

    if (org.rows.length === 0) {
      console.log('No demo organisation found. Nothing to remove.');
    } else {
      const orgId = org.rows[0]!.id;

      const users = await client.query<{ id: string; email: string }>(
        `select id, email from user_profiles where is_demo`,
      );

      await client.query('begin');
      try {
        for (const table of APPEND_ONLY_TABLES) {
          await client.query(`alter table ${table} disable trigger user`);
        }

        // One predicate. Everything else cascades from the organisation.
        await client.query(`delete from organizations where id = $1`, [orgId]);
        await client.query(`delete from user_profiles where is_demo`);
        await client.query(
          `delete from auth.users where id = any($1::uuid[])`,
          [users.rows.map((u) => u.id)],
        );
      } finally {
        // Restored inside the transaction, so a failure cannot leave the
        // guards off.
        for (const table of APPEND_ONLY_TABLES) {
          await client.query(`alter table ${table} enable trigger user`);
        }
      }
      await client.query('commit');

      console.log(`Removed the demo organisation and ${users.rows.length} demo user(s).`);

      // The GoTrue accounts live outside the database and need the admin API.
      const supabaseUrl = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (supabaseUrl && key) {
        const headers = { apikey: key, authorization: `Bearer ${key}` };
        const listed = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=200`, {
          headers,
        });

        if (listed.ok) {
          const body = (await listed.json()) as { users?: Array<{ id: string; email: string }> };
          let removed = 0;
          for (const user of body.users ?? []) {
            if (user.email?.endsWith('@velozity.demo')) {
              const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
                method: 'DELETE',
                headers,
              });
              if (res.ok) removed++;
            }
          }
          if (removed > 0) console.log(`Removed ${removed} Supabase Auth account(s).`);
        }
      }
    }

    console.log('\nRun npm run db:seed to load it again.\n');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
