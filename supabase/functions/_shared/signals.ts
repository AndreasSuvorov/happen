import { addDays, type DailyMetrics } from "./garmin/transform.ts";

const metrics = [
  "hrv_last_night", "sleep_hr_avg", "sleep_resp_avg", "bb_wake", "sleep_minutes",
  "evening_hr_avg", "sleep_score", "stress_high_min",
] as const;
type Metric = typeof metrics[number];
type RecoveryMetric = Exclude<Metric, "evening_hr_avg" | "sleep_score" | "stress_high_min">;
export type Status = "green" | "yellow" | "red" | "unknown";
export type SignalDay = Pick<DailyMetrics, Metric | "date" | "sleep_end_local" | "sleep_uncertain" |
  "hrv_baseline_low" | "hrv_baseline_high" | "wear_hours">;
export type Baseline = { median: number; low: number; high: number; count: number };
export type Baselines = Partial<Record<Metric, Baseline>>;
type Reason = { metric: RecoveryMetric; value: number; normal_low: number | null; normal_high: number | null; severity: "red" | "yellow" };

const MIN_VALUES = 10;
const isValue = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isSleepMetric = (metric: Metric) => metric.startsWith("sleep_") || metric === "bb_wake" || metric === "hrv_last_night";
const value = (day: SignalDay | undefined, metric: Metric) =>
  day && !(day.sleep_uncertain && isSleepMetric(metric)) ? day[metric] : null;

export function daysUntilBaseline(history: SignalDay[], date: string): number {
  const start = addDays(date, -28);
  const days = history.filter((day) => day.date >= start && day.date < date);
  const counts = metrics.slice(0, 5).map((metric) => days.filter((day) => isValue(value(day, metric))).length);
  return Math.max(0, MIN_VALUES - Math.max(...counts));
}

function quantile(values: number[], q: number): number {
  const index = (values.length - 1) * q;
  const lower = Math.floor(index);
  return values[lower] + (values[Math.ceil(index)] - values[lower]) * (index - lower);
}

export function normalRanges(history: SignalDay[], date: string): Baselines {
  const start = addDays(date, -28);
  const days = history.filter((row) => row.date >= start && row.date < date);
  const result: Baselines = {};
  for (const metric of metrics) {
    const values = days.map((day) => value(day, metric)).filter(isValue).sort((a, b) => a - b);
    if (values.length < MIN_VALUES) continue;
    result[metric] = {
      median: quantile(values, 0.5),
      low: quantile(values, 0.25),
      high: quantile(values, 0.75),
      count: values.length,
    };
  }
  return result;
}

export function recovery(today: SignalDay | undefined, ranges: Baselines): { status: Status; reasons: Reason[] } {
  if (!today || today.sleep_uncertain) return { status: "unknown", reasons: [] };
  const hasRecoveryHistory = metrics.slice(0, 5).some((metric) => ranges[metric]);
  if (!hasRecoveryHistory) return { status: "unknown", reasons: [] };

  const reasons: Reason[] = [];
  let checked = 0;
  const check = (metric: RecoveryMetric, yellow: number | undefined, red: number | undefined, below: boolean,
    low?: number, high?: number) => {
    const n = value(today, metric);
    if (!isValue(n) || yellow === undefined || red === undefined) return;
    checked++;
    const crosses = (limit: number) => below ? n < limit : n >= limit;
    if (crosses(yellow)) reasons.push({
      metric, value: n, normal_low: low ?? null, normal_high: high ?? null,
      severity: crosses(red) ? "red" : "yellow",
    });
  };

  const hrv = ranges.hrv_last_night;
  const hasGarminRange = isValue(today.hrv_baseline_low) && isValue(today.hrv_baseline_high) &&
    today.hrv_baseline_low <= today.hrv_baseline_high;
  const hrvLow = hasGarminRange ? today.hrv_baseline_low! : hrv?.low;
  const hrvHigh = hasGarminRange ? today.hrv_baseline_high! : hrv?.high;
  check("hrv_last_night", hrvLow, hrvLow === undefined ? undefined : hrvLow - 8, true, hrvLow, hrvHigh);
  for (const [metric, yellow, red] of [["sleep_hr_avg", 4, 8], ["sleep_resp_avg", 1.5, 3]] as const) {
    const range = ranges[metric];
    if (range) check(metric, range.median + yellow, range.median + red, false, range.low, range.high);
  }
  check("bb_wake", 60, 40, true, ranges.bb_wake?.low, ranges.bb_wake?.high);
  check("sleep_minutes", 360, 300, true, ranges.sleep_minutes?.low, ranges.sleep_minutes?.high);

  const red = reasons.filter(({ severity }) => severity === "red");
  const respirationPattern = red.some(({ metric }) => metric === "sleep_resp_avg") &&
    reasons.some(({ metric }) => metric === "sleep_hr_avg" || metric === "hrv_last_night");
  if (checked < 2) return { status: "unknown", reasons };
  if (red.length >= 2 || respirationPattern) return { status: "red", reasons };
  if (red.length || reasons.length >= 2) return { status: "yellow", reasons };
  return { status: "green", reasons };
}

const standardAnswers = ["Shisha", "Alkohol", "Party", "Kind wach", "Stress", "Spät gegessen", "Hitze", "Krank", "Nichts Besonderes", "Andere…"];

export interface SignalNote { date: string; tag: string | null }
export interface SignalActivity { started_at_local: string; type: string; duration_s: number | null }
export interface SignalQuestion { text: string; options: string[]; date: string }

export function detectAnomaly(
  yesterday: SignalDay | undefined, today: SignalDay | undefined, ranges: Baselines,
  activities: SignalActivity[], notes: SignalNote[],
): SignalQuestion | null {
  const pulse = value(yesterday, "evening_hr_avg");
  const sleepScore = value(today, "sleep_score");
  const sleepPulse = value(today, "sleep_hr_avg");
  const stress = value(yesterday, "stress_high_min");
  const eveningRun = yesterday && activities.some((activity) => {
    if (!/run/i.test(activity.type) || !activity.started_at_local.startsWith(yesterday.date)) return false;
    const hour = Number(activity.started_at_local.slice(11, 13));
    const minute = Number(activity.started_at_local.slice(14, 16));
    const start = hour * 60 + minute;
    return start < 22 * 60 && start + (activity.duration_s ?? 0) / 60 >= 19 * 60;
  });

  const candidates = [
    { day: yesterday, applies: isValue(pulse) && !!ranges.evening_hr_avg &&
      pulse >= ranges.evening_hr_avg.median + 12 && !eveningRun, text: "Dein Abendpuls war höher als sonst. Was war los?" },
    { day: today, applies: isValue(sleepScore) && !!ranges.sleep_score && sleepScore <= ranges.sleep_score.median - 15 &&
      isValue(sleepPulse) && !!ranges.sleep_hr_avg && sleepPulse >= ranges.sleep_hr_avg.median + 4,
      text: "Dein Schlafwert war niedriger und dein Schlafpuls höher als sonst. Was war los?" },
    { day: yesterday, applies: isValue(stress) && !!ranges.stress_high_min &&
      stress >= ranges.stress_high_min.median + 60, text: "Gestern hattest du länger hohen Stress als sonst. Was war los?" },
    { day: yesterday, applies: !!yesterday && !yesterday.sleep_uncertain && yesterday.sleep_minutes === null &&
      isValue(yesterday.wear_hours) && yesterday.wear_hours > 20, text: "Die Uhr hat keinen Schlaf erkannt. Was war los?" },
  ];
  const candidate = candidates.find(({ day, applies }) =>
    day && applies && !notes.some((note) => note.date === day.date));
  if (!candidate?.day) return null;
  const frequency = new Map<string, number>();
  for (const { tag } of notes) {
    if (tag) {
      const key = tag.trim().toLocaleLowerCase("de-DE");
      frequency.set(key, (frequency.get(key) ?? 0) + 1);
    }
  }
  const options = [...standardAnswers].sort((a, b) => {
    if (a === "Andere…" || b === "Andere…") return Number(a === "Andere…") - Number(b === "Andere…");
    return (frequency.get(b.toLocaleLowerCase("de-DE")) ?? 0) - (frequency.get(a.toLocaleLowerCase("de-DE")) ?? 0);
  });
  return { date: candidate.day.date, text: candidate.text, options };
}
