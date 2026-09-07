-- =============================================================================
-- 0012_projects_tasks_kpis.sql
-- Delivery: projects, workstreams, tasks, dependencies, deliverables and KPIs.
-- =============================================================================

create table projects (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  company_id     uuid not null references companies (id) on delete restrict,
  opportunity_id uuid references opportunities (id) on delete set null,
  contract_id    uuid references contracts (id) on delete set null,
  onboarding_id  uuid,

  code           text not null,
  name           text not null check (length(btrim(name)) between 1 and 200),
  description    text,

  status         text not null default 'not_started'
                   check (status in ('not_started', 'active', 'on_hold', 'delivered', 'closed', 'cancelled')),
  health         text not null default 'unknown'
                   check (health in ('unknown', 'on_track', 'at_risk', 'off_track')),
  health_note    text,
  health_updated_at timestamptz,

  start_date     date,
  target_end_date date,
  actual_end_date date,

  budget_amount  numeric(14, 2) check (budget_amount is null or budget_amount >= 0),
  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),
  -- Internal cost basis; gated behind `cost:read` wherever it is surfaced.
  cost_to_date   numeric(14, 2) not null default 0,

  manager_user_id uuid references user_profiles (id) on delete set null,
  team_id        uuid references teams (id) on delete set null,

  -- Client reporting cadence, driving the scheduled report jobs.
  reporting_cadence text not null default 'monthly'
                      check (reporting_cadence in ('none', 'weekly', 'fortnightly', 'monthly', 'quarterly')),
  next_report_due date,
  kickoff_at     timestamptz,

  on_hold_reason text,
  tags           text[] not null default '{}',
  internal_notes text,

  is_demo        boolean not null default false,
  created_by     uuid references user_profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,

  constraint projects_code_unique unique (org_id, code),
  constraint projects_dates check (target_end_date is null or start_date is null or target_end_date >= start_date),
  constraint projects_hold_reason check (status <> 'on_hold' or on_hold_reason is not null)
);

create index projects_org_status_idx on projects (org_id, status) where deleted_at is null;
create index projects_company_idx    on projects (org_id, company_id) where deleted_at is null;
create index projects_manager_idx    on projects (org_id, manager_user_id) where deleted_at is null;
create index projects_name_trgm_idx  on projects using gin (name gin_trgm_ops);

create trigger projects_touch before update on projects
  for each row execute function app.touch_updated_at();

create trigger projects_00_state_channel
  before update on projects
  for each row execute function app.guard_state_column('status');

-- Resolve the forward references left by earlier migrations.
alter table documents            add constraint documents_project_fk
  foreign key (project_id) references projects (id) on delete set null;
alter table contracts            add constraint contracts_project_fk
  foreign key (project_id) references projects (id) on delete set null;
alter table payment_requirements add constraint payment_requirements_project_fk
  foreign key (project_id) references projects (id) on delete set null;
alter table invoices             add constraint invoices_project_fk
  foreign key (project_id) references projects (id) on delete set null;
alter table payments             add constraint payments_project_fk
  foreign key (project_id) references projects (id) on delete set null;

-- Services delivered under a project. One project can span several services.
create table project_services (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null references projects (id) on delete cascade,
  service_id  uuid not null references services (id) on delete restrict,
  quantity    numeric(12, 2) not null default 1 check (quantity > 0),
  -- Snapshot of the sold price so delivery is judged against what was agreed.
  contracted_amount numeric(14, 2) not null default 0,
  currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
  created_at  timestamptz not null default now(),
  constraint project_services_unique unique (project_id, service_id)
);

create index project_services_project_idx on project_services (project_id);

-- -----------------------------------------------------------------------------
-- Workstreams
-- -----------------------------------------------------------------------------
create table workstreams (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null references projects (id) on delete cascade,
  service_id  uuid references services (id) on delete set null,
  name        text not null,
  description text,
  status      text not null default 'not_started'
                check (status in ('not_started', 'active', 'blocked', 'complete', 'cancelled')),
  owner_user_id uuid references user_profiles (id) on delete set null,
  start_date  date,
  end_date    date,
  position    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index workstreams_project_idx on workstreams (project_id, position) where deleted_at is null;

create trigger workstreams_touch before update on workstreams
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Tasks
-- -----------------------------------------------------------------------------
create table tasks (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete cascade,
  project_id      uuid references projects (id) on delete cascade,
  workstream_id   uuid references workstreams (id) on delete set null,
  company_id      uuid references companies (id) on delete set null,
  parent_task_id  uuid references tasks (id) on delete cascade,

  reference       text,
  title           text not null check (length(btrim(title)) between 1 and 300),
  description     text,

  status          text not null default 'todo'
                    check (status in ('todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled')),
  priority        text not null default 'medium'
                    check (priority in ('low', 'medium', 'high', 'urgent')),

  assignee_user_id uuid references user_profiles (id) on delete set null,
  created_by       uuid references user_profiles (id) on delete set null,
  team_id          uuid references teams (id) on delete set null,

  start_date      date,
  due_date        date,
  completed_at    timestamptz,
  blocked_reason  text,

  estimated_hours numeric(8, 2) check (estimated_hours is null or estimated_hours >= 0),
  actual_hours    numeric(8, 2) check (actual_hours is null or actual_hours >= 0),

  is_deliverable  boolean not null default false,
  is_milestone    boolean not null default false,
  is_client_visible boolean not null default false,

  position        int not null default 0,
  tags            text[] not null default '{}',

  is_demo         boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint tasks_not_own_parent check (parent_task_id is null or parent_task_id <> id),
  constraint tasks_blocked_reason check (status <> 'blocked' or blocked_reason is not null),
  constraint tasks_dates check (due_date is null or start_date is null or due_date >= start_date)
);

create index tasks_project_idx   on tasks (org_id, project_id, status) where deleted_at is null;
create index tasks_assignee_idx  on tasks (org_id, assignee_user_id, status) where deleted_at is null;
create index tasks_due_idx       on tasks (org_id, due_date) where deleted_at is null and status not in ('done', 'cancelled');
create index tasks_parent_idx    on tasks (parent_task_id) where deleted_at is null;
create index tasks_title_trgm_idx on tasks using gin (title gin_trgm_ops);

create trigger tasks_touch before update on tasks
  for each row execute function app.touch_updated_at();

create or replace function app.sync_task_completion()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'done' and coalesce(old.status, '') <> 'done' then
    new.completed_at := coalesce(new.completed_at, now());
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  if new.status <> 'blocked' then
    new.blocked_reason := null;
  end if;
  return new;
end
$$;

create trigger tasks_completion_sync
  before insert or update on tasks
  for each row execute function app.sync_task_completion();

-- Dependencies. A task may not be completed while a blocking predecessor is open.
create table task_dependencies (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations (id) on delete cascade,
  task_id           uuid not null references tasks (id) on delete cascade,
  depends_on_task_id uuid not null references tasks (id) on delete cascade,
  dependency_type   text not null default 'finish_to_start'
                      check (dependency_type in ('finish_to_start', 'start_to_start',
                                                 'finish_to_finish', 'start_to_finish')),
  created_at        timestamptz not null default now(),
  constraint task_dependencies_unique unique (task_id, depends_on_task_id),
  constraint task_dependencies_distinct check (task_id <> depends_on_task_id)
);

create index task_dependencies_task_idx on task_dependencies (task_id);
create index task_dependencies_depends_idx on task_dependencies (depends_on_task_id);

create or replace function app.assert_no_dependency_cycle()
returns trigger
language plpgsql
as $$
declare
  v_cycle boolean;
begin
  with recursive chain as (
    select new.depends_on_task_id as task_id, 1 as depth
    union all
    select d.depends_on_task_id, c.depth + 1
    from task_dependencies d
    join chain c on d.task_id = c.task_id
    where c.depth < 50
  )
  select exists (select 1 from chain where task_id = new.task_id) into v_cycle;

  if v_cycle then
    raise exception 'Task dependency would form a cycle'
      using errcode = '23514', hint = 'DEPENDENCY_CYCLE';
  end if;
  return new;
end
$$;

create trigger task_dependencies_cycle_guard
  before insert or update on task_dependencies
  for each row execute function app.assert_no_dependency_cycle();

create table task_comments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  task_id     uuid not null references tasks (id) on delete cascade,
  author_id   uuid references user_profiles (id) on delete set null,
  body        text not null check (length(btrim(body)) > 0),
  is_internal boolean not null default true,
  mentions    uuid[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index task_comments_task_idx on task_comments (task_id, created_at) where deleted_at is null;

create trigger task_comments_touch before update on task_comments
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Deliverables
-- -----------------------------------------------------------------------------
create table deliverables (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  project_id    uuid not null references projects (id) on delete cascade,
  workstream_id uuid references workstreams (id) on delete set null,
  task_id       uuid references tasks (id) on delete set null,
  document_id   uuid references documents (id) on delete set null,

  name          text not null,
  description   text,
  status        text not null default 'pending'
                  check (status in ('pending', 'in_progress', 'in_review', 'delivered', 'accepted', 'rejected')),
  due_date      date,
  delivered_at  timestamptz,
  accepted_at   timestamptz,
  accepted_by_contact_id uuid references contacts (id) on delete set null,
  rejection_reason text,
  is_client_visible boolean not null default true,
  position      int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint deliverables_rejection_reason check (status <> 'rejected' or rejection_reason is not null)
);

create index deliverables_project_idx on deliverables (project_id, position) where deleted_at is null;

create trigger deliverables_touch before update on deliverables
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- KPIs
-- -----------------------------------------------------------------------------
create table kpis (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  project_id    uuid references projects (id) on delete cascade,
  company_id    uuid not null references companies (id) on delete cascade,
  service_id    uuid references services (id) on delete set null,
  -- The catalogue definition this KPI was instantiated from, when applicable.
  source_definition_id uuid references service_default_kpis (id) on delete set null,

  name          text not null,
  description   text,
  unit          text not null default 'number'
                  check (unit in ('number', 'percent', 'currency', 'ratio', 'days', 'hours', 'score')),
  currency      char(3) check (currency is null or currency ~ '^[A-Z]{3}$'),
  direction     text not null default 'higher_is_better'
                  check (direction in ('higher_is_better', 'lower_is_better', 'target_band')),
  period        text not null default 'monthly'
                  check (period in ('weekly', 'monthly', 'quarterly', 'annual', 'project')),

  baseline_value numeric(18, 4),
  target_value  numeric(18, 4),
  target_min    numeric(18, 4),
  target_max    numeric(18, 4),
  -- Latest measurement, denormalised for list views.
  current_value numeric(18, 4),
  current_period_start date,
  status        text not null default 'not_started'
                  check (status in ('not_started', 'on_track', 'at_risk', 'off_track', 'achieved', 'missed')),

  owner_user_id uuid references user_profiles (id) on delete set null,
  is_client_visible boolean not null default true,
  notes         text,
  position      int not null default 0,

  is_demo       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint kpis_currency_when_money check (unit <> 'currency' or currency is not null),
  constraint kpis_band check (direction <> 'target_band' or (target_min is not null and target_max is not null))
);

create index kpis_project_idx on kpis (org_id, project_id, position) where deleted_at is null;
create index kpis_company_idx on kpis (org_id, company_id) where deleted_at is null;

create trigger kpis_touch before update on kpis
  for each row execute function app.touch_updated_at();

create table kpi_measurements (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete cascade,
  kpi_id       uuid not null references kpis (id) on delete cascade,
  period_start date not null,
  period_end   date not null,
  value        numeric(18, 4) not null,
  target_value numeric(18, 4),
  note         text,
  recorded_by  uuid references user_profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint kpi_measurements_unique unique (kpi_id, period_start),
  constraint kpi_measurements_period check (period_end >= period_start)
);

create index kpi_measurements_kpi_idx on kpi_measurements (kpi_id, period_start desc);

create trigger kpi_measurements_touch before update on kpi_measurements
  for each row execute function app.touch_updated_at();

-- Roll the newest measurement onto the KPI and re-derive its status.
create or replace function app.sync_kpi_current_value()
returns trigger
language plpgsql
as $$
declare
  v_kpi kpis%rowtype;
  v_latest kpi_measurements%rowtype;
  v_status text;
begin
  select * into v_kpi from kpis where id = coalesce(new.kpi_id, old.kpi_id);
  if not found then return null; end if;

  select * into v_latest from kpi_measurements
  where kpi_id = v_kpi.id order by period_start desc limit 1;

  if v_latest.id is null then
    update kpis set current_value = null, current_period_start = null, status = 'not_started'
    where id = v_kpi.id;
    return null;
  end if;

  v_status := case
    when v_kpi.direction = 'higher_is_better' and v_kpi.target_value is not null then
      case when v_latest.value >= v_kpi.target_value then 'achieved'
           when v_latest.value >= v_kpi.target_value * 0.9 then 'on_track'
           when v_latest.value >= v_kpi.target_value * 0.7 then 'at_risk'
           else 'off_track' end
    when v_kpi.direction = 'lower_is_better' and v_kpi.target_value is not null then
      case when v_latest.value <= v_kpi.target_value then 'achieved'
           when v_latest.value <= v_kpi.target_value * 1.1 then 'on_track'
           when v_latest.value <= v_kpi.target_value * 1.3 then 'at_risk'
           else 'off_track' end
    when v_kpi.direction = 'target_band' then
      case when v_latest.value between v_kpi.target_min and v_kpi.target_max then 'on_track'
           else 'at_risk' end
    else 'on_track'
  end;

  update kpis set
    current_value = v_latest.value,
    current_period_start = v_latest.period_start,
    status = v_status
  where id = v_kpi.id;

  return null;
end
$$;

create trigger kpi_measurements_sync
  after insert or update or delete on kpi_measurements
  for each row execute function app.sync_kpi_current_value();

-- -----------------------------------------------------------------------------
-- Client reports
-- -----------------------------------------------------------------------------
create table client_reports (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  company_id    uuid not null references companies (id) on delete cascade,
  project_id    uuid references projects (id) on delete cascade,
  title         text not null,
  period_start  date not null,
  period_end    date not null,
  status        text not null default 'draft'
                  check (status in ('draft', 'in_review', 'published', 'sent')),
  summary       text,
  -- Snapshot of the numbers as published, so a report never changes after the
  -- fact when underlying data moves.
  content       jsonb not null default '{}'::jsonb,
  document_id   uuid references documents (id) on delete set null,
  published_at  timestamptz,
  sent_at       timestamptz,
  created_by    uuid references user_profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint client_reports_period check (period_end >= period_start)
);

create index client_reports_company_idx on client_reports (org_id, company_id, period_end desc) where deleted_at is null;
create index client_reports_project_idx on client_reports (project_id, period_end desc) where deleted_at is null;

create trigger client_reports_touch before update on client_reports
  for each row execute function app.touch_updated_at();

-- A published report is a statement of record.
create or replace function app.assert_report_published_frozen()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('published', 'sent')
     and (new.content is distinct from old.content or new.summary is distinct from old.summary) then
    raise exception 'A published report cannot be edited'
      using errcode = '42501', hint = 'REPORT_PUBLISHED';
  end if;
  return new;
end
$$;

create trigger client_reports_frozen
  before update on client_reports
  for each row execute function app.assert_report_published_frozen();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table projects enable row level security;         alter table projects force row level security;
alter table project_services enable row level security; alter table project_services force row level security;
alter table workstreams enable row level security;      alter table workstreams force row level security;
alter table tasks enable row level security;            alter table tasks force row level security;
alter table task_dependencies enable row level security;alter table task_dependencies force row level security;
alter table task_comments enable row level security;    alter table task_comments force row level security;
alter table deliverables enable row level security;     alter table deliverables force row level security;
alter table kpis enable row level security;             alter table kpis force row level security;
alter table kpi_measurements enable row level security; alter table kpi_measurements force row level security;
alter table client_reports enable row level security;   alter table client_reports force row level security;

create policy projects_select on projects for select to authenticated
  using (deleted_at is null and app.can_row(org_id, 'project', 'read', manager_user_id, team_id));
create policy projects_insert on projects for insert to authenticated
  with check (org_id = app.active_org_id() and app.can(org_id, 'project', 'create'));
create policy projects_update on projects for update to authenticated
  using (app.can_row(org_id, 'project', 'update', manager_user_id, team_id))
  with check (org_id = app.active_org_id());

create policy project_services_select on project_services for select to authenticated
  using (org_id = app.active_org_id() and exists (select 1 from projects p where p.id = project_services.project_id));
create policy project_services_write on project_services for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'project', 'update')
         and exists (select 1 from projects p where p.id = project_services.project_id))
  with check (org_id = app.active_org_id());

create policy workstreams_select on workstreams for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id()
         and exists (select 1 from projects p where p.id = workstreams.project_id));
create policy workstreams_write on workstreams for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'project', 'update')
         and exists (select 1 from projects p where p.id = workstreams.project_id))
  with check (org_id = app.active_org_id());

-- A task is visible if you can see its project, or if it is assigned to you.
create policy tasks_select on tasks for select to authenticated
  using (
    deleted_at is null
    and org_id = app.active_org_id()
    and (
      assignee_user_id = app.current_user_id()
      or created_by = app.current_user_id()
      or (project_id is not null and exists (select 1 from projects p where p.id = tasks.project_id))
      or (project_id is null and app.can(org_id, 'task', 'read'))
    )
  );

create policy tasks_insert on tasks for insert to authenticated
  with check (org_id = app.active_org_id() and app.can(org_id, 'task', 'create'));

create policy tasks_update on tasks for update to authenticated
  using (
    org_id = app.active_org_id()
    and (
      assignee_user_id = app.current_user_id()
      or app.can_row(org_id, 'task', 'update', created_by, team_id)
      or (project_id is not null and exists (
            select 1 from projects p
            where p.id = tasks.project_id
              and app.can_row(p.org_id, 'project', 'update', p.manager_user_id, p.team_id)))
    )
  )
  with check (org_id = app.active_org_id());

create policy task_dependencies_select on task_dependencies for select to authenticated
  using (org_id = app.active_org_id() and exists (select 1 from tasks t where t.id = task_dependencies.task_id));
create policy task_dependencies_write on task_dependencies for all to authenticated
  using (org_id = app.active_org_id() and exists (select 1 from tasks t where t.id = task_dependencies.task_id))
  with check (org_id = app.active_org_id());

create policy task_comments_select on task_comments for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id()
         and exists (select 1 from tasks t where t.id = task_comments.task_id)
         and (not is_internal or app.can(org_id, 'internal_note', 'read')));
create policy task_comments_insert on task_comments for insert to authenticated
  with check (org_id = app.active_org_id() and author_id = app.current_user_id()
              and exists (select 1 from tasks t where t.id = task_comments.task_id));
create policy task_comments_update on task_comments for update to authenticated
  using (org_id = app.active_org_id() and author_id = app.current_user_id())
  with check (org_id = app.active_org_id());

create policy deliverables_select on deliverables for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id()
         and exists (select 1 from projects p where p.id = deliverables.project_id));
create policy deliverables_write on deliverables for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'project', 'update')
         and exists (select 1 from projects p where p.id = deliverables.project_id))
  with check (org_id = app.active_org_id());

create policy kpis_select on kpis for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id() and app.can(org_id, 'kpi', 'read'));
create policy kpis_write on kpis for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'kpi', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'kpi', 'manage'));

create policy kpi_measurements_select on kpi_measurements for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'kpi', 'read'));
create policy kpi_measurements_write on kpi_measurements for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'kpi', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'kpi', 'manage'));

create policy client_reports_select on client_reports for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id() and app.can(org_id, 'report', 'read'));
create policy client_reports_write on client_reports for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'report', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'report', 'manage'));
