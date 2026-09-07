# Security

This document states the security model, the threats it addresses, and where each
control lives. Every claim here has a test behind it; the test file is named
alongside the claim.

---

## Principles

**Authentication is never authorization.** A valid session tells you who is
asking. It says nothing about what they may do. Those are resolved separately,
and the second one is re-derived from the database on every request.

**Deny by default.** RLS is enabled *and forced* on every tenant table. There are
no policies for the `anon` role anywhere, so an unauthenticated query returns
nothing everywhere.

**Defence in depth, with the database as the floor.** The application layer
produces good errors. The database layer makes rules true. A caller who forges a
permission set gets past the application check and is stopped by the database,
because the database resolves permissions from `user_roles` and never trusts
anything passed in from above. That exact attack is a test.

**Fail closed.** A missing FX rate returns NULL rather than assuming parity. A
missing template variable fails the render rather than inventing a value. An
unverified webhook is refused rather than processed.

---

## The tenant boundary

`org_id` on every business table, with RLS enabled and forced.

The active organisation arrives as a session GUC (`app.org_id`), and **the GUC is
only ever allowed to narrow access**:

```sql
create or replace function app.active_org_id() returns uuid as $$
  select case
    when app.current_org_id() is not null and app.is_org_member(app.current_org_id())
      then app.current_org_id()
    else null
  end
$$;
```

`app.is_org_member` checks membership against the database on every policy
evaluation. A forged GUC therefore yields `NULL`, and `org_id = NULL` matches no
row.

**Tested in `tests/integration/rls-tenant-isolation.test.ts` and
`tests/integration/security.test.ts`:**

| Attack | Result |
|---|---|
| Read another tenant's row by id | 0 rows |
| Present another tenant's `org_id` | 0 rows |
| Reach across tenants through a join | 0 rows |
| Reach across tenants through a subquery or aggregate | NULL |
| Update another tenant's row | 0 rows affected, value unchanged |
| Delete another tenant's row | 0 rows affected |
| Insert a row into another tenant | `FORBIDDEN` |
| Move an existing row into another tenant | Refused; row stays put |
| Read another tenant's audit log | 0 rows |

---

## Authentication

Supabase Auth, with password sign-in.

- **Uniform failure.** A wrong password and an unknown address produce the same
  message. Telling an attacker which addresses exist is a gift.
- **Rate limited two ways.** By email address and by IP, so neither a targeted
  attack on one account nor a spray across many is cheap.
- **Every attempt is audited**, successful or not, with IP and user agent.
- **Password reset always reports success**, whether or not the account exists.

### Session invalidation

`user_profiles.sessions_valid_from` is a watermark. A token issued before it is
refused:

```ts
if (auth.issuedAt < watermark) {
  throw new AppError('SESSION_EXPIRED', 'Your session is no longer valid.');
}
```

Deactivating an account takes effect immediately, rather than whenever the access
token happens to expire.

Deactivation is checked at three levels: the profile status, the membership
status, and `app.is_org_member` — which requires both to be active. A deactivated
user sees nothing even with a valid token.

---

## Authorization

`resource:action:scope` permissions resolved through
`users → user_roles → roles → role_permissions → permissions`.

### Separations that are load-bearing

| Separation | Why | Tested |
|---|---|---|
| `contract:send:org` is independent of deal ownership | The person who wants the deal closed should not be the only check on what goes to the client | `security.test.ts` |
| `contract:approve:org` ≠ `contract:send:org` | Usually different people | `happy-path.test.ts` |
| `legal:override:org` held only by Legal/Admin and Super Admin | Forcing delivery past unsigned paperwork is a governance act | `permission-catalog.test.ts` |
| `margin:read` / `cost:read` separate from record access | Seeing a client is not seeing its economics | `security.test.ts` |
| `finance:read` separate from client access | Seeing a client is not seeing their money | `security.test.ts` |

**There is deliberately no `contract:send:own`.** Adding one would reintroduce
exactly the coupling the separation removes.

### Field-level redaction

Sensitive fields are stripped **on the way out of the server**, not hidden in the
UI, so an API consumer cannot read them from the JSON:

```ts
const SENSITIVE_FIELD_PERMISSIONS = {
  margin_amount:  'margin:read:org',
  margin_percent: 'margin:read:org',
  cost_total:     'cost:read:org',
  unit_cost:      'cost:read:org',
  internal_notes: 'internal_note:read:org',
};
```

### Privilege escalation

**Tested in `tests/integration/security.test.ts`:**

| Attack | Result |
|---|---|
| Grant yourself a role | `FORBIDDEN` |
| Add a permission to a role you hold | `FORBIDDEN` |
| Invent a new permission | Refused — the catalogue is owned by migrations |
| Promote yourself to owner | 0 rows affected |
| Call a privileged service directly | `FORBIDDEN` |
| **Forge a permission set to satisfy the service layer** | Gets past the application check; **stopped by the database**; no override recorded |
| Write a lifecycle column directly | `FORBIDDEN` from the transition-channel guard |

---

## Input validation

Every endpoint validates params, query and body with Zod before the handler runs.
Beyond that:

**No SQL is built from user input.** All values are parameterised. The
`FilterBuilder` exists to make parameterisation the only option — callers supply
`?` placeholders and values, and it renumbers them.

**Sort columns come from an allow-list.** A column name reaches `ORDER BY` by
concatenation, so `safeOrderBy` accepts only names on a fixed list.

**Dynamic column names are validated.** Where an UPDATE is built from an object's
keys, `quote()` refuses anything that is not `^[a-z_][a-z0-9_]*$`.

**Filenames are sanitised.** Path separators, control characters and leading dots
are stripped before a name reaches a storage path or a `Content-Disposition`
header.

**SVG uploads are refused.** SVG can carry script, and these files are served
from a signed URL on a storage origin.

---

## Documents

| Control | Implementation |
|---|---|
| Private storage | Supabase bucket with public access off |
| Signed URLs only | 15-minute expiry, issued after a permission check |
| Permission checked before the URL exists | Confidential documents need `document:read_confidential:org` |
| Every issue recorded | `document_access_log` — append-only |
| SHA-256 on every version | Computed by us, from the exact bytes stored |
| Integrity verification | Re-hash on download; mismatch quarantines and refuses |
| No overwrites | New version, new path; `document_versions` refuses UPDATE |
| Immutability is one-way | Cannot be cleared, cannot be deleted, cannot receive new versions |

**Tested:** confidential documents hidden without permission; download refused;
sealed documents refuse new versions, deletion and unsealing; stored versions
cannot be mutated.

---

## Webhooks

The order of operations is the control:

1. read the raw body **once**;
2. **verify the signature**;
3. **store the event before interpreting it** — verified or not;
4. **refuse to process anything unverified**;
5. process idempotently on `(provider, provider_event_id)`;
6. retry with exponential backoff, capped, then mark dead.

Step 3 before step 4 is deliberate: a spoofed delivery is evidence.

**Signature verification is constant-time** and, for Resend, includes a
five-minute timestamp window so a correctly-signed old delivery cannot be
replayed.

**No configured secret means no processing.** `verifyWebhook` returns invalid
when the secret is absent, so a misconfigured deployment refuses webhooks rather
than trusting them.

**Tested in `tests/integration/security.test.ts`:** unsigned rejected; wrongly
signed rejected; rejected events stored as evidence; the processor refuses an
unverified event even when called directly; a critical audit record is written;
an unknown provider name is refused.

---

## AI

| Threat | Control |
|---|---|
| Model writes to the database | It cannot. Output becomes an `ai_action` requiring human approval; the `executed` status is unreachable except from `approved`, by trigger. |
| Model fabricates a client statement | `claim_type` is NOT NULL with a closed CHECK; `client_provided` requires a source; `ai_inference` requires a confidence. Unlabelled claims are unstorable. |
| Prompt injection from a document or transcript | Content is wrapped in `<untrusted_data>` with the closing tag stripped from the content first; the system prompt says instructions inside are to be reported, not obeyed; output is schema-validated regardless. |
| Model reads data the user cannot | Tools run in the user's own transaction, so RLS applies. Each declares its permission, re-checked at call time, not only when the tool list was built. |
| Model generates SQL | There is no tool that accepts SQL. Eight fixed read tools with validated parameters. |
| Model generates legal text | Templates contain variables only. AI may propose *values*; the renderer accepts nothing else and fails on a missing required variable. |
| Unnecessary PII sent to a provider | `minimisePii` strips identifiers a task does not need; ids travel instead of names where possible. |
| Organisation does not want AI at all | `organizations.ai_enabled = false` is checked before any call is made. |
| API key exposure | `ANTHROPIC_API_KEY` is read only through `lib/config/env.ts`, which imports `server-only`. |

Contract, commercial and scope-related actions are marked
`HIGH_STAKES_ACTIONS` and always require explicit field-level confirmation rather
than a blanket accept.

**Tested in `tests/integration/ai-guardrails.test.ts`** — 34 tests, including
that an unlabelled claim cannot be stored, that execution without approval is
refused by the database, that a reviewer's edits are re-validated, that a finance
tool is refused to a non-finance user even when the model names it directly, and
that supplied content cannot close its own delimiter.

---

## Automations

| Threat | Control |
|---|---|
| Automation sends something to a client | There is no `send_email` action and no `send_contract` action. Asserted by test. |
| Automation moves an entity through its lifecycle | `set_field` accepts an allow-list containing no lifecycle column. |
| Infinite loop | Chain depth (max 5) and a per-entity cooldown. Both checked before any action runs; suppressed runs are recorded. |
| Arbitrary code execution | Actions are a closed discriminated union. No expressions, no scripting, no HTTP action. |
| Condition reaching data it should not | Conditions evaluate against a snapshot assembled once, in advance, which excludes margin, cost and internal notes. |

---

## The audit log

Append-only, three ways:

1. **Triggers** refuse UPDATE and DELETE.
2. **Privileges** are revoked from `authenticated` *and* `service_role`.
3. **Policies** allow INSERT and SELECT only.

Applied to `audit_log`, `state_transitions`, `proposal_approvals`,
`document_versions`, `document_access_log`, `legal_overrides`, `signature_events`
and `email_events`.

**Tested:** UPDATE and DELETE refused on every one, even as `service_role`; and
`information_schema.role_table_grants` confirms no request role holds those
privileges on `audit_log`.

Audit writes join the caller's transaction: if the business change rolls back, so
does its audit record. A log of things that did not happen is worse than no log.

---

## The service-role escape hatch

`service_role` bypasses RLS. It is used only where there genuinely is no user:

- draining the job queue;
- processing a verified webhook, whose tenant is discovered from the payload;
- resolving a request's own identity and permissions;
- scheduled sweeps.

Three things keep it honest:

1. It is reached only through `withService(reason, fn)` — the reason is
   **required** and logged.
2. It is a different function name from `withTenant`, so its use is obvious in
   review: `grep withService` lists every occurrence.
3. Once a webhook's tenant is known, `tx.bindOrg()` sets both the GUC and the
   transaction context together, so the two cannot disagree.

---

## Transport and headers

Set in `next.config.mjs` for every response:

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Cross-Origin-Opener-Policy: same-origin
```

`poweredByHeader` is off.

**Cookies** are `httpOnly`, `sameSite: lax`, and `secure` in production.

**CSRF.** State-changing endpoints accept JSON only and are same-origin; `lax`
cookies are not sent on cross-site POSTs. The organisation-switch cookie is
validated against actual membership, and RLS re-checks it regardless — so even a
forged cookie yields an empty workspace rather than another tenant's data.

---

## Error handling

**No stack trace, SQL fragment or connection string ever reaches a client.**

`AppError` carries a stable machine code and a message written for a human
operator. Anything else is logged in full and reported as `INTERNAL_ERROR` with
no detail.

Database errors are translated by SQLSTATE, and **only** failures carrying a real
SQLSTATE are classified as database errors — a plain JavaScript error reported as
`DATABASE_ERROR` sends whoever debugs it to the wrong place.

Every response carries `request_id`, so a user can quote one number and an
operator can find the exact transaction across logs, audit and events.

**Logs are redacted by key name**: `password`, `token`, `secret`, `api_key`,
`authorization`, `cookie`, `signature` and others are replaced before writing.

---

## Rate limiting

Fixed-window counters in PostgreSQL, per user and per bucket:

| Bucket | Limit |
|---|---|
| `auth` | 10 / minute |
| `read` | 600 / minute |
| `write` | 120 / minute |
| `external` (contract send, payments) | 20 / minute |
| `ai` | 30 / minute |

Auth is additionally limited by IP.

---

## Idempotency

Every endpoint with an external effect requires an `Idempotency-Key`:

- `POST /api/v1/signature-requests`
- `POST /api/v1/payments`
- `POST /api/v1/onboardings/{id}/override`
- `POST /api/v1/proposals/versions/{id}/send`

The request body is hashed. A replay with the same body returns the stored
response; a replay with a **different** body is rejected as
`IDEMPOTENCY_KEY_REUSED` rather than silently served a stale result.

---

## Reporting a vulnerability

Email the maintainers rather than opening a public issue. Please include the
`request_id` from any response involved — it is the fastest path to the exact
transaction in the logs, the audit trail and the event stream.
