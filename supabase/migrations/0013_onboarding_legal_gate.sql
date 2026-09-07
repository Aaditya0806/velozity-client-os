-- =============================================================================
-- 0013_onboarding_legal_gate.sql
-- Onboarding and the legal gate.
--
-- The gate is the single most consequential rule in the product: delivery must
-- not begin before the paperwork is executed. It is therefore enforced in the
-- database by assert_legal_gate(), not only in application code. The only way
-- past a failing gate is a recorded override by a holder of legal:override,
-- which leaves a permanent, visible mark on the client record.
-- =============================================================================

create table onboardings (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  company_id     uuid not null references companies (id) on delete cascade,
  opportunity_id uuid references opportunities (id) on delete set null,
  project_id     uuid references projects (id) on delete set null,

  status         text not null default 'blocked'
                   check (status in ('blocked', 'ready', 'in_progress', 'complete', 'cancelled')),

  -- Set by the gate evaluation; explains to the user exactly what is missing.
  blocked_reasons jsonb not null default '[]'::jsonb,
  gate_evaluated_at timestamptz,

  -- Override state. Once true it stays true for the life of the record: the
  -- Client 360 banner must not be dismissible by clearing a flag.
  legal_override_active boolean not null default false,
  legal_override_by     uuid references user_profiles (id) on delete set null,
  legal_override_at     timestamptz,
  legal_override_reason text,

  ready_at       timestamptz,
  started_at     timestamptz,
  completed_at   timestamptz,
  target_kickoff_date date,

  owner_user_id  uuid references user_profiles (id) on delete set null,
  notes          text,

  is_demo        boolean not null default false,
  created_by     uuid references user_profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,

  constraint onboardings_one_per_opportunity unique (opportunity_id),
  constraint onboardings_override_reason
    check (not legal_override_active or (legal_override_reason is not null and legal_override_by is not null))
);

create index onboardings_company_idx on onboardings (org_id, company_id) where deleted_at is null;
create index onboardings_status_idx  on onboardings (org_id, status) where deleted_at is null;

create trigger onboardings_touch before update on onboardings
  for each row execute function app.touch_updated_at();

create trigger onboardings_00_state_channel
  before update on onboardings
  for each row execute function app.guard_state_column('status');

alter table projects
  add constraint projects_onboarding_fk
  foreign key (onboarding_id) references onboardings (id) on delete set null;

-- -----------------------------------------------------------------------------
-- The concrete list of documents this onboarding demands.
--
-- Materialised from the required-document configuration of the services sold,
-- so the gate has a fixed target that a later catalogue edit cannot move.
-- -----------------------------------------------------------------------------
create table onboarding_requirements (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  onboarding_id  uuid not null references onboardings (id) on delete cascade,
  service_id     uuid references services (id) on delete set null,

  requirement_kind text not null default 'document'
                     check (requirement_kind in ('document', 'payment')),
  contract_type  text
                   check (contract_type is null or contract_type in
                          ('nda', 'msa', 'sow', 'addendum', 'amendment', 'other')),
  label          text not null,
  is_required    boolean not null default true,
  blocks_onboarding boolean not null default true,

  -- Satisfaction evidence.
  satisfied_contract_id uuid references contracts (id) on delete set null,
  payment_requirement_id uuid references payment_requirements (id) on delete set null,
  satisfied_at   timestamptz,

  -- Waiving one requirement is a lesser act than overriding the whole gate, but
  -- is still permissioned and reasoned.
  waived_by      uuid references user_profiles (id) on delete set null,
  waived_at      timestamptz,
  waiver_reason  text,

  position       int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint onboarding_requirements_kind_shape check (
    (requirement_kind = 'document' and contract_type is not null)
    or (requirement_kind = 'payment' and payment_requirement_id is not null)
  ),
  constraint onboarding_requirements_waiver_reason
    check (waived_at is null or waiver_reason is not null)
);

create index onboarding_requirements_onboarding_idx
  on onboarding_requirements (onboarding_id, position);

create trigger onboarding_requirements_touch before update on onboarding_requirements
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Onboarding checklist
-- -----------------------------------------------------------------------------
create table onboarding_tasks (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  onboarding_id uuid not null references onboardings (id) on delete cascade,
  title         text not null,
  description   text,
  category      text not null default 'general'
                  check (category in ('general', 'legal', 'finance', 'access', 'data', 'kickoff', 'delivery')),
  status        text not null default 'todo'
                  check (status in ('todo', 'in_progress', 'done', 'skipped', 'blocked')),
  assignee_user_id uuid references user_profiles (id) on delete set null,
  due_date      date,
  completed_at  timestamptz,
  completed_by  uuid references user_profiles (id) on delete set null,
  is_required   boolean not null default true,
  position      int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index onboarding_tasks_onboarding_idx on onboarding_tasks (onboarding_id, position);

create trigger onboarding_tasks_touch before update on onboarding_tasks
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Legal overrides. A dedicated, append-only record so the Client 360 warning
-- banner is backed by evidence that cannot be edited away.
-- -----------------------------------------------------------------------------
create table legal_overrides (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  company_id     uuid not null references companies (id) on delete cascade,
  onboarding_id  uuid references onboardings (id) on delete set null,
  entity_type    text not null default 'onboarding',
  entity_id      uuid,
  reason         text not null check (length(btrim(reason)) >= 20),
  -- Snapshot of exactly which requirements were unmet at override time.
  unmet_requirements jsonb not null default '[]'::jsonb,
  overridden_by  uuid not null references user_profiles (id) on delete restrict,
  overridden_at  timestamptz not null default now(),
  request_id     text
);

create index legal_overrides_company_idx on legal_overrides (org_id, company_id, overridden_at desc);

comment on constraint legal_overrides_reason_check on legal_overrides is
  'A written reason of at least 20 characters. "ok" is not an audit trail.';

create trigger legal_overrides_no_update before update on legal_overrides
  for each statement execute function app.forbid_mutation();
create trigger legal_overrides_no_delete before delete on legal_overrides
  for each statement execute function app.forbid_mutation();

-- =============================================================================
-- THE LEGAL GATE
-- =============================================================================

-- Is a single requirement satisfied?
--   document → a non-deleted contract of that type for this company is
--              fully_executed (and, when linked, that specific contract).
--   payment  → the linked payment requirement passes its threshold test.
create or replace function app.onboarding_requirement_satisfied(p_requirement uuid)
returns boolean
language plpgsql
stable
as $$
declare
  r onboarding_requirements%rowtype;
  v_company uuid;
begin
  select * into r from onboarding_requirements where id = p_requirement;
  if not found then
    return false;
  end if;

  if r.waived_at is not null then
    return true;
  end if;
  if not r.is_required or not r.blocks_onboarding then
    return true;
  end if;

  if r.requirement_kind = 'payment' then
    return app.payment_requirement_is_satisfied(r.payment_requirement_id);
  end if;

  -- Document requirement.
  if r.satisfied_contract_id is not null then
    return exists (
      select 1 from contracts c
      where c.id = r.satisfied_contract_id
        and c.status = 'fully_executed'
        and c.deleted_at is null
        and c.executed_document_id is not null
    );
  end if;

  select o.company_id into v_company
  from onboardings o where o.id = r.onboarding_id;

  return exists (
    select 1 from contracts c
    where c.company_id = v_company
      and c.contract_type = r.contract_type
      and c.status = 'fully_executed'
      and c.deleted_at is null
      and c.executed_document_id is not null
  );
end
$$;

-- Full gate evaluation. Returns the list of unmet requirements; an empty array
-- means the gate is open. Used by the API to explain the blockage and by the
-- trigger below to enforce it.
create or replace function app.assert_legal_gate(p_onboarding uuid, p_raise boolean default true)
returns jsonb
language plpgsql
stable
as $$
declare
  v_unmet jsonb := '[]'::jsonb;
  r record;
begin
  for r in
    select id, label, requirement_kind, contract_type, payment_requirement_id
    from onboarding_requirements
    where onboarding_id = p_onboarding
      and is_required
      and blocks_onboarding
      and waived_at is null
    order by position
  loop
    if not app.onboarding_requirement_satisfied(r.id) then
      v_unmet := v_unmet || jsonb_build_object(
        'requirement_id', r.id,
        'label', r.label,
        'kind', r.requirement_kind,
        'contract_type', r.contract_type,
        'payment_requirement_id', r.payment_requirement_id
      );
    end if;
  end loop;

  if p_raise and jsonb_array_length(v_unmet) > 0 then
    raise exception 'Legal gate not satisfied: % requirement(s) outstanding',
      jsonb_array_length(v_unmet)
      using errcode = '23514',
            hint = 'LEGAL_GATE_BLOCKED',
            detail = v_unmet::text;
  end if;

  return v_unmet;
end
$$;

comment on function app.assert_legal_gate is
  'Evaluates every blocking onboarding requirement. Raises LEGAL_GATE_BLOCKED unless p_raise is false.';

-- The enforcement itself. An onboarding may not leave `blocked` while any
-- blocking requirement is unmet, unless a legal override is active.
create or replace function app.enforce_legal_gate()
returns trigger
language plpgsql
as $$
declare
  v_unmet jsonb;
begin
  if new.status = 'blocked' or new.status = 'cancelled' then
    return new;
  end if;

  if old.status <> 'blocked' then
    -- Already past the gate; later transitions between ready/in_progress/complete
    -- are not re-gated.
    return new;
  end if;

  if new.legal_override_active then
    if new.legal_override_by is null or new.legal_override_reason is null then
      raise exception 'A legal override must record who authorised it and why'
        using errcode = '23514', hint = 'OVERRIDE_INCOMPLETE';
    end if;
    if not app.has_permission(new.org_id, 'legal:override:org') then
      raise exception 'legal:override:org is required to force an onboarding past the legal gate'
        using errcode = '42501', hint = 'FORBIDDEN';
    end if;
    return new;
  end if;

  v_unmet := app.assert_legal_gate(new.id, false);

  if jsonb_array_length(v_unmet) > 0 then
    new.blocked_reasons := v_unmet;
    raise exception 'Onboarding cannot leave blocked: % legal requirement(s) outstanding',
      jsonb_array_length(v_unmet)
      using errcode = '23514', hint = 'LEGAL_GATE_BLOCKED', detail = v_unmet::text;
  end if;

  new.blocked_reasons := '[]'::jsonb;
  new.ready_at := coalesce(new.ready_at, now());
  return new;
end
$$;

create trigger onboardings_legal_gate
  before update on onboardings
  for each row execute function app.enforce_legal_gate();

-- An override, once recorded, cannot be quietly withdrawn.
create or replace function app.assert_override_permanent()
returns trigger
language plpgsql
as $$
begin
  if old.legal_override_active and not new.legal_override_active then
    raise exception 'A recorded legal override cannot be removed'
      using errcode = '42501', hint = 'OVERRIDE_PERMANENT';
  end if;
  if old.legal_override_active
     and (new.legal_override_reason is distinct from old.legal_override_reason
          or new.legal_override_by is distinct from old.legal_override_by
          or new.legal_override_at is distinct from old.legal_override_at) then
    raise exception 'The details of a recorded legal override are immutable'
      using errcode = '42501', hint = 'OVERRIDE_PERMANENT';
  end if;
  return new;
end
$$;

create trigger onboardings_override_permanent
  before update on onboardings
  for each row execute function app.assert_override_permanent();

-- Keeps blocked_reasons current for display without needing a write.
create or replace function app.onboarding_gate_status(p_onboarding uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'onboarding_id', p_onboarding,
    'unmet', app.assert_legal_gate(p_onboarding, false),
    'satisfied', jsonb_array_length(app.assert_legal_gate(p_onboarding, false)) = 0,
    'override_active', coalesce((select legal_override_active from onboardings where id = p_onboarding), false)
  )
$$;

alter table onboardings enable row level security;             alter table onboardings force row level security;
alter table onboarding_requirements enable row level security; alter table onboarding_requirements force row level security;
alter table onboarding_tasks enable row level security;        alter table onboarding_tasks force row level security;
alter table legal_overrides enable row level security;         alter table legal_overrides force row level security;

create policy onboardings_select on onboardings for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id() and app.can(org_id, 'onboarding', 'read'));
create policy onboardings_insert on onboardings for insert to authenticated
  with check (org_id = app.active_org_id() and app.can(org_id, 'onboarding', 'manage'));
create policy onboardings_update on onboardings for update to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'onboarding', 'manage'))
  with check (org_id = app.active_org_id());

create policy onboarding_requirements_select on onboarding_requirements for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'onboarding', 'read'));
create policy onboarding_requirements_write on onboarding_requirements for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'onboarding', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'onboarding', 'manage'));

create policy onboarding_tasks_select on onboarding_tasks for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'onboarding', 'read'));
create policy onboarding_tasks_write on onboarding_tasks for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'onboarding', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'onboarding', 'manage'));

-- Overrides are readable by anyone who can see the client (the banner must show
-- for everyone), and writable only by holders of legal:override:org.
create policy legal_overrides_select on legal_overrides for select to authenticated
  using (org_id = app.active_org_id());
create policy legal_overrides_insert on legal_overrides for insert to authenticated
  with check (
    org_id = app.active_org_id()
    and overridden_by = app.current_user_id()
    and app.has_permission(org_id, 'legal:override:org')
  );

revoke update, delete on legal_overrides from authenticated;
