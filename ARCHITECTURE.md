# Architecture

This document explains why the system is shaped the way it is. The decisions
below were the ones with real alternatives; each records what was chosen, what
was given up, and what would have to change to revisit it.

---

## 1. The shape of the problem

A services business loses money in the gaps between tools. The proposal is in one
place, the contract in another, the project plan in a third, and the connections
between them live in someone's head. The specific failures are predictable:

- delivery starts before the agreement is signed, because nobody checked;
- a project is planned from a service description that has since changed;
- an agreement is generated from a stale version of a proposal;
- nobody can say who approved sending a contract, or when.

Each of those is a *connection* that was never enforced. So the design goal is
not "put everything in one database" — that is easy and insufficient — but to
make the connections between stages into rules the system enforces.

That produces the central pattern: **consequential transitions are gated, and the
gate is in the database.**

---

## 2. Direct PostgreSQL, not PostgREST

**Decision.** Business data is read and written through `pg` over a direct
connection. Supabase's SDK is used only for Auth and Storage.

**Why.** A single business operation touches several tables. Winning an
opportunity writes the opportunity, appends to the transition ledger, emits a
domain event and records an audit entry. Those four writes are one fact about the
world; if any of them can succeed without the others, the system lies.

PostgREST has no way to express that. Each call is its own transaction, so
correctness would depend on compensating logic in the client — and the failure
mode is silent divergence between the ledger and the record it describes.

**What we kept.** RLS still applies to every query, because every transaction
does what PostgREST does:

```sql
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '<verified JWT payload>', true);
SELECT set_config('app.org_id', '<active organisation>', true);
```

The role is dropped *before* any application SQL runs. A policy is therefore the
floor beneath every query in the product, including one written carelessly next
year. Because the claims are set the way PostgREST sets them, `auth.uid()` and
every policy written against it behave identically whether a query arrives
through our pool or through Supabase's own API.

**Cost.** We manage a connection pool. On serverless that means the session
pooler and a modest `DATABASE_POOL_MAX`.

**To revisit.** Move simple reads to PostgREST while keeping transactional writes
here. The policies already support both.

---

## 3. Rules enforced twice

**Decision.** Every consequential rule exists as an application check *and* as a
database constraint or trigger.

**Why.** The two are not redundant; they do different jobs.

The application check produces a message a person can act on:

> This opportunity cannot move to "qualified" until the qualification details are
> complete. Missing: business_problem, budget_indication, decision_maker.

The database check makes the rule *true*:

```sql
raise exception 'Opportunity cannot reach stage % without: %', ...
```

The database version survives a new endpoint that forgets to call the service, a
migration script, a support engineer in psql, and a future refactor. The
application version is what makes the product usable.

Where they could drift, a test asserts they agree. The permission catalogue is
the clearest case: `tests/unit/permission-catalog.test.ts` fails if the
TypeScript list and the database table disagree by a single key.

**Cost.** The same rule is written twice, in two languages. That is the price of
the guarantee, and it is paid deliberately rather than by accident.

---

## 4. Transitions are a channel

**Decision.** Lifecycle columns (`stage`, `status`) may only change inside a
transaction the transition service has marked.

```sql
create or replace function app.guard_state_column() returns trigger ...
  if v_old is distinct from v_new and not app.in_transition() then
    raise exception 'Column %.% may only be changed through the transition service'
```

The transition service sets `SET LOCAL app.in_transition = 'on'` after its guards
have passed. Nothing else does.

**Why.** "Never change state with `PATCH status`" is the kind of rule that holds
until the week someone is in a hurry. Making it a database rule turns a
convention into a guarantee, and the guarantee is what the whole state machine
rests on: if state can move without the guards, the guards are decoration.

**Consequence for seed data.** The seed marks its own transaction, and says why:
fixture setup is not a user action, and putting it through the transition service
would require fabricating approvals and proposals for stages that exist only to
make a demo board look real.

**Trigger ordering matters.** PostgreSQL fires `BEFORE` triggers in name order,
so the channel guards are named `<table>_00_state_channel`. This puts them ahead
of the domain guards, so an attempt to bypass the service is reported as exactly
that, rather than as whichever business rule happened to notice first. That
ordering was discovered by a test, not by reasoning.

---

## 5. The permission model

**Decision.** `resource:action:scope`, with scopes `own` / `team` / `org`,
resolved in SQL and mirrored in TypeScript.

```
users → user_roles → roles → role_permissions → permissions
```

**Why scope rather than more roles.** Without scope you end up with
`sales_own_records`, `sales_team_records`, `sales_all_records` — a role explosion
that encodes the same idea three times. Scope makes "this salesperson sees their
team's deals" one row rather than a new role.

**How it is enforced.** A single SQL function, called by most policies:

```sql
app.can_row(org_id, 'opportunity', 'read', owner_user_id, team_id)
```

which resolves the broadest scope the user holds and applies it:

- `org` → every row in the tenant
- `team` → rows owned by the user, or by a team they belong to
- `own` → rows owned by the user
- no permission → nothing

**The separations that matter.** Three are load-bearing, and each is asserted by
a test:

- **Contract send authority is independent of deal ownership.**
  `contract:send:org` exists only at org scope and is held by Legal/Admin and
  Super Admin. A salesperson who owns the deal, owns the contract, and drafted it
  still cannot send it. There is deliberately no `contract:send:own`, because
  that would reintroduce exactly the coupling the rule removes.

- **Approving a contract and sending it are different permissions.** In most
  organisations they are different people.

- **Margin, cost and internal notes are separately permissioned.** They are
  stripped on the way out of the server, not hidden in the UI, so an API consumer
  cannot read them from the JSON.

**Unassigned records.** A record with no owner and no team is invisible at `own`
and `team` scope. The alternative — treating unowned records as tenant-public —
creates a silent disclosure channel where anything that loses its owner becomes
visible to everyone. Lead capture therefore always assigns an owner.

---

## 6. The event outbox

**Decision.** The `events` table *is* the outbox. An event row is written in the
same transaction as the change that produced it, carrying its own dispatch
status.

**Why not a job row per event.** The obvious design enqueues a job alongside each
event. It requires granting every request path INSERT on the job queue — widening
the write surface of the entire application to buy an indirection the events
table already provides. The events table has status, attempts and processed_at
because it is a queue.

**Why an outbox at all.** An opportunity cannot be marked won without its
`opportunity.won` event also existing, and no event can survive a rollback. That
is not achievable by publishing to a message broker after committing.

Fan-out is at-least-once, so every consumer is written to be idempotent.

---

## 7. Money

**Decision.** `numeric(14,2)` in the database, decimal strings over the wire,
`Decimal` in between. Every total is computed by PostgreSQL.

Line totals are stored generated columns:

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

Header totals are recomputed by a trigger whenever a line changes, so a solution
header can never drift from its lines.

**Why the arithmetic is in SQL.** If totals were computed in TypeScript, the
number a user saw and the number stored could differ by a rounding rule. Doing it
once, in the database, means there is one answer.

**Currency.** Every monetary record carries its own currency. Conversion uses the
rate captured **on the transaction**, so a closed quarter does not change value
when the market moves. `app.fx_rate_at` returns NULL when no rate is on file, and
callers treat that as "cannot express in base currency" — a silent parity
assumption produces reports that are wrong by the exchange rate and look right.

---

## 8. The legal gate

The single most consequential rule: delivery must not begin before the paperwork
is executed and the agreed money has arrived.

**How it is built.**

1. `onboarding_requirements` is *materialised* when onboarding starts, from the
   required documents of the services actually sold. Materialised, not computed
   on demand, so a later catalogue edit cannot silently change what an in-flight
   onboarding is blocked on.

2. `app.assert_legal_gate(onboarding_id)` walks every blocking requirement and
   returns those unmet — an empty array means the gate is open.

3. A trigger on `onboardings` calls it. An onboarding cannot leave `blocked`
   while anything is outstanding.

**Requirement satisfaction is derived, never stored.** A payment requirement is
satisfied when settled allocations reach its threshold:

```sql
app.payment_requirement_settled(id) >= app.payment_requirement_amount(id)
```

"Advance received" is therefore never a boolean anyone can set. Partial payments,
milestone payments and several payments against one requirement are ordinary
cases rather than special ones.

**The override.** A holder of `legal:override:org` can force the gate, and:

- a written reason of at least 20 characters is required, by check constraint;
- an immutable `legal_overrides` row is written;
- the flag on the onboarding **cannot be cleared** — a trigger refuses;
- Client 360 shows a permanent banner, backed by that immutable row.

A dismissible flag is not a permanent warning. Satisfying the paperwork later is
recorded as the requirements becoming satisfied; the fact that delivery once
began without them stays visible.

---

## 9. Documents and execution

**A contract reaches `fully_executed` only through this path:**

1. a webhook arrives and its signature is **verified**;
2. the raw event is **stored before it is interpreted** — evidence is worth
   keeping, including a spoofed delivery;
3. an unverified event is recorded and refused, never processed;
4. the executed file is downloaded from the provider;
5. **we compute its SHA-256** — the provider's word is not evidence;
6. it is stored as an immutable document;
7. only then does the contract transition.

The database refuses the combination of "executed" with no executed document, so
step 7 cannot happen without step 6.

**Immutability is one-way.** A trigger refuses to clear `is_immutable`, to change
the current version of an immutable document, or to delete one.

**Integrity is verified, not assumed.** A download can re-hash the stored bytes;
a mismatch quarantines the document, writes a critical audit record, and refuses
to serve the file.

---

## 10. AI

**The model never writes to the database.**

```
context → model → schema validation → ai_action → human review → execute → audit
```

Four properties make that more than an intention:

**Output is validated before storage.** Anything failing the schema is rejected
outright — a response we do not fully understand is not a draft for a human to
fix, it is a failed generation. Unlabelled claims are unstorable: `claim_type` is
NOT NULL with a closed CHECK, a client-attributed claim must cite a source, and
an inference must carry a confidence.

**Execution requires approval, in the database.** `ai_actions.status` cannot
reach `executed` except from `approved`, enforced by trigger. An edited payload
is re-validated, because a reviewer hand-editing JSON can break it as easily as a
model can.

**The Command Centre has no SQL surface.** Eight fixed read tools with validated
parameters. The model chooses among them; it never composes a query. That removes
a class of problem entirely: it cannot read a table it has no tool for, cannot
join around a permission, and cannot be talked into `DROP TABLE` by something in
a client's email. Each tool runs in the asking user's own transaction, so RLS
decides which rows exist, and each declares the permission it needs.

**External content is data.** Transcripts, uploaded documents and client emails
are wrapped in delimiters whose closing tag is stripped from the content first,
and the system prompt states that instructions inside them are to be reported,
not obeyed. Delimiters are the second line of defence. The first is that the
model cannot act.

---

## 11. Automations

`WHEN → IF → THEN`, stored as data, with a closed action enumeration.

**What is absent is the design.** There is no `send_email` action and no
`send_contract` action. An automation may *draft* an email and *produce* a
contract draft; a person with the relevant permission decides whether either
leaves the building. `set_field` accepts a short allow-list that contains no
lifecycle column, so an automation cannot move an entity through its state
machine and skip the guards.

**Loop protection has two independent parts.** Chain depth stops A→B→A. A
cooldown stops the same automation re-firing on one entity. Both are checked
before any action runs, and **a suppressed run is still recorded** — loop
protection that operates invisibly is indistinguishable from a broken automation.

**Conditions cannot reach the database.** The snapshot is assembled once, before
evaluation, and stored on the run. A condition therefore cannot be slow, cannot
fail, and cannot see a row it should not; and the run history shows exactly what
was true when the decision was made.

---

## 12. The client portal

Portal access is not "the internal application with fields hidden in React".

The `portal.*` schema contains views that **physically exclude** margin, cost,
internal notes, internal AI analysis and other tenants' data. A portal query
cannot select a column that does not exist in its projection.

Portal users are Supabase Auth users with a `portal_users` row and **no entries
in `user_roles`**. They hold no internal permissions at all. The application
surface is a later phase; the data contract exists now so nothing has to be
reshaped when it arrives.

---

## 13. Time

`timestamptz` for instants. `date` for calendar dates — and **`date` is parsed as
a string**, in both the production driver and the test driver. Turning
`2026-11-02` into a JavaScript `Date` makes it 2026-11-01 for anyone west of UTC,
and that class of bug is invisible until a due date is a day early.

Due dates and SLA clocks are computed on the organisation's working calendar,
skipping weekends and configured holidays. A five-day task starting on a Thursday
is due the following Thursday.

---

## 14. What is deferred, and why it still fits

| Deferred | Why the foundation supports it |
|---|---|
| Client portal UI | `portal.*` views and `portal_users` exist |
| Bidirectional email | `EmailProvider` interface; `email_messages` models both directions |
| Renewal engine | `contracts.expiry_date`, `auto_renews`, `renewal_notice_days`, and a sweep job |
| No-code automation builder | Automations are already data; only an editor is missing |
| Additional e-sign providers | `SignatureProvider` interface; adding one changes no domain code |
| Accounting integration | `invoices.external_ref` / `external_system` exist; nothing assumes we own the ledger |

The test that a foundation is right is whether the next phase requires reshaping
it. In each case above, it does not.

---

## 15. Known limits

**Permission functions are called per row.** `app.permission_scope` is `STABLE`
and consulted by most policies. Fine at current scale. If a large tenant's
opportunity list becomes slow, the fix is to resolve scope once into a CTE — not
to weaken the policy.

**The job queue is a table.** `SELECT ... FOR UPDATE SKIP LOCKED` handles far more
than this product needs, and keeps the queue inspectable with SQL. Very high
throughput would want a dedicated broker; the handler interface would not change.

**Rate limiting is a fixed window.** Simple and slightly permissive at a window
boundary. A sliding window or a token bucket would fit behind the same function.

**Search is `ILIKE` and trigram indexes.** Adequate for tens of thousands of rows
per tenant. Full-text search would be a `tsvector` column and a GIN index, with no
change to callers.
