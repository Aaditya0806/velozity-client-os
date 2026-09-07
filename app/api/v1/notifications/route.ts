import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok, paginated } from '@/lib/http/response';
import { paginationMeta } from '@/lib/validation/common';

export const GET = route(
  {
    rateLimit: false,
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      page_size: z.coerce.number().int().min(1).max(100).default(25),
      unread_only: z.enum(['true', 'false']).optional(),
    }),
  },
  async ({ query, db, requestId }) => {
    const result = await db(
      async (tx) => {
        const unreadOnly = query.unread_only === 'true';
        const where = unreadOnly
          ? 'archived_at is null and read_at is null'
          : 'archived_at is null';

        const total = await tx.one<{ count: string; unread: string }>(
          `select count(*)::text as count,
                  count(*) filter (where read_at is null)::text as unread
           from notifications where ${where}`,
        );

        const rows = await tx.many(
          `select * from notifications where ${where}
           order by created_at desc limit $1 offset $2`,
          [query.page_size, (query.page - 1) * query.page_size],
        );

        return {
          rows,
          total: Number.parseInt(total.count, 10),
          unread: Number.parseInt(total.unread, 10),
        };
      },
      { readOnly: true },
    );

    return paginated(
      result.rows,
      paginationMeta(query.page, query.page_size, result.total),
      requestId,
      { unread_count: result.unread },
    );
  },
);

export const PATCH = route(
  {
    rateLimit: false,
    body: z.object({
      ids: z.array(z.string().uuid()).optional(),
      action: z.enum(['read', 'unread', 'archive']),
      all: z.boolean().default(false),
    }),
  },
  async ({ body, db, requestId }) => {
    const updated = await db(async (tx) => {
      const column =
        body.action === 'archive'
          ? 'archived_at = now()'
          : body.action === 'read'
            ? 'read_at = now()'
            : 'read_at = null';

      // RLS restricts these to the caller's own notifications regardless.
      if (body.all) {
        const res = await tx.query(`update notifications set ${column} where archived_at is null`);
        return res.rowCount;
      }
      if (!body.ids || body.ids.length === 0) return 0;
      const res = await tx.query(
        `update notifications set ${column} where id = any ($1)`,
        [body.ids],
      );
      return res.rowCount;
    });

    return ok({ updated }, requestId);
  },
);
