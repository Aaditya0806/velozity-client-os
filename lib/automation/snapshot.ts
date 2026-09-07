/**
 * Snapshot assembly.
 *
 * Conditions are evaluated against a plain object built once, before any action
 * runs, and stored on the run. Two things follow: a condition cannot reach the
 * database (so it cannot be slow, cannot fail, and cannot see a row it should
 * not), and the run history shows exactly what was true at the moment the
 * decision was made.
 *
 * The snapshot deliberately excludes margin, cost and internal notes. An
 * automation is not a route around the permission model.
 */
import type { Tx } from '@/lib/db';

export interface EventLike {
  id: string;
  org_id: string;
  name: string;
  entity_type: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
  depth: number;
}

export interface AutomationSnapshot {
  event: Record<string, unknown>;
  entity: Record<string, unknown> | null;
  client: Record<string, unknown> | null;
  opportunity: Record<string, unknown> | null;
  project: Record<string, unknown> | null;
  contract: Record<string, unknown> | null;
  [key: string]: unknown;
}

export async function buildSnapshot(tx: Tx, event: EventLike): Promise<AutomationSnapshot> {
  const snapshot: AutomationSnapshot = {
    event: { name: event.name, depth: event.depth, ...(event.payload ?? {}) },
    entity: null,
    client: null,
    opportunity: null,
    project: null,
    contract: null,
  };

  if (!event.entity_id) return snapshot;

  switch (event.entity_type) {
    case 'opportunity': {
      const opportunity = await tx.maybeOne<Record<string, unknown>>(
        `select id, reference, name, stage, amount, currency, probability,
                expected_close_date, owner_user_id, team_id, company_id, source,
                lost_reason, tags, business_problem is not null as has_business_problem,
                budget_indication is not null as has_budget,
                decision_maker_contact_id is not null as has_decision_maker,
                accepted_proposal_version_id
         from opportunities where id = $1 and deleted_at is null`,
        [event.entity_id],
      );
      snapshot.entity = opportunity;
      snapshot.opportunity = opportunity;
      if (opportunity?.company_id) {
        snapshot.client = await loadClient(tx, String(opportunity.company_id));
      }
      break;
    }

    case 'company': {
      const company = await loadClient(tx, event.entity_id);
      snapshot.entity = company;
      snapshot.client = company;
      break;
    }

    case 'contract': {
      const contract = await tx.maybeOne<Record<string, unknown>>(
        `select id, reference, title, contract_type, status, company_id, opportunity_id,
                currency, contract_value, effective_date, expiry_date, auto_renews,
                origin, executed_at is not null as is_executed
         from contracts where id = $1 and deleted_at is null`,
        [event.entity_id],
      );
      snapshot.entity = contract;
      snapshot.contract = contract;
      if (contract?.company_id) {
        snapshot.client = await loadClient(tx, String(contract.company_id));
      }
      if (contract?.opportunity_id) {
        snapshot.opportunity = await tx.maybeOne(
          `select id, reference, name, stage, amount, currency, owner_user_id
           from opportunities where id = $1`,
          [contract.opportunity_id],
        );
      }
      break;
    }

    case 'project': {
      const project = await tx.maybeOne<Record<string, unknown>>(
        `select id, code, name, status, health, company_id, start_date, target_end_date,
                manager_user_id, reporting_cadence
         from projects where id = $1 and deleted_at is null`,
        [event.entity_id],
      );
      snapshot.entity = project;
      snapshot.project = project;
      if (project?.company_id) {
        snapshot.client = await loadClient(tx, String(project.company_id));
      }
      break;
    }

    case 'proposal': {
      const proposal = await tx.maybeOne<Record<string, unknown>>(
        `select p.id, p.reference, p.title, p.status, p.company_id, p.opportunity_id,
                p.currency, v.total, v.version_no
         from proposals p
         left join proposal_versions v on v.id = coalesce(p.accepted_version_id, p.current_version_id)
         where p.id = $1 and p.deleted_at is null`,
        [event.entity_id],
      );
      snapshot.entity = proposal;
      if (proposal?.company_id) {
        snapshot.client = await loadClient(tx, String(proposal.company_id));
      }
      break;
    }

    case 'task': {
      snapshot.entity = await tx.maybeOne(
        `select id, title, status, priority, due_date, assignee_user_id, project_id, company_id
         from tasks where id = $1 and deleted_at is null`,
        [event.entity_id],
      );
      break;
    }

    case 'onboarding': {
      const onboarding = await tx.maybeOne<Record<string, unknown>>(
        `select id, status, company_id, opportunity_id, project_id,
                legal_override_active, jsonb_array_length(blocked_reasons) as unmet_count
         from onboardings where id = $1 and deleted_at is null`,
        [event.entity_id],
      );
      snapshot.entity = onboarding;
      if (onboarding?.company_id) {
        snapshot.client = await loadClient(tx, String(onboarding.company_id));
      }
      break;
    }

    default:
      break;
  }

  return snapshot;
}

/**
 * The client facts an automation may reason about, including derived legal and
 * finance status so a condition can ask "does this client have an executed NDA?"
 * without needing a query language.
 */
async function loadClient(tx: Tx, companyId: string): Promise<Record<string, unknown> | null> {
  return tx.maybeOne<Record<string, unknown>>(
    `select c.id, c.name, c.legal_name, c.lifecycle_stage, c.status, c.industry,
            c.country, c.owner_user_id, c.team_id, c.tags, c.health_status,
            c.parent_company_id is not null as is_subsidiary,

            case
              when exists (select 1 from contracts x where x.company_id = c.id
                           and x.contract_type = 'nda' and x.status = 'fully_executed'
                           and x.deleted_at is null) then 'executed'
              when exists (select 1 from contracts x where x.company_id = c.id
                           and x.contract_type = 'nda'
                           and x.status in ('sent','viewed','partially_signed')
                           and x.deleted_at is null) then 'awaiting_signature'
              when exists (select 1 from contracts x where x.company_id = c.id
                           and x.contract_type = 'nda' and x.deleted_at is null) then 'draft'
              else 'pending'
            end as nda_status,

            case
              when exists (select 1 from contracts x where x.company_id = c.id
                           and x.contract_type in ('msa','sow') and x.status = 'fully_executed'
                           and x.deleted_at is null) then 'executed'
              when exists (select 1 from contracts x where x.company_id = c.id
                           and x.contract_type in ('msa','sow')
                           and x.status in ('sent','viewed','partially_signed')
                           and x.deleted_at is null) then 'awaiting_signature'
              else 'pending'
            end as agreement_status,

            (select count(*) from projects p where p.company_id = c.id
             and p.status in ('active','on_hold') and p.deleted_at is null) as active_project_count,
            (select count(*) from opportunities o where o.company_id = c.id
             and o.stage not in ('won','lost','closed') and o.deleted_at is null) as open_opportunity_count
     from companies c
     where c.id = $1 and c.deleted_at is null`,
    [companyId],
  );
}
