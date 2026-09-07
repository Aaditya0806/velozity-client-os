# API

Resource-oriented REST under `/api/v1`. 59 endpoints.

---

## Conventions

### Every response carries a request id

```json
{ "data": { }, "request_id": "req_a1b2c3d4e5f6" }
```

Also returned as the `x-request-id` header. A user can quote one number and an
operator can find the exact transaction across the logs, the audit trail and the
event stream.

### Errors have a stable machine code

```json
{
  "error": {
    "code": "PROPOSAL_NOT_APPROVED",
    "message": "An internally approved proposal version is required before sending."
  },
  "request_id": "req_a1b2c3d4e5f6"
}
```

Branch on `code`, not on `message`. Messages are written for people and may be
reworded.

Where useful, `details` says what to do about it:

```json
{
  "error": {
    "code": "OPPORTUNITY_QUALIFICATION_INCOMPLETE",
    "message": "This opportunity cannot move to \"qualified\" until the qualification details are complete.",
    "details": { "missing": ["business_problem", "budget_indication", "decision_maker"] }
  },
  "request_id": "req_..."
}
```

**No stack trace, SQL fragment or connection string ever appears in a response.**
Anything unexpected is logged in full and returned as `INTERNAL_ERROR` with no
detail.

### Pagination

```json
{
  "data": [ ],
  "request_id": "req_...",
  "meta": {
    "pagination": { "page": 1, "page_size": 25, "total": 143, "total_pages": 6, "has_more": true }
  }
}
```

Query: `?page=1&page_size=25&sort=name&direction=asc&q=search`.

Sort columns come from a fixed allow-list per endpoint; an unrecognised value
falls back to the default rather than erroring, so a stale bookmark still works.

### Money

Decimal **strings**, never JSON numbers. `"32400.00"`, not `32400.00`. Currency
is always adjacent.

### Dates

`YYYY-MM-DD` strings for calendar dates. ISO 8601 with offset for instants.

---

## Authentication

Session cookies, set by `POST /api/v1/auth/sign-in` and refreshed by middleware.

An unauthenticated API request returns 401 rather than a redirect.

Authentication is resolved separately from authorization. Every endpoint declares
the permission it needs, RLS restricts the rows regardless, and neither trusts the
other.

---

## Idempotency

Endpoints with an external effect require an `Idempotency-Key` header:

```
POST /api/v1/signature-requests
POST /api/v1/payments
POST /api/v1/onboardings/{id}/override
POST /api/v1/onboardings/{id}/provision
POST /api/v1/proposals/versions/{id}/send
POST /api/v1/proposals/versions/{id}/accept
POST /api/v1/signature-requests/{id}/void
```

The request body is hashed alongside the key:

- **Same key, same body** → the stored response, with `idempotent-replay: true`.
- **Same key, different body** → `409 IDEMPOTENCY_KEY_REUSED`. A client bug is
  reported rather than silently served a stale result.
- **Same key, still in flight** → `409 CONFLICT`.

Keys expire after 24 hours.

---

## Rate limits

| Bucket | Limit | Applies to |
|---|---|---|
| `auth` | 10/min | Sign-in, password reset (per address *and* per IP) |
| `read` | 600/min | GET |
| `write` | 120/min | POST, PATCH, PUT, DELETE |
| `external` | 20/min | Idempotent endpoints |
| `ai` | 30/min | `/api/v1/ai/*` |

Exceeding one returns `429 RATE_LIMITED`.

---

## Transitions

Lifecycle state never changes through `PATCH`. It changes through a transitions
endpoint, and the database rejects any other route.

```http
POST /api/v1/opportunities/{id}/transitions
Content-Type: application/json

{ "to": "won", "reason": "Signed at the board meeting", "payload": {} }
```

```json
{
  "data": {
    "id": "…", "from": "negotiation", "to": "won",
    "transition_id": "…", "entity": { }
  },
  "request_id": "req_…"
}
```

`GET` on the same path returns the current state, the moves currently available,
and the full ledger:

```json
{
  "data": {
    "current_stage": "negotiation",
    "available": ["won", "proposal_sent", "lost", "dormant"],
    "history": [ ]
  }
}
```

`available` comes from the server's own state machine, so a client need not
hardcode it.

A refused transition explains itself:

| Code | Meaning |
|---|---|
| `INVALID_TRANSITION` | The edge does not exist; `details.allowed` lists what does |
| `OPPORTUNITY_QUALIFICATION_INCOMPLETE` | `details.missing` names the fields |
| `PROPOSAL_NOT_APPROVED` | No internally approved version exists |
| `PROPOSAL_NOT_ACCEPTED` | No accepted proposal |
| `LEGAL_GATE_BLOCKED` | `details.unmet` lists the outstanding requirements |
| `CONTRACT_TERMINAL` | Fully executed; create an amendment instead |

---

## Endpoints

### Identity

| Method | Path | Permission |
|---|---|---|
| POST | `/auth/sign-in` | public |
| POST | `/auth/sign-out` | authenticated |
| POST | `/auth/reset-password` | public |
| GET | `/me` | authenticated |
| POST | `/me/organization` | membership of the target |

`GET /me` returns the user, the organisation, and the caller's **effective
permission list** — the client uses it to decide what to render, and the server
re-checks everything regardless.

### Clients and contacts

| Method | Path | Permission |
|---|---|---|
| GET | `/clients` | `company:read:*` |
| POST | `/clients` | `company:create:org` |
| GET | `/clients/{id}` | `company:read:*` |
| PATCH | `/clients/{id}` | `company:update:*` |
| DELETE | `/clients/{id}` | `company:delete:*` (archives; requires a reason) |
| GET | `/clients/{id}/overview` | `company:read:*` |
| GET | `/clients/{id}/timeline` | `company:read:*` |
| GET | `/clients/{id}/billing` | **`finance:read:org`** |
| GET/POST | `/contacts` | `contact:read:*` / `contact:create:org` |
| GET/PATCH/DELETE | `/contacts/{id}` | `contact:*` |

Seeing a client does not imply seeing their money: `/billing` needs its own
permission, and `/overview` omits the billing block rather than failing.

### Pipeline

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/opportunities` | |
| GET/PATCH | `/opportunities/{id}` | `stage` is **not** in the update schema |
| GET/POST | `/opportunities/{id}/transitions` | The only way stage changes |
| POST | `/opportunities/lead-capture` | Company + contact + opportunity in one transaction |

### Services and solutions

| Method | Path | Permission |
|---|---|---|
| GET/POST | `/services` | `service:read:org` / `service:manage:org` |
| GET/PATCH/DELETE | `/services/{id}` | DELETE archives — a service named on a signed contract must stay resolvable |
| POST | `/solutions` | `opportunity:update:*` |
| GET/PATCH | `/solutions/{id}` | |
| POST | `/solutions/{id}/duplicate` | For revising a solution already used on a proposal |

### Proposals

| Method | Path | Permission |
|---|---|---|
| GET/POST | `/proposals` | `proposal:read:*` / `proposal:create:org` |
| GET | `/proposals/{id}` | |
| POST | `/proposals/{id}` | Cuts a new draft version |
| PATCH | `/proposals/versions/{versionId}` | Requires `revision` |
| POST | `/proposals/versions/{versionId}/submit` | For internal review |
| POST | `/proposals/versions/{versionId}/approve` | **`proposal:approve:org`** |
| POST | `/proposals/versions/{versionId}/send` | **`proposal:send:org`**, idempotent |
| POST | `/proposals/versions/{versionId}/accept` | Records the client's decision |

**Optimistic concurrency.** Editing a version requires the revision you read:

```json
{ "revision": 3, "title": "…", "sections": [ ] }
```

A mismatch is `409 PROPOSAL_VERSION_CONFLICT`, carrying everything a conflict UI
needs:

```json
{
  "error": {
    "code": "PROPOSAL_VERSION_CONFLICT",
    "message": "This proposal was changed by someone else while you were editing.",
    "details": {
      "your_revision": 3,
      "current_revision": 4,
      "updated_at": "2026-09-04T11:22:33Z",
      "current": { }
    }
  }
}
```

An accepted version is immutable: `422 PROPOSAL_VERSION_IMMUTABLE`.

### Legal

| Method | Path | Permission |
|---|---|---|
| GET/POST | `/contracts` | `contract:read:*` / `contract:create:org` |
| GET | `/contracts/{id}` | Includes a `readiness` block naming missing variables |
| POST | `/contracts/{id}/render` | Fails on a missing required variable |
| PUT | `/contracts/{id}/signers` | At least one per side |
| GET/POST | `/contracts/{id}/transitions` | Routed by authority (see below) |
| POST | `/signature-requests` | **`contract:send:org`**, idempotent |
| POST | `/signature-requests/{id}/void` | **`contract:void:org`**, idempotent |

`POST /contracts/{id}/transitions` routes each target to the authority it needs:

| `to` | Requires |
|---|---|
| `internal_review` | `contract:update:*` |
| `approved_to_send` | `contract:approve:org` |
| `voided` | `contract:void:org` + a reason |
| `sent` | **Refused.** Has an external effect; use `/signature-requests` |
| `fully_executed` | **Refused.** Reached only through a verified webhook |

Rendering fails rather than guessing:

```json
{
  "error": {
    "code": "MISSING_TEMPLATE_VARIABLE",
    "message": "This contract cannot be produced: 2 required value(s) are missing.",
    "details": {
      "missing": [
        { "key": "effective_date", "label": "Effective date", "source_hint": null },
        { "key": "contract_value", "label": "Contract value", "source_hint": "proposal.total" }
      ]
    }
  }
}
```

### Documents

| Method | Path | Notes |
|---|---|---|
| GET | `/documents` | |
| POST | `/documents/upload` | multipart: `file` + JSON `metadata` |
| GET/DELETE | `/documents/{id}` | DELETE archives; refused on a sealed document |
| GET | `/documents/{id}/download` | Signed URL, 15-minute expiry |

`?verify=true` on download re-hashes the stored bytes first. A mismatch
quarantines the document and returns `500 DOCUMENT_HASH_MISMATCH` rather than
serving the file.

```json
{
  "data": {
    "url": "https://…/storage/…?token=…",
    "expires_at": "2026-09-04T12:15:00Z",
    "file_name": "MSA-000001-executed.pdf",
    "sha256": "e3b0c442…"
  }
}
```

### Onboarding

| Method | Path | Permission |
|---|---|---|
| POST | `/onboardings` | `onboarding:manage:org` |
| GET | `/onboardings/{id}` | Requirements with satisfaction state, and the gate |
| GET | `/onboardings/{id}/transitions` | The current gate evaluation |
| POST | `/onboardings/{id}/transitions` | `to: "ready"` runs the gate |
| POST | `/onboardings/{id}/override` | **`legal:override:org`**, idempotent |
| POST | `/onboardings/{id}/provision` | Creates the delivery workspace, idempotent |

A blocked gate says exactly what is outstanding:

```json
{
  "error": {
    "code": "LEGAL_GATE_BLOCKED",
    "message": "Onboarding is blocked by 2 outstanding legal requirement(s).",
    "details": {
      "unmet": [
        { "requirement_id": "…", "label": "Executed master services agreement",
          "kind": "document", "contract_type": "msa" },
        { "requirement_id": "…", "label": "Advance on signature",
          "kind": "payment", "payment_requirement_id": "…" }
      ]
    }
  }
}
```

The override requires a written reason of at least 20 characters, and there is no
endpoint to undo it.

### Delivery

| Method | Path | |
|---|---|---|
| GET | `/projects` | |
| GET/PATCH | `/projects/{id}` | |
| GET/POST | `/projects/{id}/transitions` | |
| GET/POST | `/tasks` | `?scope=mine\|team\|overdue\|due_soon\|completed\|all` |
| GET/PATCH | `/tasks/{id}` | |

Completing a task with an unfinished blocking predecessor is refused, and names
what it is waiting on:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "This task depends on 2 unfinished task(s).",
    "details": { "blocked_by": ["Audit current analytics", "Implement tracking"] }
  }
}
```

### Finance

| Method | Path | Permission |
|---|---|---|
| GET | `/payments` | `finance:read:org` |
| POST | `/payments` | `payment:manage:org`, idempotent |
| POST | `/payment-requirements` | `finance:manage:org` |
| POST | `/payment-requirements/{id}/waive` | `finance:manage:org` + a reason |

A payment with no FX rate on file is refused rather than recorded at an assumed
parity:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "No exchange rate is on file for GBP to USD. Add one before recording this payment.",
    "details": { "from": "GBP", "to": "USD" }
  }
}
```

### AI

| Method | Path | Permission |
|---|---|---|
| POST | `/ai/ask` | `ai:use:org` |
| POST | `/ai/actions/{id}` | `ai:approve:org` |

`/ai/ask` returns the answer **and the tool calls that produced it**, so the
working can be checked:

```json
{
  "data": {
    "answer": "Three clients are showing risk signals…",
    "tool_calls": [
      { "tool": "list_at_risk_clients", "ok": true, "rowCount": 3, "durationMs": 41 }
    ],
    "usage": { "inputTokens": 2140, "outputTokens": 312, "costUsd": "0.011100" },
    "prompt_version": "2026-09-01.1"
  }
}
```

The request runs in a **read-only** transaction. The assistant's tools cannot
write, and the transaction enforces that rather than trusting them to behave.

`/ai/actions/{id}` records a decision and, on approval, applies it in the same
transaction:

```json
{ "decision": "approve", "edited_payload": { } }
```

An edited payload is re-validated against the same schema — a reviewer
hand-editing JSON can break it as easily as a model can.

### Reporting

| Method | Path | |
|---|---|---|
| GET | `/dashboard` | Filters: `from`, `to`, `owner_user_id`, `company_id` |
| GET | `/search` | `?q=` — across everything the caller can see |
| GET/PATCH | `/notifications` | |

Blocks the caller may not see are returned as `{ "permitted": false }` rather
than being omitted, so a client can tell "no access" from "no data".

### Webhooks

```
POST /api/v1/webhooks/{provider}
```

Providers: `zoho_sign`, `manual`.

| Response | Meaning |
|---|---|
| `202` | Accepted and queued (or recognised as a duplicate) |
| `401 WEBHOOK_SIGNATURE_INVALID` | Signature not verified. Stored as evidence, never processed. |
| `404` | Unknown provider |

A `4xx` is returned only for a genuinely unusable request. A provider that
receives `5xx` retries; one that receives `4xx` usually gives up — and giving up
on a real signature event is worse.

### Health

```
GET /api/v1/health  →  { "status": "ok" }   |   503 { "status": "degraded" }
```

Says nothing about the deployment beyond up or down.

---

## Error codes

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request failed validation; `details.issues` lists fields |
| `INVALID_TRANSITION` | 400 | The state machine does not define that edge |
| `INVALID_STATE` | 400 | The entity is not in a state where this makes sense |
| `MISSING_TEMPLATE_VARIABLE` | 400 | A required contract variable has no value |
| `CURRENCY_MISMATCH` | 400 | An allocation's currency differs from its payment |
| `OVER_ALLOCATED` | 400 | Allocations would exceed the payment |
| `UNAUTHENTICATED` | 401 | Not signed in, or credentials rejected |
| `SESSION_EXPIRED` | 401 | Token issued before the session watermark |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | Webhook signature not verified |
| `FORBIDDEN` | 403 | Authenticated, but not permitted |
| `ACCOUNT_DEACTIVATED` | 403 | Account disabled |
| `NOT_A_MEMBER` | 403 | Not a member of the requested organisation |
| `NOT_FOUND` | 404 | Does not exist, or is not visible to you |
| `CONFLICT` | 409 | Concurrent modification, or a dependency blocks the action |
| `PROPOSAL_VERSION_CONFLICT` | 409 | Optimistic concurrency failure |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same key, different body |
| `ALREADY_EXISTS` | 409 | Unique constraint |
| `OPPORTUNITY_QUALIFICATION_INCOMPLETE` | 422 | `details.missing` names the fields |
| `PROPOSAL_NOT_APPROVED` | 422 | No internally approved version |
| `PROPOSAL_NOT_ACCEPTED` | 422 | No accepted proposal |
| `PROPOSAL_VERSION_IMMUTABLE` | 422 | Accepted versions cannot be edited |
| `ACCEPTED_VERSION_FROZEN` | 422 | The accepted version pointer cannot change |
| `CONTRACT_NOT_APPROVED` | 422 | Must be approved before sending |
| `CONTRACT_TERMINAL` | 422 | Fully executed; use an amendment |
| `CONTRACT_IMMUTABLE` | 422 | Executed contracts cannot be modified |
| `EXECUTED_DOCUMENT_REQUIRED` | 422 | Cannot mark executed without the document |
| `LEGAL_GATE_BLOCKED` | 422 | `details.unmet` lists outstanding requirements |
| `OVERRIDE_PERMANENT` | 422 | A recorded override cannot be removed |
| `DOCUMENT_IMMUTABLE` | 422 | Sealed documents cannot be changed or deleted |
| `AI_ACTION_NOT_PENDING` | 422 | Already decided |
| `AI_ACTION_NOT_APPROVED` | 422 | Cannot execute without approval |
| `AI_DISABLED` | 422 | AI is off for this organisation |
| `RATE_LIMITED` | 429 | Too many requests |
| `PROVIDER_ERROR` | 502 | An external provider rejected the request |
| `PROVIDER_UNAVAILABLE` | 503 | An external provider is unreachable or unconfigured |
| `DOCUMENT_HASH_MISMATCH` | 500 | Stored bytes do not match the recorded hash; quarantined |
| `DATABASE_ERROR` | 500 | Database failure |
| `INTERNAL_ERROR` | 500 | Anything else. No detail is returned. |
