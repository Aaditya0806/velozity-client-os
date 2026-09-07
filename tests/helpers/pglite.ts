/**
 * An in-process PostgreSQL for tests.
 *
 * PGlite is genuine PostgreSQL compiled to WebAssembly, so the migrations, the
 * triggers and - critically - the RLS policies under test are the same ones
 * that run in production. A test that proves a tenant cannot read another
 * tenant's rows is proving it against real policy evaluation, not a mock.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import type { SqlConnection, SqlDriver, QueryResult } from '@/lib/db/types';
import { loadMigrations, migrate } from '@/lib/db/migrator';

/**
 * Match the production driver's type handling exactly, so a value that arrives
 * as a string in production does not arrive as a Date in tests. Without this the
 * tests would quietly disagree with the application about what a `date` is.
 *
 *   1082 date    -> string (a calendar date has no timezone)
 *   1700 numeric -> string (money never becomes a float)
 *   20   int8    -> string
 */
const PARSERS = {
  1082: (value: string) => value,
  1700: (value: string) => value,
  20: (value: string) => value,
} as const;

export interface TestDatabase {
  driver: SqlDriver;
  raw: PGlite;
  close(): Promise<void>;
}

/**
 * PGlite is single-connection, so `connect()` hands back the same underlying
 * instance. Tests are therefore serial with respect to transactions, which is
 * exactly what we want when asserting on transaction-scoped RLS context.
 */
class PGliteConnection implements SqlConnection {
  constructor(private readonly db: PGlite) {}

  async query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    if (params && params.length > 0) {
      const res = await this.db.query<T>(text, params as unknown[], { parsers: PARSERS });
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
    }
    // Multi-statement SQL (migrations) must go through exec().
    if (/;\s*\S/.test(text.replace(/--[^\n]*\n/g, ''))) {
      await this.db.exec(text);
      return { rows: [], rowCount: 0 };
    }
    const res = await this.db.query<T>(text, [], { parsers: PARSERS });
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }

  release(): void {
    /* single shared connection */
  }
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const db = await PGlite.create({
    extensions: { pgcrypto, uuid_ossp, citext, pg_trgm, btree_gist },
  });

  const connection = new PGliteConnection(db);
  const driver: SqlDriver = {
    query: (text, params) => connection.query(text, params),
    connect: async () => connection,
    end: async () => db.close(),
  };

  const migrations = await loadMigrations();
  await migrate(driver, migrations);

  return {
    driver,
    raw: db,
    close: () => db.close(),
  };
}
