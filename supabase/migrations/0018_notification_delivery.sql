-- =============================================================================
-- 0018_notification_delivery.sql
-- Delivering a notification to another user.
--
-- Notifications are readable only by their recipient - that is the whole point
-- of the SELECT policy. But PostgreSQL applies the SELECT policy to
-- `INSERT ... ON CONFLICT DO NOTHING` as well, because it must be able to see a
-- conflicting row to decide whether to do nothing. The consequence is that the
-- obvious way to write a de-duplicated notification insert cannot deliver to
-- anyone but yourself.
--
-- This helper sidesteps that without weakening the read rule. A plain INSERT
-- (no ON CONFLICT, no RETURNING) is checked against the INSERT policy only; the
-- EXCEPTION block gives the de-duplication an implicit savepoint, so a repeat
-- delivery is absorbed rather than aborting the caller's transaction.
--
-- Deliberately NOT security definer: the caller's own INSERT policy still
-- decides whether they may write to this organisation at all.
-- =============================================================================

create or replace function app.deliver_notification(
  p_id          uuid,
  p_org         uuid,
  p_user        uuid,
  p_category    text,
  p_title       text,
  p_body        text,
  p_entity_type text,
  p_entity_id   uuid,
  p_link_url    text,
  p_priority    text,
  p_event_id    uuid,
  p_dedupe_key  text
)
returns boolean
language plpgsql
as $$
begin
  insert into public.notifications (
    id, org_id, user_id, category, title, body,
    entity_type, entity_id, link_url, priority, event_id, dedupe_key
  ) values (
    p_id, p_org, p_user, p_category, p_title, p_body,
    p_entity_type, p_entity_id, p_link_url, p_priority, p_event_id, p_dedupe_key
  );
  return true;
exception
  when unique_violation then
    -- This notification has already been delivered; a retried job must not
    -- produce a second copy.
    return false;
end
$$;

comment on function app.deliver_notification is
  'Inserts one notification, absorbing a duplicate dedupe_key. Avoids the ON CONFLICT/SELECT-policy interaction that prevents delivering to another user.';

grant execute on function app.deliver_notification(
  uuid, uuid, uuid, text, text, text, text, uuid, text, text, uuid, text
) to authenticated, service_role;
