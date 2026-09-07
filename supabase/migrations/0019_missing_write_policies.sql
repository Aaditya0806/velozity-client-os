-- =============================================================================
-- 0019_missing_write_policies.sql
-- Policies for writes that had no matching policy.
--
-- With FORCE ROW LEVEL SECURITY and no UPDATE policy, an UPDATE does not error:
-- it matches zero rows and reports success. That is the worst possible failure
-- mode, because the calling code sees no problem. `signature_requests` was in
-- exactly that state - the row could be created but the provider's request id
-- could never be written back, leaving every executed document unretrievable.
--
-- The lesson is general: a table that is written must have a policy for every
-- command it is written with, and a test that exercises the write.
-- =============================================================================

-- Writing back the provider reference, status and completion is part of sending
-- a contract, so it carries the same authority.
create policy signature_requests_update on signature_requests for update to authenticated
  using (
    org_id = app.active_org_id()
    and app.has_permission(org_id, 'contract:send:org')
  )
  with check (org_id = app.active_org_id());

-- Voiding a request in flight.
create policy signature_requests_void on signature_requests for update to authenticated
  using (
    org_id = app.active_org_id()
    and app.has_permission(org_id, 'contract:void:org')
  )
  with check (org_id = app.active_org_id());

-- Diagnosis claims are written by whoever may edit the opportunity; the diagnosis
-- record itself already had a FOR ALL policy but claims only covered the
-- existence of the parent, not the update path on a claim's acceptance columns.
create policy diagnosis_claims_review on diagnosis_claims for update to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'opportunity', 'update'))
  with check (org_id = app.active_org_id());

-- Marking a notification read is already covered; archiving one is the same act.
-- (notifications_update covers both; nothing to add.)

-- Events carry a dispatch status. The dispatcher runs as service_role, which
-- bypasses RLS, but an operator retrying a stuck event from the UI needs a path.
create policy events_update on events for update to authenticated
  using (org_id = app.active_org_id() and app.can(org_id, 'automation', 'manage'))
  with check (org_id = app.active_org_id());
