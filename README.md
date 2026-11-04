# Happen

Ernährungstagebuch per Telegram: Foto, Sprachnachricht oder Text schicken, Happen schätzt die Kalorien als ehrliche Spanne. Das Trendgewicht von der Waage zeigt, was wirklich passiert.

Phase 1 (persönliche Nutzung): Telegram-Bot, KI-Schätzung, Gewicht mit Trend, Läufe per Nachricht, Erinnerungen.
Konzept: siehe Konzeptdokument „Happen – Konzept“.

## Architektur

```
Telegram ──webhook──▶ Edge Function `telegram` ──▶ Claude (Foto/Text → Bestandteile + kcal-Spanne)
                         │                    └──▶ OpenAI-Transkription (nur Sprachnachrichten)
                         ▼
                 Postgres (users, messages, entries, weights, activities) + Storage `inbox`
                         ▲
pg_cron (alle 15 min) ──▶ Edge Function `nudges` (07:30 Waage, 13:30 Mittag, 21:00 Rückblick, So 19:00 Woche)
```

- `supabase/migrations/` – Schema. RLS ist überall aktiv, ohne Policies: nur die Edge Functions (Service Role) greifen zu.
- `supabase/functions/_shared/nutrition.ts` – reine Rechenlogik (Trendgewicht, Budget, Parser), getestet.
- `supabase/functions/_shared/estimate.ts` – Claude-Aufruf mit festem JSON-Schema.
- `supabase/functions/telegram/` – Webhook, Befehle, Buttons.
- `supabase/functions/nudges/` – Erinnerungen.

## Einrichtung (Supabase self-hosted, Docker)

Voraussetzung: das offizielle `supabase/docker`-Setup läuft und ist über HTTPS öffentlich erreichbar
(Telegram ruft den Webhook von außen auf, z. B. über Reverse Proxy oder Cloudflare Tunnel).

1. **Bot anlegen:** In Telegram `@BotFather` → `/newbot` → Token notieren.
2. **Schema einspielen:** `supabase/migrations/20261104000000_init.sql` im Studio-SQL-Editor ausführen
   (oder `psql "$DATABASE_URL" -f supabase/migrations/20261104000000_init.sql`).
3. **Functions kopieren:** Inhalt von `supabase/functions/` nach `docker/volumes/functions/` kopieren,
   sodass dort `_shared/`, `telegram/` und `nudges/` liegen.
4. **Secrets** in `docker/.env` eintragen und im `functions`-Service der `docker-compose.yml` unter `environment:` durchreichen:
   ```yaml
   TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
   TELEGRAM_WEBHOOK_SECRET: ${TELEGRAM_WEBHOOK_SECRET}   # openssl rand -hex 24
   ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
   OPENAI_API_KEY: ${OPENAI_API_KEY}                     # optional, nur für Sprachnachrichten
   CRON_SECRET: ${CRON_SECRET}                           # openssl rand -hex 24
   ALLOWED_CHAT_IDS: ${ALLOWED_CHAT_IDS}                 # deine Telegram-Chat-ID
   ```
   `SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` setzt das Docker-Setup bereits.
5. **JWT-Prüfung:** Telegram kann kein Supabase-JWT mitschicken. Im Self-Hosting gilt `FUNCTIONS_VERIFY_JWT`
   für alle Functions; für Happen `FUNCTIONS_VERIFY_JWT=false` setzen. Beide Functions prüfen selbst ein Secret
   (`x-telegram-bot-api-secret-token` bzw. `x-cron-secret`). Laufen auf derselben Instanz andere Functions,
   die JWT brauchen, müssen diese die Prüfung selbst übernehmen.
6. **Neu starten:** `docker compose up -d --force-recreate functions`
7. **Webhook registrieren:**
   ```bash
   curl "https://api.telegram.org/bot<token>/setWebhook" \
     -d "url=https://<deine-domain>/functions/v1/telegram" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
     -d 'allowed_updates=["message","callback_query"]'
   ```
   Die Chat-ID verrät der Bot selbst: einfach eine Nachricht schicken, solange `ALLOWED_CHAT_IDS` noch leer ist.
8. **Erinnerungen:** `supabase/cron.sql` im SQL-Editor ausführen. Als URL reicht intern `http://kong:8000/functions/v1/nudges`.
9. Im Bot: `/profil 176 1998 m` für das Tagesbudget.

Variante Supabase Cloud: `supabase db push`, `supabase secrets set …`, `supabase functions deploy telegram --no-verify-jwt`
(ebenso `nudges`), Webhook-URL `https://<PROJECT_REF>.supabase.co/functions/v1/telegram`.

## Tests

```bash
node --test tests/nutrition.test.ts
npx deno@2.5.6 check supabase/functions/telegram/index.ts supabase/functions/nudges/index.ts
```

## Annahmen (bewusst einfach, werden an der Waage kalibriert)

| Annahme | Wert | Quelle / Begründung |
| --- | --- | --- |
| Grundumsatz | Mifflin-St-Jeor | Standardformel |
| Aktivitätsfaktor ohne Training | 1,35 | Büroalltag, Startwert |
| Laufverbrauch brutto | ≈ 1 kcal pro kg und km | gängige Näherung |
| Gutschrift Laufkalorien | 50 % | Studien zeigen 30–60 % Kompensation |
| Defizit | Ziel kg/Woche × 7.700 / 7 | nur langfristig gültig |
| Untergrenze | 1.500 kcal/Tag | Sicherheitsgrenze |
| Trendglättung | α = 0,1 pro Tag, max. 3 Tage Lücke | dämpft Ausreißer nach Pausen |

## Kosten (grob)

Claude Opus 5.5 mit `effort: low`: ca. 2–4 Cent pro Mahlzeit, bei 5 Einträgen am Tag also etwa 3–6 € im Monat. Supabase läuft selbst gehostet.
