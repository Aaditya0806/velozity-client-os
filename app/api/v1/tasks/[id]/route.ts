import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { getTask, updateTask, taskUpdateSchema } from '@/lib/services/projects';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { anyPermission: ['task:read:own', 'task:read:team', 'task:read:org'], params },
  async ({ ctx, params: { id }, db, requestId }) => {
    const task = await db((tx) => getTask(tx, ctx, id), { readOnly: true });
    return ok(task, requestId);
  },
);

export const PATCH = route(
  {
    anyPermission: ['task:update:own', 'task:update:team', 'task:update:org'],
    params,
    body: taskUpdateSchema,
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const task = await db((tx) => updateTask(tx, ctx, id, body));
    return ok(task, requestId);
  },
);
