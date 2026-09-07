/**
 * Client 360.
 *
 * The centre of the product: everything about one client in one place, with
 * every panel respecting the caller's permissions rather than being filtered in
 * the browser. A user without `finance:read` does not receive the billing
 * numbers at all; a user without `internal_note:read` does not receive internal
 * activity.
 *
 * Panels are loaded independently so the page can stream them, and so that one
 * permission-denied panel does not blank the page.
 */
import type { Tx } from '@/lib/db';
import type { RequestContext } from '@/lib/auth/session';
import { AppError } from '@/lib/http/errors';
import { redactSensitiveFields, redactMany } from '@/lib/permissions';

export interface HealthIndicator {
  score: number | null;
  status: string | null;
  signals: Array<{ label: string; value: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }>;
}

export async function getClientOverview(tx: Tx, ctx: RequestContext, companyId: string) {
  const company = await tx.maybeOne<Record<string, unknown>>(
    `select c.*, owner.full_name as owner_name, parent.name as parent_company_name,
            t.name as team_name
     from companies c
     left join user_profiles owner on owner.id = c.owner_user_id
     left join companies parent on parent.id = c.parent_company_id
     left join teams t on t.id = c.team_id
     where c.id = $1 and c.deleted_at is null`,
    [companyId],
  );
  if (!company) throw new AppError('NOT_FOUND', 'This client was not found.');

  // Group companies, so a multi-entity client reports as one relationship.
  const groupIds = await tx.many<{ id: string }>(
    `select id from app.company_group_ids($1) as id`,
    [companyId],
  );

  const [pipeline, projects, contracts, warnings] = await Promise.all([
    tx.one<{
      open_count: string; open_value: string; won_count: string; won_value: string;
      lost_count: string; currency: string | null;
    }>(
      `select
         count(*) filter (where stage not in ('won','lost','closed'))::text as open_count,
         coalesce(sum(amount) filter (where stage not in ('won','lost','closed')), 0)::text as open_value,
         count(*) filter (where stage = 'won')::text as won_count,
         coalesce(sum(amount) filter (where stage = 'won'), 0)::text as won_value,
         count(*) filter (where stage = 'lost')::text as lost_count,
         max(currency) as currency
       from opportunities
       where company_id = $1 and deleted_at is null`,
      [companyId],
    ),
    tx.many(
      `select id, code, name, status, health, start_date, target_end_date
       from projects where company_id = $1 and deleted_at is null
       order by created_at desc limit 10`,
      [companyId],
    ),
    tx.many(
      `select id, reference, title, contract_type, status, effective_date, expiry_date, executed_at
       from contracts where company_id = $1 and deleted_at is null
       order by created_at desc limit 10`,
      [companyId],
    ),
    // The permanent legal-override banner. Visible to anyone who can see the
    // client, because the point of it is that it cannot be quietly dismissed.
    tx.many<{ id: string; reason: string; overridden_at: string; overridden_by_name: string }>(
      `select lo.id, lo.reason, lo.overridden_at, u.full_name as overridden_by_name
       from legal_overrides lo
       join user_profiles u on u.id = lo.overridden_by
       where lo.company_id = $1 order by lo.overridden_at desc`,
      [companyId],
    ),
  ]);

  const contacts = await tx.many(
    `select id, full_name, email, phone, job_title, contact_role, is_primary, is_signatory
     from contacts where company_id = $1 and deleted_at is null and status = 'active'
     order by is_primary desc, full_name`,
    [companyId],
  );

  const upcoming = await tx.many<{ kind: string; label: string; due_on: string }>(
    `select 'contract_expiry' as kind,
            reference || ' expires' as label,
            expiry_date::text as due_on
     from contracts
     where company_id = $1 and deleted_at is null and expiry_date is not null
       and expiry_date between current_date and current_date + interval '90 days'
     union all
     select 'task_due', title, due_date::text
     from tasks
     where company_id = $1 and deleted_at is null and status not in ('done','cancelled')
       and due_date between current_date and current_date + interval '14 days'
     union all
     select 'opportunity_close', name, expected_close_date::text
     from opportunities
     where company_id = $1 and deleted_at is null and stage not in ('won','lost','closed')
       and expected_close_date between current_date and current_date + interval '30 days'
     order by due_on
     limit 20`,
    [companyId],
  );

  // Finance is a separate permission from seeing the client at all.
  const billing = ctx.permissions.has('finance:read:org')
    ? await tx.one<{
        invoiced: string; paid: string; outstanding: string; overdue: string;
      }>(
        `select
           coalesce(sum(total) filter (where status <> 'draft'), 0)::text as invoiced,
           coalesce(sum(amount_paid), 0)::text as paid,
           coalesce(sum(balance_due) filter (where status not in ('draft','cancelled','written_off')), 0)::text as outstanding,
           coalesce(sum(balance_due) filter (where status = 'overdue'), 0)::text as overdue
         from invoices where company_id = $1 and deleted_at is null`,
        [companyId],
      )
    : null;

  return {
    company: redactSensitiveFields(company, ctx.permissions),
    group_company_ids: groupIds.map((g) => g.id),
    contacts,
    pipeline,
    projects,
    contracts,
    billing,
    upcoming,
    legal_warnings: warnings,
    health: buildHealth(company, pipeline, projects),
  };
}

function buildHealth(
  company: Record<string, unknown>,
  pipeline: { open_count: string; won_count: string; lost_count: string },
  projects: Array<Record<string, unknown>>,
): HealthIndicator {
  const signals: HealthIndicator['signals'] = [];

  const atRisk = projects.filter((p) => p.health === 'at_risk' || p.health === 'off_track').length;
  signals.push({
    label: 'Projects at risk',
    value: String(atRisk),
    tone: atRisk === 0 ? 'good' : atRisk === 1 ? 'warn' : 'bad',
  });

  const won = Number.parseInt(pipeline.won_count, 10);
  const lost = Number.parseInt(pipeline.lost_count, 10);
  const winRate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null;
  signals.push({
    label: 'Win rate',
    value: winRate === null ? 'No closed deals' : `${winRate}%`,
    tone: winRate === null ? 'neutral' : winRate >= 50 ? 'good' : winRate >= 25 ? 'warn' : 'bad',
  });

  signals.push({
    label: 'Open opportunities',
    value: pipeline.open_count,
    tone: Number.parseInt(pipeline.open_count, 10) > 0 ? 'good' : 'neutral',
  });

  return {
    score: (company.health_score as number | null) ?? null,
    status: (company.health_status as string | null) ?? null,
    signals,
  };
}

/**
 * The activity timeline. Internal entries are excluded by RLS for anyone without
 * `internal_note:read`, so this query needs no permission branch of its own.
 */
export async function getClientTimeline(
  tx: Tx,
  _ctx: RequestContext,
  companyId: string,
  options: { limit?: number; before?: string; types?: string[] } = {},
) {
  const params: unknown[] = [companyId];
  let where = 'a.company_id = $1 and a.deleted_at is null';

  if (options.before) {
    params.push(options.before);
    where += ` and a.occurred_at < $${params.length}`;
  }
  if (options.types && options.types.length > 0) {
    params.push(options.types);
    where += ` and a.activity_type = any ($${params.length})`;
  }
  params.push(Math.min(options.limit ?? 50, 200));

  return tx.many(
    `select a.*, u.full_name as actor_name, u.avatar_url as actor_avatar
     from activities a
     left join user_profiles u on u.id = a.actor_user_id
     where ${where}
     order by a.occurred_at desc
     limit $${params.length}`,
    params,
  );
}

export async function getClientDocuments(tx: Tx, ctx: RequestContext, companyId: string) {
  const rows = await tx.many(
    `select d.id, d.name, d.category, d.created_at, d.is_immutable, d.is_confidential,
            v.file_name, v.mime_type, v.size_bytes, v.version_no,
            u.full_name as created_by_name
     from documents d
     left join document_versions v on v.id = d.current_version_id
     left join user_profiles u on u.id = d.created_by
     where d.company_id = $1 and d.deleted_at is null
     order by d.created_at desc`,
    [companyId],
  );
  return redactMany(rows as Record<string, unknown>[], ctx.permissions);
}

export async function getClientBilling(tx: Tx, ctx: RequestContext, companyId: string) {
  ctx.permissions.require('finance:read:org');

  const [invoices, payments, requirements] = await Promise.all([
    tx.many(
      `select id, reference, status, currency, total, amount_paid, balance_due,
              issue_date, due_date, paid_at
       from invoices where company_id = $1 and deleted_at is null
       order by coalesce(issue_date, created_at::date) desc`,
      [companyId],
    ),
    tx.many(
      `select id, reference, amount, currency, method, status, transaction_date
       from payments where company_id = $1 and deleted_at is null
       order by transaction_date desc`,
      [companyId],
    ),
    tx.many(
      `select r.*, app.payment_requirement_amount(r.id) as required_amount,
              app.payment_requirement_settled(r.id) as settled_amount,
              app.payment_requirement_is_satisfied(r.id) as is_satisfied
       from payment_requirements r
       where r.company_id = $1 and r.deleted_at is null
       order by r.position`,
      [companyId],
    ),
  ]);

  return { invoices, payments, requirements };
}
