-- Happen – Mehrbenutzer-Fähigkeit: PWA (Supabase Auth) ist die Hauptanwendung,
-- Telegram wird ein optionaler, verknüpfter Kanal statt der primären Identität.

-- Verknüpfung zu Supabase Auth; Telegram wird optional (statt Pflichtfeld).
alter table public.users
  add column auth_user_id uuid unique references auth.users(id) on delete cascade,
  alter column telegram_chat_id drop not null;

-- id folgt nicht mehr automatisch; beim Signup setzt der Trigger unten beides.
alter table public.users alter column id drop default;

-- Hilfsfunktion: eigene profile-id des gerade eingeloggten Auth-Nutzers.
create or replace function public.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.users where auth_user_id = auth.uid();
$$;

-- Bei jeder Supabase-Auth-Registrierung automatisch ein Profil anlegen.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, auth_user_id, first_name)
  values (new.id, new.id, new.raw_user_meta_data ->> 'first_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Einmal-Codes, mit denen ein eingeloggter PWA-Nutzer seinen Telegram-Chat verknüpft.
create table public.telegram_link_codes (
  code       text primary key,
  user_id    uuid not null references public.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '10 minutes',
  created_at timestamptz not null default now()
);
alter table public.telegram_link_codes enable row level security;

-- RLS: jeder sieht/ändert nur seine eigenen Daten; Service Role (Edge Functions) umgeht RLS ohnehin.
create policy users_self on public.users
  for select using (auth_user_id = auth.uid());
create policy users_self_update on public.users
  for update using (auth_user_id = auth.uid());

create policy messages_self on public.messages
  for select using (user_id = public.current_user_id());

create policy entries_self_select on public.entries
  for select using (user_id = public.current_user_id());
create policy entries_self_insert on public.entries
  for insert with check (user_id = public.current_user_id());
create policy entries_self_update on public.entries
  for update using (user_id = public.current_user_id());

create policy weights_self_select on public.weights
  for select using (user_id = public.current_user_id());
create policy weights_self_insert on public.weights
  for insert with check (user_id = public.current_user_id());
create policy weights_self_update on public.weights
  for update using (user_id = public.current_user_id());

create policy activities_self_select on public.activities
  for select using (user_id = public.current_user_id());
create policy activities_self_insert on public.activities
  for insert with check (user_id = public.current_user_id());
create policy activities_self_update on public.activities
  for update using (user_id = public.current_user_id());

create policy link_codes_self on public.telegram_link_codes
  for all using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());
