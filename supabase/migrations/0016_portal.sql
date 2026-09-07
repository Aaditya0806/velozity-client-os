-- =============================================================================
-- 0016_portal.sql
-- The client portal surface.
--
-- Portal access is NOT "the internal app with fields hidden in React". These
-- views physically exclude margin, cost, internal notes and AI analysis, so a
-- portal query cannot select a column that does not exist in its projection.
-- The portal application surface is built in a later phase; the data contract
-- it will read through exists now so nothing has to be reshaped later.
-- =============================================================================

-- A portal user is a contact who has been granted login access to their
-- company's workspace. They hold no internal role.
create table portal_users (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  company_id    uuid not null references companies (id) on delete cascade,
  contact_id    uuid not null references contacts (id) on delete cascade,
  -- The Supabase Auth user; same identity system, entirely different authority.
  user_id       uuid not null references user_profiles (id) on delete cascade,
  status        text not null default 'invited'
                  check (status in ('invited', 'active', 'suspended', 'revoked')),
  can_view_invoices    boolean not null default false,
  can_view_documents   boolean not null default true,
  can_approve_deliverables boolean not null default false,
  invited_by    uuid references user_profiles (id) on delete set null,
  invited_at    timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  constraint portal_users_unique unique (org_id, company_id, user_id)
);

create index portal_users_user_idx on portal_users (user_id) where status = 'active';

create trigger portal_users_touch before update on portal_users
  for each row execute function app.touch_updated_at();

alter table portal_users enable row level security;
alter table portal_users force row level security;

create policy portal_users_select on portal_users for select to authenticated
  using (
    user_id = app.current_user_id()
    or (org_id = app.active_org_id() and app.can(org_id, 'company', 'read'))
  );

create policy portal_users_write on portal_users for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'company', 'update'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'company', 'update'));

-- Companies the current user may see *as a client*. Empty for internal staff,
-- which is exactly right: the portal views are not a second door into the app.
create or replace function app.portal_company_ids()
returns uuid[]
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select coalesce(array_agg(pu.company_id), '{}'::uuid[])
  from public.portal_users pu
  where pu.user_id = app.current_user_id()
    and pu.status = 'active'
$$;

create or replace function app.is_portal_user()
returns boolean
language sql
stable
as $$
  select array_length(app.portal_company_ids(), 1) > 0
$$;

-- =============================================================================
-- PORTAL VIEWS
--
-- Every view below is defined with security_invoker = off is NOT used; instead
-- each carries its own explicit portal_company_ids() predicate and selects only
-- client-safe columns. Nothing here exposes:
--   margin_*, cost_*, unit_cost, internal_notes, is_internal activity,
--   AI analysis, diagnosis inferences, or another client's rows.
-- =============================================================================

create or replace view portal.companies as
  select
    c.id,
    c.org_id,
    c.name,
    c.legal_name,
    c.website,
    c.industry,
    c.address_line1,
    c.address_line2,
    c.city,
    c.state,
    c.postal_code,
    c.country,
    c.phone,
    c.email,
    c.created_at
  from public.companies c
  where c.deleted_at is null
    and c.id = any (app.portal_company_ids());

create or replace view portal.contacts as
  select
    ct.id,
    ct.org_id,
    ct.company_id,
    ct.first_name,
    ct.last_name,
    ct.full_name,
    ct.email,
    ct.phone,
    ct.job_title,
    ct.department
  from public.contacts ct
  where ct.deleted_at is null
    and ct.status = 'active'
    and ct.company_id = any (app.portal_company_ids());

create or replace view portal.projects as
  select
    p.id,
    p.org_id,
    p.company_id,
    p.code,
    p.name,
    p.description,
    p.status,
    p.health,
    p.start_date,
    p.target_end_date,
    p.actual_end_date,
    p.kickoff_at,
    p.reporting_cadence
  from public.projects p
  where p.deleted_at is null
    and p.company_id = any (app.portal_company_ids());

create or replace view portal.workstreams as
  select
    w.id,
    w.org_id,
    w.project_id,
    w.name,
    w.description,
    w.status,
    w.start_date,
    w.end_date,
    w.position
  from public.workstreams w
  join public.projects p on p.id = w.project_id
  where w.deleted_at is null
    and p.company_id = any (app.portal_company_ids());

-- Only tasks explicitly marked client-visible. Internal delivery chatter,
-- estimates and assignee identity stay inside.
create or replace view portal.tasks as
  select
    t.id,
    t.org_id,
    t.project_id,
    t.workstream_id,
    t.title,
    t.description,
    t.status,
    t.due_date,
    t.completed_at,
    t.is_milestone,
    t.is_deliverable
  from public.tasks t
  join public.projects p on p.id = t.project_id
  where t.deleted_at is null
    and t.is_client_visible
    and p.company_id = any (app.portal_company_ids());

create or replace view portal.deliverables as
  select
    d.id,
    d.org_id,
    d.project_id,
    d.workstream_id,
    d.document_id,
    d.name,
    d.description,
    d.status,
    d.due_date,
    d.delivered_at,
    d.accepted_at
  from public.deliverables d
  join public.projects p on p.id = d.project_id
  where d.deleted_at is null
    and d.is_client_visible
    and p.company_id = any (app.portal_company_ids());

create or replace view portal.documents as
  select
    doc.id,
    doc.org_id,
    doc.company_id,
    doc.project_id,
    doc.category,
    doc.name,
    doc.description,
    doc.current_version_id,
    doc.created_at
  from public.documents doc
  where doc.deleted_at is null
    and doc.status = 'active'
    and doc.is_client_visible
    and not doc.is_confidential
    and doc.company_id = any (app.portal_company_ids())
    and exists (
      select 1 from public.portal_users pu
      where pu.user_id = app.current_user_id()
        and pu.company_id = doc.company_id
        and pu.status = 'active'
        and pu.can_view_documents
    );

create or replace view portal.kpis as
  select
    k.id,
    k.org_id,
    k.company_id,
    k.project_id,
    k.name,
    k.description,
    k.unit,
    k.currency,
    k.direction,
    k.period,
    k.baseline_value,
    k.target_value,
    k.current_value,
    k.current_period_start,
    k.status
  from public.kpis k
  where k.deleted_at is null
    and k.is_client_visible
    and k.company_id = any (app.portal_company_ids());

create or replace view portal.kpi_measurements as
  select
    m.id,
    m.org_id,
    m.kpi_id,
    m.period_start,
    m.period_end,
    m.value,
    m.target_value
  from public.kpi_measurements m
  join public.kpis k on k.id = m.kpi_id
  where k.is_client_visible
    and k.deleted_at is null
    and k.company_id = any (app.portal_company_ids());

create or replace view portal.reports as
  select
    r.id,
    r.org_id,
    r.company_id,
    r.project_id,
    r.title,
    r.period_start,
    r.period_end,
    r.summary,
    r.content,
    r.document_id,
    r.published_at
  from public.client_reports r
  where r.deleted_at is null
    and r.status in ('published', 'sent')
    and r.company_id = any (app.portal_company_ids());

-- Contract metadata only: status and dates, never the internal review trail,
-- the notes, or the template that produced it.
create or replace view portal.contracts as
  select
    c.id,
    c.org_id,
    c.company_id,
    c.reference,
    c.title,
    c.contract_type,
    c.status,
    c.effective_date,
    c.expiry_date,
    c.executed_at,
    c.executed_document_id
  from public.contracts c
  where c.deleted_at is null
    and c.status in ('sent', 'viewed', 'partially_signed', 'fully_executed')
    and c.company_id = any (app.portal_company_ids());

create or replace view portal.invoices as
  select
    i.id,
    i.org_id,
    i.company_id,
    i.project_id,
    i.reference,
    i.status,
    i.currency,
    i.subtotal,
    i.tax_total,
    i.total,
    i.amount_paid,
    i.balance_due,
    i.issue_date,
    i.due_date,
    i.paid_at
  from public.invoices i
  where i.deleted_at is null
    and i.status <> 'draft'
    and i.company_id = any (app.portal_company_ids())
    and exists (
      select 1 from public.portal_users pu
      where pu.user_id = app.current_user_id()
        and pu.company_id = i.company_id
        and pu.status = 'active'
        and pu.can_view_invoices
    );

-- Client-facing timeline: explicitly non-internal activity only.
create or replace view portal.activities as
  select
    a.id,
    a.org_id,
    a.company_id,
    a.entity_type,
    a.entity_id,
    a.activity_type,
    a.title,
    a.body,
    a.occurred_at
  from public.activities a
  where a.deleted_at is null
    and not a.is_internal
    and a.company_id = any (app.portal_company_ids());

grant select on all tables in schema portal to authenticated;

-- Belt and braces: the portal schema is read-only from every request path.
revoke insert, update, delete on all tables in schema portal from authenticated, anon, service_role;
