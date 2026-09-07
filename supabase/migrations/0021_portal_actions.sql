-- =============================================================================
-- 0021_portal_actions.sql
-- The portal's write surface.
--
-- The portal schema is read-only by grant, and portal users hold no
-- organisation membership, so every RLS policy on a public table denies them by
-- construction. That is correct and is not relaxed here.
--
-- A client still has to be able to do three things: accept or reject a
-- deliverable they were asked to review, acknowledge a report, and have their
-- sign-in recorded. Each is expressed as a SECURITY DEFINER function that
-- re-derives the caller's portal authority from portal_users rather than
-- trusting an argument. The application cannot ask for more than the client is
-- entitled to, because it never states who it is.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A client is a distinct kind of actor
-- -----------------------------------------------------------------------------

-- A decision made by a client is not an internal user's action, and recording
-- it as one would make the timeline lie about who did what. The enumeration
-- gains a value rather than the portal borrowing an existing one.
alter table activities drop constraint if exists activities_actor_type_check;
alter table activities add constraint activities_actor_type_check
  check (actor_type in ('user', 'system', 'automation', 'provider', 'ai', 'portal_user'));

-- -----------------------------------------------------------------------------
-- Authority
-- -----------------------------------------------------------------------------

-- True when the current user is an active portal user for this company AND
-- holds the named capability. Capabilities are columns, not a bag of strings,
-- so an unknown one is a SQL error at deploy time rather than a silent allow.
create or replace function app.portal_can(p_company uuid, p_capability text)
returns boolean
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_allowed boolean;
begin
  if p_capability not in ('view_invoices', 'view_documents', 'approve_deliverables') then
    -- Hinted so the API layer reports a validation error rather than the
    -- opaque "a database error occurred" it falls back to for unmapped codes.
    raise exception 'Unknown portal capability: %', p_capability
      using errcode = '22023', hint = 'VALIDATION_ERROR';
  end if;

  select case p_capability
           when 'view_invoices' then pu.can_view_invoices
           when 'view_documents' then pu.can_view_documents
           when 'approve_deliverables' then pu.can_approve_deliverables
         end
    into v_allowed
  from public.portal_users pu
  where pu.user_id = app.current_user_id()
    and pu.company_id = p_company
    and pu.status = 'active'
  limit 1;

  return coalesce(v_allowed, false);
end
$$;

-- The contact behind the current portal session, for attribution. A decision
-- recorded against a company but not a person is not much of a record.
create or replace function app.portal_contact_id(p_company uuid)
returns uuid
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select pu.contact_id
  from public.portal_users pu
  where pu.user_id = app.current_user_id()
    and pu.company_id = p_company
    and pu.status = 'active'
  limit 1
$$;

-- -----------------------------------------------------------------------------
-- Deliverable acceptance
-- -----------------------------------------------------------------------------

create or replace function app.portal_decide_deliverable(
  p_deliverable uuid,
  p_decision    text,
  p_reason      text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  d record;
  v_contact uuid;
begin
  if p_decision not in ('accepted', 'rejected') then
    raise exception 'Decision must be accepted or rejected, not %', p_decision
      using errcode = '22023', hint = 'VALIDATION_ERROR';
  end if;

  -- A rejection without a reason is useless to the team receiving it, and the
  -- table's own constraint refuses it anyway; failing here gives a better
  -- message than a constraint violation.
  if p_decision = 'rejected' and coalesce(btrim(p_reason), '') = '' then
    raise exception 'A rejection must say why'
      using errcode = '23514', hint = 'VALIDATION_ERROR';
  end if;

  select dl.id, dl.org_id, dl.status, dl.is_client_visible, p.company_id
    into d
  from public.deliverables dl
  join public.projects p on p.id = dl.project_id
  where dl.id = p_deliverable
    and dl.deleted_at is null
    and p.deleted_at is null;

  -- Not found and not permitted are answered identically on purpose: probing
  -- for the existence of another client's deliverable must not be possible.
  if d.id is null
     or not d.is_client_visible
     or not app.portal_can(d.company_id, 'approve_deliverables')
  then
    raise exception 'No such deliverable'
      using errcode = '42501', hint = 'NOT_FOUND';
  end if;

  -- Only something actually put in front of the client may be decided. This is
  -- the state machine, not a suggestion: accepting a deliverable that was never
  -- delivered would let the portal skip the team's own workflow.
  if d.status not in ('delivered', 'in_review') then
    raise exception 'A deliverable in status % is not awaiting a decision', d.status
      using errcode = '23514', hint = 'INVALID_STATE';
  end if;

  v_contact := app.portal_contact_id(d.company_id);

  update public.deliverables
     set status                 = p_decision,
         accepted_at            = case when p_decision = 'accepted' then now() else null end,
         accepted_by_contact_id = case when p_decision = 'accepted' then v_contact else null end,
         rejection_reason       = case when p_decision = 'rejected' then btrim(p_reason) else null end
   where id = p_deliverable;

  -- Visible to the client on their own timeline, and to the team on theirs.
  insert into public.activities
    (org_id, company_id, entity_type, entity_id, activity_type, title, body,
     occurred_at, is_internal, actor_type, actor_user_id)
  values
    (d.org_id, d.company_id, 'deliverable', p_deliverable, 'note',
     case when p_decision = 'accepted' then 'Deliverable accepted by the client'
          else 'Deliverable rejected by the client' end,
     case when p_decision = 'rejected' then btrim(p_reason) else null end,
     now(), false, 'portal_user', app.current_user_id());

  return jsonb_build_object(
    'id', p_deliverable,
    'status', p_decision,
    'decided_at', now(),
    'contact_id', v_contact
  );
end
$$;

-- -----------------------------------------------------------------------------
-- Report acknowledgement
-- -----------------------------------------------------------------------------

create table portal_report_receipts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  report_id     uuid not null references client_reports (id) on delete cascade,
  company_id    uuid not null references companies (id) on delete cascade,
  portal_user_id uuid not null references portal_users (id) on delete cascade,
  contact_id    uuid references contacts (id) on delete set null,
  acknowledged_at timestamptz not null default now(),
  constraint portal_report_receipts_unique unique (report_id, portal_user_id)
);

create index portal_report_receipts_report_idx on portal_report_receipts (report_id);

alter table portal_report_receipts enable row level security;
alter table portal_report_receipts force row level security;

-- The team can see who acknowledged what; nobody writes this through a policy.
create policy portal_report_receipts_select on portal_report_receipts for select to authenticated
  using (
    org_id = app.active_org_id() and app.can(org_id, 'company', 'read')
  );

create or replace function app.portal_acknowledge_report(p_report uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  r record;
  v_portal_user uuid;
  v_contact uuid;
begin
  select cr.id, cr.org_id, cr.company_id, cr.status
    into r
  from public.client_reports cr
  where cr.id = p_report
    and cr.deleted_at is null
    and cr.status in ('published', 'sent');

  if r.id is null then
    raise exception 'No such report' using errcode = '42501', hint = 'NOT_FOUND';
  end if;

  select pu.id, pu.contact_id into v_portal_user, v_contact
  from public.portal_users pu
  where pu.user_id = app.current_user_id()
    and pu.company_id = r.company_id
    and pu.status = 'active'
  limit 1;

  if v_portal_user is null then
    raise exception 'No such report' using errcode = '42501', hint = 'NOT_FOUND';
  end if;

  insert into public.portal_report_receipts
    (org_id, report_id, company_id, portal_user_id, contact_id)
  values (r.org_id, p_report, r.company_id, v_portal_user, v_contact)
  on conflict (report_id, portal_user_id) do nothing;

  return jsonb_build_object('report_id', p_report, 'acknowledged_at', now());
end
$$;

-- -----------------------------------------------------------------------------
-- Sign-in recording
-- -----------------------------------------------------------------------------

create or replace function app.portal_record_login()
returns void
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  update public.portal_users
     set last_login_at = now(),
         status = case when status = 'invited' then 'active' else status end
   where user_id = app.current_user_id()
     and status in ('invited', 'active')
$$;

-- -----------------------------------------------------------------------------
-- A client's own receipts, so the portal can show what it has acknowledged.
-- -----------------------------------------------------------------------------

create or replace view portal.report_receipts as
  select
    rr.id,
    rr.org_id,
    rr.report_id,
    rr.company_id,
    rr.acknowledged_at
  from public.portal_report_receipts rr
  where rr.company_id = any (app.portal_company_ids());

-- Deliverables carry the decision fields the client themselves supplied; the
-- internal rejection trail and reviewer identity stay inside.
create or replace view portal.deliverable_decisions as
  select
    d.id,
    d.org_id,
    d.project_id,
    d.status,
    d.accepted_at,
    d.rejection_reason
  from public.deliverables d
  join public.projects p on p.id = d.project_id
  where d.deleted_at is null
    and d.is_client_visible
    and p.company_id = any (app.portal_company_ids());

grant select on portal.report_receipts, portal.deliverable_decisions to authenticated;
revoke insert, update, delete on portal.report_receipts, portal.deliverable_decisions
  from authenticated, anon, service_role;

-- -----------------------------------------------------------------------------
-- Document download
-- -----------------------------------------------------------------------------

-- A portal user holds no membership, so RLS on document_versions denies them
-- and no view can hand them a storage path without also deciding whether they
-- are entitled to it. Both decisions live here, together with the access log,
-- so there is exactly one path from "a client asked for a file" to "a signed
-- URL exists" — and it cannot run without writing down that it did.
create or replace function app.portal_document_for_download(p_document uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  d record;
  v record;
begin
  select doc.id, doc.org_id, doc.company_id, doc.name, doc.status,
         doc.is_confidential, doc.is_client_visible, doc.current_version_id
    into d
  from public.documents doc
  where doc.id = p_document
    and doc.deleted_at is null;

  -- Absent, hidden, confidential, another client's, or beyond this client's
  -- capability: all answered the same way. Distinguishing them would let a
  -- client enumerate documents they are not allowed to know exist.
  if d.id is null
     or d.status <> 'active'
     or not d.is_client_visible
     or d.is_confidential
     or not app.portal_can(d.company_id, 'view_documents')
  then
    raise exception 'No such document' using errcode = '42501', hint = 'NOT_FOUND';
  end if;

  if d.status = 'quarantined' then
    raise exception 'Document is quarantined'
      using errcode = '23514', hint = 'DOCUMENT_HASH_MISMATCH';
  end if;

  select dv.id, dv.storage_bucket, dv.storage_path, dv.file_name, dv.sha256
    into v
  from public.document_versions dv
  where dv.id = d.current_version_id;

  if v.id is null then
    raise exception 'No such document' using errcode = '42501', hint = 'NOT_FOUND';
  end if;

  insert into public.document_access_log
    (org_id, document_id, version_id, user_id, action, request_id, metadata)
  values
    (d.org_id, d.id, v.id, app.current_user_id(), 'url_issued', null,
     jsonb_build_object('surface', 'portal'));

  return jsonb_build_object(
    'document_id', d.id,
    'version_id', v.id,
    'storage_bucket', v.storage_bucket,
    'storage_path', v.storage_path,
    'file_name', v.file_name,
    'sha256', v.sha256
  );
end
$$;

-- =============================================================================
-- GRANTING AND REVOKING ACCESS
--
-- Called by internal staff, not by clients. A portal user needs a
-- `user_profiles` row, and `authenticated` deliberately holds no INSERT policy
-- on that table — so this is where the exception lives, with the permission
-- check attached to it rather than in a route that could be forgotten.
--
-- What these functions must never do is create an `org_memberships` row. A
-- portal user with a membership would satisfy `requireContext()` and be handed
-- the internal application with an empty permission set: a blank dashboard
-- instead of their portal, and a membership nobody meant to grant.
-- =============================================================================

create or replace function app.grant_portal_access(
  p_contact              uuid,
  p_auth_user            uuid,
  p_view_invoices        boolean default false,
  p_view_documents       boolean default true,
  p_approve_deliverables boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  c record;
  v_id uuid;
begin
  select ct.id, ct.org_id, ct.company_id, ct.email, ct.full_name
    into c
  from public.contacts ct
  where ct.id = p_contact
    and ct.deleted_at is null;

  if c.id is null then
    raise exception 'No such contact' using errcode = '42501', hint = 'NOT_FOUND';
  end if;

  if not app.can(c.org_id, 'company', 'update') then
    raise exception 'Not permitted to grant portal access'
      using errcode = '42501', hint = 'FORBIDDEN';
  end if;

  if coalesce(btrim(c.email), '') = '' then
    raise exception 'This contact has no email address to sign in with'
      using errcode = '23514', hint = 'VALIDATION_ERROR';
  end if;

  -- The auth user already exists; this mirrors it so foreign keys and display
  -- names resolve. Adopted rather than overwritten if it is already present.
  insert into public.user_profiles (id, email, full_name, status)
  values (p_auth_user, lower(btrim(c.email)), coalesce(c.full_name, c.email), 'active')
  on conflict (id) do update
    set full_name = coalesce(excluded.full_name, public.user_profiles.full_name);

  insert into public.portal_users
    (org_id, company_id, contact_id, user_id, status,
     can_view_invoices, can_view_documents, can_approve_deliverables,
     invited_by, invited_at)
  values
    (c.org_id, c.company_id, c.id, p_auth_user, 'invited',
     p_view_invoices, p_view_documents, p_approve_deliverables,
     app.current_user_id(), now())
  on conflict (org_id, company_id, user_id) do update
    set status                   = case when public.portal_users.status = 'revoked'
                                        then 'invited' else public.portal_users.status end,
        contact_id               = excluded.contact_id,
        can_view_invoices        = excluded.can_view_invoices,
        can_view_documents       = excluded.can_view_documents,
        can_approve_deliverables = excluded.can_approve_deliverables,
        revoked_at               = null
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'contact_id', c.id, 'company_id', c.company_id);
end
$$;

create or replace function app.set_portal_access(
  p_portal_user          uuid,
  p_view_invoices        boolean,
  p_view_documents       boolean,
  p_approve_deliverables boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.portal_users where id = p_portal_user;
  if v_org is null then
    raise exception 'No such portal user' using errcode = '42501', hint = 'NOT_FOUND';
  end if;
  if not app.can(v_org, 'company', 'update') then
    raise exception 'Not permitted' using errcode = '42501', hint = 'FORBIDDEN';
  end if;

  update public.portal_users
     set can_view_invoices = p_view_invoices,
         can_view_documents = p_view_documents,
         can_approve_deliverables = p_approve_deliverables
   where id = p_portal_user;

  return jsonb_build_object('id', p_portal_user);
end
$$;

create or replace function app.revoke_portal_access(p_portal_user uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.portal_users where id = p_portal_user;
  if v_org is null then
    raise exception 'No such portal user' using errcode = '42501', hint = 'NOT_FOUND';
  end if;
  if not app.can(v_org, 'company', 'update') then
    raise exception 'Not permitted' using errcode = '42501', hint = 'FORBIDDEN';
  end if;

  -- Revoked rather than deleted: who could see what, and until when, is a
  -- question that gets asked after an access review, not before one.
  update public.portal_users
     set status = 'revoked', revoked_at = now()
   where id = p_portal_user;

  return jsonb_build_object('id', p_portal_user, 'status', 'revoked');
end
$$;

revoke all on function app.grant_portal_access(uuid, uuid, boolean, boolean, boolean)
  from public, anon;
revoke all on function app.set_portal_access(uuid, boolean, boolean, boolean) from public, anon;
revoke all on function app.revoke_portal_access(uuid) from public, anon;

grant execute on function app.grant_portal_access(uuid, uuid, boolean, boolean, boolean)
  to authenticated;
grant execute on function app.set_portal_access(uuid, boolean, boolean, boolean) to authenticated;
grant execute on function app.revoke_portal_access(uuid) to authenticated;

-- Only these functions may be called by a signed-in client. Everything
-- else in `app` stays unreachable from a portal session.
revoke all on function app.portal_decide_deliverable(uuid, text, text) from public, anon;
revoke all on function app.portal_acknowledge_report(uuid) from public, anon;
revoke all on function app.portal_record_login() from public, anon;
revoke all on function app.portal_can(uuid, text) from public, anon;
revoke all on function app.portal_contact_id(uuid) from public, anon;
revoke all on function app.portal_document_for_download(uuid) from public, anon;

grant execute on function app.portal_decide_deliverable(uuid, text, text) to authenticated;
grant execute on function app.portal_acknowledge_report(uuid) to authenticated;
grant execute on function app.portal_record_login() to authenticated;
grant execute on function app.portal_can(uuid, text) to authenticated;
grant execute on function app.portal_contact_id(uuid) to authenticated;
grant execute on function app.portal_document_for_download(uuid) to authenticated;
