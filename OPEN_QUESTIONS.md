# Open Questions & Recorded Assumptions

Where the specification was silent or ambiguous, the safest extensible option
was chosen, the choice recorded here, and development continued. Each entry
states the assumption, why it was made, and what would change if the answer is
different.

**Note on the source of truth.** The build instruction referred to "the attached
architecture document". No such file was present in the working directory, so
the build instruction itself — which is highly detailed — has been treated as
the specification throughout. If the architecture document exists separately,
it should be reconciled against this file first; conflicts favour the document.

---

## A1 — Sales does not see margin or cost

**Assumption.** The `sales` system role holds neither `margin:read:org` nor
`cost:read:org`. Margin and cost are visible to Super Admin, Management and
Finance only.

**Why.** The specification lists margin and cost among the sensitive fields that
require explicit permission, and says permissions must not be implied by role
name. Granting them to Sales by default would be the widest reading, and
widening later is a one-line role edit while narrowing later is a data-exposure
incident.

**If wrong.** Add the two permissions to the `sales` role in
`0015_permissions_and_system_roles.sql` (or grant them per-tenant through a
custom role, which needs no migration).

---

## A2 — Unassigned records are invisible to team-scoped users

**Assumption.** `app.can_access` treats a record with no owner and no team as
inaccessible at `own` and `team` scope. Only `org` scope sees unassigned records.

**Why.** A record belonging to nobody belongs to no team. The alternative —
treating unowned records as public within the tenant — creates a silent
disclosure channel: anything that loses its owner becomes visible to everyone.

**Consequence.** An unassigned inbound lead is not visible to the sales team
until someone is assigned. Lead capture therefore always assigns an owner
(defaulting to the creating user).

**If wrong.** Extend `app.can_access` with `or (p_owner_id is null and p_team_id
is null)` for the `team` scope.

---

## A3 — A won opportunity can still be lost

**Assumption.** `won → lost` is a legal transition and still demands a lost
reason. `closed` is the terminal state, not `won`.

**Why.** The specification lists "won then lost" as an edge case that must be
designed for. Modelling `won` as terminal would make the required edge case
impossible to represent.

---

## A4 — Contract send authority is org-wide, never scoped

**Assumption.** `contract:send:org` and `contract:approve:org` exist only at org
scope, and are held by Legal/Admin and Super Admin. A deal owner cannot send
their own contract unless separately granted.

**Why.** The specification requires legal send authority to be independent from
deal ownership. A `contract:send:own` permission would reintroduce exactly the
coupling that requirement removes.

---

## A5 — The proposal's accepted version is frozen on the opportunity

**Assumption.** `opportunities.accepted_proposal_version_id` is written once, by
the `won` transition, and a database trigger then refuses to change it.

**Why.** The specification requires that later edits to the opportunity do not
change which proposal version an agreement is generated from. Making the pointer
immutable is stronger than merely reading it at generation time, because it also
survives a second acceptance or a manual correction.

---

## A6 — Email opens are recorded but never gate anything

**Assumption.** `first_opened_at` and `open_count` are stored, and no business
rule anywhere reads them.

**Why.** The specification says opens must not be treated as guaranteed truth.
Image proxies pre-fetch tracking pixels and privacy settings suppress them, so
an open is weak evidence in both directions.

---

## A7 — The legal gate counts payment thresholds, not payment flags

**Assumption.** A payment requirement is satisfied when settled allocations
reach the required amount, computed by `app.payment_requirement_is_satisfied`.
Only payments in status `received` or `cleared` count.

**Why.** The specification explicitly rejects a simple boolean for advance
received. Whether a `pending` payment should count is the ambiguous part; it is
excluded, because unblocking delivery on money that has not arrived is the
expensive direction to be wrong in.

**If wrong.** Add `'pending'` to the status filter in
`app.payment_requirement_settled`.

---

## A8 — Legal overrides are permanent

**Assumption.** Once `legal_override_active` is set on an onboarding it can never
be cleared, and its reason, author and timestamp are immutable. The Client 360
banner is therefore permanent.

**Why.** The specification requires a permanent warning banner. A clearable flag
is not a permanent banner. Satisfying the paperwork afterwards is recorded as
the requirements becoming satisfied; the fact that delivery once began without
them remains visible.

---

## A9 — Currency conversion fails closed

**Assumption.** `app.fx_rate_at` returns NULL when no rate is on file, and
callers treat that as "cannot express in base currency" rather than assuming 1.0.

**Why.** A silent parity assumption produces reports that are wrong by the
exchange rate and look right. An absent figure is visibly absent.

**Consequence.** An organisation must load FX rates before multi-currency
reporting shows base-currency totals. Same-currency amounts are unaffected.

---

## A10 — Automations may draft email but never send it

**Assumption.** The automation action enumeration contains `draft_email` and no
`send_email`, exactly as specified. There is also no `send_contract` action:
contracts are sent only by a person holding `contract:send:org`.

**Why.** The specification's stated principle is that humans stay in control of
legally and commercially consequential actions. Sending a contract is more
consequential than sending an email, so it gets the same treatment.

---

## A11 — Discovery is one workspace per opportunity

**Assumption.** `discoveries` has a unique constraint on `opportunity_id`.
Re-running discovery edits the existing record; history lives in the activity
timeline rather than in versioned discovery rows.

**Why.** The specification describes a discovery *workspace* with an activity
history, not versioned discovery documents. Diagnoses, by contrast, are
explicitly versioned.

**If wrong.** Drop the constraint and add `version` plus a `current` flag; no
other table references discovery by identity.

---

## A12 — Portal users are Supabase Auth users with no internal role

**Assumption.** A portal user is a row in `portal_users` linking a contact to an
auth user. They receive no entries in `user_roles`, and read exclusively through
the `portal.*` views.

**Why.** The specification requires the portal to be a separate surface backed by
views that physically exclude internal columns, not by frontend hiding. Giving
portal users internal permissions would defeat that even with the views in place.

---

## A13 — Job queue is a table, not pg-boss

**Assumption.** The `jobs` table plus `SELECT ... FOR UPDATE SKIP LOCKED` is used
rather than the pg-boss library. The specification offered either.

**Why.** pg-boss owns its own schema and migration lifecycle, which would sit
outside the migration ledger that the rest of this database uses. A single table
we migrate ourselves keeps one source of truth for schema state.

---

## A14 — Events are the outbox; user transactions never write to `jobs`

**Assumption.** The `events` table carries its own dispatch status and is polled
by a service-role dispatcher. A user-facing transaction has no INSERT privilege
on `jobs`.

**Why.** The alternative — enqueueing a job row alongside each event — would
require granting every request path write access to the queue. That widens the
write surface of the whole application to buy an indirection that the events
table already provides.

---

## A15 — Zero-retention is requested, not asserted

**Assumption.** `organizations.ai_retention_mode` defaults to `zero_retention`
and is passed to the model provider where the API supports it. The application
does not claim the provider honours it.

**Why.** Retention is a property of the provider account and contract, not
something an application can enforce. Recording the intent is honest; asserting
the guarantee would not be.

---

## Deferred by phase (not ambiguities)

These are specified but scheduled for a later phase, per the build order:

- Bidirectional Gmail/Microsoft email sync (Phase 3; Phase 1 is outbound only).
- Renewal engine and forecasting (Phase 4).
- No-code automation builder UI (Phase 5; the engine and its data model exist).
- Client portal application surface (Phase 5; the `portal.*` data contract exists).
- WhatsApp and Slack integrations (Phase 5).

---

## A16 — Some Client 360 tabs are placeholders

**Assumption.** The Services, Tasks, Emails and Reports tabs on Client 360 render
an explanatory panel rather than a built view. Every other tab is complete.

**Why.** The specification lists twelve tabs. Eight are built against real data;
the remaining four would be filtered views of data already reachable through
`/api/v1/tasks?company_id=`, `/api/v1/documents?company_id=` and equivalents. The
panels say so rather than pretending to be empty states, so nobody mistakes an
unbuilt view for a client with no tasks.

**Consequence.** Nothing is inaccessible — the data is on the Tasks, Documents
and Reports pages, and through the API.

---

## A17 — The SES adapter is intentionally unimplemented

**Assumption.** `sesProvider.send()` throws `PROVIDER_UNAVAILABLE` with an
explanation, rather than containing a hand-rolled SigV4 implementation.

**Why.** The specification asks for an abstraction supporting Resend *or* SES.
The abstraction is complete and Resend is implemented. Writing an AWS request
signer by hand, when `@aws-sdk/client-sesv2` exists, would be a liability rather
than a feature: signing bugs are subtle and security-relevant.

**To complete it.** Install the SDK and fill in one method. No caller changes.

---

## A18 — The seed does not set passwords

**Assumption.** The seed creates `user_profiles` and `auth.users` rows but no
passwords. Signing in as a demo user requires setting one through Supabase.

**Why.** A password written into a seed script is how a default credential ends
up in a production database. The extra step is deliberate friction.

**Documented** in README under "Seed process", with the exact command.

---

## A19 — Health scoring is deliberately simple

**Assumption.** `health.recompute` uses a transparent additive score: penalties
for at-risk projects, overdue invoices and no recent activity; credits for active
on-track projects and open opportunities.

**Why.** A client health score labels a commercial relationship. Anything
cleverer would need to be justifiable to the client it labels "at risk", and an
unexplainable score is worse than none. The formula is one SQL statement, and can
be read by anyone who asks why.

**If wrong.** It is a single query in `lib/jobs/worker.ts`.

---

## A20 — Contract documents are rendered as HTML, not PDF

**Assumption.** `renderContractDocument` produces an HTML document. Signature
providers accept it, and the *executed* copy that comes back from the provider is
stored as the PDF the provider produced.

**Why.** PDF generation needs a rendering engine (a headless browser or a layout
library), which is a substantial dependency and an operational surface. The
document that legally matters is the executed one, which the provider produces
and we store immutably after hashing it ourselves.

**If wrong.** `renderContractDocument` is the single place to change; everything
downstream already treats the draft as opaque bytes with a MIME type.
