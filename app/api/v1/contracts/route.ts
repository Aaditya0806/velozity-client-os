import { route } from '@/lib/http/api';
import { created, paginated } from '@/lib/http/response';
import {
  listContracts, createContract, contractCreateSchema, contractListSchema,
} from '@/lib/services/contracts';

export const GET = route(
  {
    anyPermission: ['contract:read:own', 'contract:read:team', 'contract:read:org'],
    query: contractListSchema,
  },
  async ({ ctx, query, db, requestId }) => {
    const result = await db((tx) => listContracts(tx, ctx, query), { readOnly: true });
    return paginated(result.rows, result.pagination, requestId);
  },
);

export const POST = route(
  { permission: 'contract:create:org', body: contractCreateSchema },
  async ({ ctx, body, db, requestId }) => {
    const contract = await db((tx) => createContract(tx, ctx, body));
    return created(contract, requestId, `/api/v1/contracts/${contract.id}`);
  },
);
