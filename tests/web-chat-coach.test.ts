// Coach-Antworten im Web-Chat: Absicht, Nacht, Lauf, Woche, Essen, Notiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectIntent, foodAdvice, nightAnswer, noteReply, pickRun, runAnswer, weekAnswer, type RunRow,
} from "../supabase/functions/web-chat/coach-answers.ts";
import { addDays } from "../supabase/functions/_shared/garmin/transform.ts";
import type { SignalDay } from "../supabase/functions/_shared/signals.ts";

const today = "2026-11-24"; // Dienstag

test("Absicht: Fragen an den Coach", () => {
  assert.deepEqual(detectIntent("Wie war meine Nacht?", today, 7), { kind: "night" });
  assert.deepEqual(detectIntent("wie habe ich geschlafen", today, 7), { kind: "night" });
  assert.deepEqual(detectIntent("Wie war mein Lauf?", today, 18), { kind: "run", day: null });
  assert.deepEqual(detectIntent("Und mein langer Lauf am Sonntag?", today, 9), { kind: "run", day: "2026-11-22" });
  assert.deepEqual(detectIntent("Wie war meine Woche?", today, 9), { kind: "week" });
  assert.deepEqual(detectIntent("Was soll ich heute noch essen?", today, 19), { kind: "food_advice" });
  assert.equal(detectIntent("Wie viel Kalorien hat ein Apfel?", today, 19), null);
});

test("Absicht: Mahlzeiten und Aktivitäten bleiben beim bestehenden Ablauf", () => {
  assert.equal(detectIntent("2 Brötchen mit Käse", today, 8), null);
  assert.equal(detectIntent("10 km gelaufen", today, 8), null);
  assert.equal(detectIntent("Bin ich heute 5 km gelaufen?", today, 8), null);
  assert.equal(detectIntent("Gestern Abend Pizza gegessen", today, 8), null);
  assert.equal(detectIntent("Döner", today, 13), null);
});

test("Absicht: Notizen aus dem Chat", () => {
  assert.deepEqual(detectIntent("gestern war Shisha", today, 8),
    { kind: "note", tag: "Shisha", date: "2026-11-23", text: "gestern war Shisha", answered: false });
  // ohne Tagesangabe morgens: der Abend davor
  assert.equal((detectIntent("Shisha", today, 8) as { date: string }).date, "2026-11-23");
  assert.equal((detectIntent("heute viel Stress", today, 20) as { tag: string }).tag, "Stress");
  // Antwort auf eine Rückfrage: immer eine Notiz für das Datum der Frage
  assert.deepEqual(detectIntent("Kind war wach", today, 8, "2026-11-23"),
    { kind: "note", tag: "Kind wach", date: "2026-11-23", text: "Kind war wach", answered: true });
  assert.equal((detectIntent("Besuch bis spät", today, 8, "2026-11-23") as { tag: string }).tag, "Sonstiges");
});

const night = (date: string, extra: Partial<SignalDay> = {}): SignalDay => ({
  date, sleep_end_local: date + "T07:00:00", sleep_uncertain: false,
  sleep_minutes: 430, sleep_score: 80, sleep_hr_avg: 53, sleep_resp_avg: 16,
  hrv_last_night: 60, hrv_baseline_low: 50, hrv_baseline_high: 73, bb_wake: 80,
  evening_hr_avg: 70, wear_hours: 23, stress_high_min: 10, ...extra,
});
const history = Array.from({ length: 14 }, (_, i) => night(addDays(today, -i - 1), { sleep_hr_avg: 50 + (i % 7), sleep_minutes: 420 + (i % 5) * 10 }));

test("Nacht: Vergleich mit dem Normalbereich als Karte", () => {
  const a = nightAnswer([...history, night(today, { sleep_minutes: 474, hrv_last_night: 84, sleep_hr_avg: 52 })], today, []);
  assert.equal(a.message, "Gut. 7,9 Stunden, länger als dein Schnitt. Deine HRV liegt über deinem Normalbereich.");
  const card = a.cards[0];
  assert.equal(card.type, "metric_compare");
  if (card.type === "metric_compare") {
    assert.deepEqual(card.items[0], { metric: "hrv_last_night", label: "HRV", value: 84, unit: "ms", low: 50, high: 73 });
    assert.equal(card.items[1].label, "Schlafpuls");
  }
});

test("Nacht: ehrlich ohne Daten oder Normalbereich, Rückfrage bei schlechter Nacht", () => {
  assert.match(nightAnswer(history, today, []).message, /noch keine Daten/);
  const short = nightAnswer([night(today, { hrv_baseline_low: null, hrv_baseline_high: null })], today, []);
  assert.match(short.message, /Normalbereich habe ich in 10 Tagen/);
  assert.equal(short.cards.length, 0);
  const bad = nightAnswer([...history, night(today, { hrv_last_night: 44, sleep_hr_avg: 62, bb_wake: 55 })], today, []);
  assert.match(bad.message, /War gestern Abend etwas\?/);
  assert.deepEqual(bad.cards.at(-1)?.type, "chips");
  const noted = nightAnswer([...history, night(today, { hrv_last_night: 44, sleep_hr_avg: 62, bb_wake: 55 })], today, ["2026-11-23"]);
  assert.ok(!noted.cards.some((c) => c.type === "chips"));
});

const run = (id: string, start: string, extra: Partial<RunRow> = {}): RunRow => ({
  external_id: id, started_at_local: start, type: "running", name: null,
  duration_s: 5160, distance_m: 12400, avg_hr: 152, analysis: null, ...extra,
});

test("Lauf: jüngster Lauf oder der genannte Tag, Urteil aus Analyse oder Puls", () => {
  const runs = [run("1", "2026-11-22T09:00:00"), run("2", "2026-11-20T18:00:00", { avg_hr: 139 }), run("3", "2026-11-23T08:00:00", { type: "strength_training" })];
  assert.equal(pickRun(runs, null)?.external_id, "1");
  assert.equal(pickRun(runs, "2026-11-20")?.external_id, "2");
  assert.equal(pickRun(runs, "2026-11-21"), null);

  const warn = runAnswer(runs[0], 145, null);
  assert.deepEqual(warn.cards[0], {
    type: "run_card", activity_id: "1", date: "2026-11-22", title: "Über deiner Obergrenze", tone: "warn",
    detail: "So, 22.11. · 86 Min. · 12,4 km · Ø Puls 152", hr_cap: 145,
  });
  assert.match(warn.message, /Pulsalarm auf 145/);
  assert.equal((runAnswer(runs[1], 145, null).cards[0] as { tone: string }).tone, "good");
  const surge = runAnswer(run("4", "2026-11-22T09:00:00", { analysis: { verdict: "late_surge", hr_series: [140, 142, 145, 150, 160, 165] } }), 145, null);
  assert.equal((surge.cards[0] as { title: string }).title, "Zu schnell geworden");
  assert.equal((surge.cards[0] as { hr?: number[] }).hr?.length, 6);
  assert.match(runAnswer(null, 145, "2026-11-21").message, /Am Sa, 21\.11\. habe ich keinen Lauf/);
});

test("Woche: Tabelle mit höchstens 5 Zeilen aus echten Werten", () => {
  const a = weekAnswer({
    today,
    days: [night("2026-11-23", { sleep_minutes: 420 }), night("2026-11-24", { sleep_minutes: 480 }), night("2026-11-10")],
    runs: [run("1", "2026-11-22T09:00:00"), run("2", "2026-11-20T18:00:00", { distance_m: 6000, duration_s: 2400 }), run("x", "2026-11-10T09:00:00")],
    statuses: [{ date: "2026-11-23", status: "green" }, { date: "2026-11-24", status: "yellow" }],
    mealDays: [{ date: "2026-11-23", mid: 2100 }, { date: "2026-11-24", mid: 1500 }],
    weights: [{ measured_on: "2026-11-18", kg: 101.4 }, { measured_on: "2026-11-24", kg: 100.8 }],
  });
  assert.equal(a.message, "2 Läufe mit 18,4 km. Du hast im Schnitt 7,5 Stunden geschlafen. An 1 von 2 Morgen warst du gut erholt. Das sind die letzten 7 Tage.");
  const t = a.cards[0];
  assert.equal(t.type, "table");
  if (t.type === "table") {
    assert.equal(t.rows.length, 5);
    assert.deepEqual(t.rows.map((r) => r.value), ["2 · 18,4 km", "7,5 h", "1× gut, 1× müde", "≈ 1.800 kcal", "−0,6 kg"]);
  }
  assert.match(weekAnswer({ today, days: [], runs: [], statuses: [], mealDays: [], weights: [] }).message, /noch kaum Daten/);
});

test("Essen: Budget, Rest und Eiweiß, ehrlich ohne Profil", () => {
  const a = foodAdvice({ count: 2, low: 1300, mid: 1450, high: 1650, protein: 84 }, 2200);
  assert.match(a.message, /^Du hast noch ≈ 750 kcal\./);
  assert.deepEqual(a.cards[0].type === "table" && a.cards[0].rows.map((r) => r.label), ["Gegessen", "Tagesbudget", "Noch übrig", "Eiweiß"]);
  assert.match(foodAdvice({ count: 3, low: 2300, mid: 2500, high: 2700, protein: 90 }, 2200).message, /drüber\. Kein Problem/);
  assert.match(foodAdvice({ count: 0, low: 0, mid: 0, high: 0, protein: 0 }, null).message, /Einstellungen/);
});

test("Notiz: Bestätigung mit Anzahl im Monat", () => {
  assert.equal(noteReply("Shisha", "2026-11-23", today, 3),
    "Notiert für gestern: Shisha. Das war das dritte Mal in diesem Monat. Ab jetzt kann ich dir zeigen, was das mit deiner Nacht macht.");
  assert.equal(noteReply("Stress", today, today, 1), "Notiert für heute: Stress. Ab drei Notizen zeige ich dir, was das mit deiner Nacht macht.");
  assert.equal(noteReply("Nichts Besonderes", "2026-11-23", today, 1), "Notiert für gestern. Danke!");
});
