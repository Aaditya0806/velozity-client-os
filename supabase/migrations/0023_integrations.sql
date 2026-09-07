-- =============================================================================
-- 0023_integrations.sql
-- Outbound channels: Slack, WhatsApp, and whatever comes next.
--
-- Phase 1 notifications were in-app only, which is fine for someone already in
-- the product and useless for a contract expiring while nobody is looking at
-- it. This adds a place to record a connection and a delivery, without
-- promising that any particular provider is configured.
--
-- Two rules shape the schema:
--
--   1. Credentials are not stored here in plain text. The `secret_ref` names a
--      key in the deployment's secret store; a token that has never been in the
--      database cannot be read out of a backup.
--
--   2. A delivery is recorded before it is attempted and updated afterwards, so
--      a message that vanished into a provider outage leaves a trace. "We think
--      we sent it" is not the same as "it was sent".
-- =============================================================================

create table integration_connections (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,

  provider      text not null
                  check (provider in ('slack', 'whatsapp', 'gmail', 'microsoft')),
  -- What this connection is for. A Slack connection used for alerts is a
  -- different thing from one used for a shared client channel.
  purpose       text not null default 'notifications'
                  check (purpose in ('notifications', 'mailbox')),

  display_name  text not null,
  -- Non-secret settings: a channel id, a phone number id, a mailbox address.
  config        jsonb not null default '{}'::jsonb,
  -- Names a key in the deployment's secret store. Never a token itself.
  secret_ref    text,

  status        text not null default 'inactive'
                  check (status in ('inactive', 'active', 'error', 'revoked')),
  last_error    text,
  last_used_at  timestamptz,
  -- For mailbox connections: how far the sync has read.
  sync_cursor   text,
  last_synced_at timestamptz,

  created_by    uuid references user_profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint integration_connections_name_unique unique (org_id, provider, display_name)
);

create index integration_connections_active_idx
  on integration_connections (org_id, provider)
  where deleted_at is null and status = 'active';

create trigger integration_connections_touch before update on integration_connections
  for each row execute function app.touch_updated_at();

alter table integration_connections enable row level security;
alter table integration_connections force row level security;

-- Reading a connection means reading which channel alerts go to — an
-- administrative concern, not a general one.
create policy integration_connections_select on integration_connections
  for select to authenticated
  using (
    deleted_at is null
    and org_id = app.active_org_id()
    and app.can(org_id, 'settings', 'manage')
  );

create policy integration_connections_write on integration_connections
  for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'settings', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'settings', 'manage'));

-- -----------------------------------------------------------------------------
-- Deliveries
-- -----------------------------------------------------------------------------

create table channel_deliveries (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  connection_id uuid not null references integration_connections (id) on delete cascade,

  -- What prompted it, so a delivery can be traced back to a cause.
  notification_id uuid references notifications (id) on delete set null,
  event_id      uuid references events (id) on delete set null,

  recipient     text not null,
  subject       text,
  body          text not null,

  status        text not null default 'queued'
                  check (status in ('queued', 'sent', 'failed', 'skipped')),
  provider_message_id text,
  error         text,
  attempts      int not null default 0,

  -- One delivery per cause per channel, however many times a sweep runs.
  dedupe_key    text,

  queued_at     timestamptz not null default now(),
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),

  constraint channel_deliveries_dedupe unique (connection_id, dedupe_key)
);

create index channel_deliveries_pending_idx on channel_deliveries (status, queued_at)
  where status = 'queued';

alter table channel_deliveries enable row level security;
alter table channel_deliveries force row level security;

-- Append-only from the application's side: the worker writes these through the
-- service role, and staff read them to answer "was that actually delivered?".
create policy channel_deliveries_select on channel_deliveries for select to authenticated
  using (
    org_id = app.active_org_id() and app.can(org_id, 'settings', 'manage')
  );

grant select on integration_connections, channel_deliveries to authenticated;
grant insert, update, delete on integration_connections to authenticated;
grant select, insert, update on channel_deliveries to service_role;
grant select, insert, update, delete on integration_connections to service_role;

-- -----------------------------------------------------------------------------
-- Queueing a delivery
-- -----------------------------------------------------------------------------

-- Records the intent to send. The worker performs the send; this only says a
-- message is owed, and dedupes so a repeated sweep does not repeat the message.
create or replace function app.queue_channel_delivery(
  p_org        uuid,
  p_connection uuid,
  p_recipient  text,
  p_body       text,
  p_subject    text default null,
  p_dedupe_key text default null,
  p_notification uuid default null,
  p_event      uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_id uuid;
begin
  -- An inactive or deleted connection is not an error worth failing a caller
  -- for; there is simply nowhere to send. The absence is recorded by returning
  -- null rather than by raising into an unrelated transaction.
  if not exists (
    select 1 from public.integration_connections
     where id = p_connection and org_id = p_org
       and deleted_at is null and status = 'active'
  ) then
    return null;
  end if;

  insert into public.channel_deliveries
    (org_id, connection_id, recipient, body, subject, dedupe_key, notification_id, event_id)
  values
    (p_org, p_connection, p_recipient, p_body, p_subject, p_dedupe_key, p_notification, p_event)
  on conflict (connection_id, dedupe_key) do nothing
  returning id into v_id;

  return v_id;
end
$$;

revoke all on function app.queue_channel_delivery(uuid, uuid, text, text, text, text, uuid, uuid)
  from public, anon;
grant execute on function app.queue_channel_delivery(uuid, uuid, text, text, text, text, uuid, uuid)
  to authenticated, service_role;
