-- =============================================================================
-- 0006_state_machine_opportunities.sql
-- The generic transition ledger, the enforcement that state may only change
-- through it, and the sales pipeline (opportunities, discovery, diagnosis).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- TRANSITION LEDGER
--
-- Every lifecycle change in the product - opportunity stage, proposal status,
-- contract status, project status, onboarding status - lands here.
-- -----------------------------------------------------------------------------
create table state_transitions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  entity_type   text not null,
  entity_id     uuid not null,
  from_state    text,
  to_state      text not null,
  reason        text,
  metadata      jsonb not null default '{}'::jsonb,
  actor_user_id uuid references user_profiles (id) on delete set null,
  actor_type    text not null default 'user'
                  check (actor_type in ('user', 'system', 'automation', 'provider', 'ai')),
  request_id    text,
  occurred_at   timestamptz not null default now()
);

create index state_transitions_entity_idx on state_transitions (org_id, entity_type, entity_id, occurred_at desc);
create index state_transitions_org_time_idx on state_transitions (org_id, occurred_at desc);

-- The ledger is evidence: append-only, like the audit log.
create trigger state_transitions_no_update before update on state_transitions
  for each statement execute function app.forbid_mutation();
create trigger state_transitions_no_delete before delete on state_transitions
  for each statement execute function app.forbid_mutation();

alter table state_transitions enable row level security;
alter table state_transitions force row level security;

create policy state_transitions_select on state_transitions for select to authenticated
  using (org_id = app.active_org_id());

create policy state_transitions_insert on state_transitions for insert to authenticated
  with check (app.is_org_member(org_id));

revoke update, delete on state_transitions from authenticated;

-- -----------------------------------------------------------------------------
-- TRANSITION CHANNEL ENFORCEMENT
--
-- `POST /api/v1/{resource}/{id}/transitions` is the only way to move an entity
-- between states. The transition service marks its transaction with
-- `SET LOCAL app.in_transition = 'on'`; any other statement that tries to change
-- a lifecycle column is rejected by the database. This is what makes
-- "never change state with PATCH status" a guarantee rather than a convention.
-- -----------------------------------------------------------------------------
create or replace function app.in_transition()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('app.in_transition', true), 'off') = 'on'
$$;

create or replace function app.guard_state_column()
returns trigger
language plpgsql
as $$
declare
  v_col     text := tg_argv[0];
  v_old     text;
  v_new     text;
begin
  execute format('select ($1).%I::text, ($2).%I::text', v_col, v_col)
    into v_old, v_new
    using old, new;

  if v_old is distinct from v_new and not app.in_transition() then
    raise exception
      'Column %.% may only be changed through the transition service (POST /api/v1/%/{id}/transitions)',
      tg_table_name, v_col, tg_table_name
      using errcode = '42501',
            hint = 'Direct updates to lifecycle columns are rejected by design.';
  end if;

  return new;
end
$$;

comment on function app.guard_state_column is
  'BEFORE UPDATE trigger. Rejects a change to the named lifecycle column unless the transaction is marked as a transition.';

-- Naming note: PostgreSQL fires BEFORE triggers in name order, so every channel
-- guard is named <table>_00_state_channel. That puts it ahead of the business
-- guards, so an attempt to bypass the transition service is reported as exactly
-- that rather than as whichever domain rule happened to notice first.

-- =============================================================================
-- OPPORTUNITIES
--
-- One table for the whole funnel. A "lead" is an opportunity in stage `lead`;
-- there is no separate leads table to reconcile, so no data is lost or
-- duplicated at conversion time.
-- =============================================================================
create table opportunities (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations (id) on delete cascade,
  company_id          uuid not null references companies (id) on delete restrict,
  primary_contact_id  uuid references contacts (id) on delete set null,

  reference           text not null,
  name                text not null check (length(btrim(name)) between 1 and 200),
  description         text,

  stage               text not null default 'lead'
                        check (stage in ('lead', 'qualified', 'discovery', 'diagnosis',
                                         'solution', 'proposal_sent', 'negotiation',
                                         'won', 'closed', 'lost', 'dormant')),

  -- Commercials. Money is always numeric(14,2); never a float.
  amount              numeric(14, 2) not null default 0 check (amount >= 0),
  currency            char(3) not null check (currency ~ '^[A-Z]{3}$'),
  -- Rate to the organisation base currency, captured when the amount was set.
  fx_rate_to_base     numeric(18, 8) check (fx_rate_to_base is null or fx_rate_to_base > 0),
  amount_base         numeric(14, 2),
  probability         smallint not null default 0 check (probability between 0 and 100),
  expected_close_date date,

  -- Qualification evidence. The `qualified` guard requires all three.
  business_problem       text,
  budget_indication      numeric(14, 2) check (budget_indication is null or budget_indication >= 0),
  budget_currency        char(3) check (budget_currency is null or budget_currency ~ '^[A-Z]{3}$'),
  decision_maker_contact_id uuid references contacts (id) on delete set null,

  -- Set when a proposal version is accepted. Frozen: later edits to the
  -- opportunity never change which version an agreement is generated from.
  accepted_proposal_version_id uuid,

  owner_user_id       uuid references user_profiles (id) on delete set null,
  team_id             uuid references teams (id) on delete set null,

  source              text,
  campaign            text,

  -- Closure detail
  lost_reason         text check (lost_reason is null or lost_reason in (
                        'price', 'timing', 'no_budget', 'competitor', 'no_decision',
                        'lost_contact', 'not_a_fit', 'internal_capacity', 'other')),
  lost_reason_detail  text,
  lost_to_competitor  text,
  -- Stage the opportunity occupied before being parked; used to restore it.
  dormant_from_stage  text,
  dormant_until       date,
  won_at              timestamptz,
  closed_at           timestamptz,

  tags                text[] not null default '{}',
  internal_notes      text,
  custom_fields       jsonb not null default '{}'::jsonb,

  is_demo             boolean not null default false,
  created_by          uuid references user_profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,

  constraint opportunities_reference_unique unique (org_id, reference),
  -- A lost opportunity must always carry a reason.
  constraint opportunities_lost_requires_reason
    check (stage <> 'lost' or lost_reason is not null),
  constraint opportunities_budget_currency
    check (budget_indication is null or budget_currency is not null)
);

create index opportunities_org_stage_idx on opportunities (org_id, stage) where deleted_at is null;
create index opportunities_company_idx   on opportunities (org_id, company_id) where deleted_at is null;
create index opportunities_owner_idx     on opportunities (org_id, owner_user_id) where deleted_at is null;
create index opportunities_close_idx     on opportunities (org_id, expected_close_date) where deleted_at is null;
create index opportunities_name_trgm_idx on opportunities using gin (name gin_trgm_ops);

create trigger opportunities_touch before update on opportunities
  for each row execute function app.touch_updated_at();

create trigger opportunities_00_state_channel
  before update on opportunities
  for each row execute function app.guard_state_column('stage');

-- -----------------------------------------------------------------------------
-- Human-readable reference numbers (OPP-000123), allocated per organisation.
-- -----------------------------------------------------------------------------
create table entity_sequences (
  org_id     uuid not null references organizations (id) on delete cascade,
  entity     text not null,
  last_value bigint not null default 0,
  primary key (org_id, entity)
);

alter table entity_sequences enable row level security;
alter table entity_sequences force row level security;

create policy entity_sequences_all on entity_sequences for all to authenticated
  using (org_id = app.active_org_id())
  with check (org_id = app.active_org_id());

create or replace function app.next_reference(p_org uuid, p_entity text, p_prefix text)
returns text
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_next bigint;
begin
  insert into public.entity_sequences (org_id, entity, last_value)
  values (p_org, p_entity, 1)
  on conflict (org_id, entity)
  do update set last_value = public.entity_sequences.last_value + 1
  returning last_value into v_next;

  return p_prefix || '-' || lpad(v_next::text, 6, '0');
end
$$;

-- -----------------------------------------------------------------------------
-- Stage guards enforced in the database.
--
-- The application performs the same checks first so it can return a helpful
-- error, but these triggers make the rules impossible to bypass - including by
-- a direct SQL statement or a future code path that forgets to ask.
-- The proposal-dependent guards are added in 0008 once proposals exist.
-- -----------------------------------------------------------------------------
create or replace function app.assert_opportunity_qualification()
returns trigger
language plpgsql
as $$
declare
  v_missing text[] := '{}';
begin
  -- Stages at or beyond `qualified` all require the qualification evidence.
  if new.stage in ('qualified', 'discovery', 'diagnosis', 'solution',
                   'proposal_sent', 'negotiation', 'won', 'closed')
     and (old.stage is null or old.stage in ('lead', 'dormant')) then

    if new.business_problem is null or length(btrim(new.business_problem)) < 10 then
      v_missing := v_missing || 'business_problem';
    end if;
    if new.budget_indication is null then
      v_missing := v_missing || 'budget_indication';
    end if;
    if new.decision_maker_contact_id is null then
      v_missing := v_missing || 'decision_maker';
    end if;

    if array_length(v_missing, 1) > 0 then
      raise exception 'Opportunity cannot reach stage % without: %',
        new.stage, array_to_string(v_missing, ', ')
        using errcode = '23514', hint = 'OPPORTUNITY_QUALIFICATION_INCOMPLETE';
    end if;
  end if;

  return new;
end
$$;

create trigger opportunities_qualification_guard
  before update of stage on opportunities
  for each row execute function app.assert_opportunity_qualification();

-- Keep closure timestamps and probability honest.
create or replace function app.sync_opportunity_closure()
returns trigger
language plpgsql
as $$
begin
  if new.stage is distinct from coalesce(old.stage, '') then
    if new.stage = 'won' then
      new.won_at := coalesce(new.won_at, now());
      new.probability := 100;
    elsif new.stage = 'lost' then
      new.closed_at := coalesce(new.closed_at, now());
      new.probability := 0;
    elsif new.stage = 'closed' then
      new.closed_at := coalesce(new.closed_at, now());
    else
      -- Reopening clears the closure marks so reporting stays accurate.
      new.closed_at := null;
      if new.stage <> 'dormant' then
        new.lost_reason := null;
        new.lost_reason_detail := null;
        new.lost_to_competitor := null;
      end if;
    end if;
  end if;
  return new;
end
$$;

create trigger opportunities_closure_sync
  before insert or update on opportunities
  for each row execute function app.sync_opportunity_closure();

alter table opportunities enable row level security;
alter table opportunities force row level security;

create policy opportunities_select on opportunities for select to authenticated
  using (deleted_at is null and app.can_row(org_id, 'opportunity', 'read', owner_user_id, team_id));

create policy opportunities_insert on opportunities for insert to authenticated
  with check (org_id = app.active_org_id() and app.can(org_id, 'opportunity', 'create'));

create policy opportunities_update on opportunities for update to authenticated
  using (app.can_row(org_id, 'opportunity', 'update', owner_user_id, team_id))
  with check (org_id = app.active_org_id());

create policy opportunities_delete on opportunities for delete to authenticated
  using (app.can_row(org_id, 'opportunity', 'delete', owner_user_id, team_id));

-- =============================================================================
-- DISCOVERY
-- One structured workspace per opportunity.
-- =============================================================================
create table discoveries (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations (id) on delete cascade,
  opportunity_id     uuid not null references opportunities (id) on delete cascade,
  company_id         uuid not null references companies (id) on delete cascade,

  status             text not null default 'draft'
                       check (status in ('draft', 'in_progress', 'complete')),

  -- Business context
  business_overview  text,
  current_situation  text,
  business_problem   text,
  root_causes        text,
  goals              text,
  success_criteria   text,

  -- Structured metric capture: [{ name, value, unit, period, source }]
  current_metrics    jsonb not null default '[]'::jsonb,
  target_kpis        jsonb not null default '[]'::jsonb,

  marketing_stack    text[] not null default '{}',
  technology_stack   text[] not null default '{}',
  existing_processes text,
  known_constraints  text,

  -- Buying process
  decision_process   text,
  decision_makers    uuid[] not null default '{}',
  competitors        text[] not null default '{}',

  budget_range_min   numeric(14, 2) check (budget_range_min is null or budget_range_min >= 0),
  budget_range_max   numeric(14, 2) check (budget_range_max is null or budget_range_max >= 0),
  budget_currency    char(3) check (budget_currency is null or budget_currency ~ '^[A-Z]{3}$'),
  timeline_notes     text,
  target_start_date  date,

  notes              text,
  internal_notes     text,

  completed_at       timestamptz,
  completed_by       uuid references user_profiles (id) on delete set null,
  created_by         uuid references user_profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,

  constraint discoveries_one_per_opportunity unique (opportunity_id),
  constraint discoveries_budget_range
    check (budget_range_min is null or budget_range_max is null or budget_range_max >= budget_range_min)
);

create index discoveries_org_idx on discoveries (org_id) where deleted_at is null;
create index discoveries_company_idx on discoveries (org_id, company_id) where deleted_at is null;

create trigger discoveries_touch before update on discoveries
  for each row execute function app.touch_updated_at();

alter table discoveries enable row level security;
alter table discoveries force row level security;

create policy discoveries_select on discoveries for select to authenticated
  using (
    deleted_at is null
    and org_id = app.active_org_id()
    and exists (
      select 1 from opportunities o
      where o.id = discoveries.opportunity_id
        and app.can_row(o.org_id, 'opportunity', 'read', o.owner_user_id, o.team_id)
    )
  );

create policy discoveries_write on discoveries for all to authenticated
  using (
    org_id = app.active_org_id()
    and exists (
      select 1 from opportunities o
      where o.id = discoveries.opportunity_id
        and app.can_row(o.org_id, 'opportunity', 'update', o.owner_user_id, o.team_id)
    )
  )
  with check (org_id = app.active_org_id());

-- =============================================================================
-- DIAGNOSIS
--
-- A diagnosis is a set of individually-attributed claims. The provenance model
-- is the whole point: a reader must always be able to tell what the client
-- said, what the model inferred, and what the model recommends.
-- =============================================================================
create table diagnoses (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  opportunity_id uuid not null references opportunities (id) on delete cascade,
  company_id     uuid not null references companies (id) on delete cascade,
  discovery_id   uuid references discoveries (id) on delete set null,

  title          text not null default 'Diagnosis',
  summary        text,
  status         text not null default 'draft'
                   check (status in ('draft', 'in_review', 'approved', 'superseded')),
  version        int not null default 1 check (version >= 1),

  -- Provenance of the document as a whole.
  generated_by   text not null default 'human'
                   check (generated_by in ('human', 'ai_assisted')),
  ai_action_id   uuid,
  reviewed_by    uuid references user_profiles (id) on delete set null,
  reviewed_at    timestamptz,

  created_by     uuid references user_profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,

  constraint diagnoses_version_unique unique (opportunity_id, version)
);

create index diagnoses_org_idx on diagnoses (org_id, opportunity_id) where deleted_at is null;

create trigger diagnoses_touch before update on diagnoses
  for each row execute function app.touch_updated_at();

create table diagnosis_claims (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  diagnosis_id  uuid not null references diagnoses (id) on delete cascade,

  -- NOT NULL with a closed CHECK: an unlabelled claim is unstorable.
  claim_type    text not null
                  check (claim_type in ('client_provided', 'ai_inference', 'ai_recommendation')),
  text          text not null check (length(btrim(text)) > 0),
  category      text,
  position      int not null default 0,

  -- Where a client_provided claim came from. Required for that type.
  source_kind   text check (source_kind in ('discovery_field', 'document', 'contact', 'metric', 'email', 'meeting')),
  source_id     uuid,
  source_field  text,
  source_quote  text,

  -- Model self-reported confidence. Required for ai_inference, meaningless
  -- for a client statement.
  confidence    numeric(3, 2) check (confidence is null or (confidence >= 0 and confidence <= 1)),

  impact        text check (impact is null or impact in ('low', 'medium', 'high', 'critical')),
  accepted_by   uuid references user_profiles (id) on delete set null,
  accepted_at   timestamptz,
  rejected_at   timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A statement attributed to the client must say where it came from.
  constraint diagnosis_claims_client_provenance
    check (claim_type <> 'client_provided' or (source_kind is not null and source_id is not null)),
  -- An inference must carry a confidence so the UI can show how firm it is.
  constraint diagnosis_claims_inference_confidence
    check (claim_type <> 'ai_inference' or confidence is not null)
);

create index diagnosis_claims_diagnosis_idx on diagnosis_claims (diagnosis_id, position);
create index diagnosis_claims_type_idx on diagnosis_claims (org_id, claim_type);

create trigger diagnosis_claims_touch before update on diagnosis_claims
  for each row execute function app.touch_updated_at();

alter table diagnoses enable row level security;
alter table diagnoses force row level security;
alter table diagnosis_claims enable row level security;
alter table diagnosis_claims force row level security;

create policy diagnoses_select on diagnoses for select to authenticated
  using (
    deleted_at is null
    and org_id = app.active_org_id()
    and exists (
      select 1 from opportunities o
      where o.id = diagnoses.opportunity_id
        and app.can_row(o.org_id, 'opportunity', 'read', o.owner_user_id, o.team_id)
    )
  );

create policy diagnoses_write on diagnoses for all to authenticated
  using (
    org_id = app.active_org_id()
    and exists (
      select 1 from opportunities o
      where o.id = diagnoses.opportunity_id
        and app.can_row(o.org_id, 'opportunity', 'update', o.owner_user_id, o.team_id)
    )
  )
  with check (org_id = app.active_org_id());

create policy diagnosis_claims_select on diagnosis_claims for select to authenticated
  using (
    org_id = app.active_org_id()
    and exists (select 1 from diagnoses d where d.id = diagnosis_claims.diagnosis_id)
  );

create policy diagnosis_claims_write on diagnosis_claims for all to authenticated
  using (
    org_id = app.active_org_id()
    and app.can(org_id, 'opportunity', 'update')
    and exists (select 1 from diagnoses d where d.id = diagnosis_claims.diagnosis_id)
  )
  with check (org_id = app.active_org_id());
