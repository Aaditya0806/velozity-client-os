-- =============================================================================
-- 0020_diagnosis_claim_source.sql
-- A claim's source reference is text, not a uuid.
--
-- `source_kind` spans several kinds of thing, and they are not all uuid-keyed:
-- a `discovery_field` points at a field name, a `metric` at a metric key, while
-- a `document` or an `email` does have a uuid. Forcing all of them into a uuid
-- column would mean either losing the non-uuid cases or inventing identifiers
-- for them, and an invented provenance reference is worse than none.
--
-- The constraint that matters is unchanged and still enforced: a claim
-- attributed to the client must carry a source at all.
-- =============================================================================

alter table diagnosis_claims
  alter column source_id type text using source_id::text;

comment on column diagnosis_claims.source_id is
  'Identifier within source_kind. A uuid for document/email/contact; a field or metric key otherwise.';
