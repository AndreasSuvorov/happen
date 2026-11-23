// Ausführen: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activitiesOnDate,
  bodyBatteryAtWake,
  buildDailyMetrics,
  dateRange,
  differs,
  eveningHrAvg,
  hrSensor,
  localFromGarminEpoch,
  splitBodyBattery,
  splitDailySummaries,
  transformActivityDetail,
  transformActivityListItem,
  transformDailySummary,
  transformHrv,
  transformSleep,
} from "../supabase/functions/_shared/garmin/transform.ts";

const fx = (name: string) =>
  JSON.parse(readFileSync(new URL(`../supabase/functions/_shared/garmin/__fixtures__/${name}`, import.meta.url), "utf8"));
const TZ = "Europe/Berlin";

test("*TimestampLocal wird als UTC formatiert, nicht umgerechnet", () => {
  assert.equal(localFromGarminEpoch(Date.UTC(2026, 10, 21, 22, 30)), "2026-11-21T22:30:00");
  assert.equal(localFromGarminEpoch(null), null);
});

test("Schlaf: grüner Morgen aus den echten Werten", () => {
  const s = transformSleep(fx("sleep_2026-11-22.json"), "2026-11-22")!;
  assert.equal(s.sleep_start_local, "2026-11-21T22:30:00");
  assert.equal(s.sleep_end_local, "2026-11-22T06:24:00");
  assert.equal(s.sleep_minutes, 474); // 7,9 h
  assert.equal(s.sleep_score, 88);
  assert.equal(s.sleep_hr_avg, 52);
  assert.equal(s.sleep_resp_avg, 16);
  assert.equal(s.deep_min, 90);
  assert.equal(s.awake_count, 1);
  assert.equal(s.sleep_need_min, 470);
  assert.equal(s.sleep_uncertain, false);
});

test("Schlaf über die Zeitumstellung 24./25.10.2026 behält die lokale Wanduhrzeit", () => {
  const s = transformSleep(fx("sleep_2026-10-25_dst.json"), "2026-10-25")!;
  assert.equal(s.sleep_start_local, "2026-10-24T23:10:00");
  assert.equal(s.sleep_end_local, "2026-10-25T06:50:00");
  // Dauer kommt aus sleepTimeSeconds (8:40 h echte Zeit), nicht aus der Differenz der Wanduhrzeiten (7:40 h).
  assert.equal(s.sleep_minutes, 520);
});

test("Schlaf: seltsame Aufzeichnung (< 3 h, Ende vor Mitternacht) ist unsicher", () => {
  const s = transformSleep(fx("sleep_weird.json"), "2026-11-10")!;
  assert.equal(s.sleep_uncertain, true);
  assert.equal(s.sleep_minutes, 138);
});

test("Schlaf: noch nicht synchronisiert → null", () => {
  assert.equal(transformSleep(fx("sleep_none.json"), "2026-11-23"), null);
  assert.equal(transformSleep(null, "2026-11-23"), null);
});

test("HRV mit Garmin-Normalbereich", () => {
  assert.deepEqual(transformHrv(fx("hrv_2026-11-22.json")), {
    hrv_last_night: 84, hrv_status: "BALANCED", hrv_baseline_low: 50, hrv_baseline_high: 73,
  });
  assert.deepEqual(transformHrv({ hrvSummary: { lastNightAvg: 40, status: "NONE", baseline: null } }), {
    hrv_last_night: 40, hrv_status: null, hrv_baseline_low: null, hrv_baseline_high: null,
  });
  assert.equal(transformHrv({ hrvSummary: null }), null);
});

test("Tageszusammenfassungen aufteilen und umwandeln", () => {
  const days = splitDailySummaries(fx("dailysummaries_2026-11-21_2026-11-22.json"));
  assert.deepEqual([...days.keys()], ["2026-11-21", "2026-11-22"]);
  const s = transformDailySummary(days.get("2026-11-21"))!;
  assert.equal(s.steps, 9876);
  assert.equal(s.resting_hr, 48);
  assert.equal(s.kcal_total, 2850);
  assert.equal(s.stress_high_min, 30);
  assert.equal(s.stress_med_min, 60);
  assert.equal(s.wear_hours, 23);
  assert.equal(s.bb_charged, 70);
  // -1 = kein Stresswert
  assert.equal(transformDailySummary(days.get("2026-11-22"))!.stress_avg, null);
});

test("Abendpuls: Ø 19:00–21:59 Ortszeit mit Lücken", () => {
  const hr = fx("heartrate_2026-11-21.json").heartRateValues;
  assert.equal(eveningHrAvg(hr, "2026-11-21", TZ), 90);
});

test("Abendpuls: Minuten innerhalb einer Aktivität zählen nicht", () => {
  const hr = fx("heartrate_2026-11-21.json").heartRateValues.map(([ms, bpm]: [number, number | null]) => {
    const localMin = (ms - Date.UTC(2026, 10, 20, 23, 0)) / 60000;
    return [ms, localMin >= 19 * 60 && localMin < 19 * 60 + 45 && bpm !== null ? 150 : bpm];
  });
  const run = [{ start_local: "2026-11-21T19:00:00", duration_s: 2700 }];
  assert.equal(eveningHrAvg(hr, "2026-11-21", TZ, run), 90);
  // ohne Ausschluss würde der Lauf den Wert verfälschen
  assert.ok(eveningHrAvg(hr, "2026-11-21", TZ)! > 100);
});

test("Abendpuls: unter 60 % Abdeckung → null", () => {
  const hr = fx("heartrate_2026-11-21.json").heartRateValues.map(([ms, bpm]: [number, number | null], i: number) => [
    ms,
    i % 2 === 0 ? null : bpm, // nur jeder zweite Wert → < 60 %
  ]);
  assert.equal(eveningHrAvg(hr, "2026-11-21", TZ), null);
  assert.equal(eveningHrAvg([], "2026-11-21", TZ), null);
});

test("Body Battery beim Aufwachen: nächster Wert nach Schlafende", () => {
  const bb = splitBodyBattery(fx("bodybattery_2026-11-21_2026-11-22.json")).get("2026-11-22");
  assert.equal(bodyBatteryAtWake(bb.bodyBatteryValuesArray, "2026-11-22T06:24:00", TZ), 98);
  assert.equal(bodyBatteryAtWake(bb.bodyBatteryValuesArray, null, TZ), null);
});

test("Aktivitätsliste: Felder und Zonen", () => {
  const [treadmill, run, strength] = fx("activities.json").map(transformActivityListItem);
  assert.equal(treadmill.external_id, "21000000001");
  assert.equal(treadmill.started_at_local, "2026-11-22T07:10:00");
  assert.equal(treadmill.type, "treadmill_running");
  assert.equal(treadmill.duration_s, 1980);
  assert.equal(treadmill.avg_hr, 139);
  assert.deepEqual(treadmill.hr_zone_s, [300, 1500, 180, 0, 0]);
  assert.equal(run.elevation_gain_m, 42);
  assert.equal(strength.hr_zone_s, null);
  assert.equal(strength.distance_m, null);
});

test("Aktivitätsdetails: Gefühl, Anstrengung, Gehpausen, Brustgurt", () => {
  const d = transformActivityDetail(fx("activity_21000000002.json"));
  assert.deepEqual(d, { feel: 75, rpe: 40, run_s: 2281, walk_s: 300, hr_sensor: "chest" });
  const t = transformActivityDetail(fx("activity_21000000001.json"));
  assert.equal(t.hr_sensor, "wrist");
  assert.equal(t.run_s, null);
  assert.equal(hrSensor([{ antplusDeviceType: "HEART_RATE" }]), "chest");
  assert.equal(hrSensor(undefined), "wrist");
});

test("buildDailyMetrics: kompletter Tag inkl. Abendpuls ohne Lauf", () => {
  const sums = splitDailySummaries(fx("dailysummaries_2026-11-21_2026-11-22.json"));
  const bbs = splitBodyBattery(fx("bodybattery_2026-11-21_2026-11-22.json"));
  const acts = fx("activities.json").map(transformActivityListItem);
  const day21 = buildDailyMetrics({
    date: "2026-11-21", today: "2026-11-23", timeZone: TZ,
    summary: sums.get("2026-11-21"), heartRate: fx("heartrate_2026-11-21.json"), bodyBattery: bbs.get("2026-11-21"),
    activities: activitiesOnDate(acts, "2026-11-21"),
  });
  assert.equal(day21.is_complete, true);
  assert.equal(day21.steps, 9876);
  assert.equal(day21.sleep_minutes, null);
  // Lauf 19:00–19:45 ausgeschlossen, Rest des Abends ist 90
  assert.equal(day21.evening_hr_avg, 90);

  const day22 = buildDailyMetrics({
    date: "2026-11-22", today: "2026-11-22", timeZone: TZ,
    summary: sums.get("2026-11-22"), sleep: fx("sleep_2026-11-22.json"), hrv: fx("hrv_2026-11-22.json"),
    bodyBattery: bbs.get("2026-11-22"),
  });
  assert.equal(day22.is_complete, false); // heute
  assert.equal(day22.hrv_last_night, 84);
  assert.equal(day22.bb_wake, 98);
  assert.equal(day22.sleep_minutes, 474);
  assert.equal(day22.evening_hr_avg, null);
});

test("activitiesOnDate erkennt Aktivitäten über Mitternacht", () => {
  const rows = [{ started_at_local: "2026-11-21T23:30:00", duration_s: 3600 }];
  assert.equal(activitiesOnDate(rows, "2026-11-21").length, 1);
  assert.equal(activitiesOnDate(rows, "2026-11-22").length, 1);
  assert.equal(activitiesOnDate(rows, "2026-11-23").length, 0);
});

test("differs normalisiert Postgres-Werte", () => {
  assert.equal(differs({ a: 52, t: "2026-11-21T22:30:00", z: [1, 2] }, { a: "52", t: "2026-11-21 22:30:00", z: [1, 2] }, ["a", "t", "z"]), false);
  assert.equal(differs({ a: 52 }, { a: "53" }, ["a"]), true);
  assert.equal(differs({ a: 1 }, undefined, ["a"]), true);
});

test("dateRange", () => {
  assert.deepEqual(dateRange("2026-10-24", "2026-10-26"), ["2026-10-24", "2026-10-25", "2026-10-26"]);
});
