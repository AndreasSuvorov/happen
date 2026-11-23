// Aufbereitung der Garmin-Rohdaten zu daily_metrics und wearable_activities.
// Reine Funktionen ohne Deno- oder Datenbankabhängigkeit, getestet in tests/garmin-transform.test.ts.
// Fallstricke: siehe docs/wiki/Coach-Plan.md, Anhang A.3.

// deno-lint-ignore no-explicit-any
type Json = any;

// ---------------------------------------------------------------------------
// Zeit
// ---------------------------------------------------------------------------

/**
 * Garmin liefert `*TimestampLocal` als Epoch-ms, die die LOKALE Uhrzeit darstellen.
 * Als UTC formatieren ergibt die lokale Wanduhrzeit; nicht in eine Zeitzone umrechnen.
 */
export function localFromGarminEpoch(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19);
}

/** Echte Epoch-ms (GMT) → lokale Wanduhrzeit "YYYY-MM-DDTHH:MM:SS" in der Zeitzone. */
export function zonedWallClock(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

/** "YYYY-MM-DD HH:MM:SS" (Garmin startTimeLocal) → "YYYY-MM-DDTHH:MM:SS". */
export function normalizeLocal(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (!m) return null;
  return `${m[1]}T${m[2].length === 5 ? m[2] + ":00" : m[2]}`;
}

/** Minuten seit Mitternacht von `date` für eine lokale Wanduhrzeit (kann < 0 oder > 1440 sein). */
function minutesSinceDayStart(local: string, date: string): number {
  return (Date.parse(local + "Z") - Date.parse(date + "T00:00:00Z")) / 60_000;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

/** Alle Tage von `from` bis `to` (inklusive), aufsteigend. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
const msToMin = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n / 60_000);
};
const sToMin = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n / 60);
};
const round1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

// ---------------------------------------------------------------------------
// Bereichsantworten in Tage aufteilen
// ---------------------------------------------------------------------------

/** `v2/dailysummaries` → Map Datum → Tageszusammenfassung. */
export function splitDailySummaries(payload: Json): Map<string, Json> {
  const list: Json[] = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return byDate(list);
}

/** `bodyBattery/reports/daily` → Map Datum → Tagesbericht. */
export function splitBodyBattery(payload: Json): Map<string, Json> {
  const list: Json[] = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return byDate(list);
}

function byDate(list: Json[]): Map<string, Json> {
  const out = new Map<string, Json>();
  for (const item of list) {
    const d = item?.calendarDate ?? item?.date ?? item?.summaryDate;
    if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d)) out.set(d.slice(0, 10), item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tageswerte
// ---------------------------------------------------------------------------

export interface DailyMetrics {
  date: string;
  sleep_start_local: string | null;
  sleep_end_local: string | null;
  sleep_minutes: number | null;
  sleep_score: number | null;
  deep_min: number | null;
  rem_min: number | null;
  light_min: number | null;
  awake_min: number | null;
  awake_count: number | null;
  sleep_hr_avg: number | null;
  sleep_resp_avg: number | null;
  sleep_stress_avg: number | null;
  sleep_need_min: number | null;
  sleep_uncertain: boolean;
  hrv_last_night: number | null;
  hrv_status: string | null;
  hrv_baseline_low: number | null;
  hrv_baseline_high: number | null;
  resting_hr: number | null;
  bb_wake: number | null;
  bb_max: number | null;
  bb_min: number | null;
  bb_charged: number | null;
  bb_drained: number | null;
  steps: number | null;
  kcal_total: number | null;
  kcal_active: number | null;
  stress_avg: number | null;
  stress_high_min: number | null;
  stress_med_min: number | null;
  intensity_min_moderate: number | null;
  intensity_min_vigorous: number | null;
  evening_hr_avg: number | null;
  wear_hours: number | null;
  is_complete: boolean;
}

export type SleepMetrics = Pick<
  DailyMetrics,
  | "sleep_start_local"
  | "sleep_end_local"
  | "sleep_minutes"
  | "sleep_score"
  | "deep_min"
  | "rem_min"
  | "light_min"
  | "awake_min"
  | "awake_count"
  | "sleep_hr_avg"
  | "sleep_resp_avg"
  | "sleep_stress_avg"
  | "sleep_need_min"
  | "sleep_uncertain"
>;

/**
 * `dailySleep?date=D`: die Nacht, die am Morgen von D endet.
 * Gibt null zurück, wenn (noch) kein Schlaf erkannt wurde.
 */
export function transformSleep(payload: Json, date: string): SleepMetrics | null {
  if (!payload) return null;
  const d = payload.dailySleepDTO ?? payload;
  const seconds = num(d.sleepTimeSeconds);
  const start = localFromGarminEpoch(num(d.sleepStartTimestampLocal));
  const end = localFromGarminEpoch(num(d.sleepEndTimestampLocal));
  if (!seconds || !start || !end) return null;
  const minutes = Math.round(seconds / 60);
  // Seltsame Aufzeichnungen (z. B. 20:50–23:36): unter 3 h und Ende vor Mitternacht.
  const uncertain = minutes < 180 && end.slice(0, 10) < date;
  return {
    sleep_start_local: start,
    sleep_end_local: end,
    sleep_minutes: minutes,
    sleep_score: int(d.sleepScores?.overall?.value),
    deep_min: sToMin(d.deepSleepSeconds),
    rem_min: sToMin(d.remSleepSeconds),
    light_min: sToMin(d.lightSleepSeconds),
    awake_min: sToMin(d.awakeSleepSeconds),
    awake_count: int(d.awakeCount),
    sleep_hr_avg: round1(num(d.avgHeartRate ?? payload.avgHeartRate)),
    sleep_resp_avg: round1(num(d.averageRespirationValue ?? payload.averageRespirationValue)),
    sleep_stress_avg: round1(num(d.avgSleepStress ?? payload.avgSleepStress)),
    sleep_need_min: int(d.sleepNeed?.actual),
    sleep_uncertain: uncertain,
  };
}

export function transformHrv(payload: Json): Pick<
  DailyMetrics,
  "hrv_last_night" | "hrv_status" | "hrv_baseline_low" | "hrv_baseline_high"
> | null {
  const s = payload?.hrvSummary ?? payload;
  if (!s) return null;
  const last = int(s.lastNightAvg);
  if (last === null) return null;
  const status = typeof s.status === "string" && s.status !== "NONE" ? s.status : null;
  return {
    hrv_last_night: last,
    hrv_status: status,
    hrv_baseline_low: int(s.baseline?.balancedLow),
    hrv_baseline_high: int(s.baseline?.balancedUpper),
  };
}

export function transformDailySummary(s: Json): Pick<
  DailyMetrics,
  | "resting_hr"
  | "bb_max"
  | "bb_min"
  | "bb_charged"
  | "bb_drained"
  | "steps"
  | "kcal_total"
  | "kcal_active"
  | "stress_avg"
  | "stress_high_min"
  | "stress_med_min"
  | "intensity_min_moderate"
  | "intensity_min_vigorous"
  | "wear_hours"
> | null {
  if (!s) return null;
  const totalMs = num(s.stress?.totalDurationInMillis);
  const avgStress = int(s.stress?.avgLevel);
  return {
    resting_hr: int(s.heartRate?.restingValue),
    bb_max: int(s.bodyBattery?.maxValue),
    bb_min: int(s.bodyBattery?.minValue),
    bb_charged: int(s.bodyBattery?.chargedValue),
    bb_drained: int(s.bodyBattery?.drainedValue),
    steps: int(s.movement?.steps?.value),
    kcal_total: int(s.calories?.burnedTotal),
    kcal_active: int(s.calories?.burnedActive),
    // Garmin meldet -1/-2, wenn kein Stresswert vorliegt.
    stress_avg: avgStress !== null && avgStress >= 0 ? avgStress : null,
    stress_high_min: msToMin(s.stress?.highStressDurationInMillis),
    stress_med_min: msToMin(s.stress?.mediumStressDurationInMillis),
    intensity_min_moderate: int(s.intensityMinutes?.moderate),
    intensity_min_vigorous: int(s.intensityMinutes?.vigorous),
    wear_hours: totalMs !== null ? Math.round((totalMs / 3_600_000) * 10) / 10 : null,
  };
}

/** Lokales Zeitintervall einer Aktivität (für den Ausschluss beim Abendpuls). */
export interface LocalInterval {
  start_local: string;
  duration_s: number;
}

const EVENING_FROM_MIN = 19 * 60;
const EVENING_TO_MIN = 22 * 60; // exklusiv → 19:00–21:59
const MIN_COVERAGE = 0.6;

/**
 * Ø Puls 19:00–21:59 Ortszeit am Tag `date`. Minuten innerhalb von Aktivitäten zählen nicht.
 * Nur, wenn mindestens 60 % der erwarteten Messwerte vorhanden sind.
 * `heartRateValues` sind echte Epoch-ms (GMT), im 2-min-Takt.
 */
export function eveningHrAvg(
  heartRateValues: Array<[number, number | null]> | null | undefined,
  date: string,
  timeZone: string,
  activities: LocalInterval[] = [],
): number | null {
  if (!Array.isArray(heartRateValues) || heartRateValues.length === 0) return null;

  const excluded = activities
    .map((a) => {
      const start = minutesSinceDayStart(a.start_local, date);
      return [start, start + a.duration_s / 60] as const;
    })
    .filter(([s, e]) => e > EVENING_FROM_MIN && s < EVENING_TO_MIN);
  const isExcluded = (m: number) => excluded.some(([s, e]) => m >= s && m < e);

  const stepMin = samplingMinutes(heartRateValues);
  let expected = 0;
  for (let m = EVENING_FROM_MIN; m < EVENING_TO_MIN; m += stepMin) if (!isExcluded(m)) expected++;
  if (expected === 0) return null;

  let sum = 0;
  let present = 0;
  for (const [ms, bpm] of heartRateValues) {
    if (typeof bpm !== "number" || bpm <= 0) continue;
    const local = zonedWallClock(ms, timeZone);
    if (local.slice(0, 10) !== date) continue;
    const m = minutesSinceDayStart(local, date);
    if (m < EVENING_FROM_MIN || m >= EVENING_TO_MIN || isExcluded(m)) continue;
    sum += bpm;
    present++;
  }
  if (present === 0 || present / expected < MIN_COVERAGE) return null;
  return Math.round((sum / present) * 10) / 10;
}

function samplingMinutes(values: Array<[number, unknown]>): number {
  const diffs: number[] = [];
  for (let i = 1; i < values.length && diffs.length < 50; i++) {
    const d = values[i][0] - values[i - 1][0];
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return 2;
  diffs.sort((a, b) => a - b);
  return Math.max(1, Math.round(diffs[Math.floor(diffs.length / 2)] / 60_000));
}

/**
 * Body Battery beim Aufwachen: der nächstgelegene Wert nach Schlafende (höchstens 3 h danach).
 * `bodyBatteryValuesArray` enthält echte Epoch-ms (GMT) und viele null-Werte.
 */
export function bodyBatteryAtWake(
  values: Array<[number, number | null]> | null | undefined,
  sleepEndLocal: string | null,
  timeZone: string,
): number | null {
  if (!Array.isArray(values) || !sleepEndLocal) return null;
  const end = Date.parse(sleepEndLocal + "Z");
  let best: { dt: number; level: number } | null = null;
  for (const [ms, level] of values) {
    if (typeof level !== "number") continue;
    const dt = Date.parse(zonedWallClock(ms, timeZone) + "Z") - end;
    if (dt < 0 || dt > 3 * 3_600_000) continue;
    if (!best || dt < best.dt) best = { dt, level };
  }
  return best ? Math.round(best.level) : null;
}

export interface DailyInput {
  date: string;
  /** heutiges Datum in der Zeitzone der Verbindung */
  today: string;
  timeZone: string;
  summary?: Json;
  sleep?: Json;
  hrv?: Json;
  heartRate?: Json;
  bodyBattery?: Json;
  /** Aktivitäten, die den Tag `date` berühren (lokale Startzeit + Dauer) */
  activities?: LocalInterval[];
}

/** Baut eine vollständige daily_metrics-Zeile (ohne user_id/updated_at) aus den Rohdaten eines Tages. */
export function buildDailyMetrics(input: DailyInput): DailyMetrics {
  const sleep = transformSleep(input.sleep, input.date);
  const hrv = transformHrv(input.hrv);
  const sum = transformDailySummary(input.summary);
  const hrValues = input.heartRate?.heartRateValues;
  const bbValues = input.bodyBattery?.bodyBatteryValuesArray;

  const wear = sum?.wear_hours ?? null;
  const row: DailyMetrics = {
    date: input.date,
    sleep_start_local: sleep?.sleep_start_local ?? null,
    sleep_end_local: sleep?.sleep_end_local ?? null,
    sleep_minutes: sleep?.sleep_minutes ?? null,
    sleep_score: sleep?.sleep_score ?? null,
    deep_min: sleep?.deep_min ?? null,
    rem_min: sleep?.rem_min ?? null,
    light_min: sleep?.light_min ?? null,
    awake_min: sleep?.awake_min ?? null,
    awake_count: sleep?.awake_count ?? null,
    sleep_hr_avg: sleep?.sleep_hr_avg ?? null,
    sleep_resp_avg: sleep?.sleep_resp_avg ?? null,
    sleep_stress_avg: sleep?.sleep_stress_avg ?? null,
    sleep_need_min: sleep?.sleep_need_min ?? null,
    sleep_uncertain: sleep?.sleep_uncertain ?? false,
    hrv_last_night: hrv?.hrv_last_night ?? null,
    hrv_status: hrv?.hrv_status ?? null,
    hrv_baseline_low: hrv?.hrv_baseline_low ?? null,
    hrv_baseline_high: hrv?.hrv_baseline_high ?? null,
    resting_hr: sum?.resting_hr ?? int(input.heartRate?.restingHeartRate),
    bb_wake: bodyBatteryAtWake(bbValues, sleep?.sleep_end_local ?? null, input.timeZone),
    bb_max: sum?.bb_max ?? null,
    bb_min: sum?.bb_min ?? null,
    bb_charged: sum?.bb_charged ?? int(input.bodyBattery?.charged),
    bb_drained: sum?.bb_drained ?? int(input.bodyBattery?.drained),
    steps: sum?.steps ?? null,
    kcal_total: sum?.kcal_total ?? null,
    kcal_active: sum?.kcal_active ?? null,
    stress_avg: sum?.stress_avg ?? null,
    stress_high_min: sum?.stress_high_min ?? null,
    stress_med_min: sum?.stress_med_min ?? null,
    intensity_min_moderate: sum?.intensity_min_moderate ?? null,
    intensity_min_vigorous: sum?.intensity_min_vigorous ?? null,
    evening_hr_avg: eveningHrAvg(hrValues, input.date, input.timeZone, input.activities ?? []),
    wear_hours: wear,
    // Abgeschlossen = Tag vorbei und (fast) ganztägig getragen. Spätere Syncs können ihn noch auffüllen.
    is_complete: input.date < input.today && wear !== null && wear >= 20,
  };
  return row;
}

// ---------------------------------------------------------------------------
// Aktivitäten
// ---------------------------------------------------------------------------

export interface ActivityListFields {
  external_id: string;
  started_at_local: string;
  type: string;
  name: string | null;
  duration_s: number | null;
  distance_m: number | null;
  elevation_gain_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  hr_zone_s: number[] | null;
  training_load: number | null;
  aerobic_te: number | null;
  anaerobic_te: number | null;
  te_label: string | null;
  avg_cadence: number | null;
}

export interface ActivityDetailFields {
  feel: number | null;
  rpe: number | null;
  run_s: number | null;
  walk_s: number | null;
  hr_sensor: "wrist" | "chest";
}

/** Eintrag aus `activities/search/activities` → Felder für wearable_activities. */
export function transformActivityListItem(a: Json): ActivityListFields | null {
  const id = a?.activityId;
  const start = normalizeLocal(a?.startTimeLocal);
  if ((typeof id !== "number" && typeof id !== "string") || !start) return null;
  const zones = [1, 2, 3, 4, 5].map((i) => int(a[`hrTimeInZone_${i}`]));
  return {
    external_id: String(id),
    started_at_local: start,
    type: a.activityType?.typeKey ?? "other",
    name: typeof a.activityName === "string" ? a.activityName : null,
    duration_s: int(a.duration),
    distance_m: round1(num(a.distance)),
    elevation_gain_m: round1(num(a.elevationGain)),
    avg_hr: int(a.averageHR),
    max_hr: int(a.maxHR),
    hr_zone_s: zones.every((z) => z === null) ? null : zones.map((z) => z ?? 0),
    training_load: round1(num(a.activityTrainingLoad)),
    aerobic_te: round1(num(a.aerobicTrainingEffect)),
    anaerobic_te: round1(num(a.anaerobicTrainingEffect)),
    te_label: typeof a.trainingEffectLabel === "string" ? a.trainingEffectLabel : null,
    avg_cadence: round1(num(a.averageRunningCadenceInStepsPerMinute)),
  };
}

/** `activity/{id}` → Gefühl, Anstrengung, Gehpausen, Pulsquelle. */
export function transformActivityDetail(d: Json): ActivityDetailFields {
  const s = d?.summaryDTO ?? {};
  const splits: Json[] = Array.isArray(d?.splitSummaries) ? d.splitSummaries : [];
  const sumSplit = (type: string): number | null => {
    const matching = splits.filter((x) => x?.splitType === type);
    if (matching.length === 0) return null;
    return Math.round(matching.reduce((acc, x) => acc + (num(x.duration) ?? 0), 0));
  };
  return {
    feel: int(s.directWorkoutFeel),
    rpe: int(s.directWorkoutRpe),
    run_s: sumSplit("RWD_RUN"),
    walk_s: sumSplit("RWD_WALK"),
    hr_sensor: hrSensor(d?.metadataDTO?.sensors),
  };
}

/** 'chest', wenn ein externer Pulssensor (BLE oder ANT+) verbunden war, sonst 'wrist'. */
export function hrSensor(sensors: Json): "wrist" | "chest" {
  if (!Array.isArray(sensors)) return "wrist";
  const isHr = (v: unknown) => typeof v === "string" && v.toUpperCase().includes("HEART_RATE");
  return sensors.some((s) => isHr(s?.bleDeviceType) || isHr(s?.antplusDeviceType) || isHr(s?.sensorType)) ? "chest" : "wrist";
}

/** Aktivitäten, die den lokalen Tag `date` berühren. */
export function activitiesOnDate<T extends { started_at_local: string; duration_s: number | null }>(
  rows: T[],
  date: string,
): LocalInterval[] {
  return rows
    .filter((r) => {
      const start = minutesSinceDayStart(r.started_at_local, date);
      const end = start + (r.duration_s ?? 0) / 60;
      return end > 0 && start < 1440;
    })
    .map((r) => ({ start_local: r.started_at_local, duration_s: r.duration_s ?? 0 }));
}

// ---------------------------------------------------------------------------
// Vergleich / Hash (für idempotente Upserts)
// ---------------------------------------------------------------------------

/** JSON mit sortierten Schlüsseln, damit gleiche Daten denselben Hash ergeben. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** true, wenn sich die angegebenen Felder unterscheiden (Zahlen aus Postgres kommen evtl. als String). */
export function differs(a: Record<string, unknown>, b: Record<string, unknown> | undefined, keys: string[]): boolean {
  if (!b) return true;
  return keys.some((k) => normalizeValue(a[k]) !== normalizeValue(b[k]));
}

function normalizeValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    // timestamp ohne Zeitzone: Postgres liefert "YYYY-MM-DDTHH:MM:SS", evtl. mit Sekundenbruchteilen
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(v)) return v.replace(" ", "T").slice(0, 19);
    if (v !== "" && !Number.isNaN(Number(v)) && /^-?\d/.test(v)) return String(Number(v));
    return v;
  }
  if (Array.isArray(v)) return `[${v.map(normalizeValue).join(",")}]`;
  return stableStringify(v);
}
