# Coach M1: Datenbasis

Stand von Meilenstein 1 aus dem [Coach-Plan](Coach-Plan.md) (Abschnitt 11).

## Was gebaut ist

| Teil | Datei |
|---|---|
| Migration (alle Tabellen aus Abschnitt 4, RLS, Vault-RPCs) | `supabase/migrations/20261123000000_coach_data.sql` |
| Garmin-Client (Token, Backoff, Endpunkte) | `supabase/functions/_shared/garmin/client.ts` |
| Aufbereitung (reine Funktionen) | `supabase/functions/_shared/garmin/transform.ts` |
| Sync-Logik (Token-Cache, Backfill, idempotente Upserts) | `supabase/functions/_shared/garmin/sync.ts` |
| Supabase-Anbindung der Sync-Logik | `supabase/functions/_shared/garmin/store.ts` |
| Verbinden / Status / Trennen | `supabase/functions/wearable-connect/` |
| Sync (Cron + „Nochmal prüfen“) | `supabase/functions/garmin-sync/` |
| Cron-Eintrag | `supabase/cron.sql` (`happen-garmin-sync`, alle 20 min) |
| Garmin-Karte in den Einstellungen | `web/src/components/GarminCard.tsx` |
| Beispieldaten | `supabase/functions/_shared/garmin/__fixtures__/` |
| Tests | `tests/garmin-transform.test.ts`, `tests/garmin-sync.test.ts`, `tests/rls.test.ts` |

## Abnahmekriterien

| Kriterium | Nachweis |
|---|---|
| Nach dem Verbinden stehen 28 Tage `daily_metrics` und alle Aktivitäten in der DB | `garmin-sync.test.ts` (Fake-Garmin); echt: nach ~2 Sync-Läufen (≤ 40 min) |
| Ein zweiter Sync-Lauf ändert nichts | `garmin-sync.test.ts`: 0 Schreibzugriffe, Token wird wiederverwendet |
| Ungültiger Schlüssel → `status = expired` und genau ein Hinweis | `garmin-sync.test.ts` |
| RLS: kein Nutzer sieht Daten eines anderen | `rls.test.ts` (alle Migrationen gegen PGlite) |

## Abweichungen vom Plan und Entscheidungen

1. **Feature-Flag als Tabelle `user_features`** statt `users.features`: Nutzer dürfen ihre `users`-Zeile selbst ändern
   (Policy `users_self_update`) und könnten sich das Flag sonst selbst setzen. Freischalten per SQL:
   `insert into public.user_features (user_id, feature) values ('<users.id>', 'garmin');`
2. **Token ebenfalls im Vault** (`token_secret_id`) statt `token_cache`-Spalte. Zugriff nur über die RPCs
   `wearable_secret_*`, die ausschließlich die Service Role ausführen darf.
3. **`wearable_connections` und `wearable_raw` haben keine Lese-Policy.** Der Client bekommt den Status über
   `wearable-connect` (`action: "status"`), so sieht er weder Vault-IDs noch Rohdaten.
4. **Zusätzliche Spalten:** `wearable_connections.consent_at` (Einwilligung, Pflicht), `last_data_at`
   (für „Uhr hat seit X h nicht synchronisiert“), `backfill_from`/`backfill_cursor`, `expired_notified_at`;
   `wearable_raw.hash` (unveränderte Daten werden nicht neu geschrieben); `daily_metrics.sleep_uncertain`;
   `wearable_activities.detail_fetched_at`.
5. **Backfill in Blöcken von 14 Tagen pro Sync-Lauf** statt alles auf einmal, damit kein Lauf in ein Zeitlimit
   der Edge Runtime läuft. Der erste Block läuft direkt nach dem Verbinden, der zweite beim nächsten Cron-Lauf.
6. **`wearable_activities` getrennt von `activities`** (offene Frage 2). FIT-Download erst in M4.
7. **Gewicht:** Garmin-Gewichte werden nicht importiert (offene Frage 1).
8. **Hinweis „Schlüssel abgelaufen“** geht bis M2 (Web Push) per Telegram, falls verknüpft, und wird in
   `nudges_sent` (`garmin_expired`) protokolliert. Die Einstellungen zeigen ihn zusätzlich.
9. **`is_complete`** = Tag vorbei und Tragezeit ≥ 20 h. `wear_hours` kommt aus `stress.totalDurationInMillis`.
10. **CORS:** wie bei den bestehenden Functions nicht gesetzt (gleiche Domain / Proxy).

## Annahmen, die echte Daten bestätigen müssen

Die Fixtures sind synthetisch nach Anhang A.2. Bitte echte, anonymisierte Antworten liefern, dann ersetze ich sie:
- `dailySleep` antwortet mit `{ dailySleepDTO: {...} }` (der Code akzeptiert auch die Felder direkt auf oberster Ebene).
- `heartRateValues` und `bodyBatteryValuesArray` enthalten **echte** Epoch-ms (GMT), anders als `*TimestampLocal`.
- Body-Battery-Bericht ist ein Array mit `date` pro Tag; Tageszusammenfassungen tragen `calendarDate`.
- Brustgurt erkennt der Code an `bleDeviceType`, `antplusDeviceType` oder `sensorType` mit `HEART_RATE`.

## Einrichtung

1. Migration einspielen: `supabase/migrations/20261123000000_coach_data.sql` (Vault-Extension muss aktiv sein,
   im Docker-Setup ist sie das).
2. Functions `wearable-connect` und `garmin-sync` deployen (Self-Hosting: nach `docker/volumes/functions/` kopieren).
   Keine neuen Secrets nötig (`CRON_SECRET`, `SUPABASE_*` gibt es schon).
3. Den Block `happen-garmin-sync` aus `supabase/cron.sql` ausführen.
4. Feature freischalten (siehe oben), dann in der PWA unter Einstellungen → Garmin den Schlüssel einfügen.

## Tests

```bash
npm install
npm test
npm run check
```
