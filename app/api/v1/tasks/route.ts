import { route } from '@/lib/http/api';
import { created, paginated } from '@/lib/http/response';
import { listTasks, createTask, taskCreateSchema, taskListSchema } from '@/lib/services/projects';

export const GET = route(
  {
    anyPermission: ['task:read:own', 'task:read:team', 'task:read:org'],
    query: taskListSchema,
  },
  async ({ ctx, query, db, requestId }) => {
    const result = await db((tx) => listTasks(tx, ctx, query), { readOnly: true });
    return paginated(result.rows, result.pagination, requestId);
  },
);

export const POST = route(
  { permission: 'task:create:org', body: taskCreateSchema },
  async ({ ctx, body, db, requestId }) => {
    const task = await db((tx) => createTask(tx, ctx, body));
    return created(task, requestId, `/api/v1/tasks/${task.id}`);
  },
);
