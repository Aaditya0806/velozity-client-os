import { route } from '@/lib/http/api';
import { paginated } from '@/lib/http/response';
import { listDocuments, documentListSchema } from '@/lib/documents';

export const GET = route(
  { permission: 'document:read:org', query: documentListSchema },
  async ({ ctx, query, db, requestId }) => {
    const result = await db((tx) => listDocuments(tx, ctx, query), { readOnly: true });
    return paginated(result.rows, result.pagination, requestId);
  },
);
