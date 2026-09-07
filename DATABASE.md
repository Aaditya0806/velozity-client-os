# Database

PostgreSQL is not a persistence layer in this system. It is where the business
rules live.

| | |
|---|---|
| Tables | 80 |
| RLS policies | 168 |
| Triggers | 98 |
| Indexes | 277 |
| Check constraints | 230 |
| Foreign keys | 302 |
| Unique constraints | 89 |
| Helper functions (`app` schema) | 64 |

---

## Schemas

| Schema | Purpose |
|---|---|
| `public` | All business tables |
| `app` | Helper functions used by policies and triggers. Not exposed over any API. |
| `auth` | Supabase Auth. A local shim is created for tests where it is absent. |
| `portal` | Read-only projections for the client portal, physically excluding internal columns |

---

## Migrations

Plain `.sql` in `supabase/migrations/`, applied in filename order, each in its own
transaction, with its SHA-256 recorded in `schema_migrations`. **A file that
changes after it has been applied is a hard error** — editing history silently is
how two environments quietly diverge.

| File | Contents |
|---|---|
| `0001_foundation` | Extensions, schemas, roles, request context, `app.current_user_id()` |
| `0002_organizations_users_rbac` | Tenants, profiles, memberships, teams, permissions, roles, calendars |
| `0003_authorization` | The authorization primitives and RLS on the identity tables |
| `0004_audit_events_jobs` | Audit log, event outbox, activities, notifications, job queue, idempotency, FX |
| `0005_companies_contacts` | Companies, contacts, relationships, group rollup |
| `0006_state_machine_opportunities` | Transition ledger, channel guard, opportunities, discovery, diagnosis |
| `0007_services_solutions` | Service catalogue, solution builder, money arithmetic |
| `0008_proposals` | Proposals, immutable versions, optimistic concurrency, opportunity guards |
| `0009_documents` | Documents, versions, hashes, access log |
| `0010_contracts_signatures` | Templates, contracts, signers, signature requests, webhook events |
| `0011_finance` | Payment requirements, invoices, payments, allocations, threshold logic |
| `0012_projects_tasks_kpis` | Projects, workstreams, tasks, dependencies, deliverables, KPIs, reports |
| `0013_onboarding_legal_gate` | Onboarding, requirements, `assert_legal_gate()`, overrides |
| `0014_ai_automations_email` | AI actions, conversations, automations, runs, email |
| `0015_permissions_and_system_roles` | The permission catalogue and eight system roles |
| `0016_portal` | Portal users and the `portal.*` views |
| `0017_grants` | Table privileges, default privileges, append-only revokes, rate limiting |
| `0018_notification_delivery` | `app.deliver_notification()` |
| `0019_missing_write_policies` | Policies for writes that had none |
| `0020_diagnosis_claim_source` | Claim source references become text |

---

## Multi-tenancy

Every business table carries `org_id`, with RLS **enabled and forced**.

Three tables legitimately differ, and only these three:

| Table | Why |
|---|---|
| `schema_migrations` | Owned by the migrator, not by the application |
| `rate_limit_counters` | RLS enabled with no policies: deny-all for `authenticated`; only `service_role` touches it |
| `permissions` | Global reference data. RLS enabled but not forced, so migrations (which run as owner) can write it while every request role can only read it. |

### The request context

```sql
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '<verified JWT>', true);
SELECT set_config('app.org_id', '<active organisation>', true);
```

The role is dropped *before* any application SQL runs, so a policy is the floor
beneath every query. Because the claims are set the way PostgREST sets them,
`auth.uid()` and every policy written against it behave identically whether a
query arrives through our pool or through Supabase's own API.

**The org GUC only narrows.** `app.active_org_id()` returns the requested
organisation *only if* the caller is genuinely a member:

```sql
create or replace function app.active_org_id() returns uuid as $$
  select case
    when app.current_org_id() is not null and app.is_org_member(app.current_org_id())
      then app.current_org_id()
    else null
  end
$$;
```

A forged GUC yields NULL, and `org_id = NULL` matches no row.

---

## The authorization primitives

All are `SECURITY DEFINER` so that a policy on, say, `opportunities` can consult
`org_memberships` without recursively triggering that table's own policy. Each is
deliberately narrow: it answers a single yes/no or scope question about the
*current* user and never returns tenant data.

| Function | Answers |
|---|---|
| `app.current_user_id()` | Who is asking (the JWT subject) |
| `app.is_org_member(org)` | Are they an active member of an active organisation |
| `app.active_org_id()` | Which organisation this request may touch |
| `app.permission_scope(org, resource, action)` | Broadest scope held: `org` > `team` > `own`, or NULL |
| `app.can(org, resource, action)` | Do they hold it at any scope |
| `app.has_permission(org, key)` | Exact-key check, for org-wide authorities |
| `app.can_access(org, resource, action, owner, team)` | Combined permission + scope test for one row |
| `app.can_row(...)` | The above, plus the tenant check. What most policies call. |
| `app.user_team_ids(org)` | Teams they belong to |

### The standard policy shape

```sql
create policy opportunities_select on opportunities for select to authenticated
  using (deleted_at is null
         and app.can_row(org_id, 'opportunity', 'read', owner_user_id, team_id));
```

For a table with no individual owner, the org-level form:

```sql
create policy services_select on services for select to authenticated
  using (deleted_at is null and org_id = app.active_org_id()
         and app.can(org_id, 'service', 'read'));
```

---

## Two RLS behaviours worth knowing

Both were found by tests, and both are the kind of thing that produces a
mysterious bug months later.

### `RETURNING` is evaluated against the SELECT policy

```sql
insert into events (...) values (...) returning *   -- needs SELECT on events
```

Reading the event stream requires `audit:read:org`, which most users do not hold.
Written the obvious way, a salesperson could not create a client, because the
event write demanded read access to the audit stream.

**The rule: writing must not imply reading.** Ids are generated in the
application and nothing is returned:

```ts
const id = randomUUID();
await tx.query(`insert into events (id, ...) values ($1, ...)`, [id, ...]);
```

### `ON CONFLICT DO NOTHING` also applies the SELECT policy

PostgreSQL must be able to *see* a conflicting row to decide to do nothing. The
`notifications` SELECT policy restricts rows to their recipient, so a
de-duplicated insert could only ever notify the caller — the opposite of what a
notification is for.

Fixed with a helper using an EXCEPTION block instead, which keeps the read
restriction intact:

```sql
create or replace function app.deliver_notification(...) returns boolean as $$
begin
  insert into public.notifications (...) values (...);
  return true;
exception
  when unique_violation then
    return false;   -- already delivered
end $$;
```

---

## Business rules carried by the database

### The transition channel

A lifecycle column may only change inside a transaction the transition service
has marked:

```sql
create or replace function app.guard_state_column() returns trigger as $$
  ...
  if v_old is distinct from v_new and not app.in_transition() then
    raise exception
      'Column %.% may only be changed through the transition service',
      tg_table_name, v_col
      using errcode = '42501';
  end if;
$$;
```

Applied to `opportunities.stage`, `proposals.status`,
`proposal_versions.status`, `contracts.status`, `projects.status` and
`onboardings.status`.

**Trigger naming matters.** PostgreSQL fires `BEFORE` triggers in *name* order,
so channel guards are named `<table>_00_state_channel`. That puts them ahead of
the domain guards, so an attempt to bypass the service is reported as exactly
that.

### Opportunity guards

```sql
-- Qualification evidence
if new.stage in ('qualified', ...) and old.stage in ('lead','dormant') then
  -- business_problem (>= 10 chars), budget_indication, decision_maker required
```

```sql
-- Proposal dependencies
if new.stage = 'proposal_sent' and not app.opportunity_has_approved_proposal(new.id)
if new.stage = 'won' and not app.opportunity_has_accepted_proposal(new.id)
if new.stage = 'won' and new.accepted_proposal_version_id is null
```

And once recorded, the accepted version is frozen:

```sql
if old.accepted_proposal_version_id is not null
   and new.accepted_proposal_version_id is distinct from old.accepted_proposal_version_id then
  raise exception 'The accepted proposal version of an opportunity cannot be changed.'
```

That is what makes "editing the opportunity afterwards does not change the
agreement" a guarantee rather than a convention.

### Contract execution is terminal

```sql
if old.status = 'fully_executed' then
  -- any status change, or a change to title, type, company, template,
  -- variable values, value, currency, effective date, executed document
  -- or executed_at, is refused
```

And execution requires evidence:

```sql
if new.status = 'fully_executed' and new.executed_document_id is null then
  raise exception 'A contract cannot be marked fully executed without its executed document'
```

### The legal gate

```sql
app.assert_legal_gate(onboarding_id, raise := false) → jsonb  -- unmet requirements
```

Enforced by a trigger on `onboardings`: it cannot leave `blocked` while anything
blocking is unmet, unless an override is active — and an override requires
`legal:override:org`, checked in the trigger itself.

Requirement satisfaction is **derived, never stored**:

```sql
app.payment_requirement_settled(id) >= app.payment_requirement_amount(id)
```

Only `received` and `cleared` payments count. Unblocking delivery on money that
has not arrived is the expensive direction to be wrong in.

### The override is permanent

```sql
if old.legal_override_active and not new.legal_override_active then
  raise exception 'A recorded legal override cannot be removed'
```

Its reason, author and timestamp are equally immutable, and an immutable
`legal_overrides` row backs the Client 360 banner.

### Document immutability

```sql
-- Cannot receive new versions
if v_immutable then raise exception 'Document % is immutable' ...
-- Cannot be unsealed, cannot change its current version, cannot be deleted
if old.is_immutable and not new.is_immutable then raise exception ...
```

`document_versions` refuses UPDATE entirely: a stored version is a historical
fact.

### AI approval

```sql
if new.status = 'executed' and old.status <> 'approved' then
  raise exception 'An AI action must be approved before it is executed'
```

Plus a check constraint that makes the invalid state unrepresentable:

```sql
constraint ai_actions_executed_requires_approval
  check (executed_at is null or approved_at is not null)
```

---

## Money

`numeric(14,2)` throughout. FX rates are `numeric(18,8)`.

Line totals are **stored generated columns**, so the arithmetic happens once, in
one place:

```sql
net_amount numeric(14,2) generated always as (
  round(quantity * unit_price, 2) -
  case discount_type
    when 'percent' then round(round(quantity * unit_price, 2) * discount_value / 100, 2)
    when 'amount'  then least(discount_value, round(quantity * unit_price, 2))
    else 0::numeric
  end
) stored
```

Header totals are recomputed by `app.recalculate_solution_totals()` on any line
change, so a header cannot drift from its lines.

**Currency conversion fails closed.** `app.fx_rate_at` returns NULL when no rate
is on file. A silent parity assumption produces reports that are wrong by the
exchange rate and look right.

---

## Append-only tables

Enforced three ways: triggers, revoked privileges, and policies that allow only
INSERT and SELECT.

| Table | Holds |
|---|---|
| `audit_log` | The compliance record |
| `state_transitions` | Every lifecycle change, with actor and reason |
| `proposal_approvals` | Who authorised what |
| `document_versions` | Stored file facts |
| `document_access_log` | Every URL issued, every integrity check |
| `legal_overrides` | Evidence behind the permanent banner |
| `signature_events` | Normalised provider events |
| `email_events` | Delivery events |
| `webhook_events` | Raw inbound payloads (DELETE blocked; status may advance) |

Audit writes join the caller's transaction: if the business change rolls back, so
does its audit record.

---

## Time

`timestamptz` for instants. `date` for calendar dates — and `date` is **parsed as
a string** in both drivers. Turning `2026-11-02` into a JavaScript `Date` makes it
2026-11-01 west of UTC, and that class of bug is invisible until a due date is a
day early.

```ts
pg.types.setTypeParser(1700, (v) => v);  // numeric  -> string
pg.types.setTypeParser(20,   (v) => v);  // int8     -> string
pg.types.setTypeParser(1082, (v) => v);  // date     -> string
```

Business hours, working days and holidays live in `holiday_calendars` and
`holidays`, per organisation.

---

## Indexing

277 indexes, following four patterns:

**Tenant + filter**, matching the policy predicate:
```sql
create index opportunities_org_stage_idx on opportunities (org_id, stage)
  where deleted_at is null;
```

**Partial**, excluding soft-deleted rows so the index stays small.

**Trigram** for name search:
```sql
create index companies_name_trgm_idx on companies using gin (name gin_trgm_ops);
```

**Unique where it enforces a rule**:
```sql
create unique index contacts_one_primary_per_company
  on contacts (company_id) where is_primary and deleted_at is null;

create unique index webhook_events_provider_event_idx
  on webhook_events (provider, provider_event_id) where provider_event_id is not null;
```

The second of those is webhook idempotency expressed as an index rather than as
code.

---

## Soft deletion

`deleted_at timestamptz` on every table holding business data. Nothing that
matters is ever hard-deleted.

Two exceptions, both deliberate:
- **Executed contracts and their documents cannot be soft-deleted either.** A
  trigger refuses.
- **Join tables** (`role_permissions`, `team_members`, `payment_allocations`) are
  hard-deleted, because they carry no history of their own.

---

## The portal schema

Views that physically exclude internal columns. A portal query cannot select a
column that does not exist in its projection.

| View | Excludes |
|---|---|
| `portal.companies` | `internal_notes`, `health_score`, `owner_user_id`, `annual_revenue` |
| `portal.projects` | `cost_to_date`, `budget_amount`, `internal_notes` |
| `portal.tasks` | Everything not `is_client_visible`; estimates, assignees |
| `portal.invoices` | Requires `portal_users.can_view_invoices` |
| `portal.contracts` | Metadata only; no internal review trail or notes |
| `portal.activities` | Anything `is_internal` |

Access is via `app.portal_company_ids()`, which returns the companies the current
user has an active `portal_users` row for — empty for internal staff, which is
exactly right: the portal views are not a second door into the application.

---

## Useful queries

```sql
-- Tables missing RLS (expect only the three documented above)
select relname from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and (not c.relrowsecurity or not c.relforcerowsecurity);

-- Any policy reachable by anon (expect none)
select tablename, policyname from pg_policies
where schemaname = 'public' and 'anon' = any(roles);

-- Write privileges on the audit log (expect none)
select grantee, privilege_type from information_schema.role_table_grants
where table_name = 'audit_log' and privilege_type in ('UPDATE','DELETE');

-- Demo data in a production database (expect 0)
select count(*) from organizations where is_demo;

-- Onboardings blocked, and by what
select o.id, c.name, o.blocked_reasons
from onboardings o join companies c on c.id = o.company_id
where o.status = 'blocked';

-- Every legal override ever made
select c.name, lo.reason, u.full_name, lo.overridden_at
from legal_overrides lo
join companies c on c.id = lo.company_id
join user_profiles u on u.id = lo.overridden_by
order by lo.overridden_at desc;

-- Work that needs attention
select * from jobs where status = 'dead';
select * from webhook_events where status = 'failed';
select * from audit_log where severity = 'critical' order by occurred_at desc;
```
