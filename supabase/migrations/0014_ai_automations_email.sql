-- =============================================================================
-- 0014_ai_automations_email.sql
-- The AI action framework, the automation engine, and outbound email.
--
-- The governing rule for both AI and automations: neither may perform a
-- consequential act directly. AI proposes an ai_action that a human approves.
-- Automations may draft an email but there is no send_email action anywhere in
-- the enumeration, so nothing leaves the building without a person deciding.
-- =============================================================================

-- =============================================================================
-- AI ACTIONS
-- =============================================================================
create table ai_actions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,

  action_type    text not null
                   check (action_type in (
                     'draft_diagnosis', 'draft_proposal_section', 'draft_email',
                     'suggest_contract_variables', 'summarize_discovery',
                     'extract_meeting_notes', 'suggest_tasks', 'suggest_kpis',
                     'draft_client_report', 'classify_activity'
                   )),

  entity_type    text not null,
  entity_id      uuid,
  company_id     uuid references companies (id) on delete cascade,

  status         text not null default 'pending_approval'
                   check (status in ('generating', 'pending_approval', 'approved',
                                     'rejected', 'executed', 'failed', 'expired', 'cancelled')),

  -- What the model proposed, validated against a Zod/JSON schema before it was
  -- ever written here. Anything outside the schema was rejected upstream.
  proposed_payload jsonb not null default '{}'::jsonb,
  -- What the human actually approved, if they edited it.
  approved_payload jsonb,
  -- Structured provenance: claim types, tool calls, source ids.
  provenance     jsonb not null default '{}'::jsonb,

  model          text not null,
  prompt_version text not null,
  -- The exact rendered system/user prompt hashes, for reproducibility. The
  -- prompt text itself is not stored to avoid duplicating client PII.
  prompt_hash    text,
  input_tokens   int not null default 0,
  output_tokens  int not null default 0,
  cost_usd       numeric(12, 6) not null default 0,
  latency_ms     int,

  requested_by   uuid references user_profiles (id) on delete set null,
  requested_at   timestamptz not null default now(),
  approved_by    uuid references user_profiles (id) on delete set null,
  approved_at    timestamptz,
  rejected_by    uuid references user_profiles (id) on delete set null,
  rejected_at    timestamptz,
  rejection_reason text,
  executed_at    timestamptz,
  execution_result jsonb,
  error          text,
  expires_at     timestamptz not null default (now() + interval '7 days'),

  request_id     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint ai_actions_approval_pair check ((approved_at is null) = (approved_by is null)),
  constraint ai_actions_rejection_reason check (rejected_at is null or rejection_reason is not null),
  -- Execution is only ever reached through approval.
  constraint ai_actions_executed_requires_approval
    check (executed_at is null or approved_at is not null)
);

create index ai_actions_org_status_idx on ai_actions (org_id, status, requested_at desc);
create index ai_actions_entity_idx     on ai_actions (entity_type, entity_id);
create index ai_actions_pending_idx    on ai_actions (org_id, requested_at desc) where status = 'pending_approval';

create trigger ai_actions_touch before update on ai_actions
  for each row execute function app.touch_updated_at();

alter table diagnoses
  add constraint diagnoses_ai_action_fk
  foreign key (ai_action_id) references ai_actions (id) on delete set null;

-- The approver must be a different consideration from the requester only where
-- the action is legally consequential; for drafting work self-approval is fine.
-- What is never fine is executing an action nobody approved.
create or replace function app.assert_ai_action_flow()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'approved' and old.status <> 'approved' then
    if new.approved_by is null then
      raise exception 'Approving an AI action must record the approver'
        using errcode = '23514', hint = 'AI_APPROVER_REQUIRED';
    end if;
    if old.status <> 'pending_approval' then
      raise exception 'Only a pending AI action can be approved (was %)', old.status
        using errcode = '23514', hint = 'AI_ACTION_NOT_PENDING';
    end if;
  end if;

  if new.status = 'executed' and old.status <> 'executed' then
    if old.status <> 'approved' then
      raise exception 'An AI action must be approved before it is executed (was %)', old.status
        using errcode = '42501', hint = 'AI_ACTION_NOT_APPROVED';
    end if;
    new.executed_at := coalesce(new.executed_at, now());
  end if;

  return new;
end
$$;

create trigger ai_actions_flow_guard
  before update on ai_actions
  for each row execute function app.assert_ai_action_flow();

-- -----------------------------------------------------------------------------
-- AI Command Centre conversations
-- -----------------------------------------------------------------------------
create table ai_conversations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations (id) on delete cascade,
  user_id    uuid not null references user_profiles (id) on delete cascade,
  title      text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index ai_conversations_user_idx on ai_conversations (org_id, user_id, updated_at desc)
  where deleted_at is null;

create trigger ai_conversations_touch before update on ai_conversations
  for each row execute function app.touch_updated_at();

create table ai_messages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete cascade,
  conversation_id uuid not null references ai_conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant', 'tool')),
  content         text not null default '',
  -- Which read tools ran and with what arguments, so the answer can show its
  -- sources. [{ tool, params, row_count, duration_ms }]
  tool_calls      jsonb not null default '[]'::jsonb,
  model           text,
  input_tokens    int not null default 0,
  output_tokens   int not null default 0,
  cost_usd        numeric(12, 6) not null default 0,
  error           text,
  created_at      timestamptz not null default now()
);

create index ai_messages_conversation_idx on ai_messages (conversation_id, created_at);

-- =============================================================================
-- AUTOMATIONS
-- =============================================================================
create table automations (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  name          text not null,
  description   text,
  is_active     boolean not null default false,

  -- WHEN: the event that starts the automation, plus an optional narrowing
  -- filter such as { "to": "won" }.
  trigger_event text not null,
  trigger_filter jsonb not null default '{}'::jsonb,

  -- IF: [{ path, op, value }] evaluated against the input snapshot.
  conditions    jsonb not null default '[]'::jsonb,

  -- THEN: [{ type, params }] where type is drawn from a closed enumeration.
  -- There is deliberately no send_email action.
  actions       jsonb not null default '[]'::jsonb,

  -- Loop protection.
  max_depth     int not null default 5 check (max_depth between 1 and 5),
  cooldown_seconds int not null default 60 check (cooldown_seconds >= 0),

  run_count     int not null default 0,
  last_run_at   timestamptz,
  last_error    text,

  is_demo       boolean not null default false,
  created_by    uuid references user_profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint automations_actions_not_empty check (jsonb_array_length(actions) > 0)
);

create index automations_trigger_idx on automations (org_id, trigger_event)
  where is_active and deleted_at is null;

create trigger automations_touch before update on automations
  for each row execute function app.touch_updated_at();

create table automation_runs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  automation_id uuid not null references automations (id) on delete cascade,
  event_id      uuid references events (id) on delete set null,

  entity_type   text,
  entity_id     uuid,

  status        text not null default 'pending'
                  check (status in ('pending', 'running', 'conditions_failed',
                                    'succeeded', 'partially_failed', 'failed',
                                    'skipped_cooldown', 'skipped_depth')),

  -- Exactly what the conditions were evaluated against.
  input_snapshot jsonb not null default '{}'::jsonb,
  condition_results jsonb not null default '[]'::jsonb,

  -- Chain depth; a run triggered by an event that an automation produced is
  -- one level deeper. Beyond max_depth the run is refused.
  depth         int not null default 0,
  parent_run_id uuid references automation_runs (id) on delete set null,

  started_at    timestamptz,
  finished_at   timestamptz,
  duration_ms   int,
  error         text,
  created_at    timestamptz not null default now()
);

create index automation_runs_automation_idx on automation_runs (automation_id, created_at desc);
create index automation_runs_entity_idx on automation_runs (org_id, entity_type, entity_id, created_at desc);
create index automation_runs_cooldown_idx on automation_runs (automation_id, entity_id, created_at desc);

create table automation_action_results (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  run_id        uuid not null references automation_runs (id) on delete cascade,
  action_index  int not null,
  action_type   text not null,
  status        text not null check (status in ('succeeded', 'failed', 'skipped')),
  params        jsonb not null default '{}'::jsonb,
  result        jsonb,
  error         text,
  attempts      int not null default 1,
  duration_ms   int,
  created_at    timestamptz not null default now(),
  constraint automation_action_results_unique unique (run_id, action_index)
);

create index automation_action_results_run_idx on automation_action_results (run_id, action_index);

-- Retrigger suppression: has this automation already run for this entity inside
-- the cooldown window?
create or replace function app.automation_in_cooldown(
  p_automation uuid, p_entity uuid, p_seconds int
)
returns boolean
language sql
stable
as $$
  select p_seconds > 0 and exists (
    select 1 from automation_runs r
    where r.automation_id = p_automation
      and r.entity_id is not distinct from p_entity
      and r.status not in ('skipped_cooldown', 'skipped_depth')
      and r.created_at > now() - make_interval(secs => p_seconds)
  )
$$;

comment on function app.automation_in_cooldown is
  'Loop protection: prevents the same automation firing repeatedly on one entity.';

-- =============================================================================
-- EMAIL (outbound only in Phase 1)
-- =============================================================================
create table email_templates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  key           citext not null,
  name          text not null,
  category      text not null default 'general'
                  check (category in ('general', 'proposal', 'contract', 'onboarding',
                                      'report', 'reminder', 'notification')),
  description   text,
  is_active     boolean not null default true,
  current_version_id uuid,
  is_demo       boolean not null default false,
  created_by    uuid references user_profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint email_templates_key_unique unique (org_id, key)
);

create trigger email_templates_touch before update on email_templates
  for each row execute function app.touch_updated_at();

create table email_template_versions (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete cascade,
  template_id  uuid not null references email_templates (id) on delete cascade,
  version_no   int not null check (version_no >= 1),
  subject      text not null,
  body_html    text not null,
  body_text    text,
  variables    jsonb not null default '[]'::jsonb,
  status       text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  created_by   uuid references user_profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint email_template_versions_unique unique (template_id, version_no)
);

create trigger email_template_versions_touch before update on email_template_versions
  for each row execute function app.touch_updated_at();

alter table email_templates
  add constraint email_templates_current_version_fk
  foreign key (current_version_id) references email_template_versions (id) on delete set null;

create table email_messages (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  company_id    uuid references companies (id) on delete set null,
  contact_id    uuid references contacts (id) on delete set null,
  entity_type   text,
  entity_id     uuid,

  template_version_id uuid references email_template_versions (id) on delete set null,
  provider      text not null default 'resend' check (provider in ('resend', 'ses', 'noop')),
  provider_message_id text,

  from_email    citext not null,
  from_name     text,
  reply_to      citext,
  to_emails     citext[] not null check (array_length(to_emails, 1) >= 1),
  cc_emails     citext[] not null default '{}',
  bcc_emails    citext[] not null default '{}',

  subject       text not null,
  body_html     text not null,
  body_text     text,

  status        text not null default 'draft'
                  check (status in ('draft', 'queued', 'sending', 'sent', 'delivered',
                                    'bounced', 'complained', 'failed', 'cancelled')),
  -- Drafts produced by AI or automations wait here for a person.
  requires_approval boolean not null default false,
  approved_by   uuid references user_profiles (id) on delete set null,
  approved_at   timestamptz,

  queued_at     timestamptz,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  -- Opens are indicative, never authoritative: image proxies and privacy
  -- settings make them unreliable, so nothing in the product gates on them.
  first_opened_at timestamptz,
  open_count    int not null default 0,
  first_clicked_at timestamptz,
  click_count   int not null default 0,
  bounced_at    timestamptz,
  bounce_type   text,
  error         text,

  ai_action_id  uuid references ai_actions (id) on delete set null,
  idempotency_key text,

  is_demo       boolean not null default false,
  created_by    uuid references user_profiles (id) on delete set null,
  sent_by       uuid references user_profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint email_messages_send_requires_approval
    check (status = 'draft' or not requires_approval or approved_at is not null)
);

create index email_messages_org_idx     on email_messages (org_id, created_at desc);
create index email_messages_company_idx on email_messages (org_id, company_id, created_at desc);
create index email_messages_entity_idx  on email_messages (entity_type, entity_id);
create index email_messages_status_idx  on email_messages (org_id, status);
create unique index email_messages_provider_idx on email_messages (provider, provider_message_id)
  where provider_message_id is not null;
create unique index email_messages_idempotency_idx on email_messages (org_id, idempotency_key)
  where idempotency_key is not null;

create trigger email_messages_touch before update on email_messages
  for each row execute function app.touch_updated_at();

create table email_events (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  message_id    uuid not null references email_messages (id) on delete cascade,
  webhook_event_id uuid references webhook_events (id) on delete set null,
  event_type    text not null
                  check (event_type in ('queued', 'sent', 'delivered', 'opened', 'clicked',
                                        'bounced', 'complained', 'delivery_delayed', 'failed')),
  url           text,
  user_agent    text,
  ip_address    inet,
  occurred_at   timestamptz not null default now(),
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index email_events_message_idx on email_events (message_id, occurred_at);

create trigger email_events_no_update before update on email_events
  for each statement execute function app.forbid_mutation();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table ai_actions enable row level security;        alter table ai_actions force row level security;
alter table ai_conversations enable row level security;  alter table ai_conversations force row level security;
alter table ai_messages enable row level security;       alter table ai_messages force row level security;
alter table automations enable row level security;       alter table automations force row level security;
alter table automation_runs enable row level security;   alter table automation_runs force row level security;
alter table automation_action_results enable row level security;
alter table automation_action_results force row level security;
alter table email_templates enable row level security;   alter table email_templates force row level security;
alter table email_template_versions enable row level security;
alter table email_template_versions force row level security;
alter table email_messages enable row level security;    alter table email_messages force row level security;
alter table email_events enable row level security;      alter table email_events force row level security;

create policy ai_actions_select on ai_actions for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'ai', 'read'));
create policy ai_actions_insert on ai_actions for insert to authenticated
  with check (org_id = app.active_org_id() and app.can(org_id, 'ai', 'use'));
create policy ai_actions_update on ai_actions for update to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'ai', 'approve'))
  with check (org_id = app.active_org_id());

create policy ai_conversations_all on ai_conversations for all to authenticated
  using (org_id = app.active_org_id() and user_id = app.current_user_id())
  with check (org_id = app.active_org_id() and user_id = app.current_user_id());

create policy ai_messages_all on ai_messages for all to authenticated
  using (org_id = app.active_org_id()
         and exists (select 1 from ai_conversations c
                     where c.id = ai_messages.conversation_id and c.user_id = app.current_user_id()))
  with check (org_id = app.active_org_id());

create policy automations_select on automations for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id() and app.can(org_id, 'automation', 'read'));
create policy automations_write on automations for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'automation', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'automation', 'manage'));

create policy automation_runs_select on automation_runs for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'automation', 'read'));
create policy automation_action_results_select on automation_action_results for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'automation', 'read'));

create policy email_templates_select on email_templates for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id() and app.can(org_id, 'email', 'read'));
create policy email_templates_write on email_templates for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'email', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'email', 'manage'));

create policy email_template_versions_select on email_template_versions for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'email', 'read'));
create policy email_template_versions_write on email_template_versions for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'email', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'email', 'manage'));

create policy email_messages_select on email_messages for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'email', 'read'));
create policy email_messages_insert on email_messages for insert to authenticated
  with check (org_id = app.active_org_id() and app.can(org_id, 'email', 'draft'));
create policy email_messages_update on email_messages for update to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'email', 'draft'))
  with check (org_id = app.active_org_id());

create policy email_events_select on email_events for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'email', 'read'));

revoke update, delete on email_events from authenticated;
revoke insert, update, delete on automation_runs from authenticated;
revoke insert, update, delete on automation_action_results from authenticated;
