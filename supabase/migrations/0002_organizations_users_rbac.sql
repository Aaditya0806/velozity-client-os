-- =============================================================================
-- 0002_organizations_users_rbac.sql
-- Tenants, user profiles, teams, and the RBAC tables.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Shared trigger helpers
-- -----------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Blocks UPDATE/DELETE outright. Used by the audit log and by executed contracts.
create or replace function app.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Rows in % are immutable (attempted %)', tg_table_name, tg_op
    using errcode = '42501';
end
$$;

-- -----------------------------------------------------------------------------
-- Organisations
-- -----------------------------------------------------------------------------
create table organizations (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(btrim(name)) between 1 and 200),
  slug              citext not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  legal_name        text,
  base_currency     char(3) not null default 'USD' check (base_currency ~ '^[A-Z]{3}$'),
  timezone          text not null default 'UTC',
  status            text not null default 'active'
                      check (status in ('active', 'suspended', 'closed')),
  ai_enabled        boolean not null default true,
  ai_retention_mode text not null default 'zero_retention'
                      check (ai_retention_mode in ('zero_retention', 'standard')),
  logo_url          text,
  settings          jsonb not null default '{}'::jsonb,
  is_demo           boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

comment on column organizations.ai_enabled is 'Org-level kill switch. When false no AI call is made for this tenant under any circumstance.';
comment on column organizations.is_demo is 'Marks seeded demo tenants. Never true for production tenants.';

create index organizations_status_idx on organizations (status) where deleted_at is null;

create trigger organizations_touch before update on organizations
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- User profiles (application-side identity, linked 1:1 to Supabase Auth)
-- -----------------------------------------------------------------------------
create table user_profiles (
  id            uuid primary key,
  email         citext not null unique,
  full_name     text not null default '',
  avatar_url    text,
  job_title     text,
  phone         text,
  timezone      text not null default 'UTC',
  locale        text not null default 'en',
  status        text not null default 'active'
                  check (status in ('active', 'invited', 'deactivated')),
  is_demo       boolean not null default false,
  last_seen_at  timestamptz,
  -- Bumped whenever the account is deactivated or credentials are revoked.
  -- Sessions issued before this instant are rejected by the application layer.
  sessions_valid_from timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

comment on table user_profiles is 'Application profile for a Supabase Auth user. id always equals auth.users.id.';
comment on column user_profiles.sessions_valid_from is 'Session invalidation watermark: tokens issued before this are refused.';

-- Link to auth.users only where that table is the real Supabase one.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'auth' and table_name = 'users'
  ) then
    alter table user_profiles
      add constraint user_profiles_auth_user_fk
      foreign key (id) references auth.users (id) on delete cascade;
  end if;
end
$$;

create trigger user_profiles_touch before update on user_profiles
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Membership: which users belong to which organisation
-- -----------------------------------------------------------------------------
create table org_memberships (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  user_id        uuid not null references user_profiles (id) on delete cascade,
  status         text not null default 'active'
                   check (status in ('active', 'invited', 'deactivated')),
  is_owner       boolean not null default false,
  invited_by     uuid references user_profiles (id) on delete set null,
  invited_at     timestamptz,
  joined_at      timestamptz,
  deactivated_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint org_memberships_unique unique (org_id, user_id)
);

create index org_memberships_user_idx on org_memberships (user_id) where deleted_at is null;
create index org_memberships_org_idx  on org_memberships (org_id, status) where deleted_at is null;

create trigger org_memberships_touch before update on org_memberships
  for each row execute function app.touch_updated_at();

-- Every organisation must keep at least one active owner.
create or replace function app.assert_org_has_owner()
returns trigger
language plpgsql
as $$
declare
  v_org uuid := coalesce(old.org_id, new.org_id);
  v_owners int;
begin
  select count(*) into v_owners
  from org_memberships
  where org_id = v_org and is_owner and status = 'active' and deleted_at is null;

  if v_owners = 0 then
    raise exception 'An organisation must retain at least one active owner'
      using errcode = '23514';
  end if;
  return null;
end
$$;

create constraint trigger org_memberships_owner_guard
  after update or delete on org_memberships
  deferrable initially deferred
  for each row execute function app.assert_org_has_owner();

-- -----------------------------------------------------------------------------
-- Teams (the unit the `team` permission scope resolves against)
-- -----------------------------------------------------------------------------
create table teams (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  name           text not null check (length(btrim(name)) between 1 and 120),
  slug           citext not null,
  description    text,
  parent_team_id uuid references teams (id) on delete set null,
  lead_user_id   uuid references user_profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint teams_slug_unique unique (org_id, slug),
  constraint teams_not_own_parent check (parent_team_id is null or parent_team_id <> id)
);

create index teams_org_idx on teams (org_id) where deleted_at is null;

create trigger teams_touch before update on teams
  for each row execute function app.touch_updated_at();

create table team_members (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations (id) on delete cascade,
  team_id    uuid not null references teams (id) on delete cascade,
  user_id    uuid not null references user_profiles (id) on delete cascade,
  is_lead    boolean not null default false,
  created_at timestamptz not null default now(),
  constraint team_members_unique unique (team_id, user_id)
);

create index team_members_user_idx on team_members (user_id);
create index team_members_org_idx  on team_members (org_id, team_id);

-- -----------------------------------------------------------------------------
-- Permissions catalogue
--
-- A permission is the triple (resource, action, scope). `key` is the canonical
-- `resource:action:scope` string used throughout the application code.
-- -----------------------------------------------------------------------------
create table permissions (
  id           uuid primary key default gen_random_uuid(),
  key          text not null unique,
  resource     text not null,
  action       text not null,
  scope        text not null check (scope in ('own', 'team', 'org')),
  description  text not null default '',
  -- Sensitive permissions gate margin, cost, internal notes, AI analysis and
  -- commercial/contract data. They are never granted implicitly.
  is_sensitive boolean not null default false,
  created_at   timestamptz not null default now(),
  constraint permissions_key_matches_parts check (key = resource || ':' || action || ':' || scope),
  constraint permissions_resource_action_scope_unique unique (resource, action, scope)
);

comment on table permissions is 'Global catalogue of resource:action:scope permissions. Not tenant scoped.';

create index permissions_resource_action_idx on permissions (resource, action);

-- -----------------------------------------------------------------------------
-- Roles
--
-- System roles (org_id IS NULL) ship with the product and are shared by every
-- tenant. Tenants may additionally define their own roles.
-- -----------------------------------------------------------------------------
create table roles (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references organizations (id) on delete cascade,
  key         text not null check (key ~ '^[a-z][a-z0-9_]{1,48}$'),
  name        text not null,
  description text not null default '',
  is_system   boolean not null default false,
  -- Ordering used purely for display and for "highest role" labelling.
  rank        int not null default 100,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint roles_system_has_no_org check (is_system = (org_id is null))
);

create unique index roles_system_key_unique on roles (key) where org_id is null;
create unique index roles_org_key_unique    on roles (org_id, key) where org_id is not null;

create trigger roles_touch before update on roles
  for each row execute function app.touch_updated_at();

create table role_permissions (
  role_id       uuid not null references roles (id) on delete cascade,
  permission_id uuid not null references permissions (id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create index role_permissions_permission_idx on role_permissions (permission_id);

create table user_roles (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations (id) on delete cascade,
  user_id    uuid not null references user_profiles (id) on delete cascade,
  role_id    uuid not null references roles (id) on delete cascade,
  granted_by uuid references user_profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  constraint user_roles_unique unique (org_id, user_id, role_id)
);

create index user_roles_lookup_idx on user_roles (org_id, user_id);

-- A role assignment must target either a system role or a role owned by the
-- same organisation. Enforced in the database so it cannot be bypassed.
create or replace function app.assert_role_belongs_to_org()
returns trigger
language plpgsql
as $$
declare
  v_role_org uuid;
begin
  select org_id into v_role_org from roles where id = new.role_id;
  if v_role_org is not null and v_role_org <> new.org_id then
    raise exception 'Role % does not belong to organisation %', new.role_id, new.org_id
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger user_roles_role_org_guard
  before insert or update on user_roles
  for each row execute function app.assert_role_belongs_to_org();

-- -----------------------------------------------------------------------------
-- Business calendar (SLA clocks and due-date maths)
-- -----------------------------------------------------------------------------
create table holiday_calendars (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations (id) on delete cascade,
  name       text not null,
  timezone   text not null default 'UTC',
  -- ISO-8601 weekday numbers (1 = Monday .. 7 = Sunday) counted as working days.
  working_days smallint[] not null default '{1,2,3,4,5}',
  work_start   time not null default '09:00',
  work_end     time not null default '18:00',
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint holiday_calendars_name_unique unique (org_id, name)
);

create unique index holiday_calendars_one_default
  on holiday_calendars (org_id) where is_default;

create trigger holiday_calendars_touch before update on holiday_calendars
  for each row execute function app.touch_updated_at();

create table holidays (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  calendar_id uuid not null references holiday_calendars (id) on delete cascade,
  holiday_on  date not null,
  name        text not null,
  created_at  timestamptz not null default now(),
  constraint holidays_unique unique (calendar_id, holiday_on)
);

create index holidays_org_date_idx on holidays (org_id, holiday_on);
