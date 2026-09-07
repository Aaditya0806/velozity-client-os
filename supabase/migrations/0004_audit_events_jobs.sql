-- =============================================================================
-- 0004_audit_events_jobs.sql
-- The cross-cutting infrastructure every domain module writes through:
-- the immutable audit log, the domain event outbox, the polymorphic activity
-- timeline, notifications, the job queue and idempotency keys.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- AUDIT LOG  (append-only, no UPDATE, no DELETE, ever)
-- -----------------------------------------------------------------------------
create table audit_log (
  id             bigserial primary key,
  org_id         uuid references organizations (id) on delete restrict,
  occurred_at    timestamptz not null default now(),
  -- Dotted action name, e.g. contract.sent, role.granted, auth.login_failed.
  action         text not null,
  category       text not null
                   check (category in (
                     'auth', 'permission', 'state_change', 'contract', 'proposal',
                     'document', 'payment', 'ai', 'automation', 'legal_override',
                     'user_admin', 'admin', 'security', 'data_access'
                   )),
  severity       text not null default 'info'
                   check (severity in ('info', 'notice', 'warning', 'critical')),
  actor_user_id  uuid references user_profiles (id) on delete set null,
  actor_type     text not null default 'user'
                   check (actor_type in ('user', 'system', 'automation', 'provider', 'ai')),
  actor_label    text,
  entity_type    text,
  entity_id      uuid,
  -- Human-readable summary rendered in the audit UI.
  summary        text not null default '',
  before_state   jsonb,
  after_state    jsonb,
  metadata       jsonb not null default '{}'::jsonb,
  reason         text,
  ip_address     inet,
  user_agent     text,
  request_id     text
);

comment on table audit_log is
  'Immutable, append-only compliance record. UPDATE and DELETE are blocked by trigger and by privilege.';

create index audit_log_org_time_idx    on audit_log (org_id, occurred_at desc);
create index audit_log_entity_idx      on audit_log (entity_type, entity_id, occurred_at desc);
create index audit_log_actor_idx       on audit_log (actor_user_id, occurred_at desc);
create index audit_log_category_idx    on audit_log (org_id, category, occurred_at desc);
create index audit_log_action_idx      on audit_log (org_id, action, occurred_at desc);

create trigger audit_log_no_update before update on audit_log
  for each statement execute function app.forbid_mutation();
create trigger audit_log_no_delete before delete on audit_log
  for each statement execute function app.forbid_mutation();

alter table audit_log enable row level security;
alter table audit_log force row level security;

create policy audit_log_select on audit_log for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'audit', 'read'));

-- Any authenticated actor may append to their own org's log; nobody may amend it.
create policy audit_log_insert on audit_log for insert to authenticated
  with check (org_id is null or app.is_org_member(org_id));

revoke update, delete on audit_log from authenticated;
revoke update, delete on audit_log from service_role;

-- -----------------------------------------------------------------------------
-- DOMAIN EVENTS (outbox)
--
-- Written in the same transaction as the state change that produced them, then
-- fanned out asynchronously to the timeline, notifications and automations.
-- -----------------------------------------------------------------------------
create table events (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  name          text not null,
  version       int not null default 1,
  entity_type   text not null,
  entity_id     uuid,
  actor_user_id uuid references user_profiles (id) on delete set null,
  actor_type    text not null default 'user'
                  check (actor_type in ('user', 'system', 'automation', 'provider', 'ai')),
  payload       jsonb not null default '{}'::jsonb,
  request_id    text,
  occurred_at   timestamptz not null default now(),
  -- Outbox dispatch bookkeeping.
  status        text not null default 'pending'
                  check (status in ('pending', 'processing', 'processed', 'failed')),
  attempts      int not null default 0,
  last_error    text,
  processed_at  timestamptz
);

create index events_org_time_idx  on events (org_id, occurred_at desc);
create index events_entity_idx    on events (entity_type, entity_id, occurred_at desc);
create index events_name_idx      on events (org_id, name, occurred_at desc);
create index events_dispatch_idx  on events (status, occurred_at) where status in ('pending', 'failed');

alter table events enable row level security;
alter table events force row level security;

create policy events_select on events for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'audit', 'read'));

create policy events_insert on events for insert to authenticated
  with check (app.is_org_member(org_id));

-- -----------------------------------------------------------------------------
-- ACTIVITIES (one polymorphic timeline for the whole product)
-- -----------------------------------------------------------------------------
create table activities (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  entity_type   text not null,
  entity_id     uuid not null,
  -- Secondary anchor so a task activity also surfaces on the company timeline.
  company_id    uuid,
  activity_type text not null
                  check (activity_type in (
                    'created', 'updated', 'deleted', 'state_changed', 'note',
                    'call', 'meeting', 'email', 'comment', 'assignment',
                    'document', 'contract', 'proposal', 'payment', 'system',
                    'ai', 'automation'
                  )),
  title         text not null,
  body          text,
  -- Internal notes are hidden from anyone without `internal_note:read` and are
  -- excluded from every portal view.
  is_internal   boolean not null default false,
  actor_user_id uuid references user_profiles (id) on delete set null,
  actor_type    text not null default 'user'
                  check (actor_type in ('user', 'system', 'automation', 'provider', 'ai')),
  metadata      jsonb not null default '{}'::jsonb,
  event_id      uuid references events (id) on delete set null,
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index activities_entity_idx on activities (org_id, entity_type, entity_id, occurred_at desc)
  where deleted_at is null;
create index activities_company_idx on activities (org_id, company_id, occurred_at desc)
  where deleted_at is null and company_id is not null;
create index activities_actor_idx  on activities (org_id, actor_user_id, occurred_at desc);

create trigger activities_touch before update on activities
  for each row execute function app.touch_updated_at();

alter table activities enable row level security;
alter table activities force row level security;

create policy activities_select on activities for select to authenticated
  using (
    deleted_at is null
    and org_id = app.active_org_id()
    and (not is_internal or app.can(org_id, 'internal_note', 'read'))
  );

create policy activities_insert on activities for insert to authenticated
  with check (app.is_org_member(org_id));

create policy activities_update on activities for update to authenticated
  using (org_id = app.active_org_id() and actor_user_id = app.current_user_id())
  with check (org_id = app.active_org_id());

-- -----------------------------------------------------------------------------
-- NOTIFICATIONS
-- -----------------------------------------------------------------------------
create table notifications (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete cascade,
  user_id      uuid not null references user_profiles (id) on delete cascade,
  category     text not null
                 check (category in (
                   'assignment', 'contract', 'approval', 'task', 'automation',
                   'proposal', 'payment', 'system', 'mention', 'security'
                 )),
  title        text not null,
  body         text,
  entity_type  text,
  entity_id    uuid,
  link_url     text,
  priority     text not null default 'normal'
                 check (priority in ('low', 'normal', 'high', 'urgent')),
  read_at      timestamptz,
  archived_at  timestamptz,
  event_id     uuid references events (id) on delete set null,
  -- Prevents duplicate notifications from a retried job.
  dedupe_key   text,
  created_at   timestamptz not null default now()
);

create index notifications_user_idx on notifications (user_id, created_at desc)
  where archived_at is null;
create index notifications_unread_idx on notifications (user_id) where read_at is null and archived_at is null;
create unique index notifications_dedupe_idx on notifications (user_id, dedupe_key)
  where dedupe_key is not null;

alter table notifications enable row level security;
alter table notifications force row level security;

create policy notifications_select on notifications for select to authenticated
  using (user_id = app.current_user_id() and org_id = app.active_org_id());

create policy notifications_update on notifications for update to authenticated
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

create policy notifications_insert on notifications for insert to authenticated
  with check (app.is_org_member(org_id));

create table notification_preferences (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  user_id     uuid not null references user_profiles (id) on delete cascade,
  category    text not null,
  in_app      boolean not null default true,
  email       boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint notification_preferences_unique unique (org_id, user_id, category)
);

create trigger notification_preferences_touch before update on notification_preferences
  for each row execute function app.touch_updated_at();

alter table notification_preferences enable row level security;
alter table notification_preferences force row level security;

create policy notification_preferences_all on notification_preferences for all to authenticated
  using (user_id = app.current_user_id() and org_id = app.active_org_id())
  with check (user_id = app.current_user_id() and org_id = app.active_org_id());

-- -----------------------------------------------------------------------------
-- JOB QUEUE
--
-- A plain PostgreSQL queue drained with SELECT ... FOR UPDATE SKIP LOCKED.
-- Keeping the queue in the same database as the business data means a job is
-- enqueued in the very transaction that produced it - no lost work, no
-- two-phase commit, and the whole thing is inspectable with SQL.
-- -----------------------------------------------------------------------------
create table jobs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid references organizations (id) on delete cascade,
  queue         text not null default 'default',
  job_type      text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'queued'
                  check (status in ('queued', 'running', 'completed', 'failed', 'cancelled', 'dead')),
  priority      int not null default 100,
  run_at        timestamptz not null default now(),
  attempts      int not null default 0,
  max_attempts  int not null default 5,
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  result        jsonb,
  -- Collapses duplicate enqueues of the same logical work.
  singleton_key text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create index jobs_poll_idx on jobs (queue, status, run_at, priority)
  where status in ('queued', 'failed');
create index jobs_org_idx on jobs (org_id, created_at desc);
create unique index jobs_singleton_idx on jobs (singleton_key)
  where singleton_key is not null and status in ('queued', 'running');

create trigger jobs_touch before update on jobs
  for each row execute function app.touch_updated_at();

alter table jobs enable row level security;
alter table jobs force row level security;

-- Jobs are drained by service_role workers. Users may only observe them.
create policy jobs_select on jobs for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'automation', 'read'));

-- -----------------------------------------------------------------------------
-- IDEMPOTENCY KEYS
--
-- Required on every endpoint with an external side effect (sending a contract,
-- creating a signature request, recording a payment).
-- -----------------------------------------------------------------------------
create table idempotency_keys (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  user_id        uuid references user_profiles (id) on delete set null,
  key            text not null,
  endpoint       text not null,
  -- SHA-256 of the request body: replaying a key with a different body is a
  -- client bug and must be rejected rather than silently served a stale result.
  request_hash   text not null,
  status         text not null default 'in_progress'
                   check (status in ('in_progress', 'completed', 'failed')),
  response_status int,
  response_body  jsonb,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  expires_at     timestamptz not null default (now() + interval '24 hours'),
  constraint idempotency_keys_unique unique (org_id, endpoint, key)
);

create index idempotency_keys_expiry_idx on idempotency_keys (expires_at);

alter table idempotency_keys enable row level security;
alter table idempotency_keys force row level security;

create policy idempotency_keys_all on idempotency_keys for all to authenticated
  using (org_id = app.active_org_id())
  with check (org_id = app.active_org_id());

-- -----------------------------------------------------------------------------
-- FX RATES
--
-- Rates are captured at transaction time and stored on the transaction itself;
-- this table is the lookup source, never the source of truth for a historical
-- report.
-- -----------------------------------------------------------------------------
create table fx_rates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid references organizations (id) on delete cascade,
  base_currency char(3) not null check (base_currency ~ '^[A-Z]{3}$'),
  quote_currency char(3) not null check (quote_currency ~ '^[A-Z]{3}$'),
  rate          numeric(18, 8) not null check (rate > 0),
  as_of         date not null,
  source        text not null default 'manual',
  created_at    timestamptz not null default now(),
  constraint fx_rates_unique unique (org_id, base_currency, quote_currency, as_of),
  constraint fx_rates_distinct_currencies check (base_currency <> quote_currency)
);

create index fx_rates_lookup_idx on fx_rates (base_currency, quote_currency, as_of desc);

alter table fx_rates enable row level security;
alter table fx_rates force row level security;

create policy fx_rates_select on fx_rates for select to authenticated
  using (org_id is null or org_id = app.active_org_id());

create policy fx_rates_write on fx_rates for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'finance', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'finance', 'manage'));

-- Most recent rate on or before a given date. NULL when no rate is available -
-- callers must treat that as an error rather than defaulting to 1.
create or replace function app.fx_rate_at(
  p_org uuid, p_from char(3), p_to char(3), p_on date
)
returns numeric
language sql
stable
as $$
  select case
    when p_from = p_to then 1::numeric
    else (
      select r.rate
      from fx_rates r
      where r.base_currency = p_from
        and r.quote_currency = p_to
        and r.as_of <= p_on
        and (r.org_id = p_org or r.org_id is null)
      order by r.as_of desc, (r.org_id is not null) desc
      limit 1
    )
  end
$$;
