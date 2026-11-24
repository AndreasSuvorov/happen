-- Coach M3. Plan decisions are separate from the generated briefing.
create table public.coach_plan_actions (
  user_id uuid not null references public.users(id) on delete cascade,
  date date not null,
  action text not null check (action in ('done', 'move', 'other')),
  activity text check (activity in ('Krafttraining', 'Radfahren', 'Spaziergang', 'Laufen', 'Schwimmen', 'Sonstiges')),
  check ((action = 'other') = (activity is not null)),
  primary key (user_id, date)
);
alter table public.coach_plan_actions enable row level security;
create policy coach_plan_actions_self on public.coach_plan_actions
  for all to authenticated using (user_id = public.current_user_id()) with check (user_id = public.current_user_id());
grant select, insert, update, delete on public.coach_plan_actions to authenticated, service_role;

-- A single snapshot keeps the first load small and uses the same local date as Garmin and nudges.
create function public.happen_today()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := public.current_user_id();
  local_today date;
  zone text;
  garmin boolean;
  connection jsonb;
begin
  if uid is null then return null; end if;
  select exists(select 1 from public.user_features f where f.user_id = uid and f.feature = 'garmin') into garmin;
  select c.timezone, jsonb_build_object('status', c.status, 'backfill', c.backfill_from is not null)
    into zone, connection
    from public.wearable_connections c where garmin and c.user_id = uid and c.provider = 'garmin_personal';
  if zone is null then
    select u.timezone into zone from public.users u where u.id = uid;
  end if;
  if zone is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = zone) then zone := 'Europe/Berlin'; end if;
  local_today := (now() at time zone zone)::date;

  return jsonb_build_object(
    'user_id', uid, 'date', local_today, 'timezone', zone, 'garmin', garmin, 'connection', connection,
    'profile', (select jsonb_build_object('height_cm', u.height_cm, 'birth_year', u.birth_year,
      'sex', u.sex, 'goal_kg_per_week', u.goal_kg_per_week) from public.users u where u.id = uid),
    'briefing', (select b.payload from public.briefings b
      where b.user_id = uid and b.date = local_today and b.kind = 'morning' and b.ref = ''),
    'metrics', (select coalesce(jsonb_agg(to_jsonb(m) - 'user_id' - 'updated_at' order by m.date), '[]'::jsonb)
      from public.daily_metrics m where garmin and m.user_id = uid and m.date between local_today - 29 and local_today),
    'wearable_activities', (select coalesce(jsonb_agg(to_jsonb(a) - 'user_id' - 'updated_at' order by a.started_at_local), '[]'::jsonb)
      from public.wearable_activities a where garmin and a.user_id = uid
      and a.started_at_local >= (local_today - 1)::timestamp and a.started_at_local < (local_today + 1)::timestamp),
    'entries', (select coalesce(jsonb_agg(to_jsonb(e) order by e.local_time), '[]'::jsonb) from (
      select e.id, e.eaten_at at time zone zone as local_time, e.meal, e.title, e.kcal_low, e.kcal_mid, e.kcal_high,
        e.protein_g, e.carbs_g, e.fat_g, e.confidence, e.note
      from public.entries e where e.user_id = uid and e.status <> 'deleted'
      and e.eaten_at >= ((local_today - 1)::timestamp at time zone zone)
      and e.eaten_at < ((local_today + 1)::timestamp at time zone zone)
    ) e),
    'activities', (select coalesce(jsonb_agg(to_jsonb(a) order by a.local_time), '[]'::jsonb) from (
      select a.id, a.started_at at time zone zone as local_time, a.type, a.distance_km, a.duration_min, a.kcal_gross
      from public.activities a where a.user_id = uid and a.status = 'active'
      and a.started_at >= ((local_today - 1)::timestamp at time zone zone)
      and a.started_at < ((local_today + 1)::timestamp at time zone zone)
    ) a),
    'notes', (select coalesce(jsonb_agg(to_jsonb(n) - 'user_id' order by n.date, n.created_at), '[]'::jsonb)
      from public.context_notes n where n.user_id = uid and n.date between local_today - 1 and local_today),
    'weight', (select jsonb_build_object('kg', w.kg, 'date', w.measured_on) from public.weights w
      where w.user_id = uid and w.measured_on <= local_today order by w.measured_on desc limit 1),
    'nutrition_target', (select jsonb_build_object('low', s.kcal_target_low, 'high', s.kcal_target_high)
      from public.coach_settings s where s.user_id = uid),
    'plan_action', (select jsonb_build_object('action', p.action, 'activity', p.activity) from public.coach_plan_actions p
      where p.user_id = uid and p.date = local_today)
  );
end;
$$;
revoke all on function public.happen_today() from public, anon, authenticated;
grant execute on function public.happen_today() to authenticated;

-- One answer per date, even if the same question is open in two browser tabs.
-- Existing notes keep their original meaning and are returned on a retry.
create function public.answer_coach_question(p_briefing_date date, p_option text, p_text text default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  uid uuid := public.current_user_id();
  question jsonb;
  note_date date;
  answer public.context_notes;
begin
  select payload -> 'question' into question from public.briefings
    where user_id = uid and date = p_briefing_date and kind = 'morning' and ref = '';
  if question is null or not coalesce((question -> 'options') ? p_option, false) then
    raise exception 'invalid coach question' using errcode = '22023';
  end if;
  note_date := (question ->> 'date')::date;
  if note_date not between p_briefing_date - 1 and p_briefing_date or note_date is null
    or (p_option = 'Andere…' and coalesce(length(btrim(p_text)), 0) not between 1 and 200) then
    raise exception 'invalid coach answer' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text || '/note/' || note_date::text, 0));
  select * into answer from public.context_notes where user_id = uid and date = note_date order by created_at limit 1;
  if not found then
    insert into public.context_notes (user_id, date, tag, text, source)
      values (uid, note_date, p_option, case when p_option = 'Andere…' then btrim(p_text) end, 'question')
      returning * into answer;
  end if;
  return to_jsonb(answer) - 'user_id';
end;
$$;
revoke all on function public.answer_coach_question(date, text, text) from public, anon, authenticated;
grant execute on function public.answer_coach_question(date, text, text) to authenticated;
