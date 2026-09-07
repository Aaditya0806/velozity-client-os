import { route } from '@/lib/http/api';
import { created, paginated } from '@/lib/http/response';
import {
  listOpportunities, createOpportunity, opportunityCreateSchema, opportunityListSchema,
} from '@/lib/services/opportunities';

export const GET = route(
  {
    anyPermission: ['opportunity:read:own', 'opportunity:read:team', 'opportunity:read:org'],
    query: opportunityListSchema,
  },
  async ({ ctx, query, db, requestId }) => {
    const result = await db((tx) => listOpportunities(tx, ctx, query), { readOnly: true });
    return paginated(result.rows, result.pagination, requestId, result.summary);
  },
);

export const POST = route(
  { permission: 'opportunity:create:org', body: opportunityCreateSchema },
  async ({ ctx, body, db, requestId }) => {
    const opportunity = await db((tx) => createOpportunity(tx, ctx, body));
    return created(opportunity, requestId, `/api/v1/opportunities/${opportunity.id}`);
  },
);
