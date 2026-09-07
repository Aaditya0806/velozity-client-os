/**
 * Migration runner.
 *
 * Migrations are plain .sql files applied in filename order inside a
 * transaction each, with their SHA-256 recorded. A file that changes after it
 * has been applied is a hard error: editing history silently is how two
 * environments quietly diverge.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SqlExecutor } from './types';

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const out: Migration[] = [];
  for (const name of entries) {
    const sql = await readFile(join(dir, name), 'utf8');
    out.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return out;
}

const LEDGER_DDL = `
create table if not exists schema_migrations (
  name        text primary key,
  checksum    text not null,
  applied_at  timestamptz not null default now(),
  duration_ms integer not null default 0
);
`;

export interface MigrateOptions {
  /** Called after each migration so a CLI can report progress. */
  onApplied?: (name: string, durationMs: number) => void;
  /** Skip the checksum check. Only for a deliberate local reset. */
  allowChecksumDrift?: boolean;
}

export async function migrate(
  db: SqlExecutor,
  migrations: Migration[],
  options: MigrateOptions = {},
): Promise<{ applied: string[]; skipped: string[] }> {
  await db.query(LEDGER_DDL);

  const existing = await db.query<{ name: string; checksum: string }>(
    'select name, checksum from schema_migrations',
  );
  const applied = new Map(existing.rows.map((r) => [r.name, r.checksum]));

  const appliedNow: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    const previous = applied.get(migration.name);
    if (previous) {
      if (previous !== migration.checksum && !options.allowChecksumDrift) {
        throw new Error(
          `Migration ${migration.name} has changed since it was applied.\n` +
            `Applied checksum: ${previous}\nCurrent checksum: ${migration.checksum}\n` +
            'Create a new migration rather than editing an applied one.',
        );
      }
      skipped.push(migration.name);
      continue;
    }

    const started = Date.now();
    try {
      await db.query('begin');
      await db.query(migration.sql);
      await db.query(
        'insert into schema_migrations (name, checksum, duration_ms) values ($1, $2, $3)',
        [migration.name, migration.checksum, Date.now() - started],
      );
      await db.query('commit');
    } catch (error) {
      await db.query('rollback').catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${migration.name} failed: ${message}`, { cause: error });
    }

    const duration = Date.now() - started;
    appliedNow.push(migration.name);
    options.onApplied?.(migration.name, duration);
  }

  return { applied: appliedNow, skipped };
}

/** Drops and recreates the public/app/portal schemas. Never run in production. */
export async function resetSchema(db: SqlExecutor): Promise<void> {
  await db.query(`
    drop schema if exists portal cascade;
    drop schema if exists app cascade;
    drop schema if exists public cascade;
    create schema public;
  `);
}
