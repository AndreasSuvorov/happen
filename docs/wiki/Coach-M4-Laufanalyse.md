# Coach M4: Laufanalyse

Stand von Meilenstein 4 (Plan 6.3, 9.4, 8.2).

## Ablauf
1. `garmin-sync` (Cron oder „Nochmal prüfen“) lädt wie bisher Aktivitätsliste und Details.
2. Danach (`SyncDeps.afterActivities` → `_shared/run/hook.ts`) werden bis zu **3 Läufe pro Sync** ausgewertet: Läufe der letzten 90 Tage mit geladenen Details, deren `analysis` fehlt oder veraltet ist.
3. Für jeden Lauf: `GET /download-service/files/activity/{id}` → `unzipFirstFit` → `parseFit` → `analyzeRun` → `comparableRuns` → `wearable_activities.analysis`.
4. Für neue Läufe von heute oder gestern kommt ein Push („Locker gelaufen · 94 % unter 145“, Link `/lauf/<id>`), mit Ruhezeit, Tageslimit und Kanal wie beim Morgenbriefing (`nudges_sent.kind = coach_run:<id>`).

Neu gerechnet wird, wenn sich `ANALYSIS_VERSION`, die Pulsgrenze (`coach_settings.easy_hr_cap`) oder die vom Nutzer genannte Laufband-Geschwindigkeit (`context_notes`, tag `laufband_kmh`) ändert. Ohne FIT-Datei wird vorsichtig aus Ø/Max-Puls geurteilt (`notes: ["no_fit"]`), damit nicht endlos neu geladen wird.

## Dateien
| Datei | Inhalt |
|---|---|
| `_shared/run/types.ts` | Schnittstelle (`FitActivity`, `RunAnalysis`, …) |
| `_shared/run/fit.ts` | ZIP + FIT-Decoder (record, device_info; Brustgurt-Erkennung) |
| `_shared/run/analyze.ts` | `analyzeRun`, `comparableRuns`, deutsche Texte |
| `_shared/run/pipeline.ts` | Auswahl, Neuberechnung, Speichern (testbar ohne Supabase) |
| `_shared/run/store.ts`, `notify.ts`, `hook.ts` | Supabase, Push, Einbindung in den Sync |

## Regeln (Kurzfassung)
- Puls 15-s-Median, Anteile ab Minute 5. `easy_ok` ≥ 85 % unter Grenze.
- `late_surge` draußen: letztes Drittel ≥ +10 bpm und schneller; Laufband: > 15 bpm in ≤ 3 min. Wird vor `easy_ok` geprüft.
- `race_like`: Ø > Grenze + 20 und > 70 % über Grenze + 10. `hard_session`: Ø ≥ Grenze + 8, nur wenn kein lockerer/langer Lauf geplant war.
- `heat_suspected`: Laufband, gleichmäßiges Tempo, Puls +10 % in 30 min.
- Vergleich: gleicher Typ; draußen Start ≤ 500 m und Distanz ±15 %; Laufband gleiche km/h und Dauer ±25 % (Zusatzregel, nicht im Plan). Sensorwechsel wird als unsicher markiert.

## Offen
- Getestet nur mit synthetischen FIT-Dateien. Eine echte Garmin-Datei als Fixture fehlt noch.
- `AnalyzeOptions.planned` kennt nur locker/lang; geplante Intervalle landen bei `easy_too_hard`.
- `lap`-Nachrichten werden nicht ausgewertet.
