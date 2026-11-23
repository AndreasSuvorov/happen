-- happen Coach, Meilenstein 1: Datenbasis für Wearables (Garmin), Notizen, Briefings, Push.
-- Plan: docs/wiki/Coach-Plan.md, Abschnitt 4.
--
-- Konventionen wie in den bisherigen Migrationen:
--  * RLS überall aktiv. Nutzer lesen nur eigene Zeilen (über public.current_user_id()).
--  * Schreiben nur über Edge Functions (Service Role). Ausnahme: context_notes und coach_settings,
--    die der Nutzer selbst anlegen und ändern darf.
--  * Geheimnisse (Garmin-Key, Token) liegen ausschließlich im Supabase Vault.

-- ---------------------------------------------------------------------------
-- Feature-Flags (Allowlist). Bewusst NICHT als Spalte in users, weil Nutzer ihre
-- users-Zeile selbst ändern dürfen (Policy users_self_update).
-- Freischalten: insert into public.user_features (user_id, feature) values ('<id>', 'garmin');
-- ---------------------------------------------------------------------------
create table public.user_features (
  user_id    uuid not null references public.users(id) on delete cascade,
  feature    text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, feature)
);

-- ---------------------------------------------------------------------------
-- Verbindung zu einem Wearable-Anbieter
-- ---------------------------------------------------------------------------
create table public.wearable_connections (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  provider         text not null check (provider in ('garmin_personal')),
  vault_secret_id  uuid not null,          -- Personal API Key im Vault
  token_secret_id  uuid,                   -- zwischengespeicherter JWT im Vault (gilt 24 h)
  token_expires_at timestamptz,
  status           text not null default 'active'
                   check (status in ('active', 'expired', 'error', 'disconnected')),
  last_sync_at     timestamptz,
  last_data_at     timestamptz,            -- wann zuletzt neue Daten ankamen ("Uhr hat seit X h nicht synchronisiert")
  last_error       text,                   -- nie Schlüssel oder Token enthalten
  backfill_from    date,                   -- ältester Tag, bis zu dem noch nachgeladen werden muss (null = fertig)
  backfill_cursor  date,                   -- ältester bereits nachgeladener Tag
  timezone         text not null default 'Europe/Berlin',
  consent_at       timestamptz not null,   -- ausdrückliche Einwilligung (DSGVO Art. 9)
  expired_notified_at timestamptz,         -- Hinweis "Schlüssel abgelaufen" genau einmal
  created_at       timestamptz not null default now(),
  unique (user_id, provider)
);

-- ---------------------------------------------------------------------------
-- Rohdaten (für Neuberechnung, 30 Tage aufbewahren; garmin-sync räumt auf)
-- ---------------------------------------------------------------------------
create table public.wearable_raw (
  user_id    uuid not null references public.users(id) on delete cascade,
  provider   text not null,
  kind       text not null check (kind in (
               'sleep', 'hrv', 'daily_summary', 'heart_rate', 'body_battery',
               'activity_list', 'activity_detail')),
  ref        text not null,                -- Datum (YYYY-MM-DD) oder Aktivitäts-ID
  payload    jsonb not null,
  hash       text not null,                -- SHA-256 des Payloads, damit unveränderte Daten nicht neu geschrieben werden
  fetched_at timestamptz not null default now(),
  primary key (user_id, provider, kind, ref)
);
create index wearable_raw_fetched_idx on public.wearable_raw (fetched_at);

-- ---------------------------------------------------------------------------
-- Aufbereitete Tageswerte. "date" ist der Kalendertag; Schlafwerte gehören
-- zur Nacht, die am Morgen dieses Tages endet.
-- ---------------------------------------------------------------------------
create table public.daily_metrics (
  user_id            uuid not null references public.users(id) on delete cascade,
  date               date not null,
  -- Schlaf
  sleep_start_local  timestamp,
  sleep_end_local    timestamp,
  sleep_minutes      int,
  sleep_score        int,
  deep_min           int,
  rem_min            int,
  light_min          int,
  awake_min          int,
  awake_count        int,
  sleep_hr_avg       numeric,
  sleep_resp_avg     numeric,
  sleep_stress_avg   numeric,
  sleep_need_min     int,
  sleep_uncertain    boolean not null default false,  -- z. B. < 3 h mit Ende vor Mitternacht
  -- Erholung
  hrv_last_night     int,
  hrv_status         text,
  hrv_baseline_low   int,
  hrv_baseline_high  int,
  resting_hr         int,
  bb_wake            int,
  bb_max             int,
  bb_min             int,
  bb_charged         int,
  bb_drained         int,
  -- Tag
  steps              int,
  kcal_total         int,
  kcal_active        int,
  stress_avg         int,
  stress_high_min    int,
  stress_med_min     int,
  intensity_min_moderate int,
  intensity_min_vigorous int,
  evening_hr_avg     numeric,       -- Ø Puls 19:00–21:59 Ortszeit, ohne Aktivitätszeiten
  wear_hours         numeric,       -- Tragezeit; unter ~20 h sind Tageswerte unvollständig
  is_complete        boolean not null default false,
  updated_at         timestamptz not null default now(),
  primary key (user_id, date)
);

-- ---------------------------------------------------------------------------
-- Aktivitäten von der Uhr. Getrennt von public.activities (manuelle Einträge
-- per Nachricht), siehe offene Frage 2 im Plan.
-- ---------------------------------------------------------------------------
create table public.wearable_activities (
  user_id           uuid not null references public.users(id) on delete cascade,
  provider          text not null,
  external_id       text not null,
  started_at_local  timestamp not null,
  type              text not null,
  name              text,
  duration_s        int,
  distance_m        numeric,
  elevation_gain_m  numeric,
  avg_hr            int,
  max_hr            int,
  hr_zone_s         int[],          -- Sekunden in Zone 1..5
  training_load     numeric,
  aerobic_te        numeric,
  anaerobic_te      numeric,
  te_label          text,
  avg_cadence       numeric,
  feel              int,            -- 0..100 (Schritte 25)
  rpe               int,            -- 10..100 (= 1..10)
  run_s             int,
  walk_s            int,
  hr_sensor         text check (hr_sensor in ('wrist', 'chest')),
  analysis          jsonb,          -- Ergebnis von signals.analyzeRun (Meilenstein 4)
  detail_fetched_at timestamptz,
  updated_at        timestamptz not null default now(),
  primary key (user_id, provider, external_id)
);
create index wearable_activities_user_started_idx on public.wearable_activities (user_id, started_at_local desc);

-- ---------------------------------------------------------------------------
-- Kontext-Notizen (Antworten auf Rückfragen, eigene Notizen)
-- ---------------------------------------------------------------------------
create table public.context_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  date       date not null,
  tag        text,
  text       text,
  source     text not null default 'question' check (source in ('question', 'chat', 'manual')),
  created_at timestamptz not null default now()
);
create index context_notes_user_date_idx on public.context_notes (user_id, date desc);

-- ---------------------------------------------------------------------------
-- Generierte Briefings
-- ---------------------------------------------------------------------------
create table public.briefings (
  user_id               uuid not null references public.users(id) on delete cascade,
  date                  date not null,
  kind                  text not null check (kind in ('morning', 'run', 'weekly')),
  ref                   text not null default '',
  status                text check (status in ('green', 'yellow', 'red', 'unknown')),
  payload               jsonb not null,
  model                 text,
  created_at            timestamptz not null default now(),
  delivered_push_at     timestamptz,
  delivered_telegram_at timestamptz,
  primary key (user_id, date, kind, ref)
);

-- ---------------------------------------------------------------------------
-- Web Push
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_success_at timestamptz,
  failed_count    int not null default 0
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- Coach-Einstellungen
-- ---------------------------------------------------------------------------
create table public.coach_settings (
  user_id            uuid primary key references public.users(id) on delete cascade,
  channel            text not null default 'push' check (channel in ('push', 'telegram', 'both')),
  briefing_mode      text not null default 'after_wake' check (briefing_mode in ('after_wake', 'fixed')),
  briefing_time      time not null default '07:00',
  quiet_from         time not null default '22:00',
  quiet_to           time not null default '06:00',
  easy_hr_cap        int not null default 145 check (easy_hr_cap between 80 and 220),
  lthr               int check (lthr between 80 and 230),
  goal               jsonb,
  kcal_target_low    int,
  kcal_target_high   int,
  bedtime_target     time not null default '22:30',
  max_pushes_per_day int not null default 3 check (max_pushes_per_day between 0 and 10),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.user_features        enable row level security;
alter table public.wearable_connections enable row level security;
alter table public.wearable_raw         enable row level security;
alter table public.daily_metrics        enable row level security;
alter table public.wearable_activities  enable row level security;
alter table public.context_notes        enable row level security;
alter table public.briefings            enable row level security;
alter table public.push_subscriptions   enable row level security;
alter table public.coach_settings       enable row level security;

-- Nur lesen (Schreiben ausschließlich über Edge Functions).
create policy user_features_self_select on public.user_features
  for select using (user_id = public.current_user_id());
create policy daily_metrics_self_select on public.daily_metrics
  for select using (user_id = public.current_user_id());
create policy wearable_activities_self_select on public.wearable_activities
  for select using (user_id = public.current_user_id());
create policy briefings_self_select on public.briefings
  for select using (user_id = public.current_user_id());
create policy push_subscriptions_self_select on public.push_subscriptions
  for select using (user_id = public.current_user_id());

-- wearable_connections und wearable_raw: keine Policy, der Status kommt über
-- die Edge Function wearable-connect (GET). So sieht der Client weder Vault-IDs noch Rohdaten.

-- Vom Nutzer selbst änderbar.
create policy context_notes_self_select on public.context_notes
  for select using (user_id = public.current_user_id());
create policy context_notes_self_insert on public.context_notes
  for insert with check (user_id = public.current_user_id());
create policy context_notes_self_update on public.context_notes
  for update using (user_id = public.current_user_id()) with check (user_id = public.current_user_id());
create policy context_notes_self_delete on public.context_notes
  for delete using (user_id = public.current_user_id());

create policy coach_settings_self_select on public.coach_settings
  for select using (user_id = public.current_user_id());
create policy coach_settings_self_insert on public.coach_settings
  for insert with check (user_id = public.current_user_id());
create policy coach_settings_self_update on public.coach_settings
  for update using (user_id = public.current_user_id()) with check (user_id = public.current_user_id());

-- ---------------------------------------------------------------------------
-- Vault-Zugriff für Edge Functions. supabase-js erreicht das Schema "vault" nicht
-- direkt, darum schmale RPCs, die nur die Service Role ausführen darf.
-- ---------------------------------------------------------------------------
create or replace function public.wearable_secret_create(p_secret text, p_name text)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select vault.create_secret(p_secret, p_name, 'happen wearable');
$$;

create or replace function public.wearable_secret_read(p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_id;
$$;

create or replace function public.wearable_secret_update(p_id uuid, p_secret text)
returns void
language sql
security definer
set search_path = ''
as $$
  select vault.update_secret(p_id, p_secret);
$$;

create or replace function public.wearable_secret_delete(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from vault.secrets where id = p_id;
$$;

revoke all on function public.wearable_secret_create(text, text) from public, anon, authenticated;
revoke all on function public.wearable_secret_read(uuid)         from public, anon, authenticated;
revoke all on function public.wearable_secret_update(uuid, text) from public, anon, authenticated;
revoke all on function public.wearable_secret_delete(uuid)       from public, anon, authenticated;
grant execute on function public.wearable_secret_create(text, text) to service_role;
grant execute on function public.wearable_secret_read(uuid)         to service_role;
grant execute on function public.wearable_secret_update(uuid, text) to service_role;
grant execute on function public.wearable_secret_delete(uuid)       to service_role;
