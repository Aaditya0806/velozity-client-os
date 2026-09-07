-- =============================================================================
-- 0017_grants.sql
-- Table privileges, applied after every table exists.
--
-- GRANT ... ON ALL TABLES is evaluated at execution time, so the grant in 0003
-- only covered the handful of tables that existed then. This migration is the
-- authoritative one; it also installs default privileges so a table added by a
-- future migration is usable without anyone remembering to come back here.
--
-- These are only the outer bound. RLS narrows every one of them, and the
-- revokes below carve out the append-only tables so that "immutable" is a
-- privilege fact and not merely a trigger that a future superuser might drop.
-- =============================================================================

grant usage on schema public to authenticated, service_role;
grant usage on schema app to authenticated, service_role;
grant usage on schema portal to authenticated, service_role;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant execute on all functions in schema app to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to authenticated, service_role;
alter default privileges in schema app
  grant execute on functions to authenticated, service_role;

-- `anon` reaches nothing. Unauthenticated access to business data is not a
-- policy decision in this system; it is an absence of privilege.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema portal from anon;
revoke all on schema app from anon;

-- -----------------------------------------------------------------------------
-- Append-only tables: no UPDATE, no DELETE, for anyone reachable from a request.
-- -----------------------------------------------------------------------------
revoke update, delete on audit_log                from authenticated, service_role;
revoke update, delete on state_transitions        from authenticated, service_role;
revoke update, delete on proposal_approvals       from authenticated, service_role;
revoke update, delete on document_versions        from authenticated;
revoke update, delete on document_access_log      from authenticated, service_role;
revoke update, delete on legal_overrides          from authenticated, service_role;
revoke update, delete on signature_events         from authenticated;
revoke update, delete on email_events             from authenticated;
revoke delete on webhook_events                   from authenticated, service_role;
revoke insert, update, delete on webhook_events   from authenticated;

-- The permission catalogue is owned by migrations.
revoke insert, update, delete on permissions from authenticated;

-- Automation history is written by the engine (service_role), read by users.
revoke insert, update, delete on automation_runs           from authenticated;
revoke insert, update, delete on automation_action_results from authenticated;

-- The job queue is drained by workers only.
revoke insert, update, delete on jobs from authenticated;

-- Reference sequences used for human-readable references need to be writable by
-- app.next_reference(), which is SECURITY DEFINER, so no direct grant is needed.
revoke insert, update, delete on entity_sequences from authenticated;

-- Portal projections are read-only from every direction.
revoke insert, update, delete on all tables in schema portal from authenticated, service_role;
grant select on all tables in schema portal to authenticated;

-- -----------------------------------------------------------------------------
-- Rate limiting counters.
--
-- Unlogged: losing them in a crash costs one window of accounting, not data.
-- -----------------------------------------------------------------------------
create unlogged table if not exists rate_limit_counters (
  bucket       text not null,
  subject      text not null,
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (bucket, subject, window_start)
);

create index if not exists rate_limit_counters_window_idx on rate_limit_counters (window_start);

alter table rate_limit_counters enable row level security;
-- No policy: only service_role (which bypasses RLS) touches this table.
revoke all on rate_limit_counters from authenticated, anon;
grant select, insert, update, delete on rate_limit_counters to service_role;

-- -----------------------------------------------------------------------------
-- Automation chain depth on the event outbox.
--
-- An event produced by an automation action carries depth + 1. The engine
-- refuses to act on anything past the automation's max_depth, which is what
-- stops "A triggers B triggers A" from running forever.
-- -----------------------------------------------------------------------------
alter table events add column if not exists depth int not null default 0;
create index if not exists events_depth_idx on events (org_id, depth) where depth > 0;
