import { route } from '@/lib/http/api';
import { created } from '@/lib/http/response';
import { createPaymentRequirement, paymentRequirementSchema } from '@/lib/services/payments';

export const POST = route(
  { permission: 'finance:manage:org', body: paymentRequirementSchema },
  async ({ ctx, body, db, requestId }) => {
    const requirement = await db((tx) => createPaymentRequirement(tx, ctx, body));
    return created(requirement, requestId);
  },
);
