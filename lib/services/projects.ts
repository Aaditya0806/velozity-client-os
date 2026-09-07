/**
 * Projects, workstreams and tasks.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { likePattern } from '@/lib/db';
import { filters } from '@/lib/db/filters';
import { AppError } from '@/lib/http/errors';
import { emitEvent, recordActivity, notify } from '@/lib/events';
import { writeAudit } from '@/lib/audit';
import type { RequestContext } from '@/lib/auth/session';
import { redactMany, redactSensitiveFields } from '@/lib/permissions';
import { performTransition, type TransitionRequest } from '@/lib/workflows/state-machine';
import { projectMachine } from '@/lib/workflows/machines';
import {
  uuid, shortText, nullableText, isoDate, currencyCode, moneyAmount, tags,
  listQuery, safeOrderBy, paginationMeta,
} from '@/lib/validation/common';

export const PROJECT_SORT_COLUMNS = [
  'name', 'code', 'created_at', 'updated_at', 'start_date', 'target_end_date', 'status', 'health',
] as const;

export const projectListSchema = listQuery(PROJECT_SORT_COLUMNS, 'updated_at', {
  company_id: uuid.optional(),
  status: z.string().optional(),
  health: z.string().optional(),
  manager_user_id: uuid.optional(),
  active_only: z.enum(['true', 'false']).optional(),
});

export const projectUpdateSchema = z.object({
  name: shortText(200).optional(),
  description: nullableText().optional(),
  start_date: isoDate.nullable().optional(),
  target_end_date: isoDate.nullable().optional(),
  budget_amount: moneyAmount.nullable().optional(),
  currency: currencyCode.optional(),
  manager_user_id: uuid.nullable().optional(),
  team_id: uuid.nullable().optional(),
  reporting_cadence: z.enum(['none', 'weekly', 'fortnightly', 'monthly', 'quarterly']).optional(),
  kickoff_at: z.string().datetime({ offset: true }).nullable().optional(),
  health: z.enum(['unknown', 'on_track', 'at_risk', 'off_track']).optional(),
  health_note: nullableText(1000).optional(),
  tags: tags.optional(),
  internal_notes: nullableText().optional(),
});

export async function listProjects(
  tx: Tx,
  ctx: RequestContext,
  query: z.infer<typeof projectListSchema>,
) {
  const f = filters('p.deleted_at is null');
  if (query.q) {
    const pat = likePattern(query.q);
    f.where('(p.name ilike ? or p.code ilike ? or c.name ilike ?)', pat, pat, pat);
  }
  f.whereIf(query.company_id, 'p.company_id = ?');
  f.whereIf(query.status, 'p.status = ?');
  f.whereIf(query.health, 'p.health = ?');
  f.whereIf(query.manager_user_id, 'p.manager_user_id = ?');
  if (query.active_only === 'true') f.where('p.status = any (?)', ['active', 'on_hold', 'not_started']);

  const totalRow = await tx.one<{ count: string }>(
    `select count(*)::text as count from projects p
     join companies c on c.id = p.company_id where ${f.sql}`,
    f.params,
  );

  const order = safeOrderBy(query.sort, query.direction, PROJECT_SORT_COLUMNS, 'updated_at');
  const limit = f.bind(query.page_size);
  const offset = f.bind((query.page - 1) * query.page_size);

  const rows = await tx.many<Record<string, unknown>>(
    `select p.*, c.name as company_name, m.full_name as manager_name,
            (select count(*) from tasks t where t.project_id = p.id and t.deleted_at is null) as task_count,
            (select count(*) from tasks t where t.project_id = p.id and t.deleted_at is null
              and t.status = 'done') as completed_task_count,
            (select count(*) from tasks t where t.project_id = p.id and t.deleted_at is null
              and t.status not in ('done','cancelled') and t.due_date < current_date) as overdue_task_count
     from projects p
     join companies c on c.id = p.company_id
     left join user_profiles m on m.id = p.manager_user_id
     where ${f.sql}
     order by p.${order}
     limit ${limit} offset ${offset}`,
    f.params,
  );

  return {
    rows: redactMany(rows, ctx.permissions),
    pagination: paginationMeta(query.page, query.page_size, Number.parseInt(totalRow.count, 10)),
  };
}

export async function getProject(tx: Tx, ctx: RequestContext, id: string) {
  const project = await tx.maybeOne<Record<string, unknown>>(
    `select p.*, c.name as company_name, m.full_name as manager_name,
            ct.reference as contract_reference
     from projects p
     join companies c on c.id = p.company_id
     left join user_profiles m on m.id = p.manager_user_id
     left join contracts ct on ct.id = p.contract_id
     where p.id = $1 and p.deleted_at is null`,
    [id],
  );
  if (!project) throw new AppError('NOT_FOUND', 'This project was not found.');

  const [workstreams, services, deliverables, kpis] = await Promise.all([
    tx.many(
      `select w.*, u.full_name as owner_name,
              (select count(*) from tasks t where t.workstream_id = w.id and t.deleted_at is null) as task_count
       from workstreams w
       left join user_profiles u on u.id = w.owner_user_id
       where w.project_id = $1 and w.deleted_at is null order by w.position`,
      [id],
    ),
    tx.many(
      `select ps.*, s.name as service_name, s.code as service_code
       from project_services ps join services s on s.id = ps.service_id
       where ps.project_id = $1`,
      [id],
    ),
    tx.many(
      `select * from deliverables where project_id = $1 and deleted_at is null order by position`,
      [id],
    ),
    ctx.permissions.can('kpi', 'read')
      ? tx.many(`select * from kpis where project_id = $1 and deleted_at is null order by position`, [id])
      : Promise.resolve([]),
  ]);

  return {
    ...redactSensitiveFields(project, ctx.permissions),
    workstreams,
    services,
    deliverables,
    kpis,
  };
}

export async function updateProject(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  input: z.infer<typeof projectUpdateSchema>,
) {
  if (input.internal_notes !== undefined && !ctx.permissions.has('internal_note:read:org')) {
    throw new AppError('FORBIDDEN', 'You do not have permission to edit internal notes.');
  }

  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return getProject(tx, ctx, id);

  // A health change is a reported judgement, so stamp when it was made.
  const extra = input.health !== undefined ? ', health_updated_at = now()' : '';
  const assignments = entries.map(([k], i) => `${quote(k)} = $${i + 2}`).join(', ');

  const project = await tx.one<Record<string, unknown>>(
    `update projects set ${assignments}${extra} where id = $1 and deleted_at is null returning *`,
    [id, ...entries.map(([, v]) => v)],
  );

  if (input.health !== undefined) {
    await emitEvent(tx, {
      name: 'project.health_changed',
      entityType: 'project',
      entityId: id,
      payload: { health: input.health, note: input.health_note ?? null },
    });
    await recordActivity(tx, {
      entityType: 'project',
      entityId: id,
      companyId: String(project.company_id),
      activityType: 'updated',
      title: `Project health set to ${String(input.health).replace('_', ' ')}`,
      body: input.health_note ?? null,
    });
  }

  return project;
}

export async function transitionProject(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  request: TransitionRequest,
) {
  const result = await performTransition(tx, projectMachine, id, request, {
    userId: ctx.user.id,
  });

  const event = await emitEvent(tx, {
    name: 'project.status_changed',
    entityType: 'project',
    entityId: id,
    payload: { from: result.from, to: result.to, reason: request.reason ?? null },
  });

  await recordActivity(tx, {
    entityType: 'project',
    entityId: id,
    companyId: String(result.entity.company_id),
    activityType: 'state_changed',
    title: `Project status changed from ${result.from} to ${result.to}`,
    body: request.reason ?? null,
    eventId: event.id,
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'project.status_changed',
    category: 'state_change',
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: id,
    summary: `Project ${result.entity.code}: ${result.from} → ${result.to}`,
    reason: request.reason ?? null,
    requestId: ctx.requestId,
  });

  return result;
}

// -----------------------------------------------------------------------------
// Tasks
// -----------------------------------------------------------------------------

export const TASK_SORT_COLUMNS = [
  'due_date', 'created_at', 'updated_at', 'priority', 'status', 'title', 'position',
] as const;

export const taskCreateSchema = z.object({
  project_id: uuid.nullable().optional(),
  workstream_id: uuid.nullable().optional(),
  company_id: uuid.nullable().optional(),
  parent_task_id: uuid.nullable().optional(),
  title: shortText(300),
  description: nullableText(),
  status: z.enum(['todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled']).default('todo'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  assignee_user_id: uuid.nullable().optional(),
  start_date: isoDate.nullable().optional(),
  due_date: isoDate.nullable().optional(),
  estimated_hours: z.string().nullable().optional(),
  is_deliverable: z.boolean().default(false),
  is_milestone: z.boolean().default(false),
  is_client_visible: z.boolean().default(false),
  tags,
});

export const taskUpdateSchema = taskCreateSchema.partial().extend({
  blocked_reason: nullableText(1000).optional(),
  actual_hours: z.string().nullable().optional(),
  position: z.number().int().optional(),
});

export const taskListSchema = listQuery(TASK_SORT_COLUMNS, 'due_date', {
  project_id: uuid.optional(),
  workstream_id: uuid.optional(),
  assignee_user_id: uuid.optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  scope: z.enum(['mine', 'team', 'all', 'overdue', 'due_soon', 'completed']).optional(),
});

export async function listTasks(
  tx: Tx,
  ctx: RequestContext,
  query: z.infer<typeof taskListSchema>,
) {
  const f = filters('t.deleted_at is null');

  if (query.q) f.where('t.title ilike ?', likePattern(query.q));
  f.whereIf(query.project_id, 't.project_id = ?');
  f.whereIf(query.workstream_id, 't.workstream_id = ?');
  f.whereIf(query.assignee_user_id, 't.assignee_user_id = ?');
  f.whereIf(query.status, 't.status = ?');
  f.whereIf(query.priority, 't.priority = ?');

  switch (query.scope) {
    case 'mine':
      f.where('t.assignee_user_id = ?', ctx.user.id);
      break;
    case 'team':
      if (ctx.teamIds.length > 0) f.where('t.team_id = any (?)', ctx.teamIds);
      break;
    case 'overdue':
      f.where(`t.due_date < current_date and t.status not in ('done','cancelled')`);
      break;
    case 'due_soon':
      f.where(
        `t.due_date between current_date and current_date + interval '7 days'
         and t.status not in ('done','cancelled')`,
      );
      break;
    case 'completed':
      f.where(`t.status = 'done'`);
      break;
    default:
      break;
  }

  const totalRow = await tx.one<{ count: string }>(
    `select count(*)::text as count from tasks t where ${f.sql}`,
    f.params,
  );

  const order = safeOrderBy(query.sort, query.direction, TASK_SORT_COLUMNS, 'due_date');
  const limit = f.bind(query.page_size);
  const offset = f.bind((query.page - 1) * query.page_size);

  const rows = await tx.many(
    `select t.*, p.name as project_name, p.code as project_code,
            w.name as workstream_name, a.full_name as assignee_name,
            c.name as company_name,
            (t.due_date is not null and t.due_date < current_date
             and t.status not in ('done','cancelled')) as is_overdue,
            (select count(*) from tasks sub where sub.parent_task_id = t.id and sub.deleted_at is null) as subtask_count
     from tasks t
     left join projects p on p.id = t.project_id
     left join workstreams w on w.id = t.workstream_id
     left join user_profiles a on a.id = t.assignee_user_id
     left join companies c on c.id = t.company_id
     where ${f.sql}
     order by t.${order} nulls last
     limit ${limit} offset ${offset}`,
    f.params,
  );

  return {
    rows,
    pagination: paginationMeta(query.page, query.page_size, Number.parseInt(totalRow.count, 10)),
  };
}

export async function createTask(
  tx: Tx,
  ctx: RequestContext,
  input: z.infer<typeof taskCreateSchema>,
) {
  const reference = await tx.one<{ reference: string }>(
    `select app.next_reference($1, 'task', 'TSK') as reference`,
    [ctx.org.id],
  );

  const task = await tx.one<Record<string, unknown>>(
    `insert into tasks (
       org_id, project_id, workstream_id, company_id, parent_task_id, reference,
       title, description, status, priority, assignee_user_id, start_date, due_date,
       estimated_hours, is_deliverable, is_milestone, is_client_visible, tags, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     returning *`,
    [
      ctx.org.id, input.project_id ?? null, input.workstream_id ?? null,
      input.company_id ?? null, input.parent_task_id ?? null, reference.reference,
      input.title, input.description ?? null, input.status, input.priority,
      input.assignee_user_id ?? null, input.start_date ?? null, input.due_date ?? null,
      input.estimated_hours ?? null, input.is_deliverable, input.is_milestone,
      input.is_client_visible, input.tags, ctx.user.id,
    ],
  );

  await emitEvent(tx, {
    name: 'task.created',
    entityType: 'task',
    entityId: String(task.id),
    payload: { title: task.title, project_id: task.project_id },
  });

  if (input.assignee_user_id && input.assignee_user_id !== ctx.user.id) {
    await notify(tx, {
      userId: input.assignee_user_id,
      category: 'assignment',
      title: 'A task was assigned to you',
      body: input.title,
      entityType: 'task',
      entityId: String(task.id),
      linkUrl: `/tasks/${task.id}`,
    });
  }

  return task;
}

export async function updateTask(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  input: z.infer<typeof taskUpdateSchema>,
) {
  const before = await tx.maybeOne<Record<string, unknown>>(
    `select * from tasks where id = $1 and deleted_at is null for update`,
    [id],
  );
  if (!before) throw new AppError('NOT_FOUND', 'This task was not found.');

  // A blocking predecessor must be finished before this can be.
  if (input.status === 'done' && before.status !== 'done') {
    const blocking = await tx.many<{ title: string }>(
      `select t.title from task_dependencies d
       join tasks t on t.id = d.depends_on_task_id
       where d.task_id = $1 and d.dependency_type = 'finish_to_start'
         and t.status not in ('done', 'cancelled') and t.deleted_at is null`,
      [id],
    );
    if (blocking.length > 0) {
      throw new AppError(
        'CONFLICT',
        `This task depends on ${blocking.length} unfinished task(s).`,
        { details: { blocked_by: blocking.map((b) => b.title) } },
      );
    }
  }

  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return before;

  const assignments = entries.map(([k], i) => `${quote(k)} = $${i + 2}`).join(', ');
  const after = await tx.one<Record<string, unknown>>(
    `update tasks set ${assignments} where id = $1 returning *`,
    [id, ...entries.map(([, v]) => v)],
  );

  if (input.status === 'done' && before.status !== 'done') {
    await emitEvent(tx, {
      name: 'task.completed',
      entityType: 'task',
      entityId: id,
      payload: { title: after.title, project_id: after.project_id },
    });
  }

  if (input.assignee_user_id && input.assignee_user_id !== before.assignee_user_id) {
    await emitEvent(tx, {
      name: 'task.assigned',
      entityType: 'task',
      entityId: id,
      payload: { assignee_user_id: input.assignee_user_id },
    });
    if (input.assignee_user_id !== ctx.user.id) {
      await notify(tx, {
        userId: input.assignee_user_id,
        category: 'assignment',
        title: 'A task was assigned to you',
        body: String(after.title),
        entityType: 'task',
        entityId: id,
        linkUrl: `/tasks/${id}`,
      });
    }
  }

  return after;
}

export async function getTask(tx: Tx, _ctx: RequestContext, id: string) {
  const task = await tx.maybeOne<Record<string, unknown>>(
    `select t.*, p.name as project_name, w.name as workstream_name,
            a.full_name as assignee_name, cr.full_name as created_by_name
     from tasks t
     left join projects p on p.id = t.project_id
     left join workstreams w on w.id = t.workstream_id
     left join user_profiles a on a.id = t.assignee_user_id
     left join user_profiles cr on cr.id = t.created_by
     where t.id = $1 and t.deleted_at is null`,
    [id],
  );
  if (!task) throw new AppError('NOT_FOUND', 'This task was not found.');

  const [subtasks, dependencies, comments] = await Promise.all([
    tx.many(
      `select id, title, status, due_date, assignee_user_id from tasks
       where parent_task_id = $1 and deleted_at is null order by position`,
      [id],
    ),
    tx.many(
      `select d.*, t.title as depends_on_title, t.status as depends_on_status
       from task_dependencies d join tasks t on t.id = d.depends_on_task_id
       where d.task_id = $1`,
      [id],
    ),
    tx.many(
      `select c.*, u.full_name as author_name from task_comments c
       left join user_profiles u on u.id = c.author_id
       where c.task_id = $1 and c.deleted_at is null order by c.created_at`,
      [id],
    ),
  ]);

  return { ...task, subtasks, dependencies, comments };
}

function quote(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe column: ${name}`);
  return `"${name}"`;
}
