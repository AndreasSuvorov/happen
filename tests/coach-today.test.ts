import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, todayNutrition, todayRecovery, type TodayData } from "../web/src/lib/today.ts";

const date = "2026-11-24";
const yesterday = "2026-11-23";
const snapshot: TodayData = {
  date, user_id: "owner", timezone: "Europe/Berlin", garmin: true, connection: { status: "active", backfill: true },
  profile: { height_cm: 179, birth_year: 1990, sex: "m", goal_kg_per_week: 0 },
  nutrition_target: { low: 2000, high: 2200 }, weight: { kg: 80, date },
  plan_action: null, briefing: null, notes: [], activities: [],
  metrics: [{
    date, sleep_start_local: yesterday + "T23:00:00", sleep_end_local: date + "T06:30:00", sleep_minutes: 450,
    sleep_uncertain: false, sleep_score: 83, hrv_last_night: 70, hrv_baseline_low: 55, hrv_baseline_high: 75,
    sleep_hr_avg: 51, sleep_resp_avg: 14, bb_wake: 92, evening_hr_avg: null, stress_high_min: null,
    wear_hours: null, resting_hr: 49,
  }],
  entries: [{
    id: "m1", local_time: date + "T07:00:00", meal: "breakfast", title: "Müsli", kcal_low: 370, kcal_mid: 430, kcal_high: 480,
    protein_g: 22, carbs_g: null, fat_g: null, confidence: null, note: null,
  }, {
    id: "m2", local_time: yesterday + "T19:00:00", meal: "dinner", title: "Suppe", kcal_low: 350, kcal_mid: 410, kcal_high: 440,
    protein_g: 14, carbs_g: null, fat_g: null, confidence: null, note: null,
  }],
  wearable_activities: [],
};

test("Schlaf über Mitternacht erscheint nach lokaler Zeit an beiden Tagen", () => {
  assert.deepEqual(buildTimeline(snapshot).map(({ date, time, title }) => [date, time, title]), [
    [yesterday, "19:00", "Suppe"], [yesterday, "23:00", "Eingeschlafen"],
    [date, "06:30", "Aufgewacht"], [date, "07:00", "Müsli"],
  ]);
});

test("Essen heute zeigt die erfasste Spanne und übernimmt das konfigurierte Ziel", () => {
  assert.deepEqual(todayNutrition(snapshot), {
    low: 370, high: 480, protein: 22, count: 1, target: { low: 2000, high: 2200 }, proteinTarget: 96,
  });
});

test("Erholung in der Einlernphase zeigt die Messwerte ohne Ampelwertung", () => {
  const result = todayRecovery(snapshot);
  assert.equal(result.status, "unknown");
  assert.equal(result.days, 0);
  assert.deepEqual(result.metrics[0].baseline, { low: 55, high: 75 });
});

test("Fehlende HRV zeigt die ausstehende Nacht auch bei vorhandenen anderen Werten", () => {
  const partial = { ...snapshot, metrics: [{ ...snapshot.metrics[0], hrv_last_night: null }] };
  assert.equal(todayRecovery(partial).state, "missing");
  assert.equal(todayRecovery(snapshot).state, "learning");
});
