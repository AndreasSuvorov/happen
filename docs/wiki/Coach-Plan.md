# happen Coach: Umsetzungsplan (PWA)

> **Für den umsetzenden Agenten:** Dieses Dokument beschreibt Ziel, Architektur, Datenmodell, UX und Meilensteine für die Erweiterung von happen um Garmin-Daten, ein Morgenbriefing, Rückfragen, Laufanalysen und einen Coach-Chat in der bestehenden PWA.
> Der Ist-Zustand in Abschnitt 1 beruht auf der Beschreibung des Eigentümers. **Prüfe ihn zuerst im Repo** und passe den Plan an, wo das Repo abweicht. Arbeite in Meilensteinen (Abschnitt 11), jeder in einem eigenen Branch und PR. Nichts geht ohne Review live.

---

## 0. Worum es geht

happen erfasst heute Mahlzeiten (Telegram und Web-App) mit kcal-Spannen, dazu Gewicht und Aktivitäten. Neu kommen Daten der Laufuhr dazu: Schlaf, HRV, Ruhepuls, Body Battery, Stress, Puls über den Tag und Läufe. Daraus entsteht ein **Coach, der Zusammenhänge zwischen Essen, Schlaf, Abenden und Training erkennt, nachfragt und ehrlich einordnet.**

Das Konzept wurde vier Wochen lang „von Hand“ mit dem Eigentümer erprobt (Claude hat die Garmin-API abgefragt und analysiert). Folgendes hat nachweislich geholfen und ist der Kern des Produkts:

1. **Ein Morgen-Check:** Wie erholt bin ich, was mache ich heute?
2. **Rückfragen bei Auffälligkeiten:** „Dein Puls war gestern Abend 20 Schläge höher als sonst. Was war los?“ Daraus entstand ein persönliches Muster: Shisha-Abende bedeuteten +20 bpm am Abend und −15 HRV in der Nacht.
3. **Laufanalyse mit klarem Urteil:** „Locker gelaufen ✅“ oder „Ab Minute 55 zu schnell geworden“
4. **Ehrlichkeit:** „Dein Rekord ist echt, aber 14 Sekunden sind Tagesform.“
5. **Essen im Zusammenhang:** „Tagsüber 1.500 kcal, abends Heißhunger. Das ist Hunger, keine Willensschwäche.“

### Produktprinzipien (gelten für jede Entscheidung)
- **Erklären statt anzeigen.** Jede Zahl steht neben „dein Normalbereich“ und einem Satz, was sie bedeutet.
- **Eine Entscheidung pro Bildschirm.** Wir bauen kein Dashboard.
- **Fragen statt nerven.** Pro Tag höchstens eine Rückfrage, beantwortbar mit einem Tipp.
- **Ehrlich, auch wenn es nicht motiviert.** Mit Unsicherheit, ohne erfundene Werte, ohne Schönfärben.
- **Verhalten loben, nicht Zahlen.** „3 Nächte in Folge vor 23 Uhr“ ist wichtiger als „HRV 84“.
- **Keine Medizin.** Wir sprechen von Abweichungen vom Normalbereich, nie von Diagnosen.

---

## 1. Ist-Zustand (laut Eigentümer, im Repo prüfen)

- **Backend:** Supabase (self-hosted per Docker, alternativ Cloud). Edge Functions in TypeScript/Deno:
  - `telegram`: Webhook für Telegram, Befehle (`/profil`) und Buttons
  - `web-chat`: Chat in der PWA (Text, Foto, Sprache), nutzt denselben Schätz-Code in `_shared/`
  - `nudges`: Erinnerungen, per `pg_cron` alle 15 min (07:30 Waage, 13:30 Mittag, 21:00 Rückblick, So 19:00 Wochenrückblick)
  - `link-code`: verknüpft einen Telegram-Chat mit einem Web-Konto
- **Postgres:** `users`, `messages`, `entries` (Mahlzeiten mit kcal low/mid/high und Makros), `weights`, `activities`, `nudges_sent`, `telegram_link_codes`. Migrationen in `supabase/migrations/`. RLS überall aktiv, Zugriff nur über Edge Functions.
- **Storage:** Bucket `inbox` für Fotos
- **KI:** `_shared/estimate.ts` nutzt Claude (`claude-opus-5-5`, Aufwand „low“, automatisches Ersatzmodell). Sprache → Text über OpenAI `gpt-4o-mini-transcribe` (`_shared/stt.ts`), optional.
- **Frontend:** React/Vite, ausgeliefert über Cloudflare (`web/wrangler.jsonc`), Supabase Auth per Magic-Link oder Code, installierbar als PWA

---

## 2. Umfang

### Im MVP (Meilensteine 1–5)
- Garmin verbinden (Personal API Key), automatischer Sync, aufbereitete Tageswerte
- Erholungsstatus und Signale (Regeln, nicht KI)
- Morgenbriefing per **Web Push** und im „Heute“-Bildschirm
- Rückfragen mit Antwort-Chips, gespeichert als Notizen
- Laufanalyse nach jedem neuen Lauf (Push + Detailseite)
- Coach-Chat in der PWA mit Werkzeugen für alle Daten
- Erweiterter Wochenrückblick
- Einstellungen: Kanal (Push/Telegram), Uhrzeit, Ziele

### Später (nicht jetzt bauen)
- Experimente (Meilenstein 6, optional)
- Apple Health über Kurzbefehl-Automation (`health-ingest`), Strava
- Native App über Capacitor (für HealthKit)
- Mehrere Nutzer mit Garmin über das offizielle Garmin Connect Developer Program (Health API)

### Wichtige Einschränkung
Die Garmin **Personal** API ist für den Zugriff auf die **eigenen** Daten gedacht. Ob andere Nutzer ihren Personal-Key in happen eintragen dürfen, ist ungeklärt (Garmin-Bedingungen). **Deshalb läuft die Garmin-Anbindung hinter einem Feature-Flag (`users.features ? 'garmin'` oder eine Allowlist), zunächst nur für den Eigentümer.**

---

## 3. Architektur

```
        Garmin Personal API
               │  (Token 24 h, pro Nutzer)
               ▼
   pg_cron ──► garmin-sync (Edge Function)
               │  Rohdaten ─► wearable_raw (JSON, 30 Tage)
               │  Aufbereitung ─► daily_metrics, wearable_activities
               ▼
           signals (_shared/signals.ts, reine Funktionen)
               │  Erholungsstatus, Auffälligkeiten, Laufurteil
               ▼
   pg_cron ──► nudges ──► coach (_shared/coach.ts, Claude) ──► briefings
               │                                              │
               ├─► Web Push (push_subscriptions) ◄────────────┘
               └─► Telegram (falls so eingestellt)

   PWA  ◄──► web-chat (+ Coach-Werkzeuge)  ◄──► daily_metrics, entries,
   (Heute, Chat, Verlauf)                         weights, notes, activities
```

**Grundsätze:**
- **Aufbereitung und Signale sind deterministischer Code**, keine KI. Die KI formuliert nur und beantwortet Fragen. Sie bekommt immer fertige Zahlen mit Normalbereich und erfindet keine.
- **Rohdaten werden 30 Tage aufbewahrt** (`wearable_raw`), damit sich die Aufbereitung neu berechnen lässt, wenn Regeln sich ändern.
- **Alles läuft pro Nutzer und ist durch RLS geschützt.** Edge Functions verwenden die Service Role nur serverseitig.

---

## 4. Datenmodell (neue Migrationen)

Namen sind Vorschläge. An bestehende Konventionen im Repo anpassen.

```sql
-- Verbindung zu einem Wearable-Anbieter
create table wearable_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('garmin_personal')),
  vault_secret_id uuid not null,          -- API-Key liegt im Supabase Vault, nie im Klartext
  token_cache text,                       -- verschlüsselt oder ebenfalls im Vault; gilt 24 h
  token_expires_at timestamptz,
  status text not null default 'active',  -- active | expired | error | disconnected
  last_sync_at timestamptz,
  last_error text,
  timezone text not null default 'Europe/Berlin',
  created_at timestamptz default now(),
  unique (user_id, provider)
);

-- Rohdaten (für Neuberechnung, 30 Tage aufbewahren)
create table wearable_raw (
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  kind text not null,          -- sleep | hrv | daily_summary | heart_rate | body_battery | activity_list | activity_detail
  ref text not null,           -- Datum (YYYY-MM-DD) oder Aktivitäts-ID
  payload jsonb not null,
  fetched_at timestamptz default now(),
  primary key (user_id, provider, kind, ref)
);

-- Aufbereitete Tageswerte. "date" ist der Kalendertag; Schlafwerte gehören
-- zur Nacht, die am Morgen dieses Tages endet.
create table daily_metrics (
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  -- Schlaf (Nacht, die an diesem Morgen endet)
  sleep_start_local timestamp, sleep_end_local timestamp,
  sleep_minutes int, sleep_score int,
  deep_min int, rem_min int, light_min int, awake_min int, awake_count int,
  sleep_hr_avg numeric, sleep_resp_avg numeric, sleep_stress_avg numeric,
  sleep_need_min int,
  -- Erholung
  hrv_last_night int, hrv_status text, hrv_baseline_low int, hrv_baseline_high int,
  resting_hr int,
  bb_wake int, bb_max int, bb_min int, bb_charged int, bb_drained int,
  -- Tag
  steps int, kcal_total int, kcal_active int,
  stress_avg int, stress_high_min int, stress_med_min int,
  intensity_min_moderate int, intensity_min_vigorous int,
  evening_hr_avg numeric,        -- Ø Puls 19:00–21:59 Ortszeit, ohne Aktivitätszeiten
  wear_hours numeric,            -- Tragezeit; unter ~20 h sind Tageswerte unvollständig
  is_complete boolean default false,  -- Tag abgeschlossen und vollständig synchronisiert
  updated_at timestamptz default now(),
  primary key (user_id, date)
);

-- Aktivitäten von der Uhr (bestehende Tabelle "activities" prüfen und
-- entweder erweitern oder diese separat nutzen und verknüpfen)
create table wearable_activities (
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  external_id text not null,
  started_at_local timestamp not null,
  type text not null,            -- running | treadmill_running | strength_training | ...
  name text,
  duration_s int, distance_m numeric, elevation_gain_m numeric,
  avg_hr int, max_hr int,
  hr_zone_s int[5],              -- Sekunden in Zone 1..5
  training_load numeric, aerobic_te numeric, anaerobic_te numeric, te_label text,
  avg_cadence numeric,
  feel int, rpe int,             -- feel 0..100 (Schritte 25), rpe 10..100 (= 1..10)
  run_s int, walk_s int,         -- aus splitSummaries (RWD_RUN / RWD_WALK)
  hr_sensor text,                -- 'wrist' | 'chest' (aus metadataDTO.sensors)
  analysis jsonb,                -- Ergebnis von signals.analyzeRun (siehe 6.3)
  primary key (user_id, provider, external_id)
);

-- Kontext-Notizen (Antworten auf Rückfragen, eigene Notizen)
create table context_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  date date not null,                    -- auf welchen Tag/Abend sich die Notiz bezieht
  tag text,                              -- shisha | kind | party | alkohol | stress | krank | hitze | sonstiges | ...
  text text,
  source text not null default 'question', -- question | chat | manual
  created_at timestamptz default now()
);

-- Generierte Briefings (einmal pro Tag, wiederverwendbar für Push, Heute und Telegram)
create table briefings (
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  kind text not null,          -- morning | run | weekly
  ref text not null default '',-- z. B. Aktivitäts-ID bei kind = run
  status text,                 -- green | yellow | red | unknown
  payload jsonb not null,      -- siehe Schema in 7.2
  model text,
  created_at timestamptz default now(),
  delivered_push_at timestamptz,
  delivered_telegram_at timestamptz,
  primary key (user_id, date, kind, ref)
);

-- Web Push
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz default now(),
  last_success_at timestamptz,
  failed_count int default 0
);

-- Coach-Einstellungen (alternativ als jsonb in users)
create table coach_settings (
  user_id uuid primary key references users(id) on delete cascade,
  channel text not null default 'push',      -- push | telegram | both
  briefing_mode text not null default 'after_wake', -- after_wake | fixed
  briefing_time time default '07:00',
  quiet_from time default '22:00', quiet_to time default '06:00',
  easy_hr_cap int default 145,               -- Obergrenze für lockere Läufe
  lthr int,                                  -- Laktatschwelle, falls bekannt
  goal jsonb,                                -- z. B. {"type":"race","name":"Halbmarathon Barcelona","date":"2027-02-14","target":"2:10:00"}
  kcal_target_low int, kcal_target_high int,
  bedtime_target time default '22:30',
  max_pushes_per_day int default 3
);
```

**RLS:** Nutzer lesen nur eigene Zeilen. Schreibzugriff haben nur die Edge Functions (Service Role). Ausnahme: `context_notes` und `coach_settings` darf der Nutzer über die API selbst anlegen und ändern, falls das Frontend direkt zugreift. Wenn das Projekt die Regel „nur Edge Functions“ hat, bleib dabei.

**Gewichte:** `weights` bleibt die einzige Quelle für Gewichtswerte. Garmin-Gewichte werden **nicht** importiert, damit nichts doppelt gezählt wird. Das ist eine offene Frage an den Eigentümer, siehe Abschnitt 13.

---

## 5. Garmin-Anbindung

Technische Details zur API stehen im Anhang A. Sie wurden in der Praxis verifiziert.

### 5.1 Verbinden (neue Edge Function `wearable-connect`)
1. Der Nutzer erzeugt im Garmin-Connect-Web unter „Personal API Key“ einen Schlüssel. Der Schlüssel wird nur einmal angezeigt, das Ablaufdatum wählt der Nutzer.
2. Die PWA zeigt eine **geführte Anleitung** (siehe 9.6) und ein Eingabefeld. Der Schlüssel geht per POST an `wearable-connect`.
3. `wearable-connect` holt testweise einen Token und ruft `userprofile-service/userprofile/settings` ab. Bei Erfolg wird der Schlüssel im **Supabase Vault** gespeichert (`vault.create_secret`) und die Verbindung angelegt. Danach wird ein erster Sync über die **letzten 28 Tage** gestartet (Backfill, damit es sofort Normalbereiche gibt).
4. **Den Schlüssel niemals loggen, niemals in `messages` speichern, niemals an das LLM geben.**
5. „Trennen“ löscht das Vault-Secret, die Verbindung und auf Wunsch alle Wearable-Daten.

### 5.2 Sync (neue Edge Function `garmin-sync`)
- **Auslöser:** `pg_cron` alle 20 min zwischen 04:30 und 23:30 Ortszeit. Die Nutzer werden auf mehrere Läufe verteilt, um die API zu schonen.
- **Token:** Zwischengespeicherten Token verwenden. Läuft er in weniger als 30 min ab, einen neuen holen. Bei 401/403 auf den Token-Endpunkt: `status = 'expired'` und dem Nutzer **einmalig** einen Hinweis schicken („Dein Garmin-Schlüssel ist abgelaufen. So erneuerst du ihn: …“).
- **Was pro Lauf geholt wird:**
  - **heute und gestern:** `v2/dailysummaries` (beide Tage in einem Aufruf), `dailyHeartRate`, `bodyBattery/reports/daily`
  - **heute:** `dailySleep?date=heute`, `hrv/{heute}`. Sobald Schlaf und HRV für heute vorhanden sind, ist das **Morgenbriefing bereit** (siehe 8).
  - **Aktivitäten:** `activities/search/activities?start=0&limit=10`. Neue IDs → `activity/{id}` (Details) und, für Läufe, den FIT-Download für die Laufanalyse (6.3).
- **Idempotent:** Alles über `upsert` mit natürlichem Schlüssel. Wiederholte Läufe ändern nichts, wenn sich die Daten nicht geändert haben.
- **Fehler:** 429 und 5xx mit exponentiellem Backoff (2, 4, 8, 16 s), höchstens 4 Versuche, dann `last_error` setzen und beim nächsten Cron-Lauf erneut versuchen.
- **Datenlücken:** Daten kommen erst, wenn die Uhr mit dem Handy synchronisiert hat. Ein Tag ohne Schlafdaten ist **kein Fehler**, sondern „noch nicht synchronisiert“. Das wird in der UX berücksichtigt.

### 5.3 Aufbereitung (`_shared/garmin/transform.ts`, reine Funktionen mit Unit-Tests)
Wandelt Rohdaten in `daily_metrics` und `wearable_activities` um. Wichtige Fallstricke stehen in Anhang A.3. Die wichtigsten:
- `sleepStartTimestampLocal` und `sleepEndTimestampLocal` sind Epoch-ms, **die die lokale Uhrzeit darstellen**. Sie werden als UTC formatiert, um die lokale Uhrzeit zu erhalten, und **nicht** in die Zeitzone umgerechnet.
- `evening_hr_avg`: Mittelwert aus `heartRateValues` zwischen 19:00 und 21:59 Ortszeit (Zeitzone aus der Verbindung). Minuten innerhalb von Aktivitäten werden ausgeschlossen. Nur berechnen, wenn mindestens 60 % der Werte vorhanden sind.
- `bb_wake`: Body-Battery-Wert am Ende des Schlafs (der nächstgelegene Wert in `bodyBatteryValuesArray` nach `sleep_end`)
- `hr_sensor`: `'chest'`, wenn `metadataDTO.sensors` einen Sensor mit `bleDeviceType = 'HEART_RATE'` oder einen ANT+-Brustgurt enthält, sonst `'wrist'`
- **Laufband:** Tempo und Distanz der Uhr sind unzuverlässig, sie werden **nie** für Effizienzvergleiche verwendet. Die Abschnittsdaten (`splitSummaries`) können von der korrigierten Gesamtdistanz abweichen.

---

## 6. Signale (`_shared/signals.ts`, deterministisch, mit Tests)

### 6.1 Normalbereich (Baseline) pro Kennzahl
- **Rollender Median und Interquartilsabstand über die letzten 28 Tage** (mindestens 10 gültige Werte), ohne den aktuellen Tag
- **HRV:** Den Normalbereich von Garmin verwenden (`baseline.balancedLow/Upper`), wenn vorhanden, sonst den eigenen.
- **Weniger als 10 Werte:** `status = 'unknown'` und in der UX „Ich lerne dich noch kennen (noch X Tage)“ anzeigen.

### 6.2 Erholungsstatus am Morgen (`green | yellow | red | unknown`)
Punkte vergeben, dann zusammenfassen:

| Kennzahl | gelb, wenn | rot, wenn |
|---|---|---|
| HRV letzte Nacht | unter balancedLow | unter balancedLow − 8 |
| Puls im Schlaf | ≥ Median + 4 | ≥ Median + 8 |
| Atmung im Schlaf | ≥ Median + 1,5 | ≥ Median + 3 |
| Body Battery beim Aufwachen | < 60 | < 40 |
| Schlafdauer | < 6 h | < 5 h |

- **Rot**, wenn mindestens 2 rote Punkte vorliegen **oder** die Atmung rot ist und gleichzeitig Puls oder HRV auffällig sind. Das ist das typische Infektmuster (z. B. 9.11.: Atmung 21 statt 16, Puls im Schlaf 73 statt 56, HRV 36).
- **Gelb**, wenn mindestens 1 roter oder mindestens 2 gelbe Punkte vorliegen.
- **Sonst grün**

Ergebnis: `{status, reasons: [{metric, value, normal_low, normal_high, severity}]}`. Daraus entsteht die „Warum?“-Ansicht.

### 6.3 Laufurteil (`analyzeRun`, bei jedem neuen Lauf)
Eingabe: Zusammenfassung, Abschnitte, FIT-Datensätze (Sekunde, Puls, Tempo, Höhe, Kadenz), `easy_hr_cap`, Lauftyp aus dem Plan, sofern bekannt.

Ausgabe (gespeichert in `wearable_activities.analysis`):
```json
{
  "verdict": "easy_ok | easy_too_hard | late_surge | hard_session | race_like | unknown",
  "share_below_cap": 0.94,
  "share_above_cap_plus5": 0.0,
  "hr_first_half": 141, "hr_second_half": 144,
  "pace_first_half_s_per_km": null, "pace_second_half_s_per_km": null,
  "surge": {"detected": false, "from_min": null, "peak_hr": null},
  "drift_pct": 2.1,
  "flat_efficiency": {"pace_s_per_km": 442, "hr": 154, "m_per_beat": 0.884, "n_windows": 96},
  "comparable_runs": [{"id": "...", "date": "2026-11-06", "delta_hr_at_same_pace": -3}],
  "notes": ["heat_suspected"],
  "sensor": "chest"
}
```

**Regeln:**
- `easy_ok`: mindestens 85 % der Laufzeit (ohne die ersten 5 min) unter `easy_hr_cap`
- `late_surge`: Das letzte Drittel liegt mindestens 10 bpm über dem ersten Drittel, und das Tempo ist im letzten Drittel schneller (draußen), bzw. der Puls steigt in mindestens 3 min um mehr als 15 bpm (Laufband). Erkannt z. B. am 22.11. (2. Hälfte +13 bpm und 28 s/km schneller) und am 18.11. (Minute 42–46: 152 → 179).
- `heat_suspected`: Laufband, gleichmäßiges Tempo und ein Puls-Anstieg über 10 % in 30 min
- **Flache Abschnitte:** 30-s-Fenster mit |Steigung| < 1,5 % und Tempo > 1,7 m/s. Nur draußen und nur mit GPS.
- **Vergleichbare Läufe:** gleicher Typ; draußen ähnliche Strecke (Startpunkt im Umkreis von 500 m und Distanz ±15 %), auf dem Laufband nur mit Geschwindigkeitsangabe des Nutzers (siehe 9.4). **Puls-Vergleiche zwischen Handgelenk und Brustgurt werden als unsicher markiert.**

### 6.4 Auffälligkeiten für Rückfragen (höchstens eine pro Tag, Priorität von oben nach unten)
1. `evening_hr_avg` gestern ≥ Median + 12 bpm
2. Sleep Score ≥ 15 unter dem Median **und** Puls im Schlaf ≥ Median + 4
3. Hoher Stress tagsüber ≥ Median + 60 min
4. Kein Schlaf erkannt, obwohl die Uhr getragen wurde (`wear_hours` > 20)

Es wird **nicht** gefragt, wenn es für diesen Tag schon eine Notiz gibt oder die Ursache offensichtlich ist (z. B. ein Lauf am Abend erklärt den Abendpuls).

**Antwort-Chips:** Standard `Shisha · Alkohol · Party · Kind wach · Stress · Spät gegessen · Hitze · Krank · Nichts Besonderes · Andere…`. **Die Reihenfolge wird personalisiert:** Häufig gewählte Antworten stehen vorne.

### 6.5 Persönliche Muster (wöchentlich, ab 3 Notizen mit demselben Stichwort)
Pro Stichwort: Durchschnitt aus Puls am Abend, HRV und Sleep Score in der Nacht danach im Vergleich zu Tagen ohne Notiz, mit Anzahl n. Ergebnis: *„Shisha (5×): Abendpuls +19, HRV −14 in der Nacht danach.“* **Immer mit n angeben und unter n = 3 nichts behaupten.**

---

## 7. Coach (LLM)

### 7.1 Modell und Aufruf
- Gleiche Konfiguration wie `_shared/estimate.ts` (Modell, Ersatzmodell, Aufwand). Für Briefings Aufwand „low“, für den Chat „medium“.
- **Prompt-Caching** für den Systemprompt und die Werkzeugdefinitionen verwenden
- Neuer Code in `_shared/coach.ts`: `buildContext(userId, date)`, `generateBriefing(kind, ctx)`, `chat(userId, messages)`

### 7.2 Briefing: Eingabe und Ausgabe
**Eingabe:** JSON mit `daily_metrics` von heute und den letzten 14 Tagen, Normalbereichen, Erholungsstatus mit Gründen, Mahlzeiten von gestern (Summe kcal low/mid/high und Eiweiß), letztem Gewicht und 7-Tage-Mittel, Notizen der letzten 14 Tage, Aktivitäten der letzten 7 Tage samt Analyse, `coach_settings` (Ziel, Lockere-Läufe-Obergrenze, Schlafenszeit) und dem geplanten Training für heute (siehe 7.4).

**Ausgabe (festes JSON, mit Schema validieren, bei Fehler einmal neu versuchen, sonst Regel-Fallback):**
```json
{
  "status": "green",
  "headline": "Gut erholt.",
  "why": "HRV 84 (dein Normalbereich 50–73), Ruhepuls 47.",
  "today": {"type": "easy_run", "text": "40 min locker, Puls unter 145.", "duration_min": 40, "hr_cap": 145},
  "food": "Gestern nur ~1.450 kcal. Frühstücke heute richtig.",
  "question": {"text": "Gestern Abend lag dein Puls bei 90, sonst ~70. Was war los?", "options": ["Shisha","Stress","Kind wach","Nichts Besonderes","Andere…"], "date": "2026-11-19"},
  "push": {"title": "Gut erholt 💚", "body": "Heute 40 min locker. Und: Was war gestern Abend los?"}
}
```

**Regeln im Systemprompt:**
- Deutsch, Du-Form, kurze Sätze. Höchstens 3 Zeilen Fließtext im ganzen Briefing.
- **Nur Zahlen verwenden, die im Kontext stehen.** Nichts schätzen oder erfinden. Wenn Daten fehlen, das offen sagen.
- Jede Zahl mit Normalbereich oder Vergleich, wo sinnvoll
- Ehrlich, ohne Schuldzuweisung: „Kein Problem“ statt „Du hättest…“
- Keine Diagnosen. Bei rotem Status mit Atmungsmuster: „Deine Werte weichen deutlich ab. Achte auf Symptome und lass das Training heute aus.“
- Höchstens 1 Emoji, nur in `push.title`

### 7.3 Coach-Chat (Erweiterung von `web-chat`)
- **Absicht erkennen:** Mahlzeit (bestehender Ablauf) oder Coach-Frage. Bei Unsicherheit eine Rückfrage mit Chips: „Essen eintragen“ / „Frage an den Coach“.
- **Werkzeuge für das Modell** (alle Daten nur für den aktuellen Nutzer, serverseitig gefiltert):
  - `get_daily_metrics(from, to)`
  - `get_activities(from, to, type?)`, `get_activity_analysis(id)`
  - `get_meals(from, to)` (Summen pro Tag und Einzelposten)
  - `get_weights(from, to)`
  - `get_notes(from, to, tag?)`
  - `get_patterns()` (aus 6.5)
  - `add_note(date, tag, text)` (wenn der Nutzer im Chat etwas erzählt, z. B. „gestern Shisha“)
  - `update_settings(partial)` (z. B. „Mein Halbmarathon ist am 14.2.“)
- **Antworten dürfen Bausteine enthalten**, die die PWA darstellt: `{"type":"metric_compare", ...}`, `{"type":"run_card", "activity_id": ...}`, `{"type":"chips", ...}`. Format siehe 9.5.
- **Verlauf:** Die letzten 20 Nachrichten der Unterhaltung mitschicken. Ältere Unterhaltungen nicht, dafür sind die Werkzeuge da.

### 7.4 Trainingsplan (minimal, regelbasiert)
Kein vollständiger Plangenerator im MVP. Stattdessen gibt es in `coach_settings.goal` ein Ziel und **Wochenvorlagen**, z. B. für die Basis-Phase: `3 Läufe (2 locker 40 min, 1 lang), 2× Kraft`.

Das Briefing wählt für heute: Ist der Status grün und steht ein Lauf an, dann laufen. Bei Gelb wird der Lauf kürzer und lockerer, bei Rot gibt es Ruhe oder einen Spaziergang. Den Lauf verschiebt das System bei Gelb/Rot automatisch auf den nächsten freien Tag und **sagt das im Briefing**.

---

## 8. Benachrichtigungen (Web Push)

### 8.1 Technik
- **VAPID-Schlüsselpaar** als Supabase Secrets (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`)
- **Service Worker** in der PWA: `push`-Ereignis → `showNotification`; `notificationclick` → öffnet `/heute` bzw. die Laufanalyse. Im Service Worker auch den „Heute“-Bildschirm für den Offline-Betrieb zwischenspeichern.
- **iOS:** Push funktioniert nur, wenn die PWA auf dem Homescreen installiert ist (iOS 16.4+), und die Berechtigung muss nach einer **Nutzeraktion** angefragt werden. Wenn die App im Browser statt installiert läuft (`display-mode: standalone` prüfen), zuerst die Installationsanleitung zeigen (9.6).
- **Versand** aus `nudges` mit einer Web-Push-Bibliothek, die unter Deno läuft, oder einer eigenen VAPID-Implementierung. Bei 404/410 das Abo löschen, bei anderen Fehlern `failed_count` erhöhen.

### 8.2 Wann gepusht wird
| Push | Wann | Inhalt |
|---|---|---|
| **Morgenbriefing** | `after_wake`: 15 min nach Schlafende, sobald Schlaf und HRV synchronisiert sind, frühestens 06:00, spätestens 09:30 (danach als Fallback ohne Schlafdaten). `fixed`: zur eingestellten Uhrzeit | `push` aus dem Briefing |
| **Laufanalyse** | Sobald ein neuer Lauf synchronisiert und analysiert ist | „Locker gelaufen ✅ 94 % unter 145“ / „Ab Min 55 zu schnell geworden. Schau mal rein.“ |
| **Schlaf-Erinnerung** (optional, standardmäßig aus) | 30 min vor `bedtime_target`, nur an Abenden vor einem geplanten Lauf | „Morgen steht dein langer Lauf an. In 30 min ins Bett?“ |
| **Wochenrückblick** | So 19:00 (bestehend) | „Deine Woche ist fertig“ |

**Regeln:** höchstens `max_pushes_per_day` Pushes am Tag, nie in der Ruhezeit. Die bestehende 07:30-Waage-Erinnerung wird ins Morgenbriefing integriert, statt zusätzlich zu kommen. Jeden Versand in `nudges_sent` protokollieren.

---

## 9. UX-Spezifikation

### 9.1 Haltung
Die App soll sich anfühlen wie **eine Trainerin, die dich kennt**, nicht wie ein Messgerät. Kurze Sätze, klare Entscheidungen, ehrlich und warm. **Der Spaß kommt aus drei Dingen:** etwas über sich selbst lernen, das man nicht wusste („Shisha kostet dich 15 HRV-Punkte“), kleine Erfolge sehen („3 Nächte in Folge vor 23 Uhr“) und fast nichts eintippen müssen (Chips statt Formulare).

### 9.2 Navigation
Unten drei Tabs und ein großer Aufnahme-Button in der Mitte:

`Heute` · `( + )` · `Chat` · `Verlauf`

- **`+`** öffnet die bestehende Mahlzeiten-Erfassung (Foto, Sprache, Text). Sie bleibt die wichtigste Aktion, deshalb sitzt sie in der Mitte.
- Die Einstellungen erreicht man über das Profilbild oben rechts.

### 9.3 „Heute“: der Startbildschirm
Von oben nach unten, **nie mehr als eine Bildschirmhöhe bis zur Frage:**

**1. Zustandskarte**
- Groß: **Status als Wort + Symbol + Farbe**, nie nur Farbe: `● Gut erholt` / `◐ Etwas müde` / `○ Heute schonen`
- Ein Satz: „HRV 84, dein Normalbereich 50–73. Ruhepuls 47.“
- Link „**Warum?**“ → Unterseite mit den 3–5 Kennzahlen aus `reasons`: Wert, Normalbereich als Balken, ein Satz Erklärung pro Kennzahl
- Wenn die Daten noch nicht synchronisiert sind: „Deine Nacht ist noch nicht da. Öffne kurz Garmin Connect auf dem Handy.“ Mit Schaltfläche **„Nochmal prüfen“**, die `garmin-sync` für den Nutzer sofort auslöst.

**2. Dein Plan für heute**
- Eine Zeile: „**40 min locker**, Puls unter 145“ bzw. „**Ruhetag**. Ein Spaziergang tut gut.“
- Schaltflächen: **„Erledigt“** (wird nach dem Sync auch automatisch erkannt) · **„Verschieben“** (auf morgen; Plan passt sich an) · **„Hab was anderes gemacht“** (Chips: Kraft, Radfahren, Spaziergang, …)
- Ist der Lauf heute schon gelaufen: Die Karte wird zur **Mini-Laufkarte** (Urteil + 1 Zahl), Tippen öffnet die Analyse.

**3. Essen heute**
- **Spannen-Band statt einer genauen Zahl:** Ein horizontales Band zeigt die bisher gegessenen kcal (low–high) gegen den Zielbereich. Das passt zu happens Ehrlichkeit bei Schätzungen.
- Darunter Eiweiß in Gramm mit kleinem Fortschrittsring
- **Ein Satz Kontext**, wo sinnvoll: „Lauftag, iss heute ruhig ~300 kcal mehr.“ / „Bis jetzt nur 600 kcal. Iss mittags richtig, sonst kommt abends der Heißhunger.“

**4. Eine Frage** (nur wenn eine offen ist)
- Karte mit der Frage und **Chips**. Ein Tipp speichert die Antwort, die Karte bestätigt kurz („Notiert ✓“) und verschwindet.
- „Andere…“ öffnet ein einzeiliges Textfeld.

**5. Tageslinie** (nach unten scrollen)
Eine **senkrechte Zeitachse des heutigen und gestrigen Tages** als Geschichte, nicht als Diagramm:
```
22:00  🌙 Eingeschlafen               (7,6 h · Score 88)
23:30  ·  wach (Kind)                  ← Notiz
05:41  ☀️ Aufgewacht · Body Battery 92
06:00  🏃 Lauf 33 min · locker ✅
07:30  🍳 Shake · 455 kcal
13:40  🍽 Weißwürste mit Breze · 700 kcal
19:00  ⚡ Puls 90 (sonst 70)           ← Shisha
```
- Einträge kommen aus Schlaf, Aktivitäten, Mahlzeiten, Notizen und Auffälligkeiten
- Tippen öffnet die jeweilige Detailansicht
- Hier sieht man auf einen Blick, **wie Essen, Abende und Nächte zusammenhängen**. Das ist der Moment, den keine andere App hat.

### 9.4 Laufanalyse (Detailseite, auch Ziel des Push)
1. **Urteil als Überschrift:** „Locker gelaufen ✅“ / „Zu schnell geworden ab Minute 55“ / „Harte Einheit“ + ein Satz Erklärung
2. **Puls-Verlauf als Fläche** mit gestrichelter Linie bei `easy_hr_cap`. Bereiche darüber sind in der Warnfarbe hinterlegt. Bei Läufen draußen das Höhenprofil blass im Hintergrund. Mit Fadenkreuz und Tooltip (Minute, Puls, Tempo).
3. **Drei Fakten als Kacheln:** Zeit unter 145 · Ø Puls · Last
4. **Vergleich**, nur wenn er belastbar ist: „Gleiche Runde wie am 6.11.: gleich gut. 14 s schneller auf 10 km, das ist Tagesform.“ Bei Sensorwechsel: „Heute mit Brustgurt gemessen. Der Puls-Vergleich ist unsicher.“
5. **Ein Tipp** für das nächste Mal: „Stell den Pulsalarm auf 145.“ / „Bergab nicht Gas geben.“
6. **Laufband:** Frage „Welche Geschwindigkeit hatte das Laufband?“ mit Chips `7,0 · 7,5 · 8,0 · 8,5 · andere`. Die Antwort wird gespeichert und für Vergleiche genutzt („7,5 km/h ≈ Puls 142, vor 2 Wochen 145“).
7. Fühlte sich laut deiner Bewertung „stark“ an, Anstrengung 4/10 (aus `feel` und `rpe`), sofern vorhanden.

### 9.5 Chat
- Sieht aus wie ein normaler Messenger, aber **Antworten des Coaches können Karten enthalten**:
  - `metric_compare`: Kennzahl heute im Vergleich zum Normalbereich (Balken)
  - `run_card`: Mini-Laufanalyse
  - `table`: kleine Tabelle (höchstens 5 Zeilen)
  - `chips`: Antwortvorschläge
- **Vorschläge über dem Eingabefeld**, je nach Tageszeit: morgens „Wie war meine Nacht?“, nach einem Lauf „Wie war mein Lauf?“, abends „Was soll ich noch essen?“
- Die Mahlzeiten-Erfassung über Foto und Sprache bleibt auch im Chat möglich

### 9.6 Onboarding (höchstens 4 Schritte)
1. **„Was willst du erreichen?“** Chips: `Abnehmen · Fitter werden · Für einen Lauf trainieren · Besser schlafen` (Mehrfachauswahl). Bei „Lauf“: Name, Datum, Wunschzeit (optional).
2. **„Verbinde deine Uhr“** mit Garmin-Logo-freier Darstellung (keine Markenlogos ohne Erlaubnis verwenden). Schritt-für-Schritt: (a) Link zur Garmin-Connect-Seite für den Personal API Key, (b) „Create Key“, Bedingungen akzeptieren, Ablaufdatum wählen, (c) Schlüssel kopieren, (d) hier einfügen. Bestätigung: „Verbunden ✓ Ich lade deine letzten 4 Wochen.“ **Überspringbar.**
3. **„Leg happen auf deinen Homescreen“**: nur auf iOS im Browser, mit Animation der Teilen-Schaltfläche und „Zum Home-Bildschirm“
4. **„Darf ich dich morgens kurz informieren?“**: erklärt den Nutzen in einem Satz, **dann** die Push-Berechtigung anfragen. Kanal: Push / Telegram / beides.

**Danach:** Erster „Heute“-Bildschirm mit dem Hinweis „Ich lerne dich noch kennen. Nach etwa 10 Tagen kenne ich deinen Normalbereich.“ und einem Fortschrittsbalken.

### 9.7 Verlauf
- **Wochenansicht** als Standard: Für jeden Tag eine Zeile mit Status-Punkt, Schlaf (Stunden), Training (Symbol + Minuten), kcal-Mitte, Notiz-Symbol. Tippen öffnet die Tageslinie dieses Tages.
- **Trends**, ein Diagramm pro Kennzahl, kein Doppelachsen-Diagramm: Gewicht (Punkte + 7-Tage-Mittel), HRV, Ruhepuls, Wochen-Lauf-Minuten nach locker/hart aufgeteilt
- **„Deine Muster“**: die Ergebnisse aus 6.5 als Karten, z. B. „Shisha · 5× · Abendpuls +19 · HRV −14“, „Vor 22:30 im Bett · 9× · HRV +12“

### 9.8 Wochenrückblick (So, Story-Format)
5 Karten zum Durchwischen, jede mit genau einer Aussage:
1. **Training:** „3 Läufe, 22,6 km. 2 davon wirklich locker.“
2. **Schlaf:** „Ø 7,1 h. Deine beste Nacht: Montag, nach einem ruhigen Abend.“
3. **Essen und Gewicht:** „Ø 2.350 kcal (Spanne 2.100–2.600) bei ~2.750 Verbrauch. Gewicht 7-Tage-Mittel −0,4 kg. Das passt zusammen.“ Wenn es nicht zusammenpasst, das ehrlich sagen.
4. **Muster der Woche:** „Zwei Shisha-Abende, beide mit schwächerer Nacht danach.“
5. **Nächste Woche:** der Plan in 3 Zeilen + „Passt das?“ mit Chips `Ja · Weniger Zeit · Mehr Zeit`

### 9.9 Sprache (Microcopy)
- **Du-Form**, kurze Hauptsätze, aktive Verben
- **Zahlen immer mit Bezug:** „HRV 54 (normal 50–73)“, nie nur „HRV 54“
- **Keine Schuld:** „Kein Problem, dann verschieben wir den Lauf.“ statt „Du hast den Lauf verpasst.“
- **Ehrlich bei Unsicherheit:** „Das ist eine Schätzung.“ / „Mit 3 Werten kann ich noch nichts sagen.“
- **Keine Diagnosen:** „Deine Werte weichen deutlich ab“ statt „Du wirst krank“
- **Lob für Verhalten:** „3 Nächte in Folge vor 23 Uhr 👏“
- **Höchstens ein Emoji pro Nachricht**

### 9.10 Gestaltung
- **Ruhig und klar:** eine Akzentfarbe, sonst neutrale Töne. Helles und dunkles Design, beides von Anfang an.
- **Statusfarben** grün, gelb und rot nur für den Erholungsstatus, **immer mit Symbol und Wort**
- **Typografie:** Die eine wichtige Zahl auf einer Karte darf groß sein, alles andere zurückhaltend. Ziffern mit `tabular-nums`.
- **Diagramme:** dünne Linien, Normalbereich als blasses Band, Tooltip bei Berührung, keine Achsenwüsten
- **Bewegung sparsam:** Eine kleine Bestätigungsanimation beim Beantworten einer Frage und beim Abhaken des Plans. `prefers-reduced-motion` respektieren.
- **Barrierefreiheit:** Tippflächen mindestens 44 × 44 px, Kontrast nach WCAG AA, nie Information nur über Farbe
- **Geschwindigkeit:** „Heute“ öffnet sich in unter 1 s aus dem Cache des Service Workers und lädt danach im Hintergrund nach

### 9.11 Leere und Fehlerzustände
| Zustand | Was der Nutzer sieht |
|---|---|
| Keine Uhr verbunden | „Heute“ zeigt nur Essen und Frage-Karten aus happen, dazu eine dezente Karte „Verbinde deine Uhr, dann kann ich dir sagen, wie erholt du bist.“ |
| Noch keine 10 Tage Daten | Status „unknown“: „Ich lerne dich noch kennen (Tag 4 von 10)“ |
| Nacht nicht synchronisiert | Siehe 9.3 (1), mit „Nochmal prüfen“ |
| Schlüssel abgelaufen | Gelbe Karte „Garmin-Verbindung abgelaufen“ + Anleitung zum Erneuern |
| Push nicht erlaubt | Einstellungen zeigen, wie man es nachträglich erlaubt; kein ständiges Nachfragen |

---

## 10. Datenschutz und Sicherheit
- **Gesundheitsdaten (DSGVO Art. 9):** Vor dem Verbinden eine **ausdrückliche Einwilligung** einholen (Checkbox mit klarem Text, was gespeichert und wofür es genutzt wird, inklusive Weitergabe an Anthropic zur Auswertung). Einwilligung mit Zeitstempel speichern.
- **Löschen:** „Verbindung trennen und Daten löschen“ entfernt Secret, Verbindung, `wearable_raw`, `daily_metrics`, `wearable_activities`, Briefings. Bestehende happen-Daten bleiben.
- **Geheimnisse:** API-Keys nur im Vault, Token nicht im Klartext, nichts davon in Logs, Fehlermeldungen oder LLM-Kontexten
- **LLM-Kontext:** nur aufbereitete Werte, keine Rohdaten, keine GPS-Koordinaten
- **RLS-Tests** für alle neuen Tabellen: Ein Nutzer darf keine Daten eines anderen sehen

---

## 11. Meilensteine mit Abnahmekriterien

Jeder Meilenstein: eigener Branch, eigener PR, Tests grün, kurze Beschreibung mit Screenshots (für UI).

### M1: Datenbasis
- Migrationen aus Abschnitt 4 inklusive RLS und Tests
- `wearable-connect` (Verbinden, Trennen, Backfill 28 Tage) und `garmin-sync` (Cron, Token-Cache, Backoff, idempotente Upserts)
- `_shared/garmin/transform.ts` mit Unit-Tests anhand von Beispiel-JSON (siehe 12)
- **Fertig, wenn:** Für den Eigentümer stehen nach dem Verbinden 28 Tage `daily_metrics` und alle Aktivitäten in der Datenbank. Ein zweiter Sync-Lauf ändert nichts. Ein ungültiger Schlüssel führt zu `status = expired` und genau einem Hinweis.

### M2: Signale, Briefing, Web Push
- `_shared/signals.ts` (6.1–6.4) mit Tests, `_shared/coach.ts` (Briefing)
- VAPID, Service Worker, `push_subscriptions`, Versand in `nudges` inklusive `after_wake`-Logik, Ruhezeiten und Tageslimit
- Waage-Erinnerung um 07:30 ins Briefing integriert
- **Fertig, wenn:** Der Eigentümer bekommt nach dem Aufwachen innerhalb von 30 min (sofern die Uhr synchronisiert hat) einen Push, und das Briefing enthält nur Zahlen, die in `daily_metrics` stehen.

### M3: „Heute“ und Tageslinie
- Bildschirm nach 9.3 mit allen Zuständen aus 9.11, Chips speichern `context_notes`
- „Nochmal prüfen“ löst einen Sync für diesen Nutzer aus
- **Fertig, wenn:** Funktioniert installiert auf dem iPhone (hell und dunkel), lädt aus dem Cache in unter 1 s, eine Frage lässt sich mit einem Tipp beantworten.

### M4: Laufanalyse
- `analyzeRun` (6.3) inklusive FIT-Parsing (Deno-kompatible FIT-Bibliothek oder eigener Parser für `record`- und `device_info`-Nachrichten)
- Detailseite nach 9.4, Push nach neuem Lauf, Frage nach der Laufband-Geschwindigkeit
- **Fertig, wenn:** Die Testfälle in 12 das erwartete Urteil liefern.

### M5: Coach-Chat und Wochenrückblick
- Werkzeuge aus 7.3, Absichtserkennung in `web-chat`, Antwort-Bausteine in der PWA
- Wochenrückblick nach 9.8 (Push + Story-Ansicht), Muster nach 6.5
- **Fertig, wenn:** „Wie war mein Lauf?“, „Wie habe ich geschlafen?“ und „Was soll ich heute Abend essen?“ werden mit echten Daten beantwortet, und „gestern war Shisha“ im Chat legt eine Notiz an.

### M6 (optional): Experimente
Karte „Experiment starten“ (z. B. „2 Wochen kein Koffein nach 14 Uhr“), tägliche Ja/Nein-Abfrage per Chip, Auswertung am Ende im Vergleich zur Zeit davor, mit n und ehrlichem Ergebnis („kein messbarer Unterschied“ ist ein gültiges Ergebnis).

---

## 12. Tests

**Beispieldaten (Fixtures):** Für jeden Endpunkt aus Anhang A eine anonymisierte Antwort in `supabase/functions/_shared/garmin/__fixtures__/`. Die Struktur steht in Anhang A.2. Der Eigentümer kann echte Antworten liefern.

**Unit-Tests, die es geben muss:**
- Lokale Schlafzeiten aus `*TimestampLocal` (inklusive einer Nacht über die Zeitumstellung, z. B. 24./25.10.2026)
- `evening_hr_avg` mit und ohne Aktivität am Abend, mit Lücken
- Erholungsstatus für diese Fälle aus den echten Daten des Eigentümers:
  - **grün:** HRV 84, Puls im Schlaf 52, Atmung 16, Body Battery 98, 7,9 h
  - **rot (Infektmuster):** HRV 36, Puls im Schlaf 73, Atmung 21, Body Battery 20, 5,4 h
  - **gelb:** HRV 44, Puls im Schlaf 65, Atmung 16, Body Battery 57, 7,3 h (nach hartem langem Lauf)
- `analyzeRun`:
  - **easy_ok:** Laufband 33 min, Ø 139, 94 % unter 145, kein Anstieg am Ende
  - **late_surge:** Laufband 49 min, 40 min bei 130–152, dann Minute 42–46 bei 167–179
  - **late_surge (draußen):** 86 min, 1. Hälfte Ø 149 bei 7:39/km, 2. Hälfte Ø 162 bei 7:11/km
- Auffälligkeiten: Abendpuls 90 bei Normalbereich ~70 → Rückfrage; Abendpuls 90 mit Lauf um 19 Uhr → keine Rückfrage
- Push: Ruhezeit, Tageslimit, `after_wake`-Fenster, Abo mit 410 wird gelöscht

**Manuell:** iPhone mit installierter PWA (Push, Offline, dunkles Design), Android Chrome, Desktop.

---

## 13. Offene Fragen an den Eigentümer
1. **Gewicht:** Bleibt `weights` die einzige Quelle, oder sollen Garmin-Gewichte importiert werden?
2. **Bestehende Tabelle `activities`:** erweitern oder `wearable_activities` getrennt halten und verknüpfen?
3. **Modell:** Für Briefing und Chat dasselbe Modell wie für die Schätzung, oder ein günstigeres für Briefings?
4. **Telegram:** Soll das Morgenbriefing parallel auch in Telegram kommen, solange die PWA neu ist?
5. **Startwerte für den Eigentümer:** `easy_hr_cap = 145`, `lthr = 174`, Ziel „Halbmarathon Barcelona, 14.02.2027, 2:10:00“, Schlafenszeit 22:30, Zeitzone Europe/Berlin

---

## Anhang A: Garmin Personal API (verifiziert)

### A.1 Grundlagen
- **Basis-URL:** `https://personal.connectapi.garmin.com` (China: `https://personal.connectapi.garmin.cn`)
- **Offizielle Doku:** https://developer.garmin.com/gc-developer-program/personal/swagger-docs/ (Swagger, die Spezifikation ist in der Seite eingebettet)
- **Token holen:**
  ```
  POST /personalapitoken-service/personal-api/personal-api-key/token
  Authorization: ApiKey <PERSONAL_API_KEY>
  ```
  Die Antwort ist **direkt der JWT als Text**, kein JSON. Gültigkeit 24 h (`exp − iat = 86400`). Scopes u. a. `PERSONAL_API_FITNESS_READ`, `PERSONAL_API_WELLNESS_READ`, `PERSONAL_API_NUTRITION_READ`, `PERSONAL_API_USER_READ`.
- **Alle weiteren Aufrufe:** `Authorization: Bearer <JWT>`
- **Nur lesend.** Die API kann nichts schreiben.
- **Nicht verfügbar:** VO2max, Trainingszustand, Trainingsbereitschaft, Erholungszeit, Wettkampfprognose, Belastungsfokus

### A.2 Endpunkte, die wir nutzen
| Zweck | Endpunkt | Hinweise |
|---|---|---|
| Profil | `GET /userprofile-service/userprofile/settings` | Zeitzone (`timeZone`), Einheiten; gut für den Verbindungstest |
| Tageszusammenfassungen | `GET /usersummary-service/v2/dailysummaries?startDate=&endDate=` | bis 1 Jahr; Antwort `{data:[...]}`. Felder: `movement.steps.value`, `heartRate.{restingValue,minValue,maxValue}`, `calories.{burnedTotal,burnedActive,burnedResting}`, `stress.{avgLevel, highStressDurationInMillis, mediumStressDurationInMillis, restDurationInMillis, totalDurationInMillis}`, `bodyBattery.{minValue,maxValue,chargedValue,drainedValue,latestValue, activityEvents[]}`, `intensityMinutes.{moderate,vigorous}`, `respiration.avgValue` |
| Schlaf einer Nacht | `GET /sleep-service/sleep/dailySleep?date=YYYY-MM-DD` | Nacht, die **am Morgen dieses Datums endet**. Felder: `sleepTimeSeconds`, `deep/light/rem/awakeSleepSeconds`, `awakeCount`, `sleepStartTimestampLocal`, `sleepEndTimestampLocal`, `avgHeartRate`, `averageRespirationValue`, `avgSleepStress`, `sleepScores.overall.value`, `sleepNeed.actual` (min), `napTimeSeconds` |
| Schlaf mehrerer Nächte | `GET /sleep-service/sleep/dailySleepSummariesByDate?startDate=&endDate=` | höchstens 31 Tage; Tage ohne Schlaf haben `null`-Felder |
| HRV | `GET /hrv-service/hrv/{date}` und `/hrv-service/hrv/daily/{from}/{to}` | `hrvSummary.{lastNightAvg, lastNight5MinHigh, weeklyAvg, status (BALANCED/UNBALANCED/LOW/NONE), baseline.{balancedLow, balancedUpper, lowUpper}}`. In der Einlernphase (ca. 3 Wochen) ist `baseline` `null` |
| Puls über den Tag | `GET /wellness-service/wellness/dailyHeartRate?date=` | `heartRateValues: [[epochMs, bpm|null], ...]` im 2-min-Takt, `restingHeartRate`, `lastSevenDaysAvgRestingHeartRate` |
| Body Battery | `GET /wellness-service/wellness/bodyBattery/reports/daily?startDate=&endDate=` | höchstens 31 Tage. `bodyBatteryValuesArray: [[epochMs, level|null]]`, **nur wenige Stützpunkte**, enthält `null` |
| Stress / Schritte | `/usersummary-service/stats/stress/daily/{s}/{e}`, `/stats/steps/daily/{s}/{e}` | höchstens 28 Tage; meist reichen die Tageszusammenfassungen |
| Aktivitätsliste | `GET /activitylist-service/activities/search/activities?start=0&limit=100` | Seiten mit `start`. Felder: `activityId`, `startTimeLocal` ("YYYY-MM-DD HH:MM:SS"), `activityType.typeKey`, `distance` (m), `duration` (s), `averageHR`, `maxHR`, `hrTimeInZone_1..5` (s), `activityTrainingLoad`, `aerobicTrainingEffect`, `anaerobicTrainingEffect`, `trainingEffectLabel`, `averageRunningCadenceInStepsPerMinute`, `elevationGain` |
| Aktivitätsdetails | `GET /activity-service/activity/{id}` | `summaryDTO` (inkl. `directWorkoutFeel` 0–100, `directWorkoutRpe` 10–100, `groundContactTime`, `verticalOscillation`, `verticalRatio`, `strideLength`, `waterEstimated`), `splitSummaries[]` mit `splitType` (`RWD_RUN`, `RWD_WALK`, `RWD_STAND`, `INTERVAL_ACTIVE/WARMUP/COOLDOWN/RECOVERY`), `metadataDTO.sensors[]` |
| Workout in Aktivität | `GET /activity-service/activity/{id}/workouts` | Schritte mit Zieltempo (`targetValueLow/High` in m/s) |
| Original-Datei | `GET /download-service/files/activity/{id}` | **ZIP mit FIT-Datei.** Pro Sekunde: `heart_rate`, `enhanced_speed`, `enhanced_altitude`, `cadence` (Schritte pro Bein, ×2 nehmen), `distance`; `lap`-Nachrichten; `device_info` (Sensoren) |
| Pulszonen | `GET /biometric-service/heartRateZones/v2` | `trainingMethod`, `zone1Floor..zone5Floor`, `maxHeartRateUsed`, `restingHeartRateUsed`, `lactateThresholdHeartRateUsed` |
| Gewicht | `GET /weight-service/weight/range/{s}/{e}?includeAll=true` | `weight` in **Gramm** |
| Weitere | Fitnessalter, SpO2, Hydration, Ernährung, Zyklus | im MVP nicht nötig |

### A.3 Fallstricke (aus der Praxis)
1. **`*TimestampLocal` sind „lokale Zeit als Epoch“.** Als UTC formatieren, nicht umrechnen.
2. **Daten kommen erst nach dem Handy-Sync.** Tage sind oft unvollständig (`stress.totalDurationInMillis` / Tragezeit prüfen). Ein späterer Sync füllt sie auf, deshalb den aktuellen und den vorherigen Tag immer neu holen.
3. **Schlafdatum = Morgen.** `dailySleep?date=2026-11-22` ist die Nacht vom 21. auf den 22.
4. **Seltsame Schlafaufzeichnungen** (z. B. „Schlaf“ 20:50–23:36 mit 2,3 h) kommen vor. Unter 3 h mit Ende vor Mitternacht als unsicher markieren.
5. **Laufband:** Tempo und Distanz vom Handgelenk sind ungenau (in der Praxis ~+35 % zu hoch). Die vom Nutzer korrigierte Gesamtdistanz kann von `splitSummaries` abweichen.
6. **Pulsquelle wechselt** (Handgelenk ↔ Brustgurt). Bei Vergleichen markieren.
7. **`hrTimeInZone_*` richtet sich nach den Zonen-Einstellungen des Nutzers** (die sich ändern können). Für eigene Urteile immer `easy_hr_cap` aus den Rohdaten verwenden.
8. **Gefühl/Anstrengung:** `directWorkoutFeel` 0/25/50/75/100 = sehr schwach/schwach/normal/stark/sehr stark; `directWorkoutRpe` 10–100 = 1–10
9. **Rate-Limits sind nicht dokumentiert.** Sparsam abfragen, Backoff bei 429.
10. **Wenn Garmin Connect auf dem Handy nicht synchronisiert**, liefert die API tagelang nichts Neues. Das ist kein API-Fehler. In der Praxis half ein Neustart des Handys. In der UX als „Uhr hat seit X Stunden nicht synchronisiert“ anzeigen, wenn der letzte Tageswert älter als 12 h ist.
