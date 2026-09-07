import { route } from '@/lib/http/api';
import { paginated } from '@/lib/http/response';
import { listProjects, projectListSchema } from '@/lib/services/projects';

export const GET = route(
  {
    anyPermission: ['project:read:own', 'project:read:team', 'project:read:org'],
    query: projectListSchema,
  },
  async ({ ctx, query, db, requestId }) => {
    const result = await db((tx) => listProjects(tx, ctx, query), { readOnly: true });
    return paginated(result.rows, result.pagination, requestId);
  },
);
