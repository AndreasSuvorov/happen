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

## Einrichtung

1. **Bot anlegen:** In Telegram `@BotFather` → `/newbot` → Token notieren.
2. **Supabase-Projekt** (Region Frankfurt `eu-central-1`) anlegen und verknüpfen:
   ```bash
   supabase link --project-ref <PROJECT_REF>
   supabase db push
   ```
3. **Secrets setzen** (Dashboard → Edge Functions → Secrets oder CLI):
   ```bash
   supabase secrets set \
     TELEGRAM_BOT_TOKEN=<token> \
     TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 24) \
     ANTHROPIC_API_KEY=<key> \
     OPENAI_API_KEY=<key-optional-fuer-sprache> \
     CRON_SECRET=$(openssl rand -hex 24) \
     ALLOWED_CHAT_IDS=<deine-chat-id>
   ```
   Die Chat-ID verrät der Bot selbst: einfach eine Nachricht schicken, solange `ALLOWED_CHAT_IDS` noch leer ist.
4. **Functions deployen** (eigene Authentifizierung über Secrets, daher ohne JWT-Prüfung):
   ```bash
   supabase functions deploy telegram --no-verify-jwt
   supabase functions deploy nudges --no-verify-jwt
   ```
5. **Webhook registrieren:**
   ```bash
   curl "https://api.telegram.org/bot<token>/setWebhook" \
     -d "url=https://<PROJECT_REF>.supabase.co/functions/v1/telegram" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
     -d 'allowed_updates=["message","callback_query"]'
   ```
6. **Erinnerungen:** `supabase/cron.sql` im SQL-Editor ausführen (Platzhalter ersetzen).
7. Im Bot: `/profil 176 <Jahrgang> m` für das Tagesbudget.

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

Claude Opus 5.5 mit `effort: low`: ca. 2–4 Cent pro Mahlzeit, bei 5 Einträgen am Tag also etwa 3–6 € im Monat. Supabase im Free-Plan.
