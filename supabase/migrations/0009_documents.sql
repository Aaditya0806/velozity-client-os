-- =============================================================================
-- 0009_documents.sql
-- The document centre: versioned, hashed, never overwritten, always private.
--
-- Files live in a private Supabase Storage bucket. The database holds the
-- metadata, the version chain and the SHA-256 of every byte stream we have ever
-- stored, so a later download can be verified against what was written.
-- =============================================================================

create table documents (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations (id) on delete cascade,

  -- Association. A document usually belongs to a company; the other anchors
  -- narrow it to a deal, a contract or a project.
  company_id         uuid references companies (id) on delete cascade,
  opportunity_id     uuid references opportunities (id) on delete set null,
  contract_id        uuid,
  project_id         uuid,
  proposal_version_id uuid references proposal_versions (id) on delete set null,

  category           text not null default 'general'
                       check (category in ('general', 'discovery', 'proposal', 'contract',
                                           'executed_contract', 'invoice', 'report',
                                           'deliverable', 'onboarding', 'legal', 'other')),
  name               text not null check (length(btrim(name)) between 1 and 300),
  description        text,

  current_version_id uuid,
  version_count      int not null default 0,

  status             text not null default 'active'
                       check (status in ('active', 'archived', 'quarantined')),

  -- Executed contracts and anything else legally final. Enforced by trigger:
  -- an immutable document accepts no new versions and no content edits.
  is_immutable       boolean not null default false,
  -- Excluded from every portal view when false.
  is_client_visible  boolean not null default false,
  is_confidential    boolean not null default false,

  source             text not null default 'upload'
                       check (source in ('upload', 'generated', 'signature_provider', 'email', 'import')),
  tags               text[] not null default '{}',

  is_demo            boolean not null default false,
  created_by         uuid references user_profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_by         uuid references user_profiles (id) on delete set null
);

create index documents_org_idx        on documents (org_id) where deleted_at is null;
create index documents_company_idx    on documents (org_id, company_id) where deleted_at is null;
create index documents_contract_idx   on documents (contract_id) where deleted_at is null;
create index documents_project_idx    on documents (project_id) where deleted_at is null;
create index documents_category_idx   on documents (org_id, category) where deleted_at is null;
create index documents_name_trgm_idx  on documents using gin (name gin_trgm_ops);

create trigger documents_touch before update on documents
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Versions. Append-only by construction: there is no code path that overwrites
-- a storage object, and the table refuses UPDATE of the content columns.
-- -----------------------------------------------------------------------------
create table document_versions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  document_id   uuid not null references documents (id) on delete cascade,
  version_no    int not null check (version_no >= 1),

  -- orgs/{org_id}/clients/{company_id}/{category}/{document_id}/v{n}/{filename}
  storage_bucket text not null default 'documents',
  storage_path  text not null,
  file_name     text not null,
  mime_type     text not null default 'application/octet-stream',
  size_bytes    bigint not null check (size_bytes >= 0),

  -- Lowercase hex SHA-256 of the exact bytes stored. Verified on every download.
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),

  change_note   text,
  uploaded_by   uuid references user_profiles (id) on delete set null,
  created_at    timestamptz not null default now(),

  constraint document_versions_unique unique (document_id, version_no),
  constraint document_versions_path_unique unique (storage_bucket, storage_path)
);

create index document_versions_document_idx on document_versions (document_id, version_no desc);
create index document_versions_sha_idx on document_versions (org_id, sha256);

-- A stored version is a historical fact. Nothing about it may change.
create trigger document_versions_no_update before update on document_versions
  for each statement execute function app.forbid_mutation();

alter table documents
  add constraint documents_current_version_fk
  foreign key (current_version_id) references document_versions (id) on delete set null;

-- New versions are refused on an immutable document.
create or replace function app.assert_document_mutable()
returns trigger
language plpgsql
as $$
declare
  v_immutable boolean;
  v_deleted   timestamptz;
begin
  select is_immutable, deleted_at into v_immutable, v_deleted
  from documents where id = new.document_id;

  if v_immutable then
    raise exception 'Document % is immutable and cannot receive new versions', new.document_id
      using errcode = '42501', hint = 'DOCUMENT_IMMUTABLE';
  end if;
  if v_deleted is not null then
    raise exception 'Document % is deleted', new.document_id
      using errcode = '42501', hint = 'DOCUMENT_DELETED';
  end if;
  return new;
end
$$;

create trigger document_versions_immutability_guard
  before insert on document_versions
  for each row execute function app.assert_document_mutable();

-- Immutability is one-way: it can be set, never cleared.
create or replace function app.assert_immutability_not_revoked()
returns trigger
language plpgsql
as $$
begin
  if old.is_immutable and not new.is_immutable then
    raise exception 'Document immutability cannot be revoked'
      using errcode = '42501', hint = 'DOCUMENT_IMMUTABLE';
  end if;
  if old.is_immutable and new.current_version_id is distinct from old.current_version_id then
    raise exception 'The current version of an immutable document cannot change'
      using errcode = '42501', hint = 'DOCUMENT_IMMUTABLE';
  end if;
  -- Hard deletion of legally significant documents is not offered anywhere.
  if old.is_immutable and new.deleted_at is not null and old.deleted_at is null then
    raise exception 'An immutable document cannot be deleted'
      using errcode = '42501', hint = 'DOCUMENT_IMMUTABLE';
  end if;
  return new;
end
$$;

create trigger documents_immutability_guard
  before update on documents
  for each row execute function app.assert_immutability_not_revoked();

-- Keep the version counter and pointer coherent.
create or replace function app.sync_document_version_pointer()
returns trigger
language plpgsql
as $$
begin
  update documents
  set current_version_id = new.id,
      version_count = (select count(*) from document_versions where document_id = new.document_id)
  where id = new.document_id;
  return null;
end
$$;

create trigger document_versions_sync
  after insert on document_versions
  for each row execute function app.sync_document_version_pointer();

-- -----------------------------------------------------------------------------
-- Access log. Every signed-URL issue and every integrity check is recorded.
-- -----------------------------------------------------------------------------
create table document_access_log (
  id            bigserial primary key,
  org_id        uuid not null references organizations (id) on delete cascade,
  document_id   uuid not null references documents (id) on delete cascade,
  version_id    uuid references document_versions (id) on delete set null,
  user_id       uuid references user_profiles (id) on delete set null,
  action        text not null
                  check (action in ('url_issued', 'downloaded', 'viewed', 'uploaded',
                                    'deleted', 'restored', 'hash_verified', 'hash_mismatch')),
  ip_address    inet,
  user_agent    text,
  request_id    text,
  metadata      jsonb not null default '{}'::jsonb,
  occurred_at   timestamptz not null default now()
);

create index document_access_log_document_idx on document_access_log (document_id, occurred_at desc);
create index document_access_log_org_idx on document_access_log (org_id, occurred_at desc);

create trigger document_access_log_no_update before update on document_access_log
  for each statement execute function app.forbid_mutation();
create trigger document_access_log_no_delete before delete on document_access_log
  for each statement execute function app.forbid_mutation();

alter table documents enable row level security;
alter table documents force row level security;
alter table document_versions enable row level security;
alter table document_versions force row level security;
alter table document_access_log enable row level security;
alter table document_access_log force row level security;

-- Document visibility follows the company it belongs to, so a salesperson with
-- `own` scope on companies cannot read another rep's client files.
create policy documents_select on documents for select to authenticated
  using (
    deleted_at is null
    and org_id = app.active_org_id()
    and app.can(org_id, 'document', 'read')
    and (
      company_id is null
      or exists (
        select 1 from companies c
        where c.id = documents.company_id
          and app.can_row(c.org_id, 'company', 'read', c.owner_user_id, c.team_id)
      )
    )
    and (not is_confidential or app.can(org_id, 'document', 'read_confidential'))
  );

create policy documents_insert on documents for insert to authenticated
  with check (org_id = app.active_org_id() and app.can(org_id, 'document', 'create'));

create policy documents_update on documents for update to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'document', 'update'))
  with check (org_id = app.active_org_id());

create policy document_versions_select on document_versions for select to authenticated
  using (
    org_id = app.active_org_id()
    and exists (select 1 from documents d where d.id = document_versions.document_id)
  );

create policy document_versions_insert on document_versions for insert to authenticated
  with check (
    org_id = app.active_org_id()
    and app.can(org_id, 'document', 'create')
    and exists (select 1 from documents d where d.id = document_versions.document_id)
  );

revoke update, delete on document_versions from authenticated;

create policy document_access_log_select on document_access_log for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'audit', 'read'));

create policy document_access_log_insert on document_access_log for insert to authenticated
  with check (app.is_org_member(org_id));

revoke update, delete on document_access_log from authenticated;
