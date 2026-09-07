import { route } from '@/lib/http/api';
import { created } from '@/lib/http/response';
import { createSolution, solutionCreateSchema } from '@/lib/services/solutions';

export const POST = route(
  {
    anyPermission: ['opportunity:update:own', 'opportunity:update:team', 'opportunity:update:org'],
    body: solutionCreateSchema,
  },
  async ({ ctx, body, db, requestId }) => {
    const solution = await db((tx) => createSolution(tx, ctx, body));
    return created(solution, requestId, `/api/v1/solutions/${solution.id}`);
  },
);
