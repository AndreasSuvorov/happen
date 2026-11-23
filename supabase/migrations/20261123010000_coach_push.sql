-- Record one logical push per user, date and kind and enforce the daily limit atomically.
-- A logical push may be delivered to multiple devices.
alter table public.nudges_sent add column is_push boolean not null default false;

create or replace function public.claim_coach_push(p_user_id uuid, p_kind text, p_date date, p_limit integer)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || '/' || p_date::text, 0));
  if (select count(*) from public.nudges_sent
      where user_id = p_user_id and local_date = p_date and is_push) >= p_limit then
    return false;
  end if;

  insert into public.nudges_sent (user_id, kind, local_date, is_push)
  values (p_user_id, p_kind, p_date, true)
  on conflict (user_id, kind, local_date) do nothing;
  return found;
end;
$$;

revoke all on function public.claim_coach_push(uuid, text, date, integer) from public, anon, authenticated;
grant execute on function public.claim_coach_push(uuid, text, date, integer) to service_role;

-- Hold the originating Garmin connection during the insert. A disconnect can then
-- remove the briefing reliably, even if its generation started before the disconnect.
create or replace function public.save_morning_briefing(
  p_user_id uuid, p_connection_id uuid, p_date date, p_status text, p_payload jsonb, p_model text
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.wearable_connections
  where id = p_connection_id and user_id = p_user_id for share;
  if found then
    insert into public.briefings (user_id, date, kind, status, payload, model)
    values (p_user_id, p_date, 'morning', p_status, p_payload, p_model)
    on conflict (user_id, date, kind, ref) do nothing;
  end if;
end;
$$;

revoke all on function public.save_morning_briefing(uuid, uuid, date, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.save_morning_briefing(uuid, uuid, date, text, jsonb, text) to service_role;
