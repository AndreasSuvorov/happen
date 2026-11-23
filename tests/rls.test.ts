// RLS-Tests für alle Tabellen der Coach-Migration: Ein Nutzer sieht keine Daten eines anderen.
// Läuft gegen PGlite (Postgres in WASM) mit allen Migrationen aus supabase/migrations/.
// Supabase-Bestandteile (auth, storage, vault, Rollen) werden minimal nachgebildet.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;

  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean);

  create schema vault;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, description text, secret text);
  create view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
    returns uuid language sql as
    $$ insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id $$;
  create function vault.update_secret(secret_id uuid, new_secret text default null) returns void language sql as
    $$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;
`;

// Supabase vergibt per Default-Privileges Tabellenrechte an anon/authenticated/service_role; RLS entscheidet.
const SUPABASE_GRANTS = `
  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  grant execute on function public.current_user_id() to anon, authenticated, service_role;
`;

let db: PGlite;

async function as<T>(role: "authenticated" | "anon" | "service_role", sub: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${sub ?? ""}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}
const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Record<string, unknown>[];

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  }
  await db.exec(SUPABASE_GRANTS);

  // Zwei Nutzer mit je einem Datensatz in jeder neuen Tabelle (als Service Role, wie die Edge Functions).
  await db.exec(`insert into auth.users (id) values ('${A}'), ('${B}');`);
  for (const u of [A, B]) {
    await db.exec(`
      insert into public.user_features (user_id, feature) values ('${u}', 'garmin');
      insert into public.wearable_connections (user_id, provider, vault_secret_id, consent_at)
        values ('${u}', 'garmin_personal', public.wearable_secret_create('key-${u}', 'k-${u}'), now());
      insert into public.wearable_raw (user_id, provider, kind, ref, payload, hash)
        values ('${u}', 'garmin_personal', 'sleep', '2026-11-22', '{}', 'h');
      insert into public.daily_metrics (user_id, date, hrv_last_night) values ('${u}', '2026-11-22', 84);
      insert into public.wearable_activities (user_id, provider, external_id, started_at_local, type)
        values ('${u}', 'garmin_personal', '1', '2026-11-22 07:00', 'running');
      insert into public.context_notes (user_id, date, tag) values ('${u}', '2026-11-21', 'shisha');
      insert into public.briefings (user_id, date, kind, payload) values ('${u}', '2026-11-22', 'morning', '{}');
      insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${u}', 'https://push/${u}', 'p', 'a');
      insert into public.coach_settings (user_id) values ('${u}');
    `);
  }
});

const READABLE = ["user_features", "daily_metrics", "wearable_activities", "context_notes", "briefings", "push_subscriptions", "coach_settings"];
const HIDDEN = ["wearable_connections", "wearable_raw"];

test("Nutzer A liest nur eigene Zeilen", async () => {
  await as("authenticated", A, async () => {
    for (const t of READABLE) {
      const rows = await q(`select user_id from public.${t}`);
      assert.equal(rows.length, 1, t);
      assert.equal(rows[0].user_id, A, t);
    }
  });
});

test("Verbindungen und Rohdaten sind für Clients unsichtbar", async () => {
  await as("authenticated", A, async () => {
    for (const t of HIDDEN) assert.equal((await q(`select * from public.${t}`)).length, 0, t);
  });
});

test("anon sieht nichts", async () => {
  await as("anon", null, async () => {
    for (const t of [...READABLE, ...HIDDEN]) assert.equal((await q(`select * from public.${t}`)).length, 0, t);
  });
});

test("Abgeleitete Daten kann der Client nicht schreiben", async () => {
  await as("authenticated", A, async () => {
    for (const sql of [
      `insert into public.daily_metrics (user_id, date) values ('${A}', '2026-11-23')`,
      `insert into public.wearable_activities (user_id, provider, external_id, started_at_local, type) values ('${A}', 'garmin_personal', '2', now(), 'x')`,
      `insert into public.briefings (user_id, date, kind, payload) values ('${A}', '2026-11-23', 'morning', '{}')`,
      `insert into public.user_features (user_id, feature) values ('${A}', 'beta')`,
      `insert into public.wearable_raw (user_id, provider, kind, ref, payload, hash) values ('${A}', 'garmin_personal', 'hrv', 'x', '{}', 'h')`,
    ]) {
      await assert.rejects(q(sql), /row-level security/, sql);
    }
    // Updates auf fremde oder eigene abgeleitete Zeilen treffen nichts
    await q(`update public.daily_metrics set hrv_last_night = 1`);
  });
  const rows = await q(`select hrv_last_night from public.daily_metrics where user_id = '${A}'`);
  assert.equal(rows[0].hrv_last_night, 84);
});

test("Notizen und Einstellungen: eigene ja, fremde nein", async () => {
  await as("authenticated", A, async () => {
    await q(`insert into public.context_notes (user_id, date, tag, source) values ('${A}', '2026-11-22', 'kind', 'manual')`);
    await assert.rejects(q(`insert into public.context_notes (user_id, date, tag) values ('${B}', '2026-11-22', 'x')`), /row-level security/);
    await q(`update public.coach_settings set easy_hr_cap = 150`);
    await q(`delete from public.context_notes where tag = 'shisha'`);
    await assert.rejects(q(`update public.context_notes set user_id = '${B}'`), /row-level security/);
  });
  const settings = await q(`select user_id, easy_hr_cap from public.coach_settings order by user_id`);
  assert.deepEqual(settings.map((r) => r.easy_hr_cap), [150, 145]);
  const notesB = await q(`select tag from public.context_notes where user_id = '${B}'`);
  assert.deepEqual(notesB.map((r) => r.tag), ["shisha"]);
});

test("Vault-Funktionen nur für die Service Role", async () => {
  await as("authenticated", A, async () => {
    await assert.rejects(q(`select public.wearable_secret_read(vault_secret_id) from public.wearable_connections`), /permission denied/);
    await assert.rejects(q(`select public.wearable_secret_create('x', 'y')`), /permission denied/);
  });
  const secret = await as("service_role", null, async () =>
    q(`select public.wearable_secret_read(vault_secret_id) as s from public.wearable_connections where user_id = '${A}'`));
  assert.equal(secret[0].s, `key-${A}`);
});

test("Push-Limit und Deduplizierung gelten pro Benutzer und lokalem Tag", async () => {
  const claim = async (user: string, kind: string, date: string, limit: number) =>
    (await q("select public.claim_coach_push($1, $2, $3, $4) as claimed", [user, kind, date, limit]))[0]?.claimed;
  await as("authenticated", A, async () => {
    await assert.rejects(claim(A, "morning", "2026-11-23", 2), /permission denied/);
  });
  await as("service_role", null, async () => {
    assert.equal(await claim(A, "morning", "2026-11-23", 0), false);
    assert.equal(await claim(A, "morning", "2026-11-23", 2), true);
    assert.equal(await claim(A, "morning", "2026-11-23", 2), false);
    assert.equal(await claim(A, "run", "2026-11-23", 2), true);
    assert.equal(await claim(A, "weekly", "2026-11-23", 2), false);
    assert.equal(await claim(A, "morning", "2026-11-24", 2), true);
    assert.equal(await claim(B, "morning", "2026-11-23", 2), true);
  });
});

test("Ein Morgenbriefing wird nur für die zugehörige Garmin-Verbindung gespeichert", async () => {
  const [connection] = await q("select id from public.wearable_connections where user_id = $1", [A]);
  const save = (userId: string, connectionId: unknown, headline: string) => q(
    "select public.save_morning_briefing($1, $2, '2026-11-23', 'green', $3::jsonb, null)",
    [userId, connectionId, JSON.stringify({ headline })],
  );
  await as("authenticated", A, async () => {
    await assert.rejects(save(A, connection.id, "Eigener Versuch"), /permission denied/);
  });
  await as("service_role", null, async () => {
    await save(B, connection.id, "Fremde Verbindung");
    await save(A, "00000000-0000-0000-0000-0000000000ff", "Gelöschte Verbindung");
    await save(A, connection.id, "Erster Versand");
    await save(A, connection.id, "Doppelter Versand");
  });
  const rows = await q("select user_id, payload->>'headline' as headline from public.briefings where date = '2026-11-23'");
  assert.deepEqual(rows, [{ user_id: A, headline: "Erster Versand" }]);
});
