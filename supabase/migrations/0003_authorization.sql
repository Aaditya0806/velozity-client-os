-- =============================================================================
-- 0003_authorization.sql
-- The authorization primitives every RLS policy calls, plus RLS on the core
-- identity/RBAC tables themselves.
--
-- All lookup helpers are SECURITY DEFINER so that a policy on, say,
-- `opportunities` can consult `org_memberships` without recursively triggering
-- that table's own policy. They are deliberately narrow: each one answers a
-- single yes/no or scope question about the *current* user and never returns
-- tenant data.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Membership
-- -----------------------------------------------------------------------------
create or replace function app.is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select exists (
    select 1
    from public.org_memberships m
    join public.user_profiles u on u.id = m.user_id
    where m.org_id = p_org
      and m.user_id = app.current_user_id()
      and m.status = 'active'
      and m.deleted_at is null
      and u.status = 'active'
      and u.deleted_at is null
  )
$$;

comment on function app.is_org_member is
  'True when the current JWT subject is an active member of an active organisation. The real tenant boundary.';

-- The organisation a request may touch: the requested org, but only if the
-- caller is genuinely a member of it. Returns NULL otherwise, and `org_id = NULL`
-- never matches a row, so a forged app.org_id GUC yields an empty result set.
create or replace function app.active_org_id()
returns uuid
language sql
stable
as $$
  select case
    when app.current_org_id() is not null and app.is_org_member(app.current_org_id())
      then app.current_org_id()
    else null
  end
$$;

create or replace function app.user_team_ids(p_org uuid)
returns uuid[]
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select coalesce(array_agg(tm.team_id), '{}'::uuid[])
  from public.team_members tm
  where tm.org_id = p_org
    and tm.user_id = app.current_user_id()
$$;

-- -----------------------------------------------------------------------------
-- Permission resolution
-- -----------------------------------------------------------------------------

-- Highest scope the current user holds for (resource, action) in an org, or
-- NULL when they hold none. `org` implies `team` implies `own`.
create or replace function app.permission_scope(p_org uuid, p_resource text, p_action text)
returns text
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select p.scope
  from public.user_roles ur
  join public.role_permissions rp on rp.role_id = ur.role_id
  join public.permissions p on p.id = rp.permission_id
  where ur.org_id = p_org
    and ur.user_id = app.current_user_id()
    and p.resource = p_resource
    and p.action = p_action
  order by case p.scope when 'org' then 3 when 'team' then 2 when 'own' then 1 else 0 end desc
  limit 1
$$;

comment on function app.permission_scope is
  'Broadest scope (org > team > own) the current user holds for resource:action, or NULL.';

-- Does the user hold resource:action at any scope?
create or replace function app.can(p_org uuid, p_resource text, p_action text)
returns boolean
language sql
stable
as $$
  select app.permission_scope(p_org, p_resource, p_action) is not null
$$;

-- Exact-key check, for permissions that are inherently org-wide authorities
-- such as `contract:approve:org` or `legal:override:org`.
create or replace function app.has_permission(p_org uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions p on p.id = rp.permission_id
    where ur.org_id = p_org
      and ur.user_id = app.current_user_id()
      and p.key = p_key
  )
$$;

-- Row-level visibility for an ownable record. This is the workhorse called by
-- most policies: it combines membership, permission and scope in one predicate.
create or replace function app.can_access(
  p_org      uuid,
  p_resource text,
  p_action   text,
  p_owner_id uuid,
  p_team_id  uuid
)
returns boolean
language sql
stable
as $$
  select case app.permission_scope(p_org, p_resource, p_action)
    when 'org'  then true
    when 'team' then p_owner_id = app.current_user_id()
                  or (p_team_id is not null and p_team_id = any (app.user_team_ids(p_org)))
    when 'own'  then p_owner_id = app.current_user_id()
    else false
  end
$$;

comment on function app.can_access is
  'Combined permission + scope test for one row. NULL scope (no permission) denies.';

-- Shorthand used by policies on rows that are not individually owned: the user
-- must be an active member of the row org AND hold resource:action.
create or replace function app.can_org(p_org uuid, p_resource text, p_action text)
returns boolean
language sql
stable
as $$
  select p_org is not null
     and p_org = app.active_org_id()
     and app.can(p_org, p_resource, p_action)
$$;

-- Same, but additionally scope-aware for owned rows.
create or replace function app.can_row(
  p_org      uuid,
  p_resource text,
  p_action   text,
  p_owner_id uuid,
  p_team_id  uuid
)
returns boolean
language sql
stable
as $$
  select p_org is not null
     and p_org = app.active_org_id()
     and app.can_access(p_org, p_resource, p_action, p_owner_id, p_team_id)
$$;

grant execute on all functions in schema app to authenticated, service_role;

-- =============================================================================
-- RLS: identity and RBAC tables
--
-- Policy discipline used throughout this schema:
--   * RLS is enabled AND forced on every tenant table.
--   * No policy exists for the `anon` role, so unauthenticated access returns
--     nothing anywhere. Deny is the default.
--   * `service_role` bypasses RLS at the role level and is reserved for
--     background jobs; user-facing request paths connect as `authenticated`.
-- =============================================================================

alter table organizations   enable row level security;
alter table organizations   force row level security;
alter table user_profiles   enable row level security;
alter table user_profiles   force row level security;
alter table org_memberships enable row level security;
alter table org_memberships force row level security;
alter table teams           enable row level security;
alter table teams           force row level security;
alter table team_members    enable row level security;
alter table team_members    force row level security;
alter table permissions     enable row level security;
alter table roles           enable row level security;
alter table roles           force row level security;
alter table role_permissions enable row level security;
alter table role_permissions force row level security;
alter table user_roles      enable row level security;
alter table user_roles      force row level security;
alter table holiday_calendars enable row level security;
alter table holiday_calendars force row level security;
alter table holidays        enable row level security;
alter table holidays        force row level security;

-- Organisations: members read their own tenants; only org:update holders change them.
create policy organizations_select on organizations for select to authenticated
  using (deleted_at is null and app.is_org_member(id));

create policy organizations_update on organizations for update to authenticated
  using (app.is_org_member(id) and app.can(id, 'organization', 'update'))
  with check (app.is_org_member(id) and app.can(id, 'organization', 'update'));

-- User profiles: your own row, plus anyone who shares an organisation with you.
create policy user_profiles_select on user_profiles for select to authenticated
  using (
    deleted_at is null
    and (
      id = app.current_user_id()
      or exists (
        select 1
        from org_memberships m
        where m.user_id = user_profiles.id
          and m.deleted_at is null
          and m.org_id = app.active_org_id()
      )
    )
  );

create policy user_profiles_update_self on user_profiles for update to authenticated
  using (id = app.current_user_id())
  with check (id = app.current_user_id());

create policy user_profiles_update_admin on user_profiles for update to authenticated
  using (
    exists (
      select 1 from org_memberships m
      where m.user_id = user_profiles.id
        and m.org_id = app.active_org_id()
        and app.can(m.org_id, 'user', 'update')
    )
  )
  with check (true);

-- Memberships
create policy org_memberships_select on org_memberships for select to authenticated
  using (
    org_id = app.active_org_id()
    and (user_id = app.current_user_id() or app.can(org_id, 'user', 'read'))
  );

create policy org_memberships_write on org_memberships for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'user', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'user', 'manage'));

-- Teams are readable by every member; managed by user:manage holders.
create policy teams_select on teams for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id());

create policy teams_write on teams for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'team', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'team', 'manage'));

create policy team_members_select on team_members for select to authenticated
  using (org_id = app.active_org_id());

create policy team_members_write on team_members for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'team', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'team', 'manage'));

-- The permission catalogue is global reference data: readable, never writable
-- from a request path (migrations own it).
create policy permissions_select on permissions for select to authenticated using (true);

create policy roles_select on roles for select to authenticated
  using (org_id is null or org_id = app.active_org_id());

create policy roles_write on roles for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'role', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'role', 'manage'));

create policy role_permissions_select on role_permissions for select to authenticated
  using (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and (r.org_id is null or r.org_id = app.active_org_id())
    )
  );

create policy role_permissions_write on role_permissions for all to authenticated
  using (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and r.org_id = app.active_org_id()
        and app.can(r.org_id, 'role', 'manage')
    )
  )
  with check (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and r.org_id = app.active_org_id()
        and app.can(r.org_id, 'role', 'manage')
    )
  );

create policy user_roles_select on user_roles for select to authenticated
  using (
    org_id = app.active_org_id()
    and (user_id = app.current_user_id() or app.can(org_id, 'user', 'read'))
  );

create policy user_roles_write on user_roles for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'role', 'assign'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'role', 'assign'));

create policy holiday_calendars_select on holiday_calendars for select to authenticated
  using (org_id = app.active_org_id());

create policy holiday_calendars_write on holiday_calendars for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'organization', 'update'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'organization', 'update'));

create policy holidays_select on holidays for select to authenticated
  using (org_id = app.active_org_id());

create policy holidays_write on holidays for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'organization', 'update'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'organization', 'update'));

-- Table privileges. RLS narrows these further; without the grant nothing works.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on permissions to authenticated;
revoke insert, update, delete on permissions from authenticated;
