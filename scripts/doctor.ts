#!/usr/bin/env tsx
/**
 * Preflight check.
 *
 *   npm run doctor
 *
 * Verifies configuration and connectivity before you try to run the app, and
 * says what to do about anything that is wrong. Every check is independent, so
 * one failure does not hide the rest.
 */
import 'dotenv/config';
import { Client } from 'pg';

type Status = 'ok' | 'warn' | 'fail';

const results: Array<{ status: Status; label: string; detail: string }> = [];

function record(status: Status, label: string, detail: string) {
  results.push({ status, label, detail });
}

function required(name: string, hint: string): string | null {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    record('fail', name, `Not set. ${hint}`);
    return null;
  }
  return value;
}

async function main() {
  console.log('\nVelozity Business OS — preflight check\n');

  // --- Runtime -------------------------------------------------------------
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major >= 20) {
    record('ok', 'Node.js', `v${process.versions.node}`);
  } else {
    record(
      'warn',
      'Node.js',
      `v${process.versions.node}. Works, but 20+ is recommended; @supabase/supabase-js warns on 18.`,
    );
  }

  // --- Required configuration ----------------------------------------------
  const databaseUrl = required('DATABASE_URL', 'Supabase → Settings → Database → Connection string.');
  const supabaseUrl = required('SUPABASE_URL', 'Supabase → Settings → API → Project URL.');
  const anonKey = required('SUPABASE_ANON_KEY', 'Supabase → Settings → API → anon public key.');

  // The browser needs its own copies; middleware refuses to run without them.
  for (const [name, serverValue] of [
    ['NEXT_PUBLIC_SUPABASE_URL', supabaseUrl],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', anonKey],
  ] as const) {
    const value = process.env[name];
    if (!value) {
      record('fail', name, 'Not set. Middleware returns 503 for every request without it.');
    } else if (serverValue && value !== serverValue) {
      record('warn', name, 'Set, but does not match its server-side counterpart.');
    } else {
      record('ok', name, 'set');
    }
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    record(
      'warn',
      'SUPABASE_SERVICE_ROLE_KEY',
      'Not set. Document upload and download will fail; everything else works.',
    );
  } else if (serviceKey === anonKey) {
    record('fail', 'SUPABASE_SERVICE_ROLE_KEY', 'This is the anon key, not the service role key.');
  } else {
    record('ok', 'SUPABASE_SERVICE_ROLE_KEY', 'set');
  }

  const secret = process.env.APP_SECRET ?? '';
  if (secret.length < 32) {
    record('fail', 'APP_SECRET', 'Must be at least 32 characters. Try: openssl rand -base64 48');
  } else if (secret.startsWith('dev-only') || secret.includes('change-me')) {
    record('warn', 'APP_SECRET', 'Still the placeholder value. Replace it before deploying.');
  } else {
    record('ok', 'APP_SECRET', `${secret.length} characters`);
  }

  // --- Database ------------------------------------------------------------
  if (databaseUrl) {
    const client = new Client({
      connectionString: databaseUrl,
      ...(process.env.DATABASE_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
      connectionTimeoutMillis: 10_000,
    });

    try {
      await client.connect();
      const version = await client.query('select version()');
      record('ok', 'Database connection', String(version.rows[0].version).split(',')[0] ?? 'connected');

      // Migrations
      try {
        const applied = await client.query('select count(*)::int as c from schema_migrations');
        const { readdir } = await import('node:fs/promises');
        const files = (await readdir('supabase/migrations')).filter((f) => f.endsWith('.sql'));
        const count = applied.rows[0].c as number;

        if (count === 0) {
          record('fail', 'Migrations', `0 of ${files.length} applied. Run: npm run db:migrate`);
        } else if (count < files.length) {
          record('fail', 'Migrations', `${count} of ${files.length} applied. Run: npm run db:migrate`);
        } else {
          record('ok', 'Migrations', `${count} applied`);
        }
      } catch {
        record('fail', 'Migrations', 'Not applied yet. Run: npm run db:migrate');
      }

      // Seed
      try {
        const demo = await client.query(
          `select count(*)::int as c from organizations where is_demo`,
        );
        const users = await client.query(`select count(*)::int as c from user_profiles`);
        if ((demo.rows[0].c as number) > 0) {
          record('ok', 'Seed data', `demo organisation present, ${users.rows[0].c} user profiles`);
        } else {
          record('warn', 'Seed data', 'Not loaded. Run: npm run db:seed (development only)');
        }
      } catch {
        // Tables do not exist yet; the migration check already said so.
      }

      // Auth users with a usable password, which is what actually lets you sign in.
      try {
        const signInReady = await client.query(
          `select count(*)::int as c from auth.users
           where encrypted_password is not null and encrypted_password <> ''`,
        );
        const c = signInReady.rows[0].c as number;
        if (c > 0) {
          record('ok', 'Sign-in ready', `${c} account(s) have a password set`);
        } else {
          record(
            'warn',
            'Sign-in ready',
            'No account has a password. See README → Seed process for the command.',
          );
        }
      } catch {
        record('warn', 'Sign-in ready', 'Could not inspect auth.users (this is normal on some plans).');
      }

      // RLS posture — the check from the production checklist.
      try {
        const unprotected = await client.query(
          `select relname from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r'
             and (not c.relrowsecurity or not c.relforcerowsecurity)
             and c.relname not in ('schema_migrations','rate_limit_counters','permissions')`,
        );
        if (unprotected.rows.length === 0) {
          record('ok', 'Row level security', 'enabled and forced on every tenant table');
        } else {
          record(
            'fail',
            'Row level security',
            `Missing on: ${unprotected.rows.map((r) => r.relname).join(', ')}`,
          );
        }
      } catch {
        // Schema not present yet.
      }
    } catch (error) {
      const e = error as { code?: string; message?: string };
      const host = (() => {
        try {
          return new URL(databaseUrl).hostname;
        } catch {
          return '';
        }
      })();

      // The three failures worth telling apart, because each has a different fix
      // and the raw driver message points at the wrong one.
      if (
        ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(e.code ?? '') &&
        /^db\.[a-z0-9]+\.supabase\.co$/.test(host)
      ) {
        record(
          'fail',
          'Database connection',
          'Cannot reach the direct connection host. Supabase serves db.*.supabase.co over IPv6 only, ' +
            'and most networks cannot route it. Use the pooler instead: Supabase -> Connect -> ' +
            '"Session pooler" -> copy the URI into DATABASE_URL, then run npm run db:password.',
        );
      } else if (e.code === '28P01') {
        record(
          'fail',
          'Database connection',
          'Reached PostgreSQL, but the password was rejected. Run: npm run db:password. ' +
            'If it still fails, reset it at Supabase -> Settings -> Database -> Reset database password.',
        );
      } else if (e.code === 'ENOTFOUND') {
        record(
          'fail',
          'Database connection',
          `Host "${host}" does not resolve. Check the project reference in DATABASE_URL.`,
        );
      } else {
        record(
          'fail',
          'Database connection',
          `${e.message ?? String(error)}${e.code ? ` (${e.code})` : ''}. ` +
            'Check DATABASE_URL, and DATABASE_SSL=false for a local database.',
        );
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  // --- Storage -------------------------------------------------------------
  if (supabaseUrl && serviceKey) {
    const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'documents';
    try {
      const response = await fetch(
        `${supabaseUrl}/storage/v1/bucket/${encodeURIComponent(bucket)}`,
        { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } },
      );

      if (response.ok) {
        const info = (await response.json()) as { public?: boolean };
        if (info.public) {
          record(
            'fail',
            `Storage bucket "${bucket}"`,
            'Exists but is PUBLIC. Every document would be world-readable. Turn public access off.',
          );
        } else {
          record('ok', `Storage bucket "${bucket}"`, 'exists and is private');
        }
      } else {
        // Say which buckets DO exist: the usual cause is a bucket created under
        // a different name, and guessing wastes more time than one extra call.
        let existing = '';
        try {
          const all = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
            headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
          });
          if (all.ok) {
            const buckets = (await all.json()) as Array<{ name: string }>;
            existing = buckets.length
              ? ` Buckets that exist: ${buckets.map((b) => `"${b.name}"`).join(', ')}.`
              : ' No buckets exist yet.';
          }
        } catch {
          /* the primary message is enough */
        }

        record(
          'fail',
          `Storage bucket "${bucket}"`,
          `Not found (HTTP ${response.status}).${existing} Create one named "${bucket}" with Public OFF, or set SUPABASE_STORAGE_BUCKET to an existing name.`,
        );
      }
    } catch (error) {
      record(
        'warn',
        'Storage',
        `Could not reach Supabase Storage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // --- Optional integrations ----------------------------------------------
  record(
    process.env.ANTHROPIC_API_KEY ? 'ok' : 'warn',
    'AI',
    process.env.ANTHROPIC_API_KEY
      ? `enabled (${process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5'})`
      : 'ANTHROPIC_API_KEY not set. AI features report that they are unconfigured; nothing else changes.',
  );

  const emailProvider = process.env.EMAIL_PROVIDER ?? 'noop';
  record(
    emailProvider === 'noop' ? 'warn' : 'ok',
    'Email',
    emailProvider === 'noop'
      ? 'Provider is "noop": messages are recorded and logged, never sent. Correct for development.'
      : `Provider is "${emailProvider}".`,
  );

  const signatureProvider = process.env.SIGNATURE_PROVIDER ?? 'manual';
  record(
    signatureProvider === 'manual' ? 'warn' : 'ok',
    'E-signature',
    signatureProvider === 'manual'
      ? 'Provider is "manual": the full legal workflow runs locally without a provider account.'
      : `Provider is "${signatureProvider}".`,
  );

  // --- Report --------------------------------------------------------------
  const icon = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ' };
  const width = Math.max(...results.map((r) => r.label.length));

  for (const result of results) {
    console.log(`[${icon[result.status]}] ${result.label.padEnd(width)}  ${result.detail}`);
  }

  const failures = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;

  console.log('');
  if (failures > 0) {
    console.log(`${failures} problem(s) must be fixed before the application will run.\n`);
    process.exit(1);
  }
  console.log(
    warnings > 0
      ? `Ready to run. ${warnings} optional item(s) noted above.\n`
      : 'Everything checks out.\n',
  );
}

main().catch((error) => {
  console.error('\nThe check itself failed:', error instanceof Error ? error.message : error, '\n');
  process.exit(1);
});
