-- =============================================================================
-- 0007_services_solutions.sql
-- The service catalogue and the solution builder that prices a deal.
--
-- All money is numeric(14,2) and every derived amount is a stored generated
-- column or is written by a trigger using exact numeric arithmetic. No value in
-- this file ever passes through a float.
-- =============================================================================

create table service_categories (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  name        text not null,
  slug        citext not null,
  description text,
  color       text,
  position    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint service_categories_slug_unique unique (org_id, slug)
);

create trigger service_categories_touch before update on service_categories
  for each row execute function app.touch_updated_at();

create table services (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations (id) on delete cascade,
  category_id       uuid references service_categories (id) on delete set null,

  code              citext not null,
  name              text not null check (length(btrim(name)) between 1 and 200),
  short_description text,
  description       text,

  pricing_model     text not null default 'fixed'
                      check (pricing_model in ('fixed', 'hourly', 'daily', 'monthly_retainer',
                                               'per_unit', 'milestone', 'usage', 'custom')),
  base_price        numeric(14, 2) not null default 0 check (base_price >= 0),
  currency          char(3) not null check (currency ~ '^[A-Z]{3}$'),
  unit_label        text not null default 'unit',
  min_quantity      numeric(12, 2) not null default 1 check (min_quantity > 0),
  -- Internal cost basis, gating the margin calculation.
  unit_cost         numeric(14, 2) check (unit_cost is null or unit_cost >= 0),

  -- SLA in business hours, measured against the org holiday calendar.
  sla_response_hours   int check (sla_response_hours is null or sla_response_hours > 0),
  sla_resolution_hours int check (sla_resolution_hours is null or sla_resolution_hours > 0),

  -- Delivery shape: default workstreams, cadence, roles required.
  delivery_config   jsonb not null default '{}'::jsonb,
  default_duration_days int check (default_duration_days is null or default_duration_days > 0),

  is_active         boolean not null default true,
  is_demo           boolean not null default false,
  position          int not null default 0,
  tags              text[] not null default '{}',

  created_by        uuid references user_profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  archived_at       timestamptz,
  deleted_at        timestamptz,

  constraint services_code_unique unique (org_id, code)
);

create index services_org_active_idx on services (org_id, is_active) where deleted_at is null;
create index services_category_idx   on services (org_id, category_id) where deleted_at is null;
create index services_name_trgm_idx  on services using gin (name gin_trgm_ops);

create trigger services_touch before update on services
  for each row execute function app.touch_updated_at();

-- Task templates instantiated when a project is created from this service.
create table service_default_tasks (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations (id) on delete cascade,
  service_id        uuid not null references services (id) on delete cascade,
  workstream_name   text,
  title             text not null,
  description       text,
  position          int not null default 0,
  priority          text not null default 'medium'
                      check (priority in ('low', 'medium', 'high', 'urgent')),
  estimated_hours   numeric(8, 2) check (estimated_hours is null or estimated_hours >= 0),
  -- Days from project start; the actual date is computed on the org calendar.
  offset_days       int not null default 0,
  duration_days     int not null default 1 check (duration_days > 0),
  is_deliverable    boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index service_default_tasks_service_idx on service_default_tasks (service_id, position);

create trigger service_default_tasks_touch before update on service_default_tasks
  for each row execute function app.touch_updated_at();

create table service_default_kpis (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  service_id    uuid not null references services (id) on delete cascade,
  name          text not null,
  description   text,
  unit          text not null default 'number'
                  check (unit in ('number', 'percent', 'currency', 'ratio', 'days', 'hours', 'score')),
  target_value  numeric(14, 4),
  direction     text not null default 'higher_is_better'
                  check (direction in ('higher_is_better', 'lower_is_better', 'target_band')),
  period        text not null default 'monthly'
                  check (period in ('weekly', 'monthly', 'quarterly', 'annual', 'project')),
  position      int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index service_default_kpis_service_idx on service_default_kpis (service_id, position);

create trigger service_default_kpis_touch before update on service_default_kpis
  for each row execute function app.touch_updated_at();

-- Which executed documents a service demands before delivery may begin.
-- This table is what the onboarding legal gate reads.
create table service_required_documents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  service_id    uuid not null references services (id) on delete cascade,
  contract_type text not null
                  check (contract_type in ('nda', 'msa', 'sow', 'addendum', 'amendment', 'other')),
  document_label text not null,
  is_required   boolean not null default true,
  -- When true the gate also demands the payment threshold be met.
  blocks_onboarding boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now(),
  constraint service_required_documents_unique unique (service_id, contract_type, document_label)
);

create index service_required_documents_service_idx on service_required_documents (service_id);

alter table service_categories enable row level security;
alter table service_categories force row level security;
alter table services enable row level security;
alter table services force row level security;
alter table service_default_tasks enable row level security;
alter table service_default_tasks force row level security;
alter table service_default_kpis enable row level security;
alter table service_default_kpis force row level security;
alter table service_required_documents enable row level security;
alter table service_required_documents force row level security;

create policy service_categories_select on service_categories for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id() and app.can(org_id, 'service', 'read'));
create policy service_categories_write on service_categories for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'service', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'service', 'manage'));

create policy services_select on services for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id() and app.can(org_id, 'service', 'read'));
create policy services_write on services for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'service', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'service', 'manage'));

create policy service_default_tasks_select on service_default_tasks for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'service', 'read'));
create policy service_default_tasks_write on service_default_tasks for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'service', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'service', 'manage'));

create policy service_default_kpis_select on service_default_kpis for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'service', 'read'));
create policy service_default_kpis_write on service_default_kpis for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'service', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'service', 'manage'));

create policy service_required_documents_select on service_required_documents for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'service', 'read'));
create policy service_required_documents_write on service_required_documents for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'service', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'service', 'manage'));

-- =============================================================================
-- SOLUTIONS
-- =============================================================================
create table solutions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  opportunity_id uuid not null references opportunities (id) on delete cascade,
  company_id     uuid not null references companies (id) on delete cascade,

  name           text not null default 'Solution',
  summary        text,
  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),

  -- Totals maintained by app.recalculate_solution_totals(); never hand-written.
  subtotal        numeric(14, 2) not null default 0,
  discount_total  numeric(14, 2) not null default 0,
  tax_total       numeric(14, 2) not null default 0,
  total           numeric(14, 2) not null default 0,
  cost_total      numeric(14, 2) not null default 0,
  -- Margin is sensitive: gated behind `margin:read` everywhere it is exposed.
  margin_amount   numeric(14, 2) not null default 0,
  margin_percent  numeric(6, 2) not null default 0,

  -- Order-level discount applied on top of line discounts.
  discount_type   text check (discount_type is null or discount_type in ('percent', 'amount')),
  discount_value  numeric(14, 2) not null default 0 check (discount_value >= 0),

  status         text not null default 'draft'
                   check (status in ('draft', 'ready', 'used', 'archived')),
  version        int not null default 1,

  notes          text,
  internal_notes text,
  created_by     uuid references user_profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create index solutions_opportunity_idx on solutions (org_id, opportunity_id) where deleted_at is null;

create trigger solutions_touch before update on solutions
  for each row execute function app.touch_updated_at();

create table solution_line_items (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  solution_id    uuid not null references solutions (id) on delete cascade,
  service_id     uuid references services (id) on delete set null,

  -- Snapshotted at add time so later catalogue edits never rewrite a quote.
  name           text not null,
  description    text,
  pricing_model  text not null default 'fixed',
  unit_label     text not null default 'unit',

  quantity       numeric(12, 2) not null default 1 check (quantity > 0),
  unit_price     numeric(14, 2) not null default 0 check (unit_price >= 0),
  unit_cost      numeric(14, 2) not null default 0 check (unit_cost >= 0),

  discount_type  text not null default 'none'
                   check (discount_type in ('none', 'percent', 'amount')),
  discount_value numeric(14, 2) not null default 0 check (discount_value >= 0),
  tax_rate       numeric(6, 3) not null default 0 check (tax_rate >= 0 and tax_rate <= 100),

  gross_amount   numeric(14, 2) generated always as
                   (round(quantity * unit_price, 2)) stored,
  discount_amount numeric(14, 2) generated always as (
                     case discount_type
                       when 'percent' then round(round(quantity * unit_price, 2) * discount_value / 100, 2)
                       when 'amount'  then least(discount_value, round(quantity * unit_price, 2))
                       else 0::numeric
                     end
                   ) stored,
  net_amount     numeric(14, 2) generated always as (
                     round(quantity * unit_price, 2) -
                     case discount_type
                       when 'percent' then round(round(quantity * unit_price, 2) * discount_value / 100, 2)
                       when 'amount'  then least(discount_value, round(quantity * unit_price, 2))
                       else 0::numeric
                     end
                   ) stored,
  tax_amount     numeric(14, 2) generated always as (
                     round((
                       round(quantity * unit_price, 2) -
                       case discount_type
                         when 'percent' then round(round(quantity * unit_price, 2) * discount_value / 100, 2)
                         when 'amount'  then least(discount_value, round(quantity * unit_price, 2))
                         else 0::numeric
                       end
                     ) * tax_rate / 100, 2)
                   ) stored,
  total_amount   numeric(14, 2) generated always as (
                     (
                       round(quantity * unit_price, 2) -
                       case discount_type
                         when 'percent' then round(round(quantity * unit_price, 2) * discount_value / 100, 2)
                         when 'amount'  then least(discount_value, round(quantity * unit_price, 2))
                         else 0::numeric
                       end
                     ) +
                     round((
                       round(quantity * unit_price, 2) -
                       case discount_type
                         when 'percent' then round(round(quantity * unit_price, 2) * discount_value / 100, 2)
                         when 'amount'  then least(discount_value, round(quantity * unit_price, 2))
                         else 0::numeric
                       end
                     ) * tax_rate / 100, 2)
                   ) stored,
  cost_amount    numeric(14, 2) generated always as (round(quantity * unit_cost, 2)) stored,

  is_optional    boolean not null default false,
  is_custom      boolean not null default false,
  position       int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index solution_line_items_solution_idx on solution_line_items (solution_id, position);

create trigger solution_line_items_touch before update on solution_line_items
  for each row execute function app.touch_updated_at();

-- Billing milestones split the solution total into scheduled payments.
create table solution_milestones (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete cascade,
  solution_id  uuid not null references solutions (id) on delete cascade,
  name         text not null,
  description  text,
  -- Either a percentage of the total or a fixed amount; exactly one.
  percent      numeric(6, 3) check (percent is null or (percent > 0 and percent <= 100)),
  amount       numeric(14, 2) check (amount is null or amount >= 0),
  due_rule     text not null default 'on_signature'
                 check (due_rule in ('on_signature', 'on_kickoff', 'on_delivery',
                                     'days_after_signature', 'fixed_date', 'monthly')),
  due_offset_days int,
  due_date     date,
  is_advance   boolean not null default false,
  position     int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint solution_milestones_amount_xor
    check ((percent is not null) <> (amount is not null))
);

create index solution_milestones_solution_idx on solution_milestones (solution_id, position);

create trigger solution_milestones_touch before update on solution_milestones
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Total recalculation. Runs after any line-item or solution-level change so the
-- header can never drift from its lines.
-- -----------------------------------------------------------------------------
create or replace function app.recalculate_solution_totals(p_solution uuid)
returns void
language plpgsql
as $$
declare
  v_net    numeric(14, 2) := 0;
  v_gross  numeric(14, 2) := 0;
  v_tax    numeric(14, 2) := 0;
  v_cost   numeric(14, 2) := 0;
  v_line_discount numeric(14, 2) := 0;
  v_order_discount numeric(14, 2) := 0;
  v_type   text;
  v_value  numeric(14, 2);
  v_total  numeric(14, 2);
begin
  select coalesce(sum(gross_amount), 0),
         coalesce(sum(discount_amount), 0),
         coalesce(sum(net_amount), 0),
         coalesce(sum(tax_amount), 0),
         coalesce(sum(cost_amount), 0)
    into v_gross, v_line_discount, v_net, v_tax, v_cost
  from solution_line_items
  where solution_id = p_solution and not is_optional;

  select discount_type, discount_value into v_type, v_value
  from solutions where id = p_solution;

  v_order_discount := case v_type
    when 'percent' then round(v_net * coalesce(v_value, 0) / 100, 2)
    when 'amount'  then least(coalesce(v_value, 0), v_net)
    else 0::numeric
  end;

  v_total := v_net - v_order_discount + v_tax;

  update solutions set
    subtotal       = v_gross,
    discount_total = v_line_discount + v_order_discount,
    tax_total      = v_tax,
    total          = v_total,
    cost_total     = v_cost,
    margin_amount  = (v_net - v_order_discount) - v_cost,
    margin_percent = case
                       when (v_net - v_order_discount) = 0 then 0
                       else round((((v_net - v_order_discount) - v_cost) / (v_net - v_order_discount)) * 100, 2)
                     end
  where id = p_solution;
end
$$;

create or replace function app.solution_totals_trigger()
returns trigger
language plpgsql
as $$
begin
  perform app.recalculate_solution_totals(coalesce(new.solution_id, old.solution_id));
  return null;
end
$$;

create trigger solution_line_items_recalc
  after insert or update or delete on solution_line_items
  for each row execute function app.solution_totals_trigger();

create or replace function app.solution_self_totals_trigger()
returns trigger
language plpgsql
as $$
begin
  if new.discount_type is distinct from old.discount_type
     or new.discount_value is distinct from old.discount_value then
    perform app.recalculate_solution_totals(new.id);
  end if;
  return null;
end
$$;

create trigger solutions_recalc
  after update on solutions
  for each row execute function app.solution_self_totals_trigger();

alter table solutions enable row level security;
alter table solutions force row level security;
alter table solution_line_items enable row level security;
alter table solution_line_items force row level security;
alter table solution_milestones enable row level security;
alter table solution_milestones force row level security;

create policy solutions_select on solutions for select to authenticated
  using (
    deleted_at is null and org_id = app.active_org_id()
    and exists (
      select 1 from opportunities o
      where o.id = solutions.opportunity_id
        and app.can_row(o.org_id, 'opportunity', 'read', o.owner_user_id, o.team_id)
    )
  );

create policy solutions_write on solutions for all to authenticated
  using (
    org_id = app.active_org_id()
    and exists (
      select 1 from opportunities o
      where o.id = solutions.opportunity_id
        and app.can_row(o.org_id, 'opportunity', 'update', o.owner_user_id, o.team_id)
    )
  )
  with check (org_id = app.active_org_id());

create policy solution_line_items_select on solution_line_items for select to authenticated
  using (
    org_id = app.active_org_id()
    and exists (select 1 from solutions s where s.id = solution_line_items.solution_id)
  );

create policy solution_line_items_write on solution_line_items for all to authenticated
  using (
    org_id = app.active_org_id()
    and exists (select 1 from solutions s where s.id = solution_line_items.solution_id)
  )
  with check (org_id = app.active_org_id());

create policy solution_milestones_select on solution_milestones for select to authenticated
  using (
    org_id = app.active_org_id()
    and exists (select 1 from solutions s where s.id = solution_milestones.solution_id)
  );

create policy solution_milestones_write on solution_milestones for all to authenticated
  using (
    org_id = app.active_org_id()
    and exists (select 1 from solutions s where s.id = solution_milestones.solution_id)
  )
  with check (org_id = app.active_org_id());
