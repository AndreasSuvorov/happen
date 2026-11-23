import { test } from "node:test";
import assert from "node:assert/strict";
import { daysUntilBaseline, detectAnomaly, normalRanges, recovery, type SignalDay } from "../supabase/functions/_shared/signals.ts";
import { addDays as shiftDate } from "../supabase/functions/_shared/garmin/transform.ts";
import { defaultSchedule, morningDue } from "../supabase/functions/_shared/briefing-schedule.ts";
import { pushFailure, recordPushOutcome } from "../supabase/functions/_shared/push-delivery.ts";

const date = "2026-11-23";
const day: SignalDay = {
  date, sleep_end_local: date + "T07:10:00", sleep_uncertain: false,
  sleep_minutes: 475, sleep_score: 85, sleep_hr_avg: 56, sleep_resp_avg: 16,
  hrv_last_night: 60, hrv_baseline_low: 50, hrv_baseline_high: 73, bb_wake: 80,
  evening_hr_avg: 70, wear_hours: 23, stress_high_min: 12,
};
const history = Array.from({ length: 12 }, (_, index) => ({ ...day, date: shiftDate(date, -index - 1) }));

test("Normalbereich verwendet die vorherigen 28 Tage, mindestens 10 gültige Werte und Quartile", () => {
  const rows = history.map((row, i) => ({ ...row, hrv_last_night: i + 40 }));
  rows[10].hrv_last_night = null;
  rows[11].sleep_uncertain = true;
  const ranges = normalRanges([...rows, { ...day, hrv_last_night: 100 }, { ...day, date: shiftDate(date, -29) }], date);
  assert.deepEqual(ranges.hrv_last_night, { median: 44.5, low: 42.25, high: 46.75, count: 10 });
  assert.equal(normalRanges(rows.slice(0, 9), date).hrv_last_night, undefined);
  assert.equal(daysUntilBaseline(rows.slice(0, 9), date), 1);
  assert.equal(recovery(day, {}).status, "unknown");
});

test("Erholung ist gemäß den Beispieldaten grün, rot oder gelb", () => {
  const ranges = normalRanges(history, date);
  const green = recovery({ ...day, hrv_last_night: 84, sleep_hr_avg: 52, sleep_resp_avg: 16, bb_wake: 98 }, ranges);
  const red = recovery({ ...day, hrv_last_night: 36, sleep_hr_avg: 73, sleep_resp_avg: 21, bb_wake: 20, sleep_minutes: 324 }, ranges);
  const yellow = recovery({ ...day, hrv_last_night: 44, sleep_hr_avg: 65, sleep_resp_avg: 16, bb_wake: 57, sleep_minutes: 438 }, ranges);
  assert.equal(green.status, "green");
  assert.equal(red.status, "red");
  assert.deepEqual(yellow.reasons[0], { metric: "hrv_last_night", value: 44, normal_low: 50, normal_high: 73, severity: "yellow" });
  assert.equal(yellow.status, "yellow");
  assert.equal(recovery({ ...day, sleep_hr_avg: 60, sleep_resp_avg: 19 }, ranges).status, "red");
  assert.equal(recovery({ ...day, sleep_uncertain: true }, ranges).status, "unknown");
});

test("Abendpuls: priorisierte Rückfrage, personalisierte Chips, früherer Lauf oder Notiz erklärt den Ausschlag", () => {
  const ranges = normalRanges(history, date);
  const yesterday = { ...day, date: shiftDate(date, -1), evening_hr_avg: 90 };
  const prior = [{ date: shiftDate(date, -4), tag: "alkohol" }];
  const anomaly = detectAnomaly(yesterday, day, ranges, [], prior);
  assert.equal(anomaly?.date, yesterday.date);
  assert.match(anomaly?.text ?? "", /Abendpuls/);
  assert.equal(anomaly?.options[0], "Alkohol");
  assert.equal(detectAnomaly(yesterday, day, ranges, [{ started_at_local: yesterday.date + "T19:00", type: "running", duration_s: 3600 }], prior), null);
  assert.equal(detectAnomaly(yesterday, day, ranges, [], [{ date: yesterday.date, tag: null }]), null);
});

test("Morgenbriefing berücksichtigt 06:00, Datenverfügbarkeit, 15 Minuten, Ersatzzeit und Ruhezeit", () => {
  assert.equal(morningDue(defaultSchedule, date, 359, date + "T05:30:00", true), false);
  assert.equal(morningDue(defaultSchedule, date, 360, date + "T05:30:00", true), true);
  assert.equal(morningDue(defaultSchedule, date, 444, day.sleep_end_local, true), false);
  assert.equal(morningDue(defaultSchedule, date, 445, day.sleep_end_local, true), true);
  assert.equal(morningDue(defaultSchedule, date, 445, day.sleep_end_local, false), false);
  assert.equal(morningDue(defaultSchedule, date, 569, null, false), false);
  assert.equal(morningDue(defaultSchedule, date, 570, null, false), true);
  assert.equal(morningDue({ ...defaultSchedule, quiet_to: "10:00" }, date, 570, null, false), false);
  assert.equal(morningDue({ ...defaultSchedule, briefing_mode: "fixed" }, date, 420, null, false), true);
});

test("Push-Dienst mit 410 oder 404 entfernt das Abo, andere Fehler erhöhen den Zähler", async () => {
  const actions: unknown[] = [];
  const subscription = { id: "a", failed_count: 3 };
  const stamp = date + "T07:25:00Z";
  const store = {
    remove: async (id: string) => { actions.push(["remove", id]); },
    update: async (id: string, values: unknown) => { actions.push(["update", id, values]); },
  };
  await recordPushOutcome(subscription, pushFailure(410), stamp, store);
  await recordPushOutcome(subscription, pushFailure(404), stamp, store);
  await recordPushOutcome(subscription, pushFailure(503), stamp, store);
  await recordPushOutcome(subscription, "accepted", stamp, store);
  assert.deepEqual(actions, [
    ["remove", "a"], ["remove", "a"], ["update", "a", { failed_count: 4 }],
    ["update", "a", { failed_count: 0, last_success_at: stamp }],
  ]);
});
