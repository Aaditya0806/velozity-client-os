/**
 * Project provisioning.
 *
 * Runs once an onboarding is unblocked. Creates the delivery workspace from the
 * services that were actually sold: workstreams, tasks, deliverables, KPIs and a
 * reporting cadence, all derived from the accepted proposal rather than from
 * whatever the catalogue says today.
 *
 * Idempotent by construction: an onboarding that already has a project returns
 * it unchanged, so a retried job cannot create a second workspace.
 */
import type { Tx } from '@/lib/db';
import type { RequestContext } from '@/lib/auth/session';
import { AppError } from '@/lib/http/errors';
import { emitEvent, recordActivity, notify } from '@/lib/events';
import { writeAudit } from '@/lib/audit';
import { nextReference } from '@/lib/services/opportunities';
import { addOnboardingTasks, DEFAULT_ONBOARDING_TASKS } from '@/lib/services/onboarding';
import { addBusinessDays } from '@/lib/util/business-time';
import { logger } from '@/lib/util/logger';

export interface ProvisionInput {
  onboardingId: string;
  projectName?: string;
  startDate?: string;
  managerUserId?: string | null;
  teamId?: string | null;
  reportingCadence?: 'none' | 'weekly' | 'fortnightly' | 'monthly' | 'quarterly';
}

export interface ProvisionResult {
  projectId: string;
  created: boolean;
  workstreams: number;
  tasks: number;
  kpis: number;
  deliverables: number;
}

export async function provisionProject(
  tx: Tx,
  ctx: RequestContext,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const onboarding = await tx.maybeOne<{
    id: string; company_id: string; opportunity_id: string | null;
    project_id: string | null; status: string; owner_user_id: string | null;
    target_kickoff_date: string | null;
  }>(
    `select id, company_id, opportunity_id, project_id, status, owner_user_id, target_kickoff_date
     from onboardings where id = $1 and deleted_at is null for update`,
    [input.onboardingId],
  );
  if (!onboarding) throw new AppError('NOT_FOUND', 'This onboarding was not found.');

  if (onboarding.status === 'blocked') {
    throw new AppError(
      'LEGAL_GATE_BLOCKED',
      'A delivery workspace cannot be created while onboarding is blocked.',
    );
  }

  if (onboarding.project_id) {
    const counts = await countWorkspace(tx, onboarding.project_id);
    return { projectId: onboarding.project_id, created: false, ...counts };
  }

  const company = await tx.one<{ name: string; currency: string | null }>(
    `select name, currency from companies where id = $1`,
    [onboarding.company_id],
  );

  // The sold services, read from the accepted proposal version's frozen
  // solution snapshot rather than the live opportunity.
  const soldServices = onboarding.opportunity_id
    ? await tx.many<{
        service_id: string; service_name: string; quantity: string;
        total_amount: string; currency: string; default_duration_days: number | null;
        delivery_config: Record<string, unknown>;
      }>(
        `select li.service_id,
                coalesce(s.name, li.name) as service_name,
                li.quantity, li.total_amount, sol.currency,
                s.default_duration_days, s.delivery_config
         from opportunities o
         join proposal_versions pv on pv.id = o.accepted_proposal_version_id
         join solutions sol on sol.id = pv.solution_id
         join solution_line_items li on li.solution_id = sol.id
         left join services s on s.id = li.service_id
         where o.id = $1 and not li.is_optional and li.service_id is not null`,
        [onboarding.opportunity_id],
      )
    : [];

  const contract = onboarding.opportunity_id
    ? await tx.maybeOne<{ id: string; currency: string | null; contract_value: string | null }>(
        `select id, currency, contract_value from contracts
         where opportunity_id = $1 and contract_type in ('msa','sow')
           and status = 'fully_executed' and deleted_at is null
         order by executed_at desc limit 1`,
        [onboarding.opportunity_id],
      )
    : null;

  const currency =
    soldServices[0]?.currency ?? contract?.currency ?? company.currency ?? ctx.org.baseCurrency;

  const startDate = input.startDate ?? new Date().toISOString().slice(0, 10);
  const longestService = soldServices.reduce(
    (max, s) => Math.max(max, s.default_duration_days ?? 0),
    0,
  );
  const targetEnd = await addBusinessDays(
    tx,
    ctx.org.id,
    startDate,
    longestService > 0 ? longestService : 60,
  );

  const code = await nextReference(tx, ctx.org.id, 'project', 'PRJ');
  const cadence = input.reportingCadence ?? 'monthly';

  const project = await tx.one<{ id: string; code: string; name: string }>(
    `insert into projects (
       org_id, company_id, opportunity_id, contract_id, onboarding_id, code, name,
       description, status, currency, budget_amount, start_date, target_end_date,
       manager_user_id, team_id, reporting_cadence, next_report_due, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,'not_started',$9,$10,$11,$12,$13,$14,$15,$16,$17)
     returning id, code, name`,
    [
      ctx.org.id, onboarding.company_id, onboarding.opportunity_id, contract?.id ?? null,
      onboarding.id, code,
      input.projectName ?? `${company.name} — delivery`,
      soldServices.map((s) => s.service_name).join(', ') || null,
      currency, contract?.contract_value ?? null, startDate, targetEnd,
      input.managerUserId ?? onboarding.owner_user_id ?? ctx.user.id,
      input.teamId ?? null, cadence,
      cadence === 'none' ? null : nextReportDate(startDate, cadence),
      ctx.user.id,
    ],
  );

  await tx.query(`update onboardings set project_id = $2 where id = $1`, [
    onboarding.id,
    project.id,
  ]);

  let workstreamCount = 0;
  let taskCount = 0;
  let kpiCount = 0;
  let deliverableCount = 0;

  for (const service of soldServices) {
    await tx.query(
      `insert into project_services (org_id, project_id, service_id, quantity, contracted_amount, currency)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (project_id, service_id) do nothing`,
      [ctx.org.id, project.id, service.service_id, service.quantity, service.total_amount, currency],
    );

    const templates = await tx.many<{
      id: string; workstream_name: string | null; title: string; description: string | null;
      position: number; priority: string; estimated_hours: string | null;
      offset_days: number; duration_days: number; is_deliverable: boolean;
    }>(
      `select id, workstream_name, title, description, position, priority,
              estimated_hours, offset_days, duration_days, is_deliverable
       from service_default_tasks where service_id = $1 order by position`,
      [service.service_id],
    );

    // One workstream per distinct name in the service's task templates, so the
    // delivery plan mirrors how the service is actually structured.
    const workstreamIds = new Map<string, string>();
    const names = [...new Set(templates.map((t) => t.workstream_name ?? service.service_name))];

    for (const [index, name] of names.entries()) {
      const workstream = await tx.one<{ id: string }>(
        `insert into workstreams (org_id, project_id, service_id, name, status, start_date, position)
         values ($1,$2,$3,$4,'not_started',$5,$6)
         returning id`,
        [ctx.org.id, project.id, service.service_id, name, startDate, index],
      );
      workstreamIds.set(name, workstream.id);
      workstreamCount++;
    }

    for (const template of templates) {
      const workstreamName = template.workstream_name ?? service.service_name;
      const start = await addBusinessDays(tx, ctx.org.id, startDate, template.offset_days);
      const due = await addBusinessDays(tx, ctx.org.id, start, template.duration_days);

      const task = await tx.one<{ id: string }>(
        `insert into tasks (
           org_id, project_id, workstream_id, company_id, title, description,
           status, priority, start_date, due_date, estimated_hours,
           is_deliverable, position, created_by
         ) values ($1,$2,$3,$4,$5,$6,'todo',$7,$8,$9,$10,$11,$12,$13)
         returning id`,
        [
          ctx.org.id, project.id, workstreamIds.get(workstreamName) ?? null,
          onboarding.company_id, template.title, template.description,
          template.priority, start, due, template.estimated_hours,
          template.is_deliverable, template.position, ctx.user.id,
        ],
      );
      taskCount++;

      if (template.is_deliverable) {
        await tx.query(
          `insert into deliverables (org_id, project_id, workstream_id, task_id, name, status, due_date, position)
           values ($1,$2,$3,$4,$5,'pending',$6,$7)`,
          [
            ctx.org.id, project.id, workstreamIds.get(workstreamName) ?? null,
            task.id, template.title, due, template.position,
          ],
        );
        deliverableCount++;
      }
    }

    // KPIs inherit their definition from the service catalogue.
    const kpiDefinitions = await tx.many<{
      id: string; name: string; description: string | null; unit: string;
      target_value: string | null; direction: string; period: string; position: number;
    }>(
      `select id, name, description, unit, target_value, direction, period, position
       from service_default_kpis where service_id = $1 order by position`,
      [service.service_id],
    );

    for (const definition of kpiDefinitions) {
      await tx.query(
        `insert into kpis (
           org_id, project_id, company_id, service_id, source_definition_id,
           name, description, unit, currency, direction, period, target_value,
           status, owner_user_id, position
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'not_started',$13,$14)`,
        [
          ctx.org.id, project.id, onboarding.company_id, service.service_id, definition.id,
          definition.name, definition.description, definition.unit,
          definition.unit === 'currency' ? currency : null,
          definition.direction, definition.period, definition.target_value,
          input.managerUserId ?? ctx.user.id, definition.position,
        ],
      );
      kpiCount++;
    }
  }

  // A project with no catalogue-driven plan still gets a usable skeleton rather
  // than an empty board.
  if (workstreamCount === 0) {
    await tx.query(
      `insert into workstreams (org_id, project_id, name, status, start_date, position)
       values ($1,$2,'Delivery','not_started',$3,0)`,
      [ctx.org.id, project.id, startDate],
    );
    workstreamCount = 1;
  }

  await addOnboardingTasks(
    tx,
    ctx,
    onboarding.id,
    DEFAULT_ONBOARDING_TASKS.map((t) => ({
      title: t.title,
      category: t.category,
      assignee_user_id: input.managerUserId ?? onboarding.owner_user_id ?? null,
    })),
  );

  const event = await emitEvent(tx, {
    name: 'project.created',
    entityType: 'project',
    entityId: project.id,
    payload: {
      code: project.code,
      company_id: onboarding.company_id,
      opportunity_id: onboarding.opportunity_id,
      onboarding_id: onboarding.id,
      workstreams: workstreamCount,
      tasks: taskCount,
      kpis: kpiCount,
    },
  });

  await recordActivity(tx, {
    entityType: 'project',
    entityId: project.id,
    companyId: onboarding.company_id,
    activityType: 'created',
    title: `Project ${project.code} created`,
    body: `${workstreamCount} workstream(s), ${taskCount} task(s) and ${kpiCount} KPI(s) generated from the sold services.`,
    eventId: event.id,
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'project.provisioned',
    category: 'admin',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: project.id,
    summary: `Provisioned delivery workspace ${project.code}`,
    metadata: { workstreams: workstreamCount, tasks: taskCount, kpis: kpiCount, deliverables: deliverableCount },
    requestId: ctx.requestId,
  });

  // Tell the people who now have work to do.
  const manager = input.managerUserId ?? onboarding.owner_user_id;
  if (manager) {
    await notify(tx, {
      userId: manager,
      category: 'assignment',
      title: 'New project ready for delivery',
      body: `${project.name} (${project.code}) has been created with ${taskCount} task(s).`,
      entityType: 'project',
      entityId: project.id,
      linkUrl: `/projects/${project.id}`,
      priority: 'high',
      dedupeKey: `project-created:${project.id}`,
    });
  }

  logger.info('Project provisioned', {
    org_id: ctx.org.id,
    project_id: project.id,
    onboarding_id: onboarding.id,
    tasks: taskCount,
  });

  return {
    projectId: project.id,
    created: true,
    workstreams: workstreamCount,
    tasks: taskCount,
    kpis: kpiCount,
    deliverables: deliverableCount,
  };
}

async function countWorkspace(tx: Tx, projectId: string) {
  const row = await tx.one<{
    workstreams: string; tasks: string; kpis: string; deliverables: string;
  }>(
    `select
       (select count(*)::text from workstreams where project_id = $1 and deleted_at is null) as workstreams,
       (select count(*)::text from tasks where project_id = $1 and deleted_at is null) as tasks,
       (select count(*)::text from kpis where project_id = $1 and deleted_at is null) as kpis,
       (select count(*)::text from deliverables where project_id = $1 and deleted_at is null) as deliverables`,
    [projectId],
  );
  return {
    workstreams: Number.parseInt(row.workstreams, 10),
    tasks: Number.parseInt(row.tasks, 10),
    kpis: Number.parseInt(row.kpis, 10),
    deliverables: Number.parseInt(row.deliverables, 10),
  };
}

function nextReportDate(start: string, cadence: string): string {
  const date = new Date(`${start}T00:00:00Z`);
  const days = { weekly: 7, fortnightly: 14, monthly: 30, quarterly: 91 }[cadence] ?? 30;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
