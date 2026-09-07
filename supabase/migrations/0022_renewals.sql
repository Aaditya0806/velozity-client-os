-- =============================================================================
-- 0022_renewals.sql
-- The renewal cycle.
--
-- Phase 1 tracked expiry on the contract and notified an owner. That is a
-- reminder, not a process: it says a date is approaching and records nothing
-- about what anyone did next. A renewal is a piece of work with an owner, a
-- decision and an outcome, and it needs somewhere to live.
--
-- What this deliberately does NOT do is renew anything by itself. A contract
-- marked `auto_renews` still produces a row here, because "it renewed without
-- anyone looking at it" is a fact worth recording rather than a reason to stay
-- silent.
-- =============================================================================

create table renewals (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete cascade,
  contract_id     uuid not null references contracts (id) on delete cascade,
  company_id      uuid not null references companies (id) on delete cascade,

  -- The cycle this row is about. A contract renewed three times has three rows,
  -- each with its own decision.
  period_end      date not null,
  notice_date     date,

  status          text not null default 'upcoming'
                    check (status in ('upcoming', 'in_progress', 'won', 'lost',
                                      'auto_renewed', 'not_renewing')),

  -- The renewal conversation, when one is opened. Renewals are opportunities:
  -- the same pipeline, the same guards, the same reporting.
  opportunity_id  uuid references opportunities (id) on delete set null,

  -- Value at risk, carried from the contract so a later change to the contract
  -- does not silently rewrite history.
  currency        char(3) check (currency is null or currency ~ '^[A-Z]{3}$'),
  value_at_risk   numeric(14, 2) check (value_at_risk is null or value_at_risk >= 0),

  owner_user_id   uuid references user_profiles (id) on delete set null,
  team_id         uuid references teams (id) on delete set null,

  decided_at      timestamptz,
  decided_by      uuid references user_profiles (id) on delete set null,
  outcome_note    text,
  -- Why a client left. The single most useful field in this table.
  loss_reason     text,

  is_demo         boolean not null default false,
  created_by      uuid references user_profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  -- One row per contract per cycle. This is what makes the sweep idempotent.
  constraint renewals_cycle_unique unique (contract_id, period_end),
  constraint renewals_loss_reason
    check (status <> 'lost' or loss_reason is not null),
  constraint renewals_decided
    check (status in ('upcoming', 'in_progress') or decided_at is not null)
);

create index renewals_due_idx on renewals (org_id, period_end)
  where deleted_at is null and status in ('upcoming', 'in_progress');
create index renewals_company_idx on renewals (company_id) where deleted_at is null;
create index renewals_owner_idx on renewals (owner_user_id)
  where deleted_at is null and status in ('upcoming', 'in_progress');

create trigger renewals_touch before update on renewals
  for each row execute function app.touch_updated_at();

-- Status is a lifecycle column, so it moves through the transition channel like
-- every other one rather than by a stray UPDATE.
-- The guard reads the column name from its trigger argument; without it the
-- function has nothing to compare and fails on every update.
create trigger renewals_00_state_channel
  before update on renewals
  for each row execute function app.guard_state_column('status');

alter table renewals enable row level security;
alter table renewals force row level security;

create policy renewals_select on renewals for select to authenticated
  using (
    deleted_at is null
    and org_id = app.active_org_id()
    and app.can_row(org_id, 'renewal', 'read', owner_user_id, team_id)
  );

create policy renewals_insert on renewals for insert to authenticated
  with check (
    org_id = app.active_org_id() and app.can(org_id, 'renewal', 'update')
  );

create policy renewals_update on renewals for update to authenticated
  using (
    deleted_at is null
    and org_id = app.active_org_id()
    and app.can_row(org_id, 'renewal', 'update', owner_user_id, team_id)
  )
  with check (org_id = app.active_org_id());

-- -----------------------------------------------------------------------------
-- Permissions
-- -----------------------------------------------------------------------------

insert into permissions (key, resource, action, scope, description) values
  ('renewal:read:own',    'renewal', 'read',   'own',  'Read renewals you own'),
  ('renewal:read:team',   'renewal', 'read',   'team', 'Read your team''s renewals'),
  ('renewal:read:org',    'renewal', 'read',   'org',  'Read every renewal'),
  ('renewal:update:own',  'renewal', 'update', 'own',  'Work renewals you own'),
  ('renewal:update:team', 'renewal', 'update', 'team', 'Work your team''s renewals'),
  ('renewal:update:org',  'renewal', 'update', 'org',  'Work every renewal')
on conflict (key) do nothing;

-- Sales own the renewal conversation; management and delivery see it; finance
-- sees it because renewal is revenue.
insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.key = any (
  case r.key
    when 'super_admin'     then array['renewal:read:org','renewal:update:org']
    when 'management'      then array['renewal:read:org','renewal:update:org']
    when 'sales'           then array['renewal:read:team','renewal:update:own']
    when 'finance'         then array['renewal:read:org']
    when 'project_manager' then array['renewal:read:team']
    when 'legal_admin'     then array['renewal:read:org']
    else array[]::text[]
  end
)
where r.org_id is null
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Opening a cycle
-- -----------------------------------------------------------------------------

-- Creates the renewal row for a contract's current cycle if it is not already
-- there. Idempotent by the unique constraint, so the sweep can run as often as
-- it likes without producing duplicates.
create or replace function app.open_renewal_cycle(p_contract uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  c record;
  v_id uuid;
begin
  select ct.id, ct.org_id, ct.company_id, ct.expiry_date, ct.renewal_notice_days,
         ct.currency, ct.contract_value, ct.owner_user_id, ct.team_id, ct.is_demo
    into c
  from public.contracts ct
  where ct.id = p_contract
    and ct.deleted_at is null
    and ct.status = 'fully_executed'
    and ct.expiry_date is not null;

  if c.id is null then
    return null;
  end if;

  insert into public.renewals
    (org_id, contract_id, company_id, period_end, notice_date, status,
     currency, value_at_risk, owner_user_id, team_id, is_demo)
  values
    (c.org_id, c.id, c.company_id, c.expiry_date,
     c.expiry_date - make_interval(days => coalesce(c.renewal_notice_days, 60)),
     'upcoming', c.currency, c.contract_value, c.owner_user_id, c.team_id,
     coalesce(c.is_demo, false))
  on conflict (contract_id, period_end) do nothing
  returning id into v_id;

  return v_id;
end
$$;

revoke all on function app.open_renewal_cycle(uuid) from public, anon;
grant execute on function app.open_renewal_cycle(uuid) to authenticated, service_role;

grant select, insert, update on renewals to authenticated;
grant select, insert, update on renewals to service_role;
