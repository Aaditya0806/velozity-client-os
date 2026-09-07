/**
 * Rate limiting.
 *
 * A fixed-window counter kept in PostgreSQL so it works across instances
 * without another piece of infrastructure. Windows are short and the table is
 * unlogged, so the write cost is small; a dedicated store can replace this
 * behind the same interface if volume ever justifies one.
 */
import type { Tx } from '@/lib/db';
import { withService } from '@/lib/db';
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

  const run = async (t: Tx) => {
    const windowStart = new Date(
      Math.floor(Date.now() / (rule.windowSeconds * 1000)) * rule.windowSeconds * 1000,
    );

    const row = await t.one<{ hits: number }>(
      `insert into rate_limit_counters (bucket, subject, window_start, hits)
       values ($1, $2, $3, 1)
       on conflict (bucket, subject, window_start)
       do update set hits = rate_limit_counters.hits + 1
       returning hits`,
      [rule.key, subject, windowStart.toISOString()],
    );

    if (row.hits > rule.limit) {
      throw new AppError('RATE_LIMITED', 'Too many requests. Please slow down.', {
        details: { limit: rule.limit, window_seconds: rule.windowSeconds },
      });
    }
  };

  if (tx) {
    await run(tx);
  } else {
    await withService('rate limit check', run);
  }
}
