-- =============================================================================
-- 0005_companies_contacts.sql
-- Companies (the tenant's clients and prospects) and their contacts.
--
-- A company may be a subsidiary of another via parent_company_id, and separate
-- legal entities of the same group are modelled as sibling companies sharing a
-- parent. Contracts attach to the legal entity; reporting rolls up the tree.
-- =============================================================================

create table companies (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations (id) on delete cascade,
  name              text not null check (length(btrim(name)) between 1 and 200),
  legal_name        text,
  parent_company_id uuid references companies (id) on delete set null,
  -- A company is a legal entity when contracts may be signed against it.
  is_legal_entity   boolean not null default true,
  registration_no   text,
  tax_id            text,

  lifecycle_stage   text not null default 'prospect'
                      check (lifecycle_stage in ('prospect', 'client', 'former_client', 'partner', 'disqualified')),
  status            text not null default 'active'
                      check (status in ('active', 'inactive', 'archived')),

  industry          text,
  website           text,
  employee_count    int check (employee_count is null or employee_count >= 0),
  annual_revenue    numeric(14, 2) check (annual_revenue is null or annual_revenue >= 0),
  currency          char(3) check (currency is null or currency ~ '^[A-Z]{3}$'),
  timezone          text,

  -- Address
  address_line1     text,
  address_line2     text,
  city              text,
  state             text,
  postal_code       text,
  country           char(2) check (country is null or country ~ '^[A-Z]{2}$'),

  phone             text,
  email             citext,
  linkedin_url      text,

  owner_user_id     uuid references user_profiles (id) on delete set null,
  team_id           uuid references teams (id) on delete set null,

  -- Denormalised health signal, recomputed by a scheduled job. 0-100.
  health_score      smallint check (health_score is null or health_score between 0 and 100),
  health_status     text check (health_status is null or health_status in ('healthy', 'watch', 'at_risk', 'critical')),
  health_computed_at timestamptz,

  source            text,
  tags              text[] not null default '{}',
  -- Visible only with `internal_note:read`; never present in portal views.
  internal_notes    text,
  custom_fields     jsonb not null default '{}'::jsonb,

  is_demo           boolean not null default false,
  created_by        uuid references user_profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,

  constraint companies_not_own_parent check (parent_company_id is null or parent_company_id <> id)
);

create index companies_org_idx        on companies (org_id) where deleted_at is null;
create index companies_owner_idx      on companies (org_id, owner_user_id) where deleted_at is null;
create index companies_stage_idx      on companies (org_id, lifecycle_stage) where deleted_at is null;
create index companies_parent_idx     on companies (parent_company_id) where deleted_at is null;
create index companies_name_trgm_idx  on companies using gin (name gin_trgm_ops);
create unique index companies_name_unique on companies (org_id, lower(name)) where deleted_at is null;

create trigger companies_touch before update on companies
  for each row execute function app.touch_updated_at();

-- The parent chain must stay acyclic and within one tenant.
create or replace function app.assert_company_hierarchy()
returns trigger
language plpgsql
as $$
declare
  v_cursor uuid := new.parent_company_id;
  v_depth  int := 0;
  v_org    uuid;
begin
  if new.parent_company_id is null then
    return new;
  end if;

  select org_id into v_org from companies where id = new.parent_company_id;
  if v_org is null or v_org <> new.org_id then
    raise exception 'Parent company must belong to the same organisation'
      using errcode = '23514';
  end if;

  while v_cursor is not null loop
    if v_cursor = new.id then
      raise exception 'Company hierarchy would form a cycle' using errcode = '23514';
    end if;
    v_depth := v_depth + 1;
    if v_depth > 10 then
      raise exception 'Company hierarchy exceeds the maximum depth of 10' using errcode = '23514';
    end if;
    select parent_company_id into v_cursor from companies where id = v_cursor;
  end loop;

  return new;
end
$$;

create trigger companies_hierarchy_guard
  before insert or update of parent_company_id on companies
  for each row execute function app.assert_company_hierarchy();

alter table companies enable row level security;
alter table companies force row level security;

create policy companies_select on companies for select to authenticated
  using (deleted_at is null and app.can_row(org_id, 'company', 'read', owner_user_id, team_id));

create policy companies_insert on companies for insert to authenticated
  with check (org_id = app.active_org_id() and app.can(org_id, 'company', 'create'));

create policy companies_update on companies for update to authenticated
  using (app.can_row(org_id, 'company', 'update', owner_user_id, team_id))
  with check (org_id = app.active_org_id());

create policy companies_delete on companies for delete to authenticated
  using (app.can_row(org_id, 'company', 'delete', owner_user_id, team_id));

-- -----------------------------------------------------------------------------
-- Contacts
-- -----------------------------------------------------------------------------
create table contacts (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  company_id     uuid references companies (id) on delete set null,
  first_name     text not null check (length(btrim(first_name)) between 1 and 100),
  last_name      text not null default '',
  full_name      text generated always as (btrim(first_name || ' ' || last_name)) stored,
  email          citext,
  phone          text,
  mobile         text,
  job_title      text,
  department     text,
  linkedin_url   text,
  timezone       text,

  -- Buying-committee role, used by the qualification guard.
  contact_role   text not null default 'other'
                   check (contact_role in ('decision_maker', 'economic_buyer', 'champion',
                                           'influencer', 'technical', 'legal', 'finance',
                                           'end_user', 'other')),
  is_primary     boolean not null default false,
  is_billing     boolean not null default false,
  is_signatory   boolean not null default false,

  status         text not null default 'active'
                   check (status in ('active', 'inactive', 'left_company', 'bounced')),
  email_opt_out  boolean not null default false,

  owner_user_id  uuid references user_profiles (id) on delete set null,
  team_id        uuid references teams (id) on delete set null,

  source         text,
  tags           text[] not null default '{}',
  internal_notes text,
  custom_fields  jsonb not null default '{}'::jsonb,

  is_demo        boolean not null default false,
  created_by     uuid references user_profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create index contacts_org_idx     on contacts (org_id) where deleted_at is null;
create index contacts_company_idx on contacts (org_id, company_id) where deleted_at is null;
create index contacts_email_idx   on contacts (org_id, email) where deleted_at is null;
create index contacts_name_trgm_idx on contacts using gin (full_name gin_trgm_ops);
create unique index contacts_company_email_unique
  on contacts (org_id, company_id, email) where deleted_at is null and email is not null;
create unique index contacts_one_primary_per_company
  on contacts (company_id) where is_primary and deleted_at is null and company_id is not null;

create trigger contacts_touch before update on contacts
  for each row execute function app.touch_updated_at();

alter table contacts enable row level security;
alter table contacts force row level security;

create policy contacts_select on contacts for select to authenticated
  using (deleted_at is null and app.can_row(org_id, 'contact', 'read', owner_user_id, team_id));

create policy contacts_insert on contacts for insert to authenticated
  with check (org_id = app.active_org_id() and app.can(org_id, 'contact', 'create'));

create policy contacts_update on contacts for update to authenticated
  using (app.can_row(org_id, 'contact', 'update', owner_user_id, team_id))
  with check (org_id = app.active_org_id());

create policy contacts_delete on contacts for delete to authenticated
  using (app.can_row(org_id, 'contact', 'delete', owner_user_id, team_id));

-- -----------------------------------------------------------------------------
-- Company relationships beyond the parent tree (partner, reseller, vendor ...)
-- -----------------------------------------------------------------------------
create table company_relationships (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations (id) on delete cascade,
  from_company_id   uuid not null references companies (id) on delete cascade,
  to_company_id     uuid not null references companies (id) on delete cascade,
  relationship_type text not null
                      check (relationship_type in ('subsidiary', 'affiliate', 'partner',
                                                   'reseller', 'vendor', 'group_entity', 'other')),
  notes             text,
  created_by        uuid references user_profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint company_relationships_unique unique (from_company_id, to_company_id, relationship_type),
  constraint company_relationships_distinct check (from_company_id <> to_company_id)
);

create index company_relationships_from_idx on company_relationships (org_id, from_company_id);
create index company_relationships_to_idx   on company_relationships (org_id, to_company_id);

alter table company_relationships enable row level security;
alter table company_relationships force row level security;

create policy company_relationships_select on company_relationships for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'company', 'read'));

create policy company_relationships_write on company_relationships for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'company', 'update'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'company', 'update'));

-- -----------------------------------------------------------------------------
-- Group rollup: a company plus every descendant, used for group reporting.
-- -----------------------------------------------------------------------------
create or replace function app.company_group_ids(p_company uuid)
returns setof uuid
language sql
stable
as $$
  with recursive tree as (
    select id from companies where id = p_company
    union all
    select c.id from companies c join tree t on c.parent_company_id = t.id
  )
  select id from tree
$$;
