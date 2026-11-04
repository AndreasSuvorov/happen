-- Happen – Phase 1 schema
-- Zugriff ausschließlich über Edge Functions mit Service-Role-Key.
-- RLS ist überall aktiv und es gibt bewusst keine Policies: anon/authenticated sehen nichts.

create table public.users (
  id               uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint not null unique,
  first_name       text,
  height_cm        numeric(5,1),
  birth_year       int,
  sex              text check (sex in ('m', 'f')),
  timezone         text not null default 'Europe/Berlin',
  goal_kg_per_week numeric(3,2) not null default 0.40,
  created_at       timestamptz not null default now()
);

-- Jede eingehende Nachricht roh, damit Einträge später neu geschätzt werden können.
create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  telegram_message_id bigint,
  kind             text not null check (kind in ('photo', 'voice', 'text')),
  telegram_file_id text,
  text             text,
  transcript       text,
  received_at      timestamptz not null default now(),
  status           text not null default 'received'
                   check (status in ('received', 'processed', 'failed', 'ignored')),
  error            text
);
create index messages_user_received_idx on public.messages (user_id, received_at desc);

-- Eine Mahlzeit, immer als Spanne.
create table public.entries (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  message_id       uuid references public.messages(id) on delete set null,
  eaten_at         timestamptz not null,
  meal             text check (meal in ('breakfast', 'lunch', 'dinner', 'snack', 'drink')),
  title            text not null,
  items            jsonb not null default '[]'::jsonb,
  kcal_low         int not null,
  kcal_mid         int not null,
  kcal_high        int not null,
  protein_g        int,
  confidence       text check (confidence in ('hoch', 'mittel', 'niedrig')),
  note             text,
  question         jsonb,           -- offene Rückfrage inkl. Optionen
  answer           text,
  status           text not null default 'estimated'
                   check (status in ('estimated', 'confirmed', 'deleted')),
  created_at       timestamptz not null default now()
);
create index entries_user_eaten_idx on public.entries (user_id, eaten_at desc) where status <> 'deleted';

-- Ein Gewicht pro Tag (letzter Wert gewinnt).
create table public.weights (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  measured_on      date not null,
  kg               numeric(5,2) not null check (kg between 30 and 300),
  source           text not null default 'telegram',
  created_at       timestamptz not null default now(),
  unique (user_id, measured_on)
);

-- Läufe und anderes Training (Phase 1: per Nachricht, Phase 3: Strava).
create table public.activities (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  message_id       uuid references public.messages(id) on delete set null,
  started_at       timestamptz not null,
  type             text not null default 'run',
  distance_km      numeric(6,2),
  duration_min     int,
  kcal_gross       int,           -- Bruttoverbrauch, Schätzung
  source           text not null default 'telegram',
  status           text not null default 'active' check (status in ('active', 'deleted')),
  created_at       timestamptz not null default now()
);
create index activities_user_started_idx on public.activities (user_id, started_at desc);

-- Verhindert doppelte Erinnerungen.
create table public.nudges_sent (
  user_id          uuid not null references public.users(id) on delete cascade,
  kind             text not null,
  local_date       date not null,
  sent_at          timestamptz not null default now(),
  primary key (user_id, kind, local_date)
);

alter table public.users       enable row level security;
alter table public.messages    enable row level security;
alter table public.entries     enable row level security;
alter table public.weights     enable row level security;
alter table public.activities  enable row level security;
alter table public.nudges_sent enable row level security;

-- Tageswerte für Auswertungen (nur über Service Role lesbar).
create view public.daily_intake
with (security_invoker = true) as
select
  e.user_id,
  (e.eaten_at at time zone u.timezone)::date as local_date,
  sum(e.kcal_low)  as kcal_low,
  sum(e.kcal_mid)  as kcal_mid,
  sum(e.kcal_high) as kcal_high,
  sum(coalesce(e.protein_g, 0)) as protein_g,
  count(*)         as entry_count
from public.entries e
join public.users u on u.id = e.user_id
where e.status <> 'deleted'
group by 1, 2;

-- Bucket für Fotos und Sprachnachrichten (privat).
insert into storage.buckets (id, name, public)
values ('inbox', 'inbox', false)
on conflict (id) do nothing;
