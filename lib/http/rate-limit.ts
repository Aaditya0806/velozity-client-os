/**
 * Rate limiting.
 *
 * A fixed-window counter kept in PostgreSQL so it works across instances
 * without another piece of infrastructure. Windows are short and the table is
 * unlogged, so the write cost is small; a dedicated store can replace this
 * behind the same interface if volume ever justifies one.
 */
import type { Tx } from '@/lib/db';
import { AppError } from '@/lib/http/errors';

export interface RateLimitRule {
  /** Identifier for the bucket, e.g. `contract:send`. */
  key: string;
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMITS = {
  auth: { key: 'auth', limit: 10, windowSeconds: 60 },
  read: { key: 'read', limit: 600, windowSeconds: 60 },
  write: { key: 'write', limit: 120, windowSeconds: 60 },
  externalEffect: { key: 'external', limit: 20, windowSeconds: 60 },
  ai: { key: 'ai', limit: 30, windowSeconds: 60 },
  webhook: { key: 'webhook', limit: 1000, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export async function checkRateLimit(
  subject: string,
  rule: RateLimitRule,
  tx?: Tx,
): Promise<void> {
  if (process.env.RATE_LIMIT_ENABLED === 'false') return;

  const windowStart = new Date(
    Math.floor(Date.now() / (rule.windowSeconds * 1000)) * rule.windowSeconds * 1000,
  );

  const sql = `insert into rate_limit_counters (bucket, subject, window_start, hits)
               values ($1, $2, $3, 1)
               on conflict (bucket, subject, window_start)
               do update set hits = rate_limit_counters.hits + 1
               returning hits`;
  const params = [rule.key, subject, windowStart.toISOString()];

  let hits: number;

  if (tx) {
    hits = (await tx.one<{ hits: number }>(sql, params)).hits;
  } else {
    // One round trip, not four.
    //
    // Wrapping this in withService() would cost BEGIN, SET LOCAL ROLE,
    // set_config and COMMIT before the single statement that does the work —
    // and it runs on every request. Against a database in another region that
    // was more than half a second of pure overhead per call.
    //
    // No transaction is needed: it is one atomic upsert. No role switch is
    // needed either, because rate_limit_counters holds no tenant data and is
    // already granted to service_role alone, with RLS enabled and no policy.
    const { pgDriver } = await import('@/lib/db/pool');
    const result = await pgDriver.query<{ hits: number }>(sql, params);
    hits = result.rows[0]?.hits ?? 0;
  }

  if (hits > rule.limit) {
    throw new AppError('RATE_LIMITED', 'Too many requests. Please slow down.', {
      details: { limit: rule.limit, window_seconds: rule.windowSeconds },
    });
  }
}
