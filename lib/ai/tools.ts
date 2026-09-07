/**
 * The AI Command Centre read tools.
 *
 * There is no text-to-SQL here, deliberately. The model chooses among a fixed
 * set of functions with validated parameters; it never composes a query. That
 * removes an entire class of problem: a model cannot read a table it was not
 * given a tool for, cannot join its way around a permission, and cannot be
 * talked into `DROP TABLE` by something in a client's email.
 *
 * Every tool runs inside the asking user's own tenant transaction, so RLS
 * decides which rows exist, and each declares the permission it needs. A user
 * who cannot see margin cannot obtain margin by asking nicely.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import type { RequestContext } from '@/lib/auth/session';
import { likePattern } from '@/lib/db';
import { AppError } from '@/lib/http/errors';
import type { Anthropic } from './client';

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  /** Permission required. A user without it does not see the tool at all. */
  permission?: string;
  run(tx: Tx, ctx: RequestContext, params: z.infer<S>): Promise<unknown>;
}

const period = z
  .enum(['this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_12_months'])
  .default('this_quarter');

function periodRange(value: z.infer<typeof period>): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  switch (value) {
    case 'this_month':
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) };
    case 'last_month':
      return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
    case 'this_quarter': {
      const q = Math.floor(m / 3) * 3;
      return { from: iso(new Date(Date.UTC(y, q, 1))), to: iso(new Date(Date.UTC(y, q + 3, 0))) };
    }
    case 'last_quarter': {
      const q = Math.floor(m / 3) * 3 - 3;
      return { from: iso(new Date(Date.UTC(y, q, 1))), to: iso(new Date(Date.UTC(y, q + 3, 0))) };
    }
    case 'this_year':
      return { from: iso(new Date(Date.UTC(y, 0, 1))), to: iso(new Date(Date.UTC(y, 11, 31))) };
    default:
      return { from: iso(new Date(Date.UTC(y - 1, m, 1))), to: iso(now) };
  }
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'search_clients',
    description:
      'Find clients by name, lifecycle stage, industry, owner or health status. Returns up to 25 matches with summary counts. Use this to resolve a client name to an id before calling other tools.',
    permission: undefined,
    schema: z.object({
      query: z.string().max(120).optional(),
      lifecycle_stage: z
        .enum(['prospect', 'client', 'former_client', 'partner', 'disqualified'])
        .optional(),
      health_status: z.enum(['healthy', 'watch', 'at_risk', 'critical']).optional(),
      industry: z.string().max(80).optional(),
      limit: z.number().int().min(1).max(25).default(10),
    }),
    async run(tx, ctx, params) {
      ctx.permissions.requireAny('company', 'read');
      const conditions = ['c.deleted_at is null'];
      const values: unknown[] = [];

      if (params.query) {
        values.push(likePattern(params.query));
        conditions.push(`c.name ilike $${values.length}`);
      }
      if (params.lifecycle_stage) {
        values.push(params.lifecycle_stage);
        conditions.push(`c.lifecycle_stage = $${values.length}`);
      }
      if (params.health_status) {
        values.push(params.health_status);
        conditions.push(`c.health_status = $${values.length}`);
      }
      if (params.industry) {
        values.push(likePattern(params.industry));
        conditions.push(`c.industry ilike $${values.length}`);
      }
      values.push(params.limit);

      return tx.many(
        `select c.id, c.name, c.lifecycle_stage, c.industry, c.health_status,
                (select count(*) from opportunities o where o.company_id = c.id
                  and o.deleted_at is null and o.stage not in ('won','lost','closed')) as open_opportunities,
                (select count(*) from projects p where p.company_id = c.id
                  and p.deleted_at is null and p.status = 'active') as active_projects
         from companies c
         where ${conditions.join(' and ')}
         order by c.name
         limit $${values.length}`,
        values,
      );
    },
  },

  {
    name: 'get_pipeline_summary',
    description:
      'Pipeline totals by stage for a period, with win rate and average days to close. Optionally narrowed to one owner.',
    schema: z.object({
      period,
      owner_user_id: z.string().uuid().optional(),
    }),
    async run(tx, ctx, params) {
      ctx.permissions.requireAny('opportunity', 'read');
      const { from, to } = periodRange(params.period);
      const { pipelineSummary } = await import('@/lib/services/reporting');
      return {
        period: { from, to },
        ...(await pipelineSummary(tx, { owner_user_id: params.owner_user_id }, from, to)),
      };
    },
  },

  {
    name: 'list_at_risk_clients',
    description:
      'Clients showing risk signals: an at-risk or off-track project, an overdue invoice, no recent activity, or a contract expiring soon.',
    schema: z.object({ limit: z.number().int().min(1).max(25).default(10) }),
    async run(tx, ctx, params) {
      ctx.permissions.requireAny('company', 'read');
      return tx.many(
        `select c.id, c.name, c.health_status,
                (select count(*) from projects p where p.company_id = c.id
                  and p.deleted_at is null and p.health in ('at_risk','off_track')) as troubled_projects,
                (select count(*) from contracts ct where ct.company_id = c.id
                  and ct.deleted_at is null and ct.status = 'fully_executed'
                  and ct.expiry_date between current_date and current_date + interval '60 days') as expiring_contracts,
                (select max(a.occurred_at) from activities a where a.company_id = c.id) as last_activity_at
         from companies c
         where c.deleted_at is null and c.lifecycle_stage = 'client'
           and (
             c.health_status in ('at_risk','critical')
             or exists (select 1 from projects p where p.company_id = c.id
                        and p.deleted_at is null and p.health in ('at_risk','off_track'))
             or not exists (select 1 from activities a where a.company_id = c.id
                            and a.occurred_at > now() - interval '45 days')
           )
         order by c.name
         limit $1`,
        [params.limit],
      );
    },
  },

  {
    name: 'list_contracts_by_status',
    description:
      'Contracts in a given lifecycle status, newest first. Use to answer questions about what is awaiting signature or recently executed.',
    permission: 'contract:read:org',
    schema: z.object({
      status: z.enum([
        'draft', 'internal_review', 'approved_to_send', 'sent', 'viewed',
        'partially_signed', 'fully_executed', 'declined', 'expired', 'voided',
      ]),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    async run(tx, ctx, params) {
      ctx.permissions.requireAny('contract', 'read');
      return tx.many(
        `select ct.id, ct.reference, ct.title, ct.contract_type, ct.status,
                co.name as company_name, ct.sent_at, ct.executed_at, ct.expiry_date
         from contracts ct
         join companies co on co.id = ct.company_id
         where ct.deleted_at is null and ct.status = $1
         order by coalesce(ct.sent_at, ct.created_at) desc
         limit $2`,
        [params.status, params.limit],
      );
    },
  },

  {
    name: 'get_client_360',
    description:
      'Everything about one client: contacts, pipeline totals, projects, contracts and upcoming dates. Call search_clients first to get the id.',
    schema: z.object({ client_id: z.string().uuid() }),
    async run(tx, ctx, params) {
      ctx.permissions.requireAny('company', 'read');
      const { getClientOverview } = await import('@/lib/services/client360');
      const overview = await getClientOverview(tx, ctx, params.client_id);
      // Internal notes never travel to the model, even for a user who may read
      // them: they are not needed to answer a question about a client.
      const { internal_notes: _internal, ...company } = overview.company as Record<string, unknown>;
      return { ...overview, company };
    },
  },

  {
    name: 'list_overdue_tasks',
    description: 'Tasks past their due date and not finished, optionally for one assignee.',
    schema: z.object({
      assignee_user_id: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    async run(tx, ctx, params) {
      ctx.permissions.requireAny('task', 'read');
      const values: unknown[] = [];
      let filter = '';
      if (params.assignee_user_id) {
        values.push(params.assignee_user_id);
        filter = `and t.assignee_user_id = $${values.length}`;
      }
      values.push(params.limit);

      return tx.many(
        `select t.id, t.title, t.status, t.priority, t.due_date,
                (current_date - t.due_date) as days_overdue,
                u.full_name as assignee_name, p.name as project_name
         from tasks t
         left join user_profiles u on u.id = t.assignee_user_id
         left join projects p on p.id = t.project_id
         where t.deleted_at is null and t.status not in ('done','cancelled')
           and t.due_date < current_date ${filter}
         order by t.due_date
         limit $${values.length}`,
        values,
      );
    },
  },

  {
    name: 'list_renewals_due',
    description: 'Executed contracts expiring within a number of days.',
    permission: 'contract:read:org',
    schema: z.object({ days: z.number().int().min(1).max(365).default(90) }),
    async run(tx, ctx, params) {
      ctx.permissions.requireAny('contract', 'read');
      const { renewalsDue } = await import('@/lib/services/reporting');
      return renewalsDue(tx, params.days);
    },
  },

  {
    name: 'get_revenue_summary',
    description:
      'Revenue received in a period, by month or by client. Requires finance permission; returns nothing without it.',
    permission: 'finance:read:org',
    schema: z.object({
      period,
      dimension: z.enum(['month', 'client', 'total']).default('month'),
    }),
    async run(tx, ctx, params) {
      ctx.permissions.require('finance:read:org');
      const { from, to } = periodRange(params.period);

      if (params.dimension === 'client') {
        return {
          period: { from, to },
          rows: await tx.many(
            `select c.name as client, coalesce(sum(p.amount_base), 0)::text as amount
             from payments p join companies c on c.id = p.company_id
             where p.deleted_at is null and p.status in ('received','cleared')
               and p.transaction_date between $1::date and $2::date
             group by c.name order by 2 desc limit 25`,
            [from, to],
          ),
        };
      }

      const { revenueSummary } = await import('@/lib/services/reporting');
      return { period: { from, to }, ...(await revenueSummary(tx, ctx, {}, from, to)) };
    },
  },
];

/** The tools this user may actually use, in Anthropic's schema format. */
export function toolsForUser(ctx: RequestContext): Anthropic.Tool[] {
  return TOOLS.filter((tool) => !tool.permission || ctx.permissions.has(tool.permission)).map(
    (tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: zodToJsonSchema(tool.schema),
    }),
  );
}

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * Runs a tool the model asked for.
 *
 * Parameters are validated before execution, the permission is re-checked here
 * (not only when the tool list was built), and an unknown name is an error
 * rather than a no-op — a model asking for a tool that does not exist is a
 * signal worth surfacing.
 */
export async function runTool(
  tx: Tx,
  ctx: RequestContext,
  name: string,
  rawParams: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const tool = findTool(name);
  if (!tool) return { ok: false, error: `There is no tool named "${name}".` };

  if (tool.permission && !ctx.permissions.has(tool.permission)) {
    return { ok: false, error: 'You do not have permission to read that data.' };
  }

  const parsed = tool.schema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid parameters: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    };
  }

  try {
    return { ok: true, data: await tool.run(tx, ctx, parsed.data) };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

/**
 * A minimal Zod-to-JSON-Schema conversion covering the shapes these tools use.
 * A general converter would be a dependency and a liability; this handles
 * exactly what is here and throws on anything it does not recognise.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Anthropic.Tool['input_schema'] {
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const { json, isRequired } = fieldToJson(value as z.ZodTypeAny);
    properties[key] = json;
    if (isRequired) required.push(key);
  }

  return { type: 'object', properties, required } as Anthropic.Tool['input_schema'];
}

function fieldToJson(field: z.ZodTypeAny): { json: unknown; isRequired: boolean } {
  let current = field;
  let isRequired = true;

  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodNullable
  ) {
    isRequired = false;
    current =
      current instanceof z.ZodDefault
        ? current._def.innerType
        : (current as z.ZodOptional<z.ZodTypeAny>).unwrap();
  }

  if (current instanceof z.ZodEnum) {
    return { json: { type: 'string', enum: current.options }, isRequired };
  }
  if (current instanceof z.ZodString) {
    return { json: { type: 'string' }, isRequired };
  }
  if (current instanceof z.ZodNumber) {
    return { json: { type: 'integer' }, isRequired };
  }
  if (current instanceof z.ZodBoolean) {
    return { json: { type: 'boolean' }, isRequired };
  }
  if (current instanceof z.ZodArray) {
    return {
      json: { type: 'array', items: fieldToJson(current.element).json },
      isRequired,
    };
  }

  throw new Error(`Unsupported tool parameter type: ${current.constructor.name}`);
}
