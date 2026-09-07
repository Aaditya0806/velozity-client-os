import { route } from '@/lib/http/api';
import { created, paginated } from '@/lib/http/response';
import { listPayments, recordPayment, paymentSchema, paymentListSchema } from '@/lib/services/payments';

export const GET = route(
  { permission: 'finance:read:org', query: paymentListSchema },
  async ({ ctx, query, db, requestId }) => {
    const result = await db((tx) => listPayments(tx, ctx, query), { readOnly: true });
    return paginated(result.rows, result.pagination, requestId, result.summary);
  },
);

// Recording money is an external-effect-adjacent action: idempotent by contract,
// so a retried submission cannot double-count a receipt.
export const POST = route(
  { permission: 'payment:manage:org', idempotent: true, body: paymentSchema },
  async ({ ctx, body, db, requestId }) => {
    const payment = await db((tx) => recordPayment(tx, ctx, body));
    return created(payment, requestId, `/api/v1/payments/${payment.id}`);
  },
);
