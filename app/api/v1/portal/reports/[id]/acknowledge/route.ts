import { z } from 'zod';
import { portalRoute } from '@/lib/http/portal-api';
import { ok } from '@/lib/http/response';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

/** Records that this client has read a published report. */
export const POST = portalRoute({ params }, async ({ params: { id }, db, requestId }) => {
  const result = await db(
    (tx) =>
      tx.one<{ result: unknown }>(`select app.portal_acknowledge_report($1) as result`, [id]),
    { writable: true },
  );
  return ok(result.result, requestId);
});
