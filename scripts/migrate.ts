#!/usr/bin/env tsx
/**
 * CLI: apply pending migrations to the database in DATABASE_URL.
 *
 *   npm run db:migrate
 *   npm run db:reset     # drops and recreates the schema first (never in prod)
 */
import 'dotenv/config';
import { Client } from 'pg';
import { loadMigrations, migrate, resetSchema } from '../lib/db/migrator';
import type { SqlExecutor } from '../lib/db/types';

async function main() {
  const reset = process.argv.includes('--reset');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  if (reset && process.env.NODE_ENV === 'production') {
    console.error('Refusing to reset the schema with NODE_ENV=production.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ...(process.env.DATABASE_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
  });
  await client.connect();

  const executor: SqlExecutor = {
    async query(text, params) {
      const res = await client.query(text, params as unknown[] | undefined);
      return { rows: res.rows, rowCount: res.rowCount ?? 0 };
    },
  };

  try {
    if (reset) {
      console.log('Resetting schema…');
      await resetSchema(executor);
    }

    const migrations = await loadMigrations();
    console.log(`Found ${migrations.length} migration file(s).`);

    const result = await migrate(executor, migrations, {
      onApplied: (name, ms) => console.log(`  applied  ${name}  (${ms}ms)`),
    });

    if (result.applied.length === 0) {
      console.log('Database is already up to date.');
    } else {
      console.log(`\nApplied ${result.applied.length} migration(s).`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
