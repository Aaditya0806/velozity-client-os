import { route } from '@/lib/http/api';
import { created, paginated } from '@/lib/http/response';
import {
  listProposals, createProposal, proposalCreateSchema, proposalListSchema,
} from '@/lib/services/proposals';

export const GET = route(
  {
    anyPermission: ['proposal:read:own', 'proposal:read:team', 'proposal:read:org'],
    query: proposalListSchema,
  },
  async ({ ctx, query, db, requestId }) => {
    const result = await db((tx) => listProposals(tx, ctx, query), { readOnly: true });
    return paginated(result.rows, result.pagination, requestId);
  },
);

export const POST = route(
  { permission: 'proposal:create:org', body: proposalCreateSchema },
  async ({ ctx, body, db, requestId }) => {
    const proposal = await db((tx) => createProposal(tx, ctx, body));
    return created(proposal, requestId, `/api/v1/proposals/${proposal.id}`);
  },
);
