# Coach M3 – Heute und Tageslinie

[Designrunde 2 mit allen Zuständen und dem Komponentenblatt](Coach-M3-Designrunde-2.md).

Die PWA startet mit „Heute“. Die Route `/heute` öffnet dieselbe Ansicht aus der Push-Mitteilung.
Die Tageslinie zeigt Schlaf, Aktivitäten, Mahlzeiten, Notizen und Auffälligkeiten von heute und gestern.
Die Uhrzeiten folgen der Garmin-Zeitzone, sonst der Zeitzone des Happen-Profils.

„Heute“ zeigt den gespeicherten Stand des laufenden Tages sofort nach Wiederherstellung einer gültigen
Sitzung und lädt im Hintergrund neu. Beim Abmelden oder Löschen der Garmin-Daten wird der lokale
Stand auf diesem Gerät gelöscht. Antworten auf Rückfragen und Planänderungen werden online gespeichert.
Eine wiederholte Antwort auf dieselbe Rückfrage übernimmt die bereits gespeicherte Notiz.

Bei „Verschieben“ bekommt die Einheit morgen Vorrang. War für morgen schon eine Einheit eingeplant,
rückt sie auf den nächsten freien Tag. Die Erholungsregeln gelten auch für verschobene Einheiten.
Eine passende Aktivität von Garmin oder aus dem Happen-Chat hakt den Plan automatisch ab.
Eine vorhandene Laufaufzeichnung öffnet ihre Details in der Tageslinie. Das Laufurteil erscheint,
sobald eine Analyse vorliegt.

Das Kalorienband nimmt das hinterlegte Kalorienziel oder das bestehende Happen-Tagesbudget als Bezug.
Der Eiweißring nutzt bei vorhandenem Gewicht 1,2 g/kg als allgemeinen Richtwert.

## Rollout und Abnahme

1. Migration `20261124000000_coach_today.sql` anwenden. Sie legt den Datenabruf für „Heute“,
   den Schreibweg für Kontextnotizen und die Tabelle für Planentscheidungen an.
2. `nudges` mit dem aktualisierten `_shared/` deployen. Anschließend den PWA-Build veröffentlichen.
3. Auf einem iPhone die installierte PWA in hellem und dunklem Modus öffnen. Nach dem ersten Laden
   neu öffnen und prüfen, ob die Ansicht aus dem Cache in unter einer Sekunde erscheint.
4. Eine Rückfrage antippen, „Notiert ✓“ abwarten und die Notiz in der Tageslinie prüfen.
   „Nochmal prüfen“ antippen und den Garmin-Abgleich für das eigene Konto kontrollieren.
