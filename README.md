# Velozity Business OS

A business operating system for the whole client lifecycle:

```
Lead → Qualification → Discovery → Diagnosis → Solution → Proposal →
Negotiation → Won → NDA → Agreement → Payment → Onboarding → Project →
Tasks → Deliverables → KPIs → Reporting → Renewal
```

It joins the pieces that usually live in separate tools — CRM, proposals, legal,
e-signature, delivery, finance — so that the connections between them can be
enforced rather than remembered. Winning a deal is what produces an NDA. An
executed agreement is what unblocks delivery. A project's plan comes from the
service that was actually sold.

---

## Contents

- [What makes this different](#what-makes-this-different)
- [Requirements](#requirements)
- [Setup](#setup)
- [Environment variables](#environment-variables)
- [Supabase setup](#supabase-setup)
- [Database migrations](#database-migrations)
- [Seed process](#seed-process)
- [Local development](#local-development)
- [Testing](#testing)
- [Deployment](#deployment)
- [Production checklist](#production-checklist)
- [Further reading](#further-reading)

---

## What makes this different

Five decisions shape everything else. Each is documented at length in
[ARCHITECTURE.md](ARCHITECTURE.md); the summary is:

**Rules are enforced twice, deliberately.** Every consequential rule exists as an
application check *and* as a database constraint or trigger. The application
check produces an error a person can act on. The database check makes the rule
true even for a code path that forgets to ask. A test asserts the two agree.

**State changes are a channel, not a convention.** `UPDATE opportunities SET
stage = 'won'` is rejected by the database. Lifecycle columns move only inside a
transaction the transition service has marked, so the guards cannot be skipped.

**Money never becomes a float.** `numeric(14,2)` in the database, decimal strings
over the wire, `Decimal` in between. Every total is computed by PostgreSQL.

**Execution is evidenced, not asserted.** A contract reaches `fully_executed`
only after a verified webhook, the executed file downloaded, hashed by us, and
stored immutably. The database refuses "executed" with no executed document.

**Humans hold the consequential decisions.** The AI proposes an action a person
approves. Automations may draft an email; there is no `send_email` action, and no
`send_contract` action either.

---

## Requirements

| | |
|---|---|
| Node.js | 20 or later recommended. 18.18+ works; `@supabase/supabase-js` warns on 18. |
| PostgreSQL | 15+ (Supabase provides this) |
| Supabase project | For Auth and Storage |

The test suite needs neither PostgreSQL nor Docker — it runs against
[PGlite](https://pglite.dev), which is PostgreSQL 18 compiled to WebAssembly.

---

## Setup

```bash
git clone <repository>
cd velozity-os
npm install

cp .env.example .env
# Fill in DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY at minimum.

npm run db:migrate
npm run db:seed        # development only
npm run dev
```

Open http://localhost:3000.

---

## Environment variables

Every variable is documented in [.env.example](.env.example). The ones you
cannot start without:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Direct PostgreSQL connection. Every user-facing query goes through this, as the `authenticated` role, so RLS applies. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Authentication. |
| `SUPABASE_SERVICE_ROLE_KEY` | Storage operations and background jobs. Bypasses RLS — never reaches a browser. |
| `APP_SECRET` | Signs internal tokens. At least 32 characters. |

Optional, and off by default:

| Variable | Effect when unset |
|---|---|
| `ANTHROPIC_API_KEY` | AI features report that they are not configured. Nothing else changes. |
| `RESEND_API_KEY` | `EMAIL_PROVIDER=noop` records and logs messages without sending. |
| `ZOHO_SIGN_*` | `SIGNATURE_PROVIDER=manual` runs the entire legal workflow locally. |

**`NEXT_PUBLIC_` is the boundary.** Anything with that prefix is compiled into
the browser bundle. Nothing secret carries it. `lib/config/env.ts` imports
`server-only`, so importing it from a client component is a build error rather
than a leak.

---

## Supabase setup

1. **Create a project** at [supabase.com](https://supabase.com).

2. **Copy the connection string** from Settings → Database into `DATABASE_URL`.
   Use the session pooler for serverless deployments.

3. **Create the storage bucket.** Storage → New bucket → name `documents`,
   **Public: off**. Files are reachable only through signed URLs that expire in
   15 minutes, issued after a permission check and recorded in the access log.

4. **Configure Auth.** Authentication → Providers → Email. Turn on "Confirm
   email" for production. Set the Site URL to your `APP_URL`.

5. **Run the migrations** (below). They create the `authenticated` and
   `service_role` grants the application expects; on Supabase those roles already
   exist and the migration is a no-op for them.

---

## Database migrations

Plain `.sql` files in `supabase/migrations/`, applied in filename order, each in
its own transaction, with its SHA-256 recorded.

```bash
npm run db:migrate      # apply pending migrations
npm run db:reset        # drop and recreate the schema, then apply (never in production)
```

**An applied migration whose file has changed is a hard error.** Editing history
is how two environments quietly diverge; create a new migration instead.

Migrations are the only way the schema changes. There is no "sync" step and no
schema generated from code.

---

## Seed process

```bash
npm run db:seed
```

Creates one demo organisation with eight people across every role, a service
catalogue, seven clients (including a multi-entity group), opportunities in every
pipeline stage, contract and email templates, and two automations.

Every seeded row has `is_demo = true`. That is a database column, not a naming
convention, so a production database can be audited for accidental demo data with
one predicate.

**Signing in as a demo user.** The seed creates `user_profiles` rows and their
`auth.users` counterparts, but does not set passwords — writing passwords into a
seed script is how a default credential ends up in production. Set one through
the Supabase dashboard (Authentication → Users), or with the admin API:

```bash
curl -X POST "$SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@velozity.demo","password":"<choose one>","email_confirm":true}'
```

The seeded accounts, each with genuinely different permissions:

| Email | Role | Notably can / cannot |
|---|---|---|
| `admin@velozity.demo` | Super Admin | Everything |
| `md@velozity.demo` | Management | Sees margin and cost; cannot override the legal gate |
| `legal@velozity.demo` | Legal / Admin | Only role besides Super Admin that can send contracts or override the gate |
| `finance@velozity.demo` | Finance | Owns money; no legal authority |
| `sales@velozity.demo` | Sales | Team-scoped pipeline; **cannot** send contracts or see margin |
| `pm@velozity.demo` | Project Manager | Owns delivery org-wide |
| `delivery@velozity.demo` | Delivery | Own tasks only |

---

## Local development

```bash
npm run dev            # application
npm run worker         # background jobs and event dispatch
npm run typecheck
npm run lint
```

The worker drains the event outbox and the job queue. Without it the application
still works, but automations do not fire, executed contracts are not downloaded,
and scheduled sweeps do not run. In production it is a separate process; in
development a second terminal is enough.

`npm run worker -- --once` runs a single batch and exits, which is what you want
from cron or a scheduled function.

### Project structure

```
app/
  (auth)/               sign-in, password reset
  (dashboard)/          the authenticated application
  api/v1/               REST endpoints
components/
  ui/                   design system primitives
  layout/               shell, navigation, command bar
lib/
  ai/                   model client, action framework, read tools, prompts
  audit/                the immutable audit log
  auth/                 Supabase clients, session and request context
  automation/           WHEN → IF → THEN engine
  contracts/            template renderer
  db/                   pg driver, transactions, migrator
  documents/            storage, hashing, versioning
  email/                provider abstraction
  events/               transactional outbox, activities, notifications
  http/                 route wrapper, errors, responses, rate limiting
  jobs/                 queue and worker
  permissions/          catalogue and checks
  services/             domain services
  signature/            e-signature provider abstraction
  workflows/            state machine, executed documents, provisioning
supabase/
  migrations/           the schema, in order
  seed/                 development data
tests/
  unit/ integration/ e2e/
```

---

## Testing

```bash
npm test                    # everything
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:watch
```

**176 tests**, running against real PostgreSQL. RLS policies, triggers and
constraints under test are the same ones that run in production — a test that
proves one tenant cannot read another's data proves it against real policy
evaluation, not a mock.

| Suite | Covers |
|---|---|
| `rls-tenant-isolation` | Cross-tenant reads, writes, joins, forged org context, deactivated users |
| `permission-catalog` | TypeScript and database catalogues agree; role separation holds |
| `opportunity-lifecycle` | Stage guards, the transition channel, lost reasons, the ledger |
| `contract-renderer` | Deterministic substitution; failure on a missing variable |
| `automation-engine` | Conditions, cooldown, chain depth, no send action exists |
| `ai-guardrails` | Provenance validation, approval before execution, tool restrictions, injection defences |
| `security` | Every attack the specification names, performed and refused |
| `seed` | The seed runs and produces coherent data |
| `happy-path` (e2e) | Lead → qualified → proposal → won → NDA → e-sign → MSA → payment → onboarding → project |

The end-to-end test is the acceptance criterion for the critical workflow. It
substitutes only object storage (an in-memory map); hashing, versioning and
immutability run unchanged.

---

## Deployment

### Application

Any host that runs Next.js 15. Vercel needs no configuration beyond the
environment variables.

```bash
npm run build
npm start
```

### Worker

A separate long-running process:

```bash
NODE_ENV=production npm run worker
```

Or on a scheduler, every minute:

```bash
NODE_ENV=production npm run worker -- --once
```

### Migrations

Run before deploying application code, so the new schema is present when the new
code arrives:

```bash
NODE_ENV=production npm run db:migrate
```

### Webhooks

Point your providers at:

```
POST https://your-domain/api/v1/webhooks/zoho_sign
POST https://your-domain/api/v1/webhooks/resend
```

Set the corresponding `*_WEBHOOK_SECRET`. **Without a configured secret, webhooks
are stored and rejected, never processed** — a contract cannot be marked executed
by an unverified callback.

---

## Production checklist

**Before the first deployment**

- [ ] `APP_SECRET` is a fresh random value of at least 32 characters
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is set in the server environment only, never as `NEXT_PUBLIC_`
- [ ] The `documents` storage bucket exists and is **not public**
- [ ] `DATABASE_SSL=true`
- [ ] `RATE_LIMIT_ENABLED=true`
- [ ] Email confirmation is on in Supabase Auth
- [ ] `SENTRY_DSN` is set
- [ ] `LOG_LEVEL=info` (not `debug` — debug logs query errors)
- [ ] Migrations applied; `npm run db:migrate` reports no pending work
- [ ] **No demo data**: `select count(*) from organizations where is_demo` returns 0

**Verify the security posture**

- [ ] `npm test` passes, including the `security` suite
- [ ] Every tenant table has RLS enabled *and* forced:
      ```sql
      select relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (not c.relrowsecurity or not c.relforcerowsecurity);
      ```
      Three tables legitimately appear, and only these three:
      `schema_migrations` (owned by the migrator), `rate_limit_counters`
      (service-role only, no policies by design) and `permissions` (global
      reference data owned by migrations, readable by all, writable by none).
- [ ] No `anon` policies exist:
      ```sql
      select tablename, policyname from pg_policies
      where schemaname = 'public' and 'anon' = any(roles);
      ```
      Should return nothing.
- [ ] The audit log is append-only for every request role:
      ```sql
      select grantee, privilege_type from information_schema.role_table_grants
      where table_name = 'audit_log' and privilege_type in ('UPDATE','DELETE');
      ```
      Should return nothing.

**Operational**

- [ ] The worker process is running and monitored
- [ ] FX rates are loaded for every currency you trade in — `app.fx_rate_at`
      returns NULL rather than assuming parity, so base-currency reporting will
      show nothing without them
- [ ] Contract templates exist and are `active` for every type you use
- [ ] Backups are configured and a restore has been tested
- [ ] Alerts on: dead jobs (`jobs where status = 'dead'`), failed webhooks
      (`webhook_events where status = 'failed'`), and any
      `audit_log where severity = 'critical'`

---

## Further reading

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Why the system is shaped this way, and the trade-offs taken |
| [SECURITY.md](SECURITY.md) | The security model, threats, and how each is addressed |
| [DATABASE.md](DATABASE.md) | Schema, RLS patterns, and the constraints that carry business rules |
| [API.md](API.md) | REST conventions, endpoints, errors, idempotency |
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | What is built, what is not, and defects found along the way |
| [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) | Assumptions made where the specification was silent |
