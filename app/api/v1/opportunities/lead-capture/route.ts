import { route } from '@/lib/http/api';
import { created } from '@/lib/http/response';
import { captureLead, leadCaptureSchema } from '@/lib/services/opportunities';

/**
 * Creates company, contact and opportunity in one transaction, so an inbound
 * lead never lands half-recorded.
 */
export const POST = route(
  { permission: 'opportunity:create:org', body: leadCaptureSchema },
  async ({ ctx, body, db, requestId }) => {
    const result = await db((tx) => captureLead(tx, ctx, body));
    return created(
      {
        company_id: result.companyId,
        contact_id: result.contactId,
        opportunity: result.opportunity,
      },
      requestId,
      `/api/v1/opportunities/${result.opportunity.id}`,
    );
  },
);
