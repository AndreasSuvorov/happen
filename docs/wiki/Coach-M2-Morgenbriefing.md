# Coach M2 – Signale, Morgenbriefing und Web Push

Die Erholungsampel und Rückfragen werden aus den aufbereiteten Garmin-Daten berechnet. Der Coach vergleicht den
aktuellen Tag mit den letzten 28 Tagen und verwendet Garmin-Normalbereiche für HRV, sobald sie vorliegen.
Ohne genügend Vergleichswerte zeigt das Briefing an, wie viele Messtage für die erste Einordnung fehlen.

Das Morgenbriefing wird pro lokalem Datum gespeichert und öffnet sich unter `/heute`. Nach dem ersten Laden
ist diese Ansicht bei gültiger Sitzung auch offline verfügbar. Regeln liefern Status, Messwerte, Trainingsplan
und Rückfragen. Claude wählt aus geprüften Formulierungen. Ist der Dienst nicht verfügbar, zeigt Happen das
regelbasierte Briefing. Push-Mitteilungen zeigen auf dem Sperrbildschirm eine allgemeine Nachricht.

Als Trainingsvorlage gelten lockere Läufe am Dienstag und Donnerstag, ein längerer Lauf am Sonntag und
Krafttraining am Montag und Freitag. Bei Gelb oder Rot wird ein geplantes Lauftraining auf den nächsten freien
Tag verschoben. Das Briefing enthält den Waage-Hinweis ab halb acht, solange für den Tag noch kein Gewicht
eingetragen ist. Aktive Coach-Kanäle übernehmen diese Erinnerung vom Ernährungsbot.

## Einrichtung

1. Migration `20261123010000_coach_push.sql` anwenden.
2. Ein dauerhaftes VAPID-Schlüsselpaar erzeugen, beispielsweise mit `npx web-push generate-vapid-keys`.
   `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` und `VAPID_SUBJECT` in der Edge Runtime konfigurieren.
   Als Subject eine erreichbare `mailto:`-Adresse oder HTTPS-URL verwenden.
3. `nudges` und `push-subscription` zusammen mit `_shared/` deployen und den PWA-Build veröffentlichen.
   Bei abgeschalteter Gateway-JWT-Prüfung authentifiziert `push-subscription` die Sitzung selbst.
4. Den Block `happen-nudges` aus `supabase/cron.sql` nach dem Deploy erneut ausführen, damit der vorhandene
   Job alle fünf Minuten läuft. Der Garmin-Sync bleibt bei seinem Intervall von 20 Minuten.
5. In Happen unter **Einstellungen → Morgenbriefing** den Kanal und die Zustellzeit wählen. Auf dem iPhone
   Happen zuerst zum Home-Bildschirm hinzufügen und dann über das App-Symbol öffnen. Danach Push auf diesem Gerät
   aktivieren. Telegram ist bei verknüpftem Chat als Kanal wählbar.

## Abnahme

- `npm test` deckt Erholungsampel, Normalbereiche, Rückfragen, Zeitfenster, Ruhezeit, Tageslimit und abgelaufene Push-Abos ab.
- `npm run check` prüft die Edge Functions. `npm --prefix web run build` prüft die PWA inklusive Service Worker.
- Auf einem echten Gerät mit verbundenem Garmin-Konto die Benachrichtigung nach dem Aufwachen und den
  Ersatztermin um 09:30 prüfen. Prüfen, ob die Benachrichtigung `/heute` öffnet und eine zuvor geladene Ansicht
  offline verfügbar bleibt.
