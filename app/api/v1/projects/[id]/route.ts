import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { getProject, updateProject, projectUpdateSchema } from '@/lib/services/projects';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { anyPermission: ['project:read:own', 'project:read:team', 'project:read:org'], params },
  async ({ ctx, params: { id }, db, requestId }) => {
    const project = await db((tx) => getProject(tx, ctx, id), { readOnly: true });
    return ok(project, requestId);
  },
);

export const PATCH = route(
  {
    anyPermission: ['project:update:own', 'project:update:team', 'project:update:org'],
    params,
    body: projectUpdateSchema,
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const project = await db((tx) => updateProject(tx, ctx, id, body));
    return ok(project, requestId);
  },
);
