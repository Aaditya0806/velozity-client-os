import { z } from 'zod';
import { portalRoute } from '@/lib/http/portal-api';
import { ok } from '@/lib/http/response';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });
const body = z.object({
  decision: z.enum(['accepted', 'rejected']),
  reason: z.string().trim().max(2000).optional(),
});

/**
 * A client accepts or rejects a deliverable.
 *
 * The handler passes the identifier and nothing else. Who is asking, which
 * company they belong to, whether they may approve at all, and whether the
 * deliverable is even awaiting a decision are all settled inside
 * `app.portal_decide_deliverable`, from the session — so this route cannot be
 * talked into deciding something on another client's behalf.
 */
export const POST = portalRoute(
  { capability: 'approveDeliverables', params, body },
  async ({ params: { id }, body: input, db, requestId }) => {
    const result = await db(
      (tx) =>
        tx.one<{ result: unknown }>(
          `select app.portal_decide_deliverable($1, $2, $3) as result`,
          [id, input.decision, input.reason ?? null],
        ),
      { writable: true },
    );

    return ok(result.result, requestId);
  },
);
