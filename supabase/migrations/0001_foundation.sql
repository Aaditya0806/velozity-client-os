-- =============================================================================
-- 0001_foundation.sql
-- Extensions, schemas, database roles, and the security helper layer that every
-- RLS policy in this system depends on.
--
-- Portability note: these migrations run both against Supabase (where the
-- `auth` schema, `auth.users` and the `anon`/`authenticated`/`service_role`
-- roles already exist) and against a plain PostgreSQL instance used for
-- integration tests. Everything that Supabase provides is created defensively
-- so the same file works in both places.
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";
create extension if not exists "citext";
create extension if not exists "pg_trgm";
create extension if not exists "btree_gist";

create schema if not exists app;
create schema if not exists auth;
create schema if not exists portal;

comment on schema app is 'Internal helper functions used by RLS policies and triggers. Not exposed over the API.';
comment on schema portal is 'Read-only projections for the external client portal. Physically excludes internal-only columns.';

-- -----------------------------------------------------------------------------
-- Database roles (no-ops on Supabase, required on a bare PostgreSQL test DB)
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema app to anon, authenticated, service_role;
grant usage on schema portal to authenticated, service_role;

-- Ensure the connecting login role can assume the request roles.
do $$
declare
  v_current text := current_user;
begin
  execute format('grant anon, authenticated, service_role to %I', v_current);
exception
  when duplicate_object then null;
  when others then
    raise notice 'Could not grant request roles to %: %', v_current, sqlerrm;
end
$$;

-- -----------------------------------------------------------------------------
-- auth.users shim for non-Supabase environments.
-- On Supabase this table already exists and this block does nothing.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'auth' and table_name = 'users'
  ) then
    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text unique,
      encrypted_password text,
      raw_app_meta_data jsonb not null default '{}'::jsonb,
      raw_user_meta_data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    comment on table auth.users is 'Local shim standing in for the Supabase Auth users table during integration tests.';
  end if;
end
$$;

-- =============================================================================
-- REQUEST CONTEXT
--
-- The application opens every user-facing transaction as the `authenticated`
-- role and sets `request.jwt.claims` to the verified Supabase JWT payload —
-- exactly what PostgREST does. That means the policies below behave identically
-- whether a query arrives through our pg pool or through Supabase's own API.
--
-- The active organisation is carried in the separate `app.org_id` GUC because a
-- user may belong to several organisations with one session. The GUC is only
-- ever allowed to *narrow* access: `app.is_org_member()` re-checks membership
-- against the database on every policy evaluation, so a forged GUC grants
-- nothing.
-- =============================================================================

create or replace function app.jwt_claims()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

create or replace function app.current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(app.jwt_claims() ->> 'sub', '')::uuid
$$;

comment on function app.current_user_id is 'The authenticated Supabase Auth user id for the current transaction, or NULL.';

-- Supabase already defines auth.uid(); define it only if absent.
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $fn$
      create function auth.uid() returns uuid
      language sql stable as 'select app.current_user_id()'
    $fn$;
  end if;
end
$$;

create or replace function app.current_org_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

comment on function app.current_org_id is 'Organisation the current request is scoped to. Advisory only - membership is always re-verified.';

create or replace function app.current_request_id()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.request_id', true), '')
$$;

-- `true` only inside trusted background jobs that deliberately connect as
-- service_role. User-facing request paths never set this.
create or replace function app.is_service_role()
returns boolean
language sql
stable
as $$
  select current_setting('role', true) = 'service_role'
      or current_user = 'service_role'
$$;
