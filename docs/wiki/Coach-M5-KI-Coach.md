# Coach M5: KI-Coach im Chat

## Wann antwortet die KI?
1. Feste Fragen und Notizen (Nacht, Lauf, Woche, Essen, „gestern war Shisha“) beantwortet `coach-answers.ts` weiter **ohne KI**: schnell, kostenlos, deterministisch.
2. Andere **Fragen** (Fragezeichen oder Fragewort am Anfang, `question.ts`) gehen an den KI-Coach (`coach-agent.ts`).
3. Alles andere läuft wie bisher durch die Mahlzeiten-Schätzung. Ist es weder Mahlzeit noch Training, bekommt der KI-Coach den Text.
4. Ohne `ANTHROPIC_API_KEY`, bei Ablehnung oder Fehler gibt es die bisherige kurze Antwort.

## Wie der KI-Coach arbeitet
- Modell `claude-opus-5-5`, Aufwand `low`, serverseitiger Fallback (`fallbacks: "default"`), Prompt-Cache auf System-Prompt und Werkzeugen. Das Datum steht in der Nutzernachricht, damit der Cache greift.
- Höchstens 6 Runden mit Werkzeugen. Alle Werkzeuge sind nur lesend und auf den angemeldeten Nutzer beschränkt (`coach-data.ts`), außer `notiz_speichern` (nur letzte 14 Tage).
- Werkzeuge: `tage` (Schlaf, HRV, Puls, Body Battery, Abendpuls, Stress + Normalbereich), `aktivitaeten` (inkl. Laufurteil aus M4), `essen`, `gewicht`, `notizen`, `plan` (Morgenbriefing).
- Karten baut der Server aus echten Daten: `karte_kennzahl`, `karte_lauf`, `karte_tabelle` (≤ 5 Zeilen), `antwort_chips` (2–4).
- Regeln im System-Prompt: nur Zahlen aus Werkzeugen, Zahlen mit Normalbereich, keine Diagnosen, Du-Form, höchstens 4 Sätze. Allgemeine Richtwerte („Wie viel Eiweiß hat Skyr?“) nur als Richtwert gekennzeichnet.
- Kontext: die letzten 4 Wechsel der letzten 2 Tage aus `messages` (Nachricht + `reply`).

## Notizen vereinheitlichen
Freie Antworten ohne erkanntes Stichwort („Andere…“) ordnet eine kurze KI-Abfrage einem festen Stichwort zu (bekannte Stichwörter des Nutzers + Standardliste), z. B. „Wasserpfeife“ → Shisha. So zählen die Muster richtig.

## Antworten speichern
Migration `20261125000000_messages_reply.sql`: `messages.reply jsonb`. `web-chat` schreibt jede Antwort dorthin; die PWA liest den Verlauf daraus (vorher nur im Browser gespeichert).

## Datenschutz
Für KI-Antworten gehen Schlaf-, Puls-, Lauf-, Essens- und Notizdaten des Zeitraums, den die KI abfragt, an Anthropic. GPS-Daten und Pulsreihen werden nicht übergeben.

## Tests
`tests/web-chat-agent.test.ts` (gefälschte Messages API, kein Netz): Werkzeug-Schemas, Zeitraum-Grenzen, Karten aus echten Daten, Notiz-Grenzen, Schleife, Ablehnung, Rundenlimit, Werkzeugfehler, Stichwort-Normalisierung, Frageerkennung.
