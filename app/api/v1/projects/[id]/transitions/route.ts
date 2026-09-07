import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { transitionProject } from '@/lib/services/projects';
import { getTransitionHistory } from '@/lib/services/opportunities';
import { projectMachine } from '@/lib/workflows/machines';
import { availableTransitions } from '@/lib/workflows/state-machine';
import { uuid, transitionBody } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { anyPermission: ['project:read:own', 'project:read:team', 'project:read:org'], params },
  async ({ params: { id }, db, requestId }) => {
    const result = await db(
      async (tx) => {
        const current = await tx.one<{ status: string }>(
          'select status from projects where id = $1 and deleted_at is null',
          [id],
        );
        return {
          current_status: current.status,
          available: availableTransitions(projectMachine, current.status),
          history: await getTransitionHistory(tx, 'project', id),
        };
      },
      { readOnly: true },
    );
    return ok(result, requestId);
  },
);

export const POST = route(
  {
    anyPermission: ['project:update:own', 'project:update:team', 'project:update:org'],
    params,
    body: transitionBody,
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const result = await db((tx) => transitionProject(tx, ctx, id, body));
    return ok({ from: result.from, to: result.to, entity: result.entity }, requestId);
  },
);
