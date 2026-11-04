// Reine Rechenfunktionen ohne I/O – getestet in tests/nutrition.test.ts.

export type Sex = "m" | "f";

export interface Profile {
  heightCm: number | null;
  birthYear: number | null;
  sex: Sex | null;
  goalKgPerWeek: number;
}

export interface WeightPoint {
  date: string; // YYYY-MM-DD (lokales Datum)
  kg: number;
}

export interface TrendPoint extends WeightPoint {
  trend: number;
}

/** Energiegehalt pro kg Körpermasse – nur für langfristige Budgets, nicht für kurze Fenster. */
export const KCAL_PER_KG_LONG_TERM = 7700;
/** Untergrenze für das Tagesbudget (Männer). */
export const MIN_DAILY_KCAL = 1500;
/** Anteil der Laufkalorien, der als zusätzliches Budget gutgeschrieben wird. */
export const RUN_CREDIT_SHARE = 0.5;
/** Aktivitätsfaktor ohne Training (Büroalltag). Annahme, wird später an der Waage kalibriert. */
export const BASE_ACTIVITY_FACTOR = 1.35;
/** Glättungsfaktor für das Trendgewicht pro Tag. */
export const TREND_ALPHA = 0.1;

/** Mifflin-St-Jeor-Grundumsatz in kcal/Tag. */
export function mifflinBmr(kg: number, heightCm: number, age: number, sex: Sex): number {
  return 10 * kg + 6.25 * heightCm - 5 * age + (sex === "m" ? 5 : -161);
}

/** Bruttoverbrauch beim Laufen: Näherung ca. 1 kcal pro kg Körpergewicht und km. */
export function runKcalGross(kg: number, km: number): number {
  return Math.round(kg * km);
}

export function ageFromBirthYear(birthYear: number, now: Date = new Date()): number {
  return now.getUTCFullYear() - birthYear;
}

/** Grundbedarf ohne Training oder null, wenn das Profil unvollständig ist. */
export function baseTdee(profile: Profile, kg: number, now: Date = new Date()): number | null {
  if (!profile.heightCm || !profile.birthYear || !profile.sex) return null;
  const bmr = mifflinBmr(kg, profile.heightCm, ageFromBirthYear(profile.birthYear, now), profile.sex);
  return Math.round(bmr * BASE_ACTIVITY_FACTOR);
}

/** Tagesbudget: Grundbedarf − Defizit + Teil der Laufkalorien, nie unter der Untergrenze. */
export function dailyBudget(tdee: number, goalKgPerWeek: number, runKcalToday: number): number {
  const deficit = (goalKgPerWeek * KCAL_PER_KG_LONG_TERM) / 7;
  const budget = tdee - deficit + RUN_CREDIT_SHARE * runKcalToday;
  return Math.max(MIN_DAILY_KCAL, Math.round(budget));
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

/**
 * Exponentiell geglättetes Trendgewicht. Fehlende Tage werden übersprungen:
 * nach d Tagen Pause wirkt der neue Wert mit 1 − (1 − α)^min(d, 3).
 * Die Obergrenze verhindert, dass nach einer Pause ein einzelner Ausreißer
 * (z. B. Montag nach einem Grill-Wochenende) den Trend übernimmt.
 */
export function trendSeries(points: WeightPoint[], alpha = TREND_ALPHA): TrendPoint[] {
  const sorted = [...points].sort((x, y) => x.date.localeCompare(y.date));
  const out: TrendPoint[] = [];
  for (const p of sorted) {
    const prev = out.at(-1);
    if (!prev) {
      out.push({ ...p, trend: p.kg });
      continue;
    }
    const d = Math.min(3, Math.max(1, daysBetween(prev.date, p.date)));
    const a = 1 - Math.pow(1 - alpha, d);
    out.push({ ...p, trend: prev.trend + a * (p.kg - prev.trend) });
  }
  return out;
}

/** Steigung des Trends in kg pro Woche (lineare Regression über die letzten `windowDays`). */
export function weeklyRate(series: TrendPoint[], windowDays = 14): number | null {
  const last = series.at(-1);
  if (!last) return null;
  const pts = series.filter((p) => daysBetween(p.date, last.date) < windowDays);
  if (pts.length < 4) return null;
  const xs = pts.map((p) => daysBetween(pts[0].date, p.date));
  if (xs.at(-1)! < 6) return null; // zu kurzer Zeitraum
  const ys = pts.map((p) => p.trend);
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * (ys[i] - my);
    den += (x - mx) ** 2;
  });
  return den === 0 ? null : (num / den) * 7;
}

/** Erkennt eine reine Gewichtsnachricht wie "102", "101,4 kg" oder "/gewicht 101.4". */
export function parseWeight(text: string): number | null {
  const m = text
    .trim()
    .match(/^(?:\/?(?:w|gewicht|waage)\s*)?(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:kg)?$/i);
  if (!m) return null;
  const kg = Number(m[1].replace(",", "."));
  return kg >= 30 && kg <= 300 ? kg : null;
}

/** Erkennt "/profil 176 1985 m". */
export function parseProfile(text: string): { heightCm: number; birthYear: number; sex: Sex } | null {
  const m = text.trim().match(/^\/profil\s+(\d{3})\s+(\d{4})\s+([mf])$/i);
  if (!m) return null;
  const heightCm = Number(m[1]);
  const birthYear = Number(m[2]);
  if (heightCm < 120 || heightCm > 230 || birthYear < 1920 || birthYear > 2015) return null;
  return { heightCm, birthYear, sex: m[3].toLowerCase() as Sex };
}

/** Lokales Datum YYYY-MM-DD in einer Zeitzone. */
export function localDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Lokale Stunde und Minute in einer Zeitzone. */
export function localTime(d: Date, timeZone: string): { hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { hour: Number(get("hour")), minute: Number(get("minute")), weekday: weekdays.indexOf(get("weekday")) };
}

export function fmtKcal(n: number): string {
  return Math.round(n).toLocaleString("de-DE");
}

export function fmtKg(n: number, digits = 1): string {
  return n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtSigned(n: number, digits = 1): string {
  const s = fmtKg(Math.abs(n), digits);
  return (n > 0 ? "+" : n < 0 ? "−" : "±") + s;
}
