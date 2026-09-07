/**
 * Transaction helpers.
 *
 * `withTenant` is the single entry point for every user-facing query. It opens a
 * transaction, drops to the `authenticated` role, publishes the caller's JWT
 * claims and the active organisation, and only then runs the callback. Because
 * the role is dropped *before* any application SQL runs, an RLS policy is the
 * floor beneath every query in the product - including any future one written
 * carelessly.
 *
 * `withService` is the deliberate escape hatch for background work. It is
 * exported separately and named so that its use is obvious in review.
 */
import type { DbContext, QueryResult, SqlConnection, SqlDriver, SqlExecutor } from './types';
import { fromDatabaseError, AppError } from '@/lib/http/errors';
import { logger } from '@/lib/util/logger';

export type { DbContext, QueryResult, SqlExecutor, SqlConnection, SqlDriver };

// The driver is injectable so tests can run the identical code against PGlite.
let driverOverride: SqlDriver | null = null;

export function setDriver(driver: SqlDriver | null): void {
  driverOverride = driver;
}

async function resolveDriver(): Promise<SqlDriver> {
  if (driverOverride) return driverOverride;
  const { pgDriver } = await import('./pool');
  return pgDriver;
}

async function resolveAdminDriver(): Promise<SqlDriver> {
  if (driverOverride) return driverOverride;
  const { adminDriver } = await import('./pool');
  return adminDriver();
}

/**
 * A transaction-scoped executor. Beyond `query` it carries the helpers the
 * domain services need: transition marking and single-row fetches.
 */
export interface Tx extends SqlExecutor {
  readonly context: DbContext;
  /**
   * Binds this transaction to an organisation discovered mid-flight.
   *
   * Background work often does not know its tenant until it has read something:
   * a signature webhook identifies its organisation only via the signature
   * request it names. This sets both the database GUC and the transaction
   * context together, so the two can never disagree - which they would if a
   * caller set `app.org_id` with raw SQL and left `tx.context.orgId` null.
   */
  bindOrg(orgId: string): Promise<void>;
  /**
   * Marks the remainder of this transaction as a lifecycle transition, which is
   * the only condition under which the database permits a state column to move.
   * Called by the transition service and by nothing else.
   */
  enterTransition(): Promise<void>;
  one<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T>;
  maybeOne<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T | null>;
  many<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

class TxImpl implements Tx {
  #context: DbContext;

  constructor(
    private readonly conn: SqlConnection,
    context: DbContext,
  ) {
    this.#context = context;
  }

  get context(): DbContext {
    return this.#context;
  }

  async bindOrg(orgId: string): Promise<void> {
    await this.conn.query(`select set_config('app.org_id', $1, true)`, [orgId]);
    this.#context = { ...this.#context, orgId };
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    try {
      return await this.conn.query<T>(text, params);
    } catch (error) {
      logger.debug('Query failed', {
        request_id: this.context.requestId,
        org_id: this.context.orgId ?? undefined,
        error,
      });
      throw fromDatabaseError(error);
    }
  }

  async enterTransition(): Promise<void> {
    await this.conn.query(`select set_config('app.in_transition', 'on', true)`);
  }

  async one<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T> {
    const res = await this.query<T>(text, params);
    const row = res.rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'The requested record was not found.');
    return row;
  }

  async maybeOne<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<T | null> {
    const res = await this.query<T>(text, params);
    return res.rows[0] ?? null;
  }

  async many<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]> {
    return (await this.query<T>(text, params)).rows;
  }
}

interface TenantOptions {
  /** Wrap in a read-only transaction. Cheap defence against an accidental write. */
  readOnly?: boolean;
  /** Retry once on a serialisation failure or deadlock. */
  retryOnConflict?: boolean;
}

/**
 * Runs `fn` inside a tenant-scoped transaction as the `authenticated` role.
 */
export async function withTenant<T>(
  context: DbContext,
  fn: (tx: Tx) => Promise<T>,
  options: TenantOptions = {},
): Promise<T> {
  const driver = await resolveDriver();
  const attempt = async (): Promise<T> => {
    const conn = await driver.connect();
    try {
      await conn.query('begin');
      if (options.readOnly) {
        await conn.query('set transaction read only');
      }

      // Order matters: drop privilege first, then publish claims. A failure
      // between the two leaves the session with fewer rights, never more.
      await conn.query('set local role authenticated');

      const claims = {
        sub: context.userId,
        role: 'authenticated',
        ...(context.claims ?? {}),
      };
      await conn.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(claims),
      ]);
      await conn.query(`select set_config('app.org_id', $1, true)`, [context.orgId ?? '']);
      await conn.query(`select set_config('app.request_id', $1, true)`, [context.requestId ?? '']);

      const tx = new TxImpl(conn, context);
      const result = await fn(tx);
      await conn.query('commit');
      return result;
    } catch (error) {
      try {
        await conn.query('rollback');
      } catch {
        // The connection is already broken; the pool will discard it.
      }
      throw error instanceof AppError ? error : fromDatabaseError(error);
    } finally {
      conn.release();
    }
  };

  try {
    return await attempt();
  } catch (error) {
    if (
      options.retryOnConflict &&
      error instanceof AppError &&
      error.code === 'CONFLICT'
    ) {
      logger.warn('Retrying transaction after conflict', {
        request_id: context.requestId,
        org_id: context.orgId ?? undefined,
      });
      return attempt();
    }
    throw error;
  }
}

/**
 * Runs `fn` as `service_role`, bypassing RLS.
 *
 * Legitimate uses are narrow and all of them are background work: draining the
 * job queue, processing a verified provider webhook whose tenant is discovered
 * from the payload, and scheduled maintenance. `reason` is required and logged
 * so every such execution is accounted for.
 */
export interface ServiceOptions extends Partial<DbContext> {
  /**
   * Marks a high-frequency internal read — the worker polling its own queues,
   * for instance. These log at `debug` instead of `info`.
   *
   * The default is `info` because service_role bypasses RLS and its use should
   * be accountable. But a poll loop logging at info produces tens of thousands
   * of identical lines a day and buries the entries that matter, which defeats
   * the accountability it was meant to provide.
   */
  routine?: boolean;
}

export async function withService<T>(
  reason: string,
  fn: (tx: Tx) => Promise<T>,
  context: ServiceOptions = {},
): Promise<T> {
  const driver = await resolveAdminDriver();
  const conn = await driver.connect();
  // Background work has no user. Actor columns are nullable references to
  // user_profiles, so the absence is represented honestly rather than by a
  // synthetic system-user row.
  const ctx: DbContext = {
    userId: context.userId ?? null,
    orgId: context.orgId ?? null,
    requestId: context.requestId,
  };

  logger[context.routine ? 'debug' : 'info']('Service-role transaction', {
    reason,
    request_id: ctx.requestId,
    org_id: ctx.orgId ?? undefined,
  });

  try {
    await conn.query('begin');
    await conn.query('set local role service_role');
    await conn.query(`select set_config('app.org_id', $1, true)`, [ctx.orgId ?? '']);
    await conn.query(`select set_config('app.request_id', $1, true)`, [ctx.requestId ?? '']);
    const result = await fn(new TxImpl(conn, ctx));
    await conn.query('commit');
    return result;
  } catch (error) {
    try {
      await conn.query('rollback');
    } catch {
      /* connection already broken */
    }
    throw error instanceof AppError ? error : fromDatabaseError(error);
  } finally {
    conn.release();
  }
}

/** Escapes a value for use in an ILIKE pattern. */
export function likePattern(input: string): string {
  return `%${input.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
