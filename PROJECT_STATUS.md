# Project Status — Velozity Business OS

Last updated at the end of the first build session.

---

## Summary

Phase 1 is complete and verified. The critical WON → ONBOARDED workflow —
proposal acceptance, NDA generation, e-signature, executed-document storage, MSA,
payment thresholds, the legal gate and project provisioning — passes end to end
as an automated test against real PostgreSQL.

| | |
|---|---|
| Migrations | 20, all applying cleanly |
| Tables | 80 |
| RLS policies | 168 |
| Triggers | 98 |
| Check constraints | 230 |
| Permissions | 127 |
| System roles | 8 |
| API endpoints | 59 |
| **Tests** | **176 passing** |
| Typecheck | Clean (strict, `noUncheckedIndexedAccess`) |
| Production build | Clean, no warnings |

Tests run against **PGlite** — PostgreSQL 18 compiled to WebAssembly — so the RLS
policies, triggers and constraints under test are the ones that run in
production. No PostgreSQL server or Docker is needed to run the suite.

---

## Completed

### Foundation
- [x] Next.js 15 App Router, TypeScript strict, Tailwind, shadcn-style components
- [x] Zod-validated environment, server/public split enforced by `server-only`
- [x] Migration runner with checksum enforcement
- [x] Direct PostgreSQL layer assuming `authenticated` per transaction, so RLS
      applies while multi-step operations stay atomic
- [x] `withService` escape hatch — named, reason-required, logged
- [x] Structured JSON logging with key-based redaction
- [x] Error vocabulary; PostgreSQL trigger hints map to machine codes
- [x] Audit log — append-only by trigger *and* by revoked privilege
- [x] Event service (transactional outbox on `events`)
- [x] Polymorphic activity timeline
- [x] Notifications, including cross-user delivery
- [x] Job queue (`FOR UPDATE SKIP LOCKED`) and worker
- [x] Idempotency keys with request-body hashing
- [x] Rate limiting

### Authentication and authorization
- [x] Supabase Auth; server-side session resolution
- [x] Session invalidation watermark — deactivation takes effect immediately
- [x] RBAC with `resource:action:scope` and own/team/org scopes
- [x] 8 system roles with deliberately separated authorities
- [x] RLS on every tenant table, forced, deny-by-default, no `anon` policies
- [x] Field-level redaction of margin, cost and internal notes on the way out
- [x] TypeScript catalogue asserted against the database by test

### Sales
- [x] Companies and contacts, parent companies, group rollup, relationships
- [x] Opportunities — one table for the whole funnel
- [x] Lead capture: company + contact + opportunity in one transaction
- [x] Generic state machine; append-only transition ledger
- [x] Transition-channel enforcement — direct `UPDATE ... stage` is refused
- [x] Guards: qualification evidence, approved proposal, accepted proposal
- [x] Lost reasons; reversible dormancy that restores the prior stage
- [x] Discovery workspace
- [x] Diagnosis with per-claim provenance; unlabelled claims unstorable
- [x] Service catalogue with default tasks, KPIs and required documents
- [x] Solution builder; all money arithmetic in PostgreSQL `numeric`
- [x] Proposals: versioning, immutable accepted version, optimistic concurrency

### Legal
- [x] Contract templates; deterministic renderer that fails on a missing variable
- [x] Contract lifecycle; `fully_executed` terminal and immutable
- [x] Approve and send as separate authorities, both independent of deal ownership
- [x] E-signature provider abstraction; Zoho Sign adapter; manual adapter
- [x] Verified-webhook pipeline: store raw before processing, reject unverified,
      idempotent, exponential backoff
- [x] Executed-document workflow: download → hash → seal → only then mark executed
- [x] Amendments via `parent_contract_id`

### Documents
- [x] Private storage, versioning, no overwrites
- [x] SHA-256 on every version; verification on demand
- [x] Quarantine and critical alert on hash mismatch
- [x] Signed URLs, 15-minute expiry, permission-checked, access-logged
- [x] One-way immutability

### Finance
- [x] Payment requirements, invoices, payments, allocations
- [x] Threshold evaluation — "advance received" is derived, never a boolean
- [x] Multi-currency with rates captured at transaction time
- [x] Structured so an external ledger can take over without reshaping

### Onboarding and delivery
- [x] Materialised requirements from the services actually sold
- [x] `assert_legal_gate()` enforced in the database
- [x] Legal override — permanent, reasoned, immutably recorded, permanent banner
- [x] Project provisioning: workstreams, tasks, deliverables, KPIs, cadence
- [x] Projects, workstreams, tasks, dependencies, comments, deliverables
- [x] KPI framework with measurements and derived status
- [x] Business calendar and SLA clock helpers

### Intelligence
- [x] AI action framework: propose → validate → approve → execute → audit
- [x] Provenance schema; execution-requires-approval enforced by trigger
- [x] AI Command Centre with 8 fixed read tools; no text-to-SQL
- [x] Prompt-injection defences; PII minimisation; org-level kill switch
- [x] Automation engine: WHEN → IF → THEN, closed action enumeration
- [x] Loop protection: chain depth and per-entity cooldown, both recorded

### Interface
- [x] Application shell: sidebar, ⌘K command bar, notifications, org switcher
- [x] Permission-aware navigation
- [x] Dashboard with pipeline funnel, delivery health, blocked onboardings
- [x] Client 360 with twelve tabs, timeline, billing, permanent legal banner
- [x] Pipeline Kanban with drag-to-transition and guard feedback
- [x] Opportunity detail with a qualification checklist mirroring the guard
- [x] Legal list and contract detail with authority-aware actions
- [x] Projects, tasks, services, documents, finance, reports, AI, automations, settings
- [x] Loading skeletons, empty states, error states, confirmation dialogs, toasts
- [x] Dark mode, responsive layouts, keyboard access, visible focus, ARIA

### Operations
- [x] Seed data — one coherent tenant, every role, every pipeline stage
- [x] Background worker with retry and backoff
- [x] Health check
- [x] Documentation: README, ARCHITECTURE, SECURITY, DATABASE, API

---

## Not started

These are specified for later phases and the foundation supports each without
reshaping. See ARCHITECTURE.md §14.

- [ ] Client portal application surface (the `portal.*` data contract exists)
- [ ] Bidirectional Gmail / Microsoft email (Phase 1 is outbound only, by design)
- [ ] Renewal engine and forecasting (data model and sweep job exist)
- [ ] No-code automation builder UI (automations are already data)
- [ ] WhatsApp and Slack integrations
- [ ] Delivery profitability reporting
- [ ] Playwright browser tests (the logic is covered by 176 tests; these would
      cover rendering and interaction)
- [ ] SES adapter implementation (interface complete; needs `@aws-sdk/client-sesv2`)

---

## Defects found by tests, and fixed

Recorded because each was a genuine bug that only a test against real PostgreSQL
would have caught. Several are behaviours worth knowing about generally.

1. **`GRANT ... ON ALL TABLES` is evaluated at execution time.** The grant in
   migration 0003 covered only the tables that existed then; 60+ later tables had
   no privileges. Fixed with a dedicated grants migration and
   `ALTER DEFAULT PRIVILEGES`.

2. **The event outbox tried to write to a table users cannot write to.**
   `emitEvent` enqueued a job, but `authenticated` correctly has no INSERT on
   `jobs`. Rather than widening that privilege across every request path, the
   `events` table became the outbox itself.

3. **Trigger firing order made the wrong rule report the failure.** A direct
   `UPDATE ... SET stage = 'won'` was rejected by the *proposal* guard rather
   than the transition-channel guard, because PostgreSQL fires BEFORE triggers in
   name order. Channel guards renamed to `<table>_00_state_channel`.

4. **`RETURNING` is evaluated against the SELECT policy.** `insert ... returning *`
   on `events` required `audit:read:org`, so a salesperson could not create a
   client. Ids are now generated in the application and nothing is returned:
   writing must not imply reading.

5. **`INSERT ... ON CONFLICT DO NOTHING` also applies the SELECT policy.**
   PostgreSQL must see a conflicting row to decide to do nothing, so de-duplicated
   notification inserts could only ever target the caller. Fixed with
   `app.deliver_notification()`, which uses an EXCEPTION block.

6. **A table written with no UPDATE policy fails silently.**
   `signature_requests` had SELECT and INSERT policies but no UPDATE policy, so
   writing back the provider's request id matched zero rows and reported success —
   leaving every executed document unretrievable. The general lesson: every
   command a table is written with needs a policy *and* a test.

7. **A placeholder "system user" UUID violates foreign keys.** Background actors
   are now `NULL` with `actor_type` carrying the attribution, rather than a
   synthetic row every FK would need to know about.

8. **A parameter used twice with different inferred types.** `$16` was an integer
   in one position and text inside an interval expression.

9. **`date` was parsed inconsistently between drivers.** Now a string in both,
   because converting `2026-11-02` to a `Date` makes it 2026-11-01 west of UTC.

10. **`fromDatabaseError` labelled every failure a database error.** A plain
    `ReferenceError` inside a transaction was reported as `DATABASE_ERROR`,
    sending debugging to the wrong place. Only failures with a real SQLSTATE are
    classified that way now.

11. **A data-modifying CTE cannot see rows a sibling CTE inserted.** A test setup
    used one statement to insert a template, its version, and the pointer between
    them; the pointer was never set. Split into separate statements.

12. **`citext[]` needed an explicit cast.** Passing a JavaScript array to a
    `citext[]` column failed type inference.

---

## Architectural decisions

Recorded in full in [ARCHITECTURE.md](ARCHITECTURE.md). In brief:

| Decision | Why |
|---|---|
| Direct PostgreSQL, not PostgREST, for business data | A lifecycle change writes four tables and must be one transaction |
| Rules enforced twice | The application check gives a good error; the database check makes the rule true |
| Transitions are a channel, not a convention | The guards are only meaningful if state cannot move without them |
| Money never becomes a float | One answer, computed once, in the database |
| The accepted proposal version is frozen | Later edits cannot repoint the agreement |
| Execution is evidenced | Hashed by us, stored immutably, before the status moves |
| Humans hold consequential decisions | AI proposes; automations draft; people commit |
| Events are the outbox | Avoids granting every request path write access to the job queue |
| The portal is a separate projection | Hiding fields in React is not a boundary |

---

## Known issues and limitations

**Node 18.** The toolchain runs on Node 18.20.8; `@supabase/supabase-js` warns
that it wants Node 20+. Everything works, but Node 20 is recommended before
deployment.

**Storage is stubbed in tests.** Object storage is an in-memory map in the test
suite. Hashing, path construction, versioning and immutability run unchanged, but
the Supabase Storage client itself is not exercised.

**The Zoho Sign adapter has not been run against the live API.** It is written to
the documented API and its webhook verification is tested, but no calls have been
made to Zoho. The `manual` provider covers the whole workflow end to end, and is
what the E2E test uses.

**The SES adapter is deliberately unimplemented.** Hand-rolling a SigV4 signer
would be a liability next to the AWS SDK. The interface is complete; adding SES
means installing `@aws-sdk/client-sesv2` and filling in one method.

**FX rates must be loaded** before base-currency reporting shows totals.
`app.fx_rate_at` returns NULL rather than assuming parity — deliberate, and
documented in OPEN_QUESTIONS A9.

**Permission helper functions are `STABLE` and called per row.** Fine at current
scale. If a large tenant's list view becomes slow, the fix is to resolve the
scope once into a CTE, not to weaken the policy.

**Some Client 360 tabs are placeholders.** Services, Tasks, Emails and Reports
render an explanatory panel. The underlying data exists and is reachable through
the API; only these four panels are unbuilt.

**No Playwright tests yet.** The 176 tests cover logic, permissions, state
machines and the full workflow. Browser tests would cover rendering and
interaction, which they do not.
