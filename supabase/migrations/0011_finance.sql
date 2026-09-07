-- =============================================================================
-- 0011_finance.sql
-- The finance surface Phase 1 actually needs: payment requirements, invoices,
-- payments and allocations.
--
-- This is deliberately not an accounting system. It records what was required,
-- what was invoiced and what arrived, with enough structure that a Zoho Books or
-- Tally integration can later own the ledger without reshaping these tables.
--
-- "Advance received" is never a boolean: it is derived by comparing allocated,
-- settled payments against a declared threshold.
-- =============================================================================

create table payment_requirements (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  company_id     uuid not null references companies (id) on delete cascade,
  opportunity_id uuid references opportunities (id) on delete set null,
  contract_id    uuid references contracts (id) on delete set null,
  project_id     uuid,

  name           text not null,
  description    text,
  requirement_type text not null default 'advance'
                     check (requirement_type in ('advance', 'milestone', 'recurring', 'final', 'full')),

  -- Either an absolute amount or a percentage of the contract value.
  amount         numeric(14, 2) check (amount is null or amount >= 0),
  percent_of_value numeric(6, 3) check (percent_of_value is null or (percent_of_value > 0 and percent_of_value <= 100)),
  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),

  due_rule       text not null default 'on_signature'
                   check (due_rule in ('on_signature', 'on_kickoff', 'on_delivery',
                                       'days_after_signature', 'fixed_date', 'monthly')),
  due_offset_days int,
  due_date       date,

  -- When true, onboarding stays blocked until this requirement is satisfied.
  blocks_onboarding boolean not null default false,

  status         text not null default 'pending'
                   check (status in ('pending', 'partially_paid', 'satisfied', 'waived', 'cancelled')),
  satisfied_at   timestamptz,
  waived_by      uuid references user_profiles (id) on delete set null,
  waived_at      timestamptz,
  waiver_reason  text,

  position       int not null default 0,
  is_demo        boolean not null default false,
  created_by     uuid references user_profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,

  constraint payment_requirements_amount_xor
    check ((amount is not null) <> (percent_of_value is not null)),
  constraint payment_requirements_waiver_reason
    check (waived_at is null or waiver_reason is not null)
);

create index payment_requirements_company_idx  on payment_requirements (org_id, company_id) where deleted_at is null;
create index payment_requirements_contract_idx on payment_requirements (contract_id) where deleted_at is null;
create index payment_requirements_gate_idx     on payment_requirements (org_id, blocks_onboarding, status)
  where deleted_at is null and blocks_onboarding;

create trigger payment_requirements_touch before update on payment_requirements
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Invoices
-- -----------------------------------------------------------------------------
create table invoices (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  company_id     uuid not null references companies (id) on delete restrict,
  contract_id    uuid references contracts (id) on delete set null,
  project_id     uuid,
  payment_requirement_id uuid references payment_requirements (id) on delete set null,

  reference      text not null,
  -- Populated when the ledger of record is an external accounting system.
  external_ref   text,
  external_system text,

  status         text not null default 'draft'
                   check (status in ('draft', 'issued', 'partially_paid', 'paid',
                                     'overdue', 'cancelled', 'written_off')),

  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),
  fx_rate_to_base numeric(18, 8) check (fx_rate_to_base is null or fx_rate_to_base > 0),

  subtotal       numeric(14, 2) not null default 0,
  discount_total numeric(14, 2) not null default 0,
  tax_total      numeric(14, 2) not null default 0,
  total          numeric(14, 2) not null default 0,
  amount_paid    numeric(14, 2) not null default 0,
  balance_due    numeric(14, 2) generated always as (total - amount_paid) stored,

  issue_date     date,
  due_date       date,
  paid_at        timestamptz,
  notes          text,

  is_demo        boolean not null default false,
  created_by     uuid references user_profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,

  constraint invoices_reference_unique unique (org_id, reference),
  constraint invoices_amount_paid_sane check (amount_paid >= 0)
);

create index invoices_company_idx on invoices (org_id, company_id) where deleted_at is null;
create index invoices_status_idx  on invoices (org_id, status) where deleted_at is null;
create index invoices_due_idx     on invoices (org_id, due_date) where deleted_at is null;

create trigger invoices_touch before update on invoices
  for each row execute function app.touch_updated_at();

create table invoice_line_items (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  invoice_id  uuid not null references invoices (id) on delete cascade,
  service_id  uuid references services (id) on delete set null,
  name        text not null,
  description text,
  quantity    numeric(12, 2) not null default 1 check (quantity > 0),
  unit_price  numeric(14, 2) not null default 0 check (unit_price >= 0),
  tax_rate    numeric(6, 3) not null default 0 check (tax_rate >= 0 and tax_rate <= 100),
  net_amount  numeric(14, 2) generated always as (round(quantity * unit_price, 2)) stored,
  tax_amount  numeric(14, 2) generated always as
                (round(round(quantity * unit_price, 2) * tax_rate / 100, 2)) stored,
  total_amount numeric(14, 2) generated always as
                (round(quantity * unit_price, 2) + round(round(quantity * unit_price, 2) * tax_rate / 100, 2)) stored,
  position    int not null default 0,
  created_at  timestamptz not null default now()
);

create index invoice_line_items_invoice_idx on invoice_line_items (invoice_id, position);

-- -----------------------------------------------------------------------------
-- Payments
-- -----------------------------------------------------------------------------
create table payments (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  company_id     uuid not null references companies (id) on delete restrict,
  invoice_id     uuid references invoices (id) on delete set null,
  contract_id    uuid references contracts (id) on delete set null,
  project_id     uuid,

  reference      text not null,
  external_ref   text,

  amount         numeric(14, 2) not null check (amount > 0),
  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),
  -- Captured at transaction time. Historical reporting uses this, not today's rate.
  fx_rate_to_base numeric(18, 8) not null check (fx_rate_to_base > 0),
  amount_base    numeric(14, 2) generated always as (round(amount * fx_rate_to_base, 2)) stored,

  method         text not null default 'bank_transfer'
                   check (method in ('bank_transfer', 'card', 'cheque', 'cash', 'upi',
                                     'direct_debit', 'other')),
  status         text not null default 'received'
                   check (status in ('pending', 'received', 'cleared', 'failed', 'refunded', 'reversed')),

  transaction_date date not null,
  received_at    timestamptz not null default now(),
  cleared_at     timestamptz,
  notes          text,

  is_demo        boolean not null default false,
  recorded_by    uuid references user_profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,

  constraint payments_reference_unique unique (org_id, reference)
);

create index payments_company_idx on payments (org_id, company_id, transaction_date desc) where deleted_at is null;
create index payments_invoice_idx on payments (invoice_id) where deleted_at is null;
create index payments_status_idx  on payments (org_id, status) where deleted_at is null;

create trigger payments_touch before update on payments
  for each row execute function app.touch_updated_at();

-- A single payment may settle several requirements (and a requirement may be
-- settled by several payments). Allocations make partial and milestone payments
-- first-class rather than a special case.
create table payment_allocations (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organizations (id) on delete cascade,
  payment_id             uuid not null references payments (id) on delete cascade,
  payment_requirement_id uuid references payment_requirements (id) on delete cascade,
  invoice_id             uuid references invoices (id) on delete cascade,
  amount                 numeric(14, 2) not null check (amount > 0),
  currency               char(3) not null check (currency ~ '^[A-Z]{3}$'),
  created_by             uuid references user_profiles (id) on delete set null,
  created_at             timestamptz not null default now(),
  constraint payment_allocations_target
    check (payment_requirement_id is not null or invoice_id is not null)
);

create index payment_allocations_payment_idx on payment_allocations (payment_id);
create index payment_allocations_requirement_idx on payment_allocations (payment_requirement_id);
create index payment_allocations_invoice_idx on payment_allocations (invoice_id);

-- Allocations may never exceed the payment they draw on.
create or replace function app.assert_allocation_within_payment()
returns trigger
language plpgsql
as $$
declare
  v_payment numeric(14, 2);
  v_alloc   numeric(14, 2);
  v_currency char(3);
begin
  select amount, currency into v_payment, v_currency
  from payments where id = new.payment_id;

  if new.currency <> v_currency then
    raise exception 'Allocation currency % does not match payment currency %', new.currency, v_currency
      using errcode = '23514', hint = 'CURRENCY_MISMATCH';
  end if;

  select coalesce(sum(amount), 0) into v_alloc
  from payment_allocations
  where payment_id = new.payment_id and id <> new.id;

  if v_alloc + new.amount > v_payment then
    raise exception 'Allocations (%) would exceed the payment amount (%)', v_alloc + new.amount, v_payment
      using errcode = '23514', hint = 'OVER_ALLOCATED';
  end if;

  return new;
end
$$;

create trigger payment_allocations_within_payment
  before insert or update on payment_allocations
  for each row execute function app.assert_allocation_within_payment();

-- -----------------------------------------------------------------------------
-- Derived settlement state
-- -----------------------------------------------------------------------------

-- Amount required by a requirement, resolving a percentage against its contract.
create or replace function app.payment_requirement_amount(p_requirement uuid)
returns numeric
language sql
stable
as $$
  select case
    when r.amount is not null then r.amount
    else round(coalesce(c.contract_value, 0) * r.percent_of_value / 100, 2)
  end
  from payment_requirements r
  left join contracts c on c.id = r.contract_id
  where r.id = p_requirement
$$;

-- Sum of settled payments allocated to a requirement. Only `received` and
-- `cleared` payments count; pending and failed ones do not.
create or replace function app.payment_requirement_settled(p_requirement uuid)
returns numeric
language sql
stable
as $$
  select coalesce(sum(a.amount), 0)::numeric(14, 2)
  from payment_allocations a
  join payments p on p.id = a.payment_id
  where a.payment_requirement_id = p_requirement
    and p.status in ('received', 'cleared')
    and p.deleted_at is null
$$;

create or replace function app.payment_requirement_is_satisfied(p_requirement uuid)
returns boolean
language sql
stable
as $$
  select case
    when (select status from payment_requirements where id = p_requirement) = 'waived' then true
    else app.payment_requirement_settled(p_requirement)
         >= coalesce(app.payment_requirement_amount(p_requirement), 0)
  end
$$;

comment on function app.payment_requirement_is_satisfied is
  'Threshold test used by the onboarding gate. Never a stored boolean flag.';

-- Recompute requirement and invoice status whenever money moves.
create or replace function app.refresh_payment_derived_state()
returns trigger
language plpgsql
as $$
declare
  v_req  uuid;
  v_inv  uuid;
  v_paid numeric(14, 2);
  v_total numeric(14, 2);
begin
  v_req := coalesce(new.payment_requirement_id, old.payment_requirement_id);
  v_inv := coalesce(new.invoice_id, old.invoice_id);

  if v_req is not null then
    update payment_requirements r
    set status = case
          when r.status in ('waived', 'cancelled') then r.status
          when app.payment_requirement_settled(v_req) >= coalesce(app.payment_requirement_amount(v_req), 0)
               and coalesce(app.payment_requirement_amount(v_req), 0) > 0 then 'satisfied'
          when app.payment_requirement_settled(v_req) > 0 then 'partially_paid'
          else 'pending'
        end,
        satisfied_at = case
          when r.status not in ('waived', 'cancelled')
               and app.payment_requirement_settled(v_req) >= coalesce(app.payment_requirement_amount(v_req), 0)
               and coalesce(app.payment_requirement_amount(v_req), 0) > 0
            then coalesce(r.satisfied_at, now())
          else null
        end
    where r.id = v_req;
  end if;

  if v_inv is not null then
    select coalesce(sum(a.amount), 0) into v_paid
    from payment_allocations a
    join payments p on p.id = a.payment_id
    where a.invoice_id = v_inv
      and p.status in ('received', 'cleared')
      and p.deleted_at is null;

    select total into v_total from invoices where id = v_inv;

    update invoices set
      amount_paid = v_paid,
      status = case
        when status in ('draft', 'cancelled', 'written_off') then status
        when v_paid >= v_total and v_total > 0 then 'paid'
        when v_paid > 0 then 'partially_paid'
        when due_date is not null and due_date < current_date then 'overdue'
        else 'issued'
      end,
      paid_at = case when v_paid >= v_total and v_total > 0 then coalesce(paid_at, now()) else null end
    where id = v_inv;
  end if;

  return null;
end
$$;

create trigger payment_allocations_refresh
  after insert or update or delete on payment_allocations
  for each row execute function app.refresh_payment_derived_state();

-- A payment changing status must ripple through to everything it settles.
create or replace function app.refresh_on_payment_status_change()
returns trigger
language plpgsql
as $$
declare
  v_alloc record;
begin
  if new.status is distinct from old.status or new.deleted_at is distinct from old.deleted_at then
    for v_alloc in select * from payment_allocations where payment_id = new.id loop
      update payment_requirements set updated_at = now() where id = v_alloc.payment_requirement_id;
      update invoices set updated_at = now() where id = v_alloc.invoice_id;
      -- Re-run the same derived-state maths.
      perform app.recompute_allocation_targets(v_alloc.payment_requirement_id, v_alloc.invoice_id);
    end loop;
  end if;
  return null;
end
$$;

create or replace function app.recompute_allocation_targets(p_requirement uuid, p_invoice uuid)
returns void
language plpgsql
as $$
declare
  v_paid numeric(14, 2);
  v_total numeric(14, 2);
begin
  if p_requirement is not null then
    update payment_requirements r
    set status = case
          when r.status in ('waived', 'cancelled') then r.status
          when app.payment_requirement_settled(p_requirement) >= coalesce(app.payment_requirement_amount(p_requirement), 0)
               and coalesce(app.payment_requirement_amount(p_requirement), 0) > 0 then 'satisfied'
          when app.payment_requirement_settled(p_requirement) > 0 then 'partially_paid'
          else 'pending'
        end,
        satisfied_at = case
          when r.status not in ('waived', 'cancelled')
               and app.payment_requirement_settled(p_requirement) >= coalesce(app.payment_requirement_amount(p_requirement), 0)
               and coalesce(app.payment_requirement_amount(p_requirement), 0) > 0
            then coalesce(r.satisfied_at, now())
          else null
        end
    where r.id = p_requirement;
  end if;

  if p_invoice is not null then
    select coalesce(sum(a.amount), 0) into v_paid
    from payment_allocations a
    join payments p on p.id = a.payment_id
    where a.invoice_id = p_invoice and p.status in ('received', 'cleared') and p.deleted_at is null;

    select total into v_total from invoices where id = p_invoice;

    update invoices set
      amount_paid = v_paid,
      status = case
        when status in ('draft', 'cancelled', 'written_off') then status
        when v_paid >= v_total and v_total > 0 then 'paid'
        when v_paid > 0 then 'partially_paid'
        else 'issued'
      end
    where id = p_invoice;
  end if;
end
$$;

create trigger payments_status_refresh
  after update on payments
  for each row execute function app.refresh_on_payment_status_change();

alter table payment_requirements enable row level security;
alter table payment_requirements force row level security;
alter table invoices enable row level security;
alter table invoices force row level security;
alter table invoice_line_items enable row level security;
alter table invoice_line_items force row level security;
alter table payments enable row level security;
alter table payments force row level security;
alter table payment_allocations enable row level security;
alter table payment_allocations force row level security;

-- Finance data is sensitive: reading it requires an explicit finance permission,
-- not merely being able to see the client.
create policy payment_requirements_select on payment_requirements for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id() and app.can(org_id, 'finance', 'read'));
create policy payment_requirements_write on payment_requirements for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'finance', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'finance', 'manage'));

create policy invoices_select on invoices for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id() and app.can(org_id, 'finance', 'read'));
create policy invoices_write on invoices for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'finance', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'finance', 'manage'));

create policy invoice_line_items_select on invoice_line_items for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'finance', 'read'));
create policy invoice_line_items_write on invoice_line_items for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'finance', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'finance', 'manage'));

create policy payments_select on payments for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id() and app.can(org_id, 'finance', 'read'));
create policy payments_write on payments for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'payment', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'payment', 'manage'));

create policy payment_allocations_select on payment_allocations for select to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'finance', 'read'));
create policy payment_allocations_write on payment_allocations for all to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'payment', 'manage'))
  with check (org_id = app.active_org_id() and app.can(org_id, 'payment', 'manage'));
