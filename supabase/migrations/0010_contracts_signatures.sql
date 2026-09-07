-- =============================================================================
-- 0010_contracts_signatures.sql
-- Contract templates, the contract lifecycle, e-signature requests, and the
-- verified-webhook pipeline that is the only thing allowed to mark a contract
-- fully executed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- TEMPLATES
--
-- A template is legal text plus a declared set of variables. The renderer
-- substitutes variables and does nothing else - it cannot generate, infer or
-- default a clause. A missing required variable fails the render.
-- -----------------------------------------------------------------------------
create table contract_templates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  key           citext not null,
  name          text not null,
  contract_type text not null
                  check (contract_type in ('nda', 'msa', 'sow', 'addendum', 'amendment', 'other')),
  description   text,
  jurisdiction  text,
  governing_law text,
  is_active     boolean not null default true,
  current_version_id uuid,
  is_demo       boolean not null default false,
  created_by    uuid references user_profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint contract_templates_key_unique unique (org_id, key)
);

create trigger contract_templates_touch before update on contract_templates
  for each row execute function app.touch_updated_at();

create table contract_template_versions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  template_id   uuid not null references contract_templates (id) on delete cascade,
  version_no    int not null check (version_no >= 1),

  -- The legal text. Contains {{variable}} placeholders and nothing executable.
  body          text not null,
  -- Declared variables:
  -- [{ key, label, type, required, description, source_hint }]
  variables     jsonb not null default '[]'::jsonb,

  status        text not null default 'draft'
                  check (status in ('draft', 'active', 'retired')),
  change_note   text,
  approved_by   uuid references user_profiles (id) on delete set null,
  approved_at   timestamptz,
  created_by    uuid references user_profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint contract_template_versions_unique unique (template_id, version_no)
);

create index contract_template_versions_template_idx on contract_template_versions (template_id, version_no desc);

create trigger contract_template_versions_touch before update on contract_template_versions
  for each row execute function app.touch_updated_at();

alter table contract_templates
  add constraint contract_templates_current_version_fk
  foreign key (current_version_id) references contract_template_versions (id) on delete set null;

-- An active template version is in legal use; its text is frozen. Changing the
-- wording means cutting a new version.
create or replace function app.assert_template_version_frozen()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'active' and new.body is distinct from old.body then
    raise exception 'The body of an active template version is frozen. Create a new version instead.'
      using errcode = '42501', hint = 'TEMPLATE_VERSION_FROZEN';
  end if;
  if old.status = 'active' and new.variables is distinct from old.variables then
    raise exception 'The variable set of an active template version is frozen.'
      using errcode = '42501', hint = 'TEMPLATE_VERSION_FROZEN';
  end if;
  return new;
end
$$;

create trigger contract_template_versions_frozen
  before update on contract_template_versions
  for each row execute function app.assert_template_version_frozen();

-- =============================================================================
-- CONTRACTS
-- One table, discriminated by contract_type, so the lifecycle, the signature
-- pipeline and the legal gate are written exactly once.
-- =============================================================================
create table contracts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations (id) on delete cascade,

  company_id          uuid not null references companies (id) on delete restrict,
  -- The signing legal entity, which may differ from the account company.
  legal_entity_id     uuid references companies (id) on delete set null,
  opportunity_id      uuid references opportunities (id) on delete set null,
  project_id          uuid,

  reference           text not null,
  title               text not null,
  contract_type       text not null
                        check (contract_type in ('nda', 'msa', 'sow', 'addendum', 'amendment', 'other')),

  status              text not null default 'draft'
                        check (status in ('draft', 'internal_review', 'approved_to_send', 'sent',
                                          'viewed', 'partially_signed', 'fully_executed',
                                          'declined', 'expired', 'voided')),

  -- Amendments and addenda hang off the contract they modify.
  parent_contract_id  uuid references contracts (id) on delete restrict,

  -- Provenance of the paper.
  origin              text not null default 'our_template'
                        check (origin in ('our_template', 'client_paper', 'negotiated')),
  template_version_id uuid references contract_template_versions (id) on delete set null,
  -- The exact variable values used at render time. Kept for reproducibility.
  variable_values     jsonb not null default '{}'::jsonb,
  -- The accepted proposal version this agreement was generated from. Frozen.
  source_proposal_version_id uuid references proposal_versions (id) on delete set null,

  currency            char(3) check (currency is null or currency ~ '^[A-Z]{3}$'),
  contract_value      numeric(14, 2) check (contract_value is null or contract_value >= 0),
  fx_rate_to_base     numeric(18, 8) check (fx_rate_to_base is null or fx_rate_to_base > 0),

  effective_date      date,
  expiry_date         date,
  -- Renewal tracking feeds the renewals dashboard.
  auto_renews         boolean not null default false,
  renewal_notice_days int,

  -- Draft and sent artefacts.
  draft_document_id   uuid references documents (id) on delete set null,
  executed_document_id uuid references documents (id) on delete set null,

  -- Legal review trail. Send authority is deliberately separate from the deal
  -- owner: approved_by must hold contract:approve, sent_by must hold contract:send.
  submitted_for_review_at timestamptz,
  submitted_by        uuid references user_profiles (id) on delete set null,
  approved_by         uuid references user_profiles (id) on delete set null,
  approved_at         timestamptz,
  sent_by             uuid references user_profiles (id) on delete set null,
  sent_at             timestamptz,
  first_viewed_at     timestamptz,
  executed_at         timestamptz,
  declined_at         timestamptz,
  decline_reason      text,
  voided_at           timestamptz,
  void_reason         text,
  expires_at          timestamptz,

  owner_user_id       uuid references user_profiles (id) on delete set null,
  team_id             uuid references teams (id) on delete set null,
  notes               text,
  internal_notes      text,

  is_demo             boolean not null default false,
  created_by          uuid references user_profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,

  constraint contracts_reference_unique unique (org_id, reference),
  constraint contracts_not_own_parent check (parent_contract_id is null or parent_contract_id <> id),
  constraint contracts_amendment_has_parent
    check (contract_type not in ('addendum', 'amendment') or parent_contract_id is not null),
  constraint contracts_decline_reason check (declined_at is null or decline_reason is not null),
  constraint contracts_void_reason check (voided_at is null or void_reason is not null),
  constraint contracts_dates check (expiry_date is null or effective_date is null or expiry_date >= effective_date)
);

create index contracts_org_status_idx  on contracts (org_id, status) where deleted_at is null;
create index contracts_company_idx     on contracts (org_id, company_id) where deleted_at is null;
create index contracts_type_idx        on contracts (org_id, contract_type, status) where deleted_at is null;
create index contracts_opportunity_idx on contracts (opportunity_id) where deleted_at is null;
create index contracts_parent_idx      on contracts (parent_contract_id) where deleted_at is null;
create index contracts_expiry_idx      on contracts (org_id, expiry_date) where deleted_at is null and expiry_date is not null;

create trigger contracts_touch before update on contracts
  for each row execute function app.touch_updated_at();

create trigger contracts_00_state_channel
  before update on contracts
  for each row execute function app.guard_state_column('status');

alter table documents
  add constraint documents_contract_fk
  foreign key (contract_id) references contracts (id) on delete set null;

-- -----------------------------------------------------------------------------
-- fully_executed is terminal and the record is frozen.
-- Anything that needs to change afterwards is an amendment.
-- -----------------------------------------------------------------------------
create or replace function app.assert_contract_execution_terminal()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'fully_executed' then
    if new.status is distinct from old.status then
      raise exception
        'A fully executed contract is terminal. Create an amendment referencing it instead.'
        using errcode = '42501', hint = 'CONTRACT_TERMINAL';
    end if;

    if new.title              is distinct from old.title
    or new.contract_type      is distinct from old.contract_type
    or new.company_id         is distinct from old.company_id
    or new.legal_entity_id    is distinct from old.legal_entity_id
    or new.template_version_id is distinct from old.template_version_id
    or new.variable_values    is distinct from old.variable_values
    or new.contract_value     is distinct from old.contract_value
    or new.currency           is distinct from old.currency
    or new.effective_date     is distinct from old.effective_date
    or new.executed_document_id is distinct from old.executed_document_id
    or new.executed_at        is distinct from old.executed_at
    or new.source_proposal_version_id is distinct from old.source_proposal_version_id then
      raise exception 'A fully executed contract is immutable'
        using errcode = '42501', hint = 'CONTRACT_IMMUTABLE';
    end if;
  end if;

  -- Execution must be evidenced by a stored executed document.
  if new.status = 'fully_executed' and old.status <> 'fully_executed' then
    if new.executed_document_id is null then
      raise exception 'A contract cannot be marked fully executed without its executed document'
        using errcode = '23514', hint = 'EXECUTED_DOCUMENT_REQUIRED';
    end if;
    new.executed_at := coalesce(new.executed_at, now());
  end if;

  return new;
end
$$;

create trigger contracts_execution_terminal
  before update on contracts
  for each row execute function app.assert_contract_execution_terminal();

-- Approve and send authority are checked in the database as well as the API.
create or replace function app.assert_contract_authority()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'approved_to_send' and old.status is distinct from new.status then
    if new.approved_by is null then
      raise exception 'Approving a contract for sending must record the approver'
        using errcode = '23514', hint = 'CONTRACT_APPROVER_REQUIRED';
    end if;
  end if;

  if new.status = 'sent' and old.status is distinct from new.status then
    if old.status <> 'approved_to_send' then
      raise exception 'A contract must be approved to send before it is sent (was %)', old.status
        using errcode = '23514', hint = 'CONTRACT_NOT_APPROVED';
    end if;
    if new.sent_by is null then
      raise exception 'Sending a contract must record the sender'
        using errcode = '23514', hint = 'CONTRACT_SENDER_REQUIRED';
    end if;
    if not app.has_permission(new.org_id, 'contract:send:org') then
      raise exception 'contract:send:org is required to send a contract'
        using errcode = '42501', hint = 'FORBIDDEN';
    end if;
  end if;

  return new;
end
$$;

create trigger contracts_authority_guard
  before update on contracts
  for each row execute function app.assert_contract_authority();

-- -----------------------------------------------------------------------------
-- Signers
-- -----------------------------------------------------------------------------
create table contract_signers (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  contract_id    uuid not null references contracts (id) on delete cascade,
  party          text not null check (party in ('internal', 'counterparty', 'witness')),
  contact_id     uuid references contacts (id) on delete set null,
  user_id        uuid references user_profiles (id) on delete set null,
  name           text not null,
  email          citext not null,
  role_label     text,
  signing_order  int not null default 1 check (signing_order >= 1),
  status         text not null default 'pending'
                   check (status in ('pending', 'sent', 'viewed', 'signed', 'declined', 'bounced')),
  signed_at      timestamptz,
  declined_at    timestamptz,
  decline_reason text,
  ip_address     inet,
  provider_signer_id text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint contract_signers_email_unique unique (contract_id, email)
);

create index contract_signers_contract_idx on contract_signers (contract_id, signing_order);

create trigger contract_signers_touch before update on contract_signers
  for each row execute function app.touch_updated_at();

-- =============================================================================
-- SIGNATURE REQUESTS
-- The provider-facing side. Credentials never live here - only opaque ids.
-- =============================================================================
create table signature_requests (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations (id) on delete cascade,
  contract_id         uuid not null references contracts (id) on delete cascade,

  provider            text not null default 'zoho_sign'
                        check (provider in ('zoho_sign', 'docusign', 'adobe_sign', 'manual')),
  provider_request_id text,

  status              text not null default 'created'
                        check (status in ('created', 'sent', 'viewed', 'partially_signed',
                                          'completed', 'declined', 'expired', 'voided', 'failed')),

  document_version_id uuid references document_versions (id) on delete set null,
  -- Hash of the document handed to the provider, so we can prove the executed
  -- copy corresponds to what was sent.
  sent_sha256         text check (sent_sha256 is null or sent_sha256 ~ '^[0-9a-f]{64}$'),

  subject             text,
  message             text,
  expires_at          timestamptz,

  -- Guards duplicate creation when a send is retried.
  idempotency_key     text,

  requested_by        uuid references user_profiles (id) on delete set null,
  requested_at        timestamptz not null default now(),
  completed_at        timestamptz,
  last_error          text,
  provider_metadata   jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint signature_requests_provider_unique unique (provider, provider_request_id)
);

create index signature_requests_contract_idx on signature_requests (contract_id, created_at desc);
create index signature_requests_status_idx on signature_requests (org_id, status);
create unique index signature_requests_idempotency_idx
  on signature_requests (org_id, idempotency_key) where idempotency_key is not null;

create trigger signature_requests_touch before update on signature_requests
  for each row execute function app.touch_updated_at();

-- =============================================================================
-- WEBHOOKS
--
-- Every inbound provider callback is persisted raw *before* it is interpreted,
-- with its signature verification result recorded. Processing is idempotent on
-- (provider, provider_event_id) and retries with exponential backoff.
-- =============================================================================
create table webhook_events (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null,
  provider_event_id  text,
  event_type         text,

  -- Verification is recorded, not assumed. An unverified event is stored for
  -- forensics and never processed.
  signature_verified boolean not null default false,
  verification_error text,

  raw_body           text not null,
  headers            jsonb not null default '{}'::jsonb,
  payload            jsonb,

  org_id             uuid references organizations (id) on delete set null,
  status             text not null default 'received'
                       check (status in ('received', 'rejected', 'processing', 'processed', 'failed', 'ignored')),
  attempts           int not null default 0,
  max_attempts       int not null default 8,
  next_attempt_at    timestamptz,
  last_error         text,

  received_at        timestamptz not null default now(),
  processed_at       timestamptz
);

-- Idempotency: the same provider event can arrive any number of times.
create unique index webhook_events_provider_event_idx
  on webhook_events (provider, provider_event_id) where provider_event_id is not null;
create index webhook_events_status_idx on webhook_events (status, next_attempt_at)
  where status in ('received', 'failed');
create index webhook_events_received_idx on webhook_events (provider, received_at desc);

-- Raw evidence: never edited, never deleted from a request path.
create trigger webhook_events_no_delete before delete on webhook_events
  for each statement execute function app.forbid_mutation();

-- Normalised signature events derived from verified webhooks.
create table signature_events (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organizations (id) on delete cascade,
  signature_request_id uuid not null references signature_requests (id) on delete cascade,
  webhook_event_id     uuid references webhook_events (id) on delete set null,
  event_type           text not null
                         check (event_type in ('sent', 'viewed', 'signed', 'declined',
                                               'completed', 'expired', 'voided', 'failed')),
  signer_email         citext,
  provider_signer_id   text,
  occurred_at          timestamptz not null default now(),
  payload              jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);

create index signature_events_request_idx on signature_events (signature_request_id, occurred_at);

create trigger signature_events_no_update before update on signature_events
  for each statement execute function app.forbid_mutation();

alter table contract_templates enable row level security;
alter table contract_templates force row level security;
alter table contract_template_versions enable row level security;
alter table contract_template_versions force row level security;
alter table contracts enable row level security;
alter table contracts force row level security;
alter table contract_signers enable row level security;
alter table contract_signers force row level security;
alter table signature_requests enable row level security;
alter table signature_requests force row level security;
alter table webhook_events enable row level security;
alter table webhook_events force row level security;
alter table signature_events enable row level security;
alter table signature_events force row level security;

create policy contract_templates_select on contract_templates for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id() and app.can(org_id, 'contract_template', 'read'));
create policy contract_templates_write on contract_templates for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'contract_template', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'contract_template', 'manage'));

create policy contract_template_versions_select on contract_template_versions for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'contract_template', 'read'));
create policy contract_template_versions_write on contract_template_versions for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'contract_template', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'contract_template', 'manage'));

create policy contracts_select on contracts for select to authenticated
  using (deleted_at is null and app.can_row(org_id, 'contract', 'read', owner_user_id, team_id));
create policy contracts_insert on contracts for insert to authenticated
  with check (org_id = app.active_org_id() and app.can(org_id, 'contract', 'create'));
create policy contracts_update on contracts for update to authenticated
  using (app.can_row(org_id, 'contract', 'update', owner_user_id, team_id))
  with check (org_id = app.active_org_id());

create policy contract_signers_select on contract_signers for select to authenticated
  using (
    org_id = app.active_org_id()
    and exists (select 1 from contracts c where c.id = contract_signers.contract_id)
  );
create policy contract_signers_write on contract_signers for all to authenticated
  using (
    org_id = app.active_org_id()
    and app.can(org_id, 'contract', 'update')
    and exists (select 1 from contracts c where c.id = contract_signers.contract_id)
  )
  with check (org_id = app.active_org_id());

create policy signature_requests_select on signature_requests for select to authenticated
  using (
    org_id = app.active_org_id()
    and exists (select 1 from contracts c where c.id = signature_requests.contract_id)
  );
create policy signature_requests_insert on signature_requests for insert to authenticated
  with check (org_id = app.active_org_id() and app.has_permission(org_id, 'contract:send:org'));

create policy signature_events_select on signature_events for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'contract', 'read'));

-- Webhook rows are written and drained by service_role only. Legal/admin users
-- may read them for troubleshooting; nobody may write them from a request path.
create policy webhook_events_select on webhook_events for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'audit', 'read'));

revoke insert, update, delete on webhook_events from authenticated;
revoke update, delete on signature_events from authenticated;
