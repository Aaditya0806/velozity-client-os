-- =============================================================================
-- 0008_proposals.sql
-- Proposals, immutable versions, internal review, and the opportunity stage
-- guards that depend on them.
--
-- The central rule: the *accepted version* is the source of truth for every
-- downstream artefact. Editing the opportunity afterwards changes nothing about
-- the agreement that gets generated.
-- =============================================================================

create table proposals (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations (id) on delete cascade,
  opportunity_id      uuid not null references opportunities (id) on delete cascade,
  company_id          uuid not null references companies (id) on delete restrict,

  reference           text not null,
  title               text not null check (length(btrim(title)) between 1 and 250),

  status              text not null default 'draft'
                        check (status in ('draft', 'internal_review', 'approved',
                                          'sent', 'accepted', 'rejected', 'expired', 'withdrawn')),

  current_version_id  uuid,
  accepted_version_id uuid,

  currency            char(3) not null check (currency ~ '^[A-Z]{3}$'),
  owner_user_id       uuid references user_profiles (id) on delete set null,
  team_id             uuid references teams (id) on delete set null,

  created_by          uuid references user_profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,

  constraint proposals_reference_unique unique (org_id, reference)
);

create index proposals_opportunity_idx on proposals (org_id, opportunity_id) where deleted_at is null;
create index proposals_company_idx     on proposals (org_id, company_id) where deleted_at is null;
create index proposals_status_idx      on proposals (org_id, status) where deleted_at is null;

create trigger proposals_touch before update on proposals
  for each row execute function app.touch_updated_at();

create trigger proposals_00_state_channel
  before update on proposals
  for each row execute function app.guard_state_column('status');

-- -----------------------------------------------------------------------------
-- Proposal versions
--
-- A version snapshots everything needed to reproduce the document: the priced
-- solution, the narrative sections, the terms. Once accepted it is frozen.
-- -----------------------------------------------------------------------------
create table proposal_versions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  proposal_id    uuid not null references proposals (id) on delete cascade,
  version_no     int not null check (version_no >= 1),

  status         text not null default 'draft'
                   check (status in ('draft', 'internal_review', 'approved', 'sent',
                                     'accepted', 'rejected', 'expired', 'superseded')),

  -- Optimistic concurrency token. Every write must present the revision it read;
  -- a mismatch is a 409 and the client is shown a conflict resolution view.
  revision       bigint not null default 1,

  title          text not null,
  executive_summary text,
  -- Ordered narrative blocks: [{ id, type, heading, body, ... }]
  sections       jsonb not null default '[]'::jsonb,

  -- Frozen copy of the solution as priced at version time. Downstream contract
  -- generation reads this, never the live solution row.
  solution_id    uuid references solutions (id) on delete set null,
  solution_snapshot jsonb not null default '{}'::jsonb,

  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),
  subtotal       numeric(14, 2) not null default 0,
  discount_total numeric(14, 2) not null default 0,
  tax_total      numeric(14, 2) not null default 0,
  total          numeric(14, 2) not null default 0,
  fx_rate_to_base numeric(18, 8) check (fx_rate_to_base is null or fx_rate_to_base > 0),

  payment_terms  text,
  validity_days  int not null default 30 check (validity_days > 0),
  valid_until    date,
  terms          jsonb not null default '{}'::jsonb,

  -- Review and decision trail
  submitted_for_review_at timestamptz,
  submitted_by   uuid references user_profiles (id) on delete set null,
  approved_by    uuid references user_profiles (id) on delete set null,
  approved_at    timestamptz,
  rejected_by    uuid references user_profiles (id) on delete set null,
  rejected_at    timestamptz,
  rejection_reason text,
  sent_at        timestamptz,
  sent_by        uuid references user_profiles (id) on delete set null,
  sent_to        jsonb not null default '[]'::jsonb,
  viewed_at      timestamptz,
  accepted_at    timestamptz,
  accepted_by_contact_id uuid references contacts (id) on delete set null,
  accepted_note  text,
  expires_at     timestamptz,

  -- Rendered artefact, once produced.
  document_id    uuid,

  created_by     uuid references user_profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint proposal_versions_unique unique (proposal_id, version_no),
  constraint proposal_versions_approval_pair
    check ((approved_at is null) = (approved_by is null)),
  constraint proposal_versions_rejection_reason
    check (rejected_at is null or rejection_reason is not null)
);

create index proposal_versions_proposal_idx on proposal_versions (proposal_id, version_no desc);
create index proposal_versions_status_idx   on proposal_versions (org_id, status);

create trigger proposal_versions_touch before update on proposal_versions
  for each row execute function app.touch_updated_at();

create trigger proposal_versions_00_state_channel
  before update on proposal_versions
  for each row execute function app.guard_state_column('status');

alter table proposals
  add constraint proposals_current_version_fk
  foreign key (current_version_id) references proposal_versions (id) on delete set null;

alter table proposals
  add constraint proposals_accepted_version_fk
  foreign key (accepted_version_id) references proposal_versions (id) on delete set null;

alter table opportunities
  add constraint opportunities_accepted_proposal_fk
  foreign key (accepted_proposal_version_id) references proposal_versions (id) on delete set null;

-- -----------------------------------------------------------------------------
-- Immutability of an accepted version.
--
-- Once a client has accepted, the document they accepted must be reproducible
-- byte for byte. Only the small set of post-acceptance bookkeeping columns may
-- still move.
-- -----------------------------------------------------------------------------
create or replace function app.assert_proposal_version_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'accepted' then
    if new.title            is distinct from old.title
    or new.executive_summary is distinct from old.executive_summary
    or new.sections         is distinct from old.sections
    or new.solution_snapshot is distinct from old.solution_snapshot
    or new.currency         is distinct from old.currency
    or new.subtotal         is distinct from old.subtotal
    or new.discount_total   is distinct from old.discount_total
    or new.tax_total        is distinct from old.tax_total
    or new.total            is distinct from old.total
    or new.payment_terms    is distinct from old.payment_terms
    or new.terms            is distinct from old.terms
    or new.version_no       is distinct from old.version_no
    or new.accepted_at      is distinct from old.accepted_at then
      raise exception 'Proposal version % is accepted and its content is immutable', old.version_no
        using errcode = '42501', hint = 'PROPOSAL_VERSION_IMMUTABLE';
    end if;
  end if;
  return new;
end
$$;

create trigger proposal_versions_immutable
  before update on proposal_versions
  for each row execute function app.assert_proposal_version_immutable();

-- Optimistic concurrency: every content update must bump the revision, and the
-- caller must have supplied the revision it read.
create or replace function app.bump_proposal_revision()
returns trigger
language plpgsql
as $$
begin
  if new.revision = old.revision then
    new.revision := old.revision + 1;
  elsif new.revision <> old.revision + 1 then
    raise exception 'Proposal version revision must advance by exactly one (had %, got %)',
      old.revision, new.revision
      using errcode = '40001', hint = 'PROPOSAL_VERSION_CONFLICT';
  end if;
  return new;
end
$$;

create trigger proposal_versions_revision
  before update on proposal_versions
  for each row execute function app.bump_proposal_revision();

-- -----------------------------------------------------------------------------
-- Internal review trail
-- -----------------------------------------------------------------------------
create table proposal_approvals (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  version_id    uuid not null references proposal_versions (id) on delete cascade,
  reviewer_id   uuid not null references user_profiles (id) on delete restrict,
  decision      text not null check (decision in ('approved', 'rejected', 'changes_requested')),
  comment       text,
  decided_at    timestamptz not null default now(),
  constraint proposal_approvals_rejection_comment
    check (decision = 'approved' or comment is not null)
);

create index proposal_approvals_version_idx on proposal_approvals (version_id, decided_at desc);

-- Approvals are evidence of who authorised what: append-only.
create trigger proposal_approvals_no_update before update on proposal_approvals
  for each statement execute function app.forbid_mutation();
create trigger proposal_approvals_no_delete before delete on proposal_approvals
  for each statement execute function app.forbid_mutation();

alter table proposals enable row level security;
alter table proposals force row level security;
alter table proposal_versions enable row level security;
alter table proposal_versions force row level security;
alter table proposal_approvals enable row level security;
alter table proposal_approvals force row level security;

create policy proposals_select on proposals for select to authenticated
  using (deleted_at is null and app.can_row(org_id, 'proposal', 'read', owner_user_id, team_id));

create policy proposals_insert on proposals for insert to authenticated
  with check (org_id = app.active_org_id() and app.can(org_id, 'proposal', 'create'));

create policy proposals_update on proposals for update to authenticated
  using (app.can_row(org_id, 'proposal', 'update', owner_user_id, team_id))
  with check (org_id = app.active_org_id());

create policy proposal_versions_select on proposal_versions for select to authenticated
  using (
    org_id = app.active_org_id()
    and exists (
      select 1 from proposals p
      where p.id = proposal_versions.proposal_id
        and app.can_row(p.org_id, 'proposal', 'read', p.owner_user_id, p.team_id)
    )
  );

create policy proposal_versions_write on proposal_versions for all to authenticated
  using (
    org_id = app.active_org_id()
    and exists (
      select 1 from proposals p
      where p.id = proposal_versions.proposal_id
        and app.can_row(p.org_id, 'proposal', 'update', p.owner_user_id, p.team_id)
    )
  )
  with check (org_id = app.active_org_id());

create policy proposal_approvals_select on proposal_approvals for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'proposal', 'read'));

-- Only holders of proposal:approve may record a review decision, and only for
-- themselves. Approving on someone else's behalf is not possible.
create policy proposal_approvals_insert on proposal_approvals for insert to authenticated
  with check (
    org_id = app.active_org_id()
    and reviewer_id = app.current_user_id()
    and app.can(org_id, 'proposal', 'approve')
  );

revoke update, delete on proposal_approvals from authenticated;

-- =============================================================================
-- OPPORTUNITY GUARDS THAT DEPEND ON PROPOSALS
-- =============================================================================
create or replace function app.opportunity_has_approved_proposal(p_opportunity uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select exists (
    select 1
    from public.proposal_versions v
    join public.proposals p on p.id = v.proposal_id
    where p.opportunity_id = p_opportunity
      and p.deleted_at is null
      and v.status in ('approved', 'sent', 'accepted')
      and v.approved_at is not null
  )
$$;

comment on function app.opportunity_has_approved_proposal is
  'True when at least one proposal version has cleared internal review. Required before proposal_sent.';

create or replace function app.opportunity_has_accepted_proposal(p_opportunity uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select exists (
    select 1
    from public.proposal_versions v
    join public.proposals p on p.id = v.proposal_id
    where p.opportunity_id = p_opportunity
      and p.deleted_at is null
      and v.status = 'accepted'
      and v.accepted_at is not null
  )
$$;

create or replace function app.assert_opportunity_proposal_guards()
returns trigger
language plpgsql
as $$
begin
  if new.stage = old.stage then
    return new;
  end if;

  if new.stage = 'proposal_sent'
     and not app.opportunity_has_approved_proposal(new.id) then
    raise exception
      'An internally approved proposal version is required before sending.'
      using errcode = '23514', hint = 'PROPOSAL_NOT_APPROVED';
  end if;

  if new.stage = 'won' then
    if not app.opportunity_has_accepted_proposal(new.id) then
      raise exception 'An accepted proposal is required before an opportunity can be won.'
        using errcode = '23514', hint = 'PROPOSAL_NOT_ACCEPTED';
    end if;
    if new.accepted_proposal_version_id is null then
      raise exception 'Winning an opportunity must record the accepted proposal version.'
        using errcode = '23514', hint = 'ACCEPTED_VERSION_NOT_RECORDED';
    end if;
  end if;

  return new;
end
$$;

create trigger opportunities_proposal_guard
  before update of stage on opportunities
  for each row execute function app.assert_opportunity_proposal_guards();

-- Once recorded, the accepted proposal version on an opportunity is frozen.
-- This is what stops a later edit from silently re-pointing the agreement.
create or replace function app.assert_accepted_version_frozen()
returns trigger
language plpgsql
as $$
begin
  if old.accepted_proposal_version_id is not null
     and new.accepted_proposal_version_id is distinct from old.accepted_proposal_version_id then
    raise exception 'The accepted proposal version of an opportunity cannot be changed.'
      using errcode = '42501', hint = 'ACCEPTED_VERSION_FROZEN';
  end if;
  return new;
end
$$;

create trigger opportunities_accepted_version_frozen
  before update on opportunities
  for each row execute function app.assert_accepted_version_frozen();
