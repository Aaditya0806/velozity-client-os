/**
 * The production PostgreSQL driver.
 *
 * We talk to PostgreSQL directly rather than through PostgREST so that a
 * multi-statement business operation - transition an opportunity, write the
 * ledger row, emit the event, enqueue the job - is one atomic transaction. RLS
 * still applies because every transaction assumes the `authenticated` role and
 * sets request.jwt.claims exactly as PostgREST would.
 */
import 'server-only';
import { Pool, type PoolClient } from 'pg';
import type { SqlConnection, SqlDriver, QueryResult } from './types';
import { serverEnv } from '@/lib/config/env';
import { logger } from '@/lib/util/logger';

// Type parsing is pinned deliberately.
//
//   numeric / int8 -> string. A money amount that passes through a JavaScript
//     number has already lost the argument.
//   date -> string. A calendar date has no time and no timezone; turning
//     2026-11-02 into a Date makes it 2026-11-01 for anyone west of UTC, and
//     that class of bug is invisible until a due date is a day early.
//   timestamptz stays a Date, which is correct: it denotes an instant.
import pg from 'pg';
pg.types.setTypeParser(1700, (v: string) => v); // numeric
pg.types.setTypeParser(20, (v: string) => v); // int8
pg.types.setTypeParser(1082, (v: string) => v); // date

/**
 * Pools are cached on globalThis, not in a module variable.
 *
 * Next's dev server re-evaluates modules on every hot reload, so a module-level
 * pool is recreated each time and the old one is never drained — after a dozen
 * edits the connections are gone. That is not only a development annoyance:
 * Supabase's session pooler caps a project at 15 clients, and exhausting it
 * takes down every query with EMAXCONNSESSION rather than failing gracefully.
 *
 * Keying by connection string means a changed DATABASE_URL still gets a fresh
 * pool rather than silently reusing the old one.
 */
const POOLS = Symbol.for('velozity.pg.pools');

interface PoolRegistry {
  [key: string]: Pool;
}

function registry(): PoolRegistry {
  const g = globalThis as unknown as Record<symbol, PoolRegistry | undefined>;
  g[POOLS] ??= {};
  return g[POOLS]!;
}

function sharedPool(key: string, create: () => Pool): Pool {
  const pools = registry();
  pools[key] ??= create();
  return pools[key]!;
}

function buildPool(connectionString: string, max: number, ssl: boolean): Pool {
  const p = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Nothing in a request path should hold a transaction open this long.
    statement_timeout: 30_000,
    query_timeout: 30_000,
    ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  p.on('error', (err) => {
    logger.error('Idle database client error', { error: err });
  });

  return p;
}

function getPool(): Pool {
  const env = serverEnv();
  return sharedPool(`app:${env.DATABASE_URL}`, () =>
    buildPool(env.DATABASE_URL, env.DATABASE_POOL_MAX, env.DATABASE_SSL),
  );
}

class PgConnection implements SqlConnection {
  constructor(private readonly client: PoolClient) {}

  async query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    const res = await this.client.query(text, params as unknown[] | undefined);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  }

  release(): void {
    this.client.release();
  }
}

export const pgDriver: SqlDriver = {
  async query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
    const res = await getPool().query(text, params as unknown[] | undefined);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  },
  async connect(): Promise<SqlConnection> {
    return new PgConnection(await getPool().connect());
  },
  async end(): Promise<void> {
    const pools = registry();
    await Promise.all(Object.values(pools).map((p) => p.end().catch(() => undefined)));
    for (const key of Object.keys(pools)) delete pools[key];
  },
};

/**
 * A pool that connects as `service_role`. Reserved for background workers that
 * legitimately operate outside any user's tenant - the webhook processor, the
 * job runner, scheduled reports. Never reachable from a request handler.
 */
export function adminDriver(): SqlDriver {
  const env = serverEnv();
  const url = env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;

  // Background work is bursty but low-volume, so it gets a small share of the
  // budget. The two pools together must stay under whatever the database (or
  // the pooler in front of it) allows.
  const adminMax = Math.max(2, Math.ceil(env.DATABASE_POOL_MAX / 3));
  const p = sharedPool(`admin:${url}`, () => buildPool(url, adminMax, env.DATABASE_SSL));
  return {
    async query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      const res = await p.query(text, params as unknown[] | undefined);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
    async connect(): Promise<SqlConnection> {
      return new PgConnection(await p.connect());
    },
    async end(): Promise<void> {
      await p.end().catch(() => undefined);
      delete registry()[`admin:${url}`];
    },
  };
}
