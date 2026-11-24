// Laufurteil (Coach-Plan 6.3, Meilenstein 4): aus FIT-Datensätzen und Zusammenfassung wird `RunAnalysis`.
// Reine, deterministische Funktionen ohne Deno- oder npm-Importe, damit `node --test` sie direkt laden kann.
//
// Grundsätze (Coach-Plan 6.3, 9.4, 9.9, A.3):
// - Grenze ist immer `easy_hr_cap` aus den Rohdaten, nie `hrTimeInZone_*` (A.3.7).
// - Laufband: Tempo und Distanz vom Handgelenk sind ungenau (A.3.5). Das FIT-Tempo wird dort ignoriert,
//   für Texte zählt nur die Geschwindigkeit, die der Nutzer angegeben hat.
// - Ohne Zeitreihe sagen wir nichts, was die Zusammenfassung nicht hergibt (kein „ab Minute X“).
// - Texte: Du-Form, kurz, Zahlen mit Bezug, keine Schuld, keine Diagnosen, keine Emoji.
import { ANALYSIS_VERSION } from "./types.ts";
import type {
  AnalyzeOptions, ComparableRun, FitActivity, FitRecord, HrPoint, RunAnalysis, RunInput, Verdict,
} from "./types.ts";

/* ---------------------------------------------------------------------------
 * Schwellen
 * ------------------------------------------------------------------------- */
/** Die ersten 5 Minuten zählen für die Anteile nicht (Puls kommt erst hoch). */
const WARMUP_S = 300;
/** Lücken bis 10 s werden mit dem letzten Wert gefüllt (Garmin „Smart Recording“), längere gelten als Pause. */
const MAX_FILL_S = 10;
/** Mehr als 6 Stunden werten wir nicht aus (Schutz gegen kaputte Zeitstempel). */
const MAX_SECONDS = 6 * 3600;
/** Median über ±7 s (15-s-Fenster) gegen Ausreißer vom Sensor. */
const SMOOTH_HALF_S = 7;
/** Mindestens 2 Minuten gültiger Puls, sonst ist die Zeitreihe nicht belastbar. */
const MIN_HR_SECONDS = 120;
const EASY_SHARE = 0.85;
/** Toleranz für einzelne Spitzen (Steigung, Ampel), wie `share_above_cap_plus5`. */
const SPIKE = 5;
/** Draußen: letztes Drittel mindestens so viel über dem ersten. */
const SURGE_THIRDS_BPM = 10;
/** Draußen: letztes Drittel mindestens so viel schneller (s/km), sonst ist es normale Drift. */
const SURGE_FASTER_S = 5;
/** Laufband: Anstieg um mehr als 15 bpm in höchstens 3 Minuten. */
const SURGE_TREADMILL_BPM = 15;
const SURGE_TREADMILL_WINDOW_S = 180;
/** Vor dem Anstieg darf der Lauf noch nicht hart gewesen sein (Ø unter Grenze + 8), sonst ist es kein „später“ Anstieg, sondern insgesamt zu hart. Das Beispiel vom 22.11. lag vorher bei Ø 149 (Grenze 145). */
const PRE_SURGE_MAX_OVER_CAP = 7;
/** Hitze: +10 % Puls in 30 min bei gleichmäßigem Tempo (±4 % pro Minute). */
const HEAT_RISE = 0.1;
const HEAT_SPAN_S = 30 * 60;
const STEADY_TOLERANCE = 0.04;
/** Drift nur bei gleichmäßigem Tempo: Hälften höchstens 5 % auseinander. */
const DRIFT_PACE_TOLERANCE = 0.05;
/** Flache Abschnitte: 30-s-Fenster, |Steigung| < 1,5 %, Tempo > 1,7 m/s, mindestens 10 Fenster. */
const FLAT_GRADE = 0.015;
const FLAT_MIN_SPEED = 1.7;
const FLAT_MIN_WINDOWS = 10;
/** Wettkampfähnlich: Ø > Grenze + 20 und > 70 % der Zeit über Grenze + 10, mindestens 15 min ausgewertet. */
const RACE_OVER_CAP = 20;
const RACE_SHARE_OVER10 = 0.7;
const RACE_MIN_S = 15 * 60;
/** Harte Einheit: Ø mindestens Grenze + 8 und weniger als 30 % unter der Grenze. */
const HARD_OVER_CAP = 8;
const HARD_MAX_SHARE_BELOW = 0.3;
/** Vergleich: Startpunkt ≤ 500 m, Distanz ±15 %, Laufband-Dauer ±25 %. */
const SAME_START_M = 500;
const SAME_DIST = 0.15;
const SAME_TREADMILL_DURATION = 0.25;
/** „Gleich gut“ / „Tagesform“: bis 3 bpm und bis 15 s/km. */
const SAME_HR_BPM = 3;
const SAME_PACE_S = 15;
/** Puls bei gleichem Tempo nur umrechnen, wenn das flache Tempo höchstens 45 s/km auseinander liegt. */
const MAX_PACE_SCALE_S = 45;

const TREADMILL_TYPES = new Set(["treadmill_running", "indoor_running"]);
export const isTreadmillType = (type: string) => TREADMILL_TYPES.has(type);

/* ---------------------------------------------------------------------------
 * Hilfen
 * ------------------------------------------------------------------------- */
type Series = (number | null)[];

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const round = (n: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const pct = (share: number) => `${Math.round(share * 100)} %`;
const de = (n: number, digits = 1) => n.toFixed(digits).replace(".", ",");
/** „7:39/km“ */
export function formatPace(sPerKm: number): string {
  const s = Math.round(sPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/km`;
}
/** „7,5 km/h“, ganze Zahlen ohne Komma („8 km/h“ wird „8,0 km/h“ wie in den Chips). */
const kmhText = (kmh: number) => `${de(kmh, 1)} km/h`;
/** „2026-11-06…“ → „6.11.“ */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])}.${Number(m[2])}.` : iso;
}

function mean(values: Series, from: number, to: number, pred?: (v: number) => boolean): number | null {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(values.length, to); i++) {
    const v = values[i];
    if (v !== null && (!pred || pred(v))) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : null;
}

function countValid(values: Series, from = 0, to = values.length): number {
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(values.length, to); i++) if (values[i] !== null) n++;
  return n;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Mittelwerte je Block von `size` Sekunden; ein Block braucht mindestens ein Drittel gültige Werte. */
function buckets(values: Series, size: number): Series {
  const out: Series = [];
  for (let start = 0; start < values.length; start += size) {
    const end = Math.min(values.length, start + size);
    out.push(countValid(values, start, end) >= Math.max(1, Math.floor(size / 3)) ? mean(values, start, end) : null);
  }
  return out;
}

/** Tempo in s/km aus Geschwindigkeiten (nur Sekunden in Bewegung, > 0,5 m/s). */
function paceOf(speed: Series, from: number, to: number): number | null {
  const v = mean(speed, from, to, (x) => x > 0.5);
  return v ? 1000 / v : null;
}

const EARTH_M = 6371000;
function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* ---------------------------------------------------------------------------
 * Zeitreihe: Datensätze auf ein 1-s-Raster bringen
 * ------------------------------------------------------------------------- */
interface Grid {
  n: number;
  /** Puls, 15-s-Median */
  hr: Series;
  speed: Series;
  dist: Series;
  alt: Series;
  cad: Series;
  hasGps: boolean;
  start: { lat: number; lon: number } | null;
}

function buildGrid(records: FitRecord[]): Grid {
  const recs = records.filter((r) => isNum(r.t_s)).sort((a, b) => a.t_s - b.t_s);
  const t0 = recs.length ? recs[0].t_s : 0;
  const n = recs.length ? Math.min(MAX_SECONDS, Math.round(recs[recs.length - 1].t_s - t0) + 1) : 0;
  const empty = (): Series => new Array<number | null>(n).fill(null);
  const raw = empty();
  const speed = empty();
  const dist = empty();
  const alt = empty();
  const cad = empty();
  let gps = 0;
  let start: { lat: number; lon: number } | null = null;

  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const from = Math.round(r.t_s - t0);
    if (from >= n) break;
    const next = i + 1 < recs.length ? Math.round(recs[i + 1].t_s - t0) : from + 1;
    const to = Math.min(n, Math.max(from + 1, Math.min(next, from + MAX_FILL_S)));
    const hr = isNum(r.hr) && r.hr >= 30 && r.hr <= 230 ? r.hr : null;
    const sp = isNum(r.speed_mps) && r.speed_mps >= 0 && r.speed_mps < 12 ? r.speed_mps : null;
    const di = isNum(r.dist_m) && r.dist_m >= 0 ? r.dist_m : null;
    const al = isNum(r.alt_m) && r.alt_m > -500 && r.alt_m < 9000 ? r.alt_m : null;
    const ca = isNum(r.cadence_spm) && r.cadence_spm > 0 ? r.cadence_spm : null;
    const hasPos = isNum(r.lat) && isNum(r.lon) && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180 && !(r.lat === 0 && r.lon === 0);
    if (hasPos) {
      gps++;
      if (!start) start = { lat: r.lat as number, lon: r.lon as number };
    }
    for (let s = from; s < to; s++) {
      if (hr !== null) raw[s] = hr;
      if (sp !== null) speed[s] = sp;
      if (di !== null) dist[s] = di;
      if (al !== null) alt[s] = al;
      if (ca !== null) cad[s] = ca;
    }
  }

  // Ohne speed_mps, aber mit Distanz: Geschwindigkeit aus der Distanz über 10 s
  if (countValid(speed) === 0 && countValid(dist) > 0) {
    for (let s = 5; s + 5 < n; s++) {
      const a = dist[s - 5];
      const b = dist[s + 5];
      if (a !== null && b !== null && b >= a) speed[s] = (b - a) / 10;
    }
  }

  // Puls glätten: Median über ±7 s, nur wo ein Messwert liegt (keine Lücken erfinden)
  const hr = empty();
  for (let s = 0; s < n; s++) {
    if (raw[s] === null) continue;
    const win: number[] = [];
    for (let k = Math.max(0, s - SMOOTH_HALF_S); k <= Math.min(n - 1, s + SMOOTH_HALF_S); k++) {
      const v = raw[k];
      if (v !== null) win.push(v);
    }
    hr[s] = win.length >= 5 ? median(win) : null;
  }

  return { n, hr, speed, dist, alt, cad, hasGps: recs.length > 0 && gps / recs.length >= 0.5, start };
}

/* ---------------------------------------------------------------------------
 * Anstieg erkennen
 * ------------------------------------------------------------------------- */
interface Surge {
  detected: boolean;
  from_s: number | null;
  peak_hr: number | null;
  peak_s: number | null;
}
const NO_SURGE: Surge = { detected: false, from_s: null, peak_hr: null, peak_s: null };

function peakAfter(hr: Series, from: number): { hr: number; s: number } | null {
  let best: { hr: number; s: number } | null = null;
  for (let s = from; s < hr.length; s++) {
    const v = hr[s];
    if (v !== null && (!best || v > best.hr)) best = { hr: v, s };
  }
  return best;
}

/** Ein Anstieg zählt nur, wenn er über die Grenze führt und der Lauf davor im Rahmen war. */
function confirmSurge(g: Grid, a0: number, fromS: number, cap: number): Surge {
  const peak = peakAfter(g.hr, fromS);
  const before = mean(g.hr, a0, fromS);
  const beforeSeconds = countValid(g.hr, a0, fromS);
  if (!peak || peak.hr <= cap || before === null || beforeSeconds < WARMUP_S || before > cap + PRE_SURGE_MAX_OVER_CAP) {
    return NO_SURGE;
  }
  return { detected: true, from_s: fromS, peak_hr: Math.round(peak.hr), peak_s: peak.s };
}

/**
 * Draußen: letztes Drittel ≥ +10 bpm gegenüber dem ersten Drittel UND schneller (6.3).
 * Beginn des Anstiegs: Modell „flach, dann Gerade“ (Sprung und/oder Rampe) an die 30-s-Mittel angepasst,
 * der Knick mit dem kleinsten Fehler ist `from`. So liefert eine Rampe ab Minute 43 auch „ab Minute 43“.
 */
function outdoorSurge(g: Grid, a0: number, cap: number): Surge {
  const len = g.n - a0;
  if (len < 15 * 60) return NO_SURGE;
  const third = Math.floor(len / 3);
  const hr1 = mean(g.hr, a0, a0 + third);
  const hr3 = mean(g.hr, g.n - third, g.n);
  const p1 = paceOf(g.speed, a0, a0 + third);
  const p3 = paceOf(g.speed, g.n - third, g.n);
  if (hr1 === null || hr3 === null || p1 === null || p3 === null) return NO_SURGE;
  if (hr3 - hr1 < SURGE_THIRDS_BPM || p1 - p3 < SURGE_FASTER_S) return NO_SURGE;

  const b0 = Math.ceil(a0 / 30);
  const pts: { t: number; v: number }[] = [];
  buckets(g.hr, 30).forEach((v, i) => {
    if (i >= b0 && v !== null) pts.push({ t: i, v });
  });
  const m = pts.length;
  let best = { k: -1, sse: Infinity, level: 0 };
  for (let k = Math.ceil(m * 0.15); k <= Math.floor(m * 0.9); k++) {
    const left = pts.slice(0, k);
    const right = pts.slice(k);
    if (left.length < 2 || right.length < 3) continue;
    const lm = left.reduce((s, p) => s + p.v, 0) / left.length;
    let sse = left.reduce((s, p) => s + (p.v - lm) ** 2, 0);
    // rechts: einfache lineare Regression
    const tm = right.reduce((s, p) => s + p.t, 0) / right.length;
    const vm = right.reduce((s, p) => s + p.v, 0) / right.length;
    let sxy = 0;
    let sxx = 0;
    for (const p of right) {
      sxy += (p.t - tm) * (p.v - vm);
      sxx += (p.t - tm) ** 2;
    }
    const b = sxx ? sxy / sxx : 0;
    for (const p of right) sse += (p.v - (vm + b * (p.t - tm))) ** 2;
    if (sse < best.sse - 1e-9) best = { k, sse, level: lm };
  }
  if (best.k < 0) return NO_SURGE;
  // Der Knick liegt bei einer kurzen Rampe oft etwas spät: zurück, solange es davor schon steigt und über dem Niveau davor liegt
  let k = best.k;
  while (k - 1 > 0 && pts[k - 1].v > best.level + 1.5 && pts[k - 1].v < pts[k].v) k--;
  return confirmSurge(g, a0, pts[k].t * 30, cap);
}

/**
 * Laufband: Puls steigt in höchstens 3 Minuten um mehr als 15 bpm (6.3), nach dem Einlaufen.
 * Beginn = Anfang des durchgehenden Anstiegs vor der Stelle, an der die Schwelle überschritten wird.
 */
function treadmillSurge(g: Grid, a0: number, cap: number): Surge {
  const b = buckets(g.hr, 30);
  const b0 = Math.ceil(a0 / 30);
  const win = SURGE_TREADMILL_WINDOW_S / 30;
  for (let j = b0 + 1; j < b.length; j++) {
    const vj = b[j];
    if (vj === null) continue;
    let lo: { i: number; v: number } | null = null;
    for (let i = Math.max(b0, j - win); i < j; i++) {
      const vi = b[i];
      if (vi !== null && (!lo || vi < lo.v)) lo = { i, v: vi };
    }
    if (!lo || vj - lo.v <= SURGE_TREADMILL_BPM) continue;
    // zurück bis zum Beginn des Anstiegs (solange der Wert davor niedriger ist)
    let k = j;
    while (k - 1 >= b0 && b[k - 1] !== null && (b[k - 1] as number) < (b[k] as number)) k--;
    // … und wieder vor bis dorthin, wo es steil wird (≥ 2 bpm pro 30 s); das flache Pendeln davor zählt nicht
    while (k + 1 < j && (b[k + 1] as number) - (b[k] as number) < 2) k++;
    return confirmSurge(g, a0, k * 30, cap);
  }
  return NO_SURGE;
}

/* ---------------------------------------------------------------------------
 * Weitere Kennzahlen
 * ------------------------------------------------------------------------- */
/** Gleichmäßig: jede Minute nach dem Einlaufen höchstens ±4 % vom Median (Tempo, sonst Kadenz). */
function steady(g: Grid, a0: number): boolean {
  for (const values of [g.speed, g.cad]) {
    const mins = buckets(values, 60).slice(Math.ceil(a0 / 60));
    const valid = mins.filter(isNum);
    if (valid.length < Math.max(5, mins.length * 0.8)) continue;
    const med = median(valid);
    if (med <= 0) continue;
    return valid.every((v) => Math.abs(v / med - 1) <= STEADY_TOLERANCE);
  }
  return false;
}

/** Hitze-Verdacht: Laufband, gleichmäßig, Puls +10 % innerhalb von 30 min (2-min-Mittel). */
function heatRise(g: Grid, a0: number): { from: number; to: number } | null {
  if (!steady(g, a0)) return null;
  const twoMin = buckets(g.hr, 120);
  const span = HEAT_SPAN_S / 120;
  let best: { from: number; to: number; ratio: number } | null = null;
  for (let i = Math.ceil(a0 / 120); i < twoMin.length; i++) {
    const a = twoMin[i];
    if (a === null) continue;
    for (let j = i + 1; j <= Math.min(twoMin.length - 1, i + span); j++) {
      const b = twoMin[j];
      if (b !== null && b / a - 1 >= HEAT_RISE && (!best || b / a > best.ratio)) best = { from: a, to: b, ratio: b / a };
    }
  }
  return best ? { from: Math.round(best.from), to: Math.round(best.to) } : null;
}

function flatEfficiency(g: Grid, a0: number): RunAnalysis["flat_efficiency"] {
  let meters = 0;
  let seconds = 0;
  let beats = 0;
  let windows = 0;
  for (let s = Math.ceil(a0 / 30) * 30; s + 30 < g.n; s += 30) {
    const d0 = g.dist[s];
    const d1 = g.dist[s + 30];
    const h0 = g.alt[s];
    const h1 = g.alt[s + 30];
    const hr = mean(g.hr, s, s + 30);
    if (d0 === null || d1 === null || h0 === null || h1 === null || hr === null) continue;
    if (countValid(g.hr, s, s + 30) < 20) continue;
    const dd = d1 - d0;
    if (dd / 30 <= FLAT_MIN_SPEED || Math.abs((h1 - h0) / dd) >= FLAT_GRADE) continue;
    meters += dd;
    seconds += 30;
    beats += hr * 0.5;
    windows++;
  }
  if (windows < FLAT_MIN_WINDOWS) return null;
  const speed = meters / seconds;
  const hr = (beats / seconds) * 60;
  return {
    pace_s_per_km: Math.round(1000 / speed),
    hr: Math.round(hr),
    m_per_beat: round((speed * 60) / hr, 3),
    n_windows: windows,
  };
}

function hrSeries(g: Grid, withPace: boolean, withElev: boolean): HrPoint[] {
  const hr = buckets(g.hr, 30);
  const sp = withPace ? buckets(g.speed, 30) : [];
  const el = withElev ? buckets(g.alt, 30) : [];
  const out: HrPoint[] = [];
  hr.forEach((v, i) => {
    if (v === null) return;
    const p: HrPoint = { t_min: round(i * 0.5, 1), hr: Math.round(v) };
    if (withPace) {
      const s = sp[i];
      p.pace_s_per_km = s !== null && s > 0.5 ? Math.round(1000 / s) : null;
    }
    if (withElev) {
      const e = el[i];
      p.elev_m = e !== null ? round(e, 1) : null;
    }
    out.push(p);
  });
  return out;
}

/* ---------------------------------------------------------------------------
 * analyzeRun
 * ------------------------------------------------------------------------- */
interface Texts {
  headline: string;
  explanation: string;
  tip: string | null;
}

export function analyzeRun(run: RunInput, fit: FitActivity | null, opts: AnalyzeOptions): RunAnalysis {
  const cap = opts.easy_hr_cap;
  const treadmill = isTreadmillType(run.type);
  const kmh = treadmill && isNum(opts.treadmill_kmh) && opts.treadmill_kmh > 0 ? opts.treadmill_kmh : null;
  const sensor = fit?.hr_sensor ?? run.hr_sensor ?? null;
  const g = fit && fit.records.length ? buildGrid(fit.records) : null;

  const base: RunAnalysis = {
    version: ANALYSIS_VERSION,
    verdict: "unknown",
    headline: "",
    explanation: "",
    tip: null,
    share_below_cap: null,
    share_above_cap_plus5: null,
    hr_first_half: null,
    hr_second_half: null,
    pace_first_half_s_per_km: null,
    pace_second_half_s_per_km: null,
    surge: { detected: false, from_min: null, peak_hr: null },
    drift_pct: null,
    flat_efficiency: null,
    comparable_runs: [],
    notes: [],
    sensor,
    hr_cap: cap,
    hr_series: [],
    start_point: null,
  };

  const outdoor = !treadmill;
  const gps = !!g && outdoor && g.hasGps;
  if (gps && g.start) base.start_point = { lat: round(g.start.lat, 3), lon: round(g.start.lon, 3) };

  // Ohne verwertbaren Puls in der FIT-Datei: vorsichtiges Urteil aus der Zusammenfassung
  if (!g || countValid(g.hr) < MIN_HR_SECONDS) {
    // no_fit: keine Datei bzw. keine Datensätze; no_hr: kein verwertbarer Puls (Datei oder Zusammenfassung)
    const notes = g ? ["no_hr"] : run.avg_hr === null ? ["no_fit", "no_hr"] : ["no_fit"];
    const s = summaryJudgement(run, opts, kmh, sensor);
    return { ...base, ...s, notes };
  }

  // Ab Minute 5 auswerten; bei sehr kurzen Läufen (unter 15 min) den ganzen Lauf
  const a0 = g.n - WARMUP_S >= 10 * 60 ? WARMUP_S : 0;
  const pace = gps && countValid(g.speed) >= g.n * 0.5;
  const mid = Math.floor(g.n / 2);

  let valid = 0;
  let below = 0;
  let over5 = 0;
  let over10 = 0;
  for (let s = a0; s < g.n; s++) {
    const v = g.hr[s];
    if (v === null) continue;
    valid++;
    if (v <= cap) below++;
    if (v > cap + SPIKE) over5++;
    if (v > cap + 10) over10++;
  }
  const shareBelow = below / valid;
  const shareOver5 = over5 / valid;
  const shareOver10 = over10 / valid;
  const avg = mean(g.hr, a0, g.n) as number;
  const avgAll = mean(g.hr, 0, g.n) as number;

  const hr1 = mean(g.hr, 0, mid);
  const hr2 = mean(g.hr, mid, g.n);
  const p1 = pace ? paceOf(g.speed, 0, mid) : null;
  const p2 = pace ? paceOf(g.speed, mid, g.n) : null;

  // Drift: Puls/Tempo 2. gegen 1. Hälfte (nach dem Einlaufen), nur draußen bei gleichmäßigem Tempo
  let drift: number | null = null;
  if (pace && g.n - a0 >= 20 * 60) {
    const m2 = a0 + Math.floor((g.n - a0) / 2);
    const dh1 = mean(g.hr, a0, m2);
    const dh2 = mean(g.hr, m2, g.n);
    const dp1 = paceOf(g.speed, a0, m2);
    const dp2 = paceOf(g.speed, m2, g.n);
    if (dh1 && dh2 && dp1 && dp2 && Math.abs(dp2 / dp1 - 1) <= DRIFT_PACE_TOLERANCE) {
      // Puls pro Geschwindigkeit = Puls × Tempo
      drift = round(((dh2 * dp2) / (dh1 * dp1) - 1) * 100, 1);
    }
  }

  const surge = treadmill ? treadmillSurge(g, a0, cap) : pace ? outdoorSurge(g, a0, cap) : NO_SURGE;
  const heat = treadmill && !surge.detected ? heatRise(g, a0) : null;
  const notes: string[] = [];
  if (heat) notes.push("heat_suspected");

  const third = Math.floor((g.n - a0) / 3);
  const hrThird1 = mean(g.hr, a0, a0 + third);
  const hrThird3 = mean(g.hr, g.n - third, g.n);
  const flatEnd = hrThird1 !== null && hrThird3 !== null && hrThird3 - hrThird1 < 5;
  const planned = opts.planned ?? null;
  const analysedS = countValid(g.hr, a0, g.n);

  // Reihenfolge der Prüfung:
  // 1. race_like zuerst: die stärkste Aussage. Ein Wettkampf hat oft auch einen Endspurt, der ist dann aber nicht das Thema.
  // 2. late_surge vor easy_ok: Ein später Anstieg kann in 85 % „unter der Grenze“ untergehen (z. B. die letzten 5 von 49 min),
  //    gehört aber genau benannt. confirmSurge verlangt, dass der Lauf davor im Rahmen war, sonst ist es kein später Anstieg.
  // 3. easy_ok: mindestens 85 % unter der Grenze (6.3).
  // 4. hard_session: deutlich und durchgehend über der Grenze, aber nur wenn kein lockerer Lauf geplant war.
  //    War einer geplant, ist das ehrliche Urteil „zu schnell für locker“.
  // 5. easy_too_hard: alles andere.
  let verdict: Verdict;
  if (avg > cap + RACE_OVER_CAP && shareOver10 > RACE_SHARE_OVER10 && analysedS >= RACE_MIN_S) verdict = "race_like";
  else if (surge.detected) verdict = "late_surge";
  else if (shareBelow >= EASY_SHARE) verdict = "easy_ok";
  else if (!planned && avg >= cap + HARD_OVER_CAP && shareBelow < HARD_MAX_SHARE_BELOW) verdict = "hard_session";
  else verdict = "easy_too_hard";

  const fromMin = surge.from_s !== null ? Math.round(surge.from_s / 60) : null;
  const ctx: TextContext = {
    cap, treadmill, kmh, planned, shareBelow, shareOver5, avg: Math.round(avgAll), avgAfterWarmup: avg,
    hr1, hr2, p1, p2, flatEnd, heat, g, a0, surge, fromMin,
  };
  const texts = fitTexts(verdict, ctx);

  return {
    ...base,
    verdict,
    ...texts,
    share_below_cap: round(shareBelow, 2),
    share_above_cap_plus5: round(shareOver5, 2),
    hr_first_half: hr1 !== null ? Math.round(hr1) : null,
    hr_second_half: hr2 !== null ? Math.round(hr2) : null,
    pace_first_half_s_per_km: p1 !== null ? Math.round(p1) : null,
    pace_second_half_s_per_km: p2 !== null ? Math.round(p2) : null,
    surge: { detected: surge.detected, from_min: fromMin, peak_hr: surge.peak_hr },
    drift_pct: drift,
    flat_efficiency: gps ? flatEfficiency(g, a0) : null,
    notes,
    hr_series: hrSeries(g, pace, outdoor && countValid(g.alt) > 0),
  };
}

/* ---------------------------------------------------------------------------
 * Texte
 * ------------------------------------------------------------------------- */
interface TextContext {
  cap: number;
  treadmill: boolean;
  kmh: number | null;
  planned: AnalyzeOptions["planned"];
  shareBelow: number;
  shareOver5: number;
  avg: number;
  avgAfterWarmup: number;
  hr1: number | null;
  hr2: number | null;
  p1: number | null;
  p2: number | null;
  flatEnd: boolean;
  heat: { from: number; to: number } | null;
  g: Grid;
  a0: number;
  surge: Surge;
  fromMin: number | null;
}

const keepCalm = "Weiter so. Beim nächsten Lauf genauso ruhig anfangen.";
const treadmillHold = "Halte das Band bis zum Schluss bei deinem Starttempo. Steigern kannst du an einem anderen Tag.";
const alarm = (cap: number) => `Stell den Pulsalarm auf ${cap}. Dann merkst du sofort, wenn es zu schnell wird.`;
const restTip = "Morgen locker bleiben oder pausieren.";
const raceTip = "Gönn dir jetzt ein, zwei ruhige Tage.";

function plannedGoal(planned: AnalyzeOptions["planned"], cap: number): string {
  if (planned === "long_run") return "Ein langer Lauf sollte bis zum Ende ruhig bleiben.";
  if (planned === "easy_run") return "Ein lockerer Lauf sollte bis zum Ende ruhig bleiben.";
  return `Locker heißt: bis zum Ende unter ${cap}.`;
}

function halvesSentence(c: TextContext): string {
  if (c.hr1 === null || c.hr2 === null) return "";
  const at = (p: number | null) => (p !== null ? ` bei ${formatPace(p)}` : "");
  return `Erste Hälfte Ø ${Math.round(c.hr1)}${at(c.p1)}, zweite Hälfte Ø ${Math.round(c.hr2)}${at(c.p2)}.`;
}

/** Laufband-Geschwindigkeit als Einstieg, z. B. „Bei 7,5 km/h “. */
const atSpeed = (kmh: number | null) => (kmh !== null ? `Bei ${kmhText(kmh)} ` : "");

function fitTexts(verdict: Verdict, c: TextContext): Texts {
  const cap = c.cap;
  switch (verdict) {
    case "easy_ok": {
      const share = `${pct(c.shareBelow)} der Zeit unter ${cap}`;
      const first = c.kmh !== null ? `${atSpeed(c.kmh)}${share}` : share.charAt(0).toUpperCase() + share.slice(1);
      if (c.heat) {
        return {
          headline: "Locker gelaufen",
          explanation: `${first}. Bei gleichem Tempo stieg der Puls aber langsam von ${c.heat.from} auf ${c.heat.to}, vielleicht war es warm im Raum.`,
          tip: "Stell einen Ventilator auf und trink vorher etwas.",
        };
      }
      return {
        headline: "Locker gelaufen",
        explanation: `${first}${c.flatEnd ? ", kein Anstieg am Ende" : ""}. Genau so war es gedacht.`,
        tip: keepCalm,
      };
    }
    case "late_surge": {
      const from = c.fromMin as number;
      const headline = `Ab Minute ${from} zu schnell geworden`;
      if (c.treadmill) {
        const pre = buckets(c.g.hr, 30).slice(Math.ceil(c.a0 / 30), Math.floor((c.surge.from_s as number) / 30)).filter(isNum);
        const lo = Math.round(Math.min(...pre));
        const hi = Math.round(Math.max(...pre));
        const preAvg = pre.reduce((s, v) => s + v, 0) / pre.length;
        const riseMin = Math.max(1, Math.round(((c.surge.peak_s as number) - (c.surge.from_s as number)) / 60));
        const calm = preAvg <= cap ? " ruhig" : "";
        return {
          headline,
          explanation: `${from} Minuten${calm} zwischen ${lo} und ${hi}, dann in ${riseMin} ${riseMin === 1 ? "Minute" : "Minuten"} auf ${c.surge.peak_hr}. ${plannedGoal(c.planned, cap)}`,
          tip: treadmillHold,
        };
      }
      // Bergab schneller geworden? Dann passt der Hinweis aus 9.4.
      const fromS = c.surge.from_s as number;
      const altFrom = mean(c.g.alt, fromS, fromS + 60);
      const altEnd = mean(c.g.alt, c.g.n - 60, c.g.n);
      const downhill = altFrom !== null && altEnd !== null && altFrom - altEnd >= 15;
      return {
        headline,
        explanation: `${halvesSentence(c) || `Zum Schluss bis ${c.surge.peak_hr} Puls.`} ${plannedGoal(c.planned, cap)}`,
        tip: downhill ? `Stell den Pulsalarm auf ${cap}. Und bergab nicht Gas geben.` : alarm(cap),
      };
    }
    case "easy_too_hard": {
      const close = c.shareOver5 < 0.15;
      const planned = c.planned === "long_run" ? "langen Lauf" : "lockeren Lauf";
      const explanation = close
        ? `${pct(c.shareBelow)} der Zeit unter ${cap}, der Rest meist knapp darüber. Für einen ${planned} sollten es mindestens 85 % sein.`
        : c.shareBelow < 0.05
        ? `Fast die ganze Zeit über ${cap}, Ø Puls ${c.avg}. Für einen ${planned} sollten mindestens 85 % der Zeit darunter liegen.`
        : `Nur ${pct(c.shareBelow)} der Zeit unter ${cap}, Ø Puls ${c.avg}. Für einen ${planned} sollten es mindestens 85 % sein.`;
      let tip = alarm(cap);
      if (c.treadmill) {
        tip = c.kmh !== null && c.kmh > 5
          ? `Stell das Band beim nächsten Mal etwas langsamer, etwa auf ${kmhText(c.kmh - 0.5)}.`
          : `Stell das Band etwas langsamer und den Pulsalarm auf ${cap}.`;
      }
      return { headline: close ? "Knapp über locker" : "Zu schnell für locker", explanation, tip };
    }
    case "hard_session": {
      const over = Math.round(c.avgAfterWarmup - cap);
      const halves = halvesSentence(c);
      return {
        headline: "Harte Einheit",
        explanation: `${atSpeed(c.kmh)}${c.kmh !== null ? "lag" : "Nach dem Einlaufen lag"} dein Puls im Schnitt bei ${Math.round(c.avgAfterWarmup)}, ${over} über deiner Grenze für lockere Läufe von ${cap}.${halves ? " " + halves : ""}`,
        tip: restTip,
      };
    }
    case "race_like": {
      const over = Math.round(c.avgAfterWarmup - cap);
      return {
        headline: "Wie ein Wettkampf gelaufen",
        explanation: `Ø Puls ${Math.round(c.avgAfterWarmup)}, ${over} über deiner Grenze von ${cap}, und das fast die ganze Zeit. So läuft man einen Wettkampf.`,
        tip: raceTip,
      };
    }
    default:
      return noHrTexts(null);
  }
}

function noHrTexts(sensor: "wrist" | "chest" | null): Texts {
  return {
    headline: "Ohne Puls gelaufen",
    explanation: "Die Uhr hat für diesen Lauf keinen Puls geliefert. Deshalb kann ich nicht sagen, ob er locker war.",
    tip: sensor === "chest"
      ? "Prüf vor dem nächsten Lauf, ob der Brustgurt gut sitzt und die Batterie voll ist."
      : "Trag die Uhr beim nächsten Lauf etwas enger, dann misst sie zuverlässiger.",
  };
}

/** Ohne Zeitreihe: nur Ø und Max gegen die Grenze, keine Minuten, keine Hälften. */
function summaryJudgement(
  run: RunInput, opts: AnalyzeOptions, kmh: number | null, sensor: "wrist" | "chest" | null,
): Texts & { verdict: Verdict } {
  const cap = opts.easy_hr_cap;
  const avg = run.avg_hr;
  const max = run.max_hr;
  if (!isNum(avg)) return { verdict: "unknown", ...noHrTexts(sensor) };
  const maxPart = isNum(max) ? `, höchstens ${max}` : "";
  const speed = kmh !== null ? `Bei ${kmhText(kmh)}: ` : "";
  if (avg <= cap && (!isNum(max) || max <= cap + SPIKE)) {
    return {
      verdict: "easy_ok",
      headline: "Locker gelaufen",
      explanation: `${speed}Ø Puls ${avg}${maxPart}. Unter deiner Grenze von ${cap}, genau so war es gedacht.`,
      tip: keepCalm,
    };
  }
  if (avg <= cap) {
    return {
      verdict: "easy_too_hard",
      headline: "Meist locker gelaufen",
      explanation: `${speed}Ø Puls ${avg} unter ${cap}, aber zwischendurch bis ${max}. Wann genau, zeigt erst der Pulsverlauf.`,
      tip: alarm(cap),
    };
  }
  if (!opts.planned && avg >= cap + 10) {
    return {
      verdict: "hard_session",
      headline: "Harte Einheit",
      explanation: `${speed}Ø Puls ${avg}${maxPart}, ${avg - cap} über deiner Grenze für lockere Läufe von ${cap}. Den genauen Verlauf habe ich für diesen Lauf nicht.`,
      tip: restTip,
    };
  }
  return {
    verdict: "easy_too_hard",
    headline: "Zu schnell für locker",
    explanation: `${speed}Ø Puls ${avg}${maxPart}. Für einen lockeren Lauf liegt das über deiner Grenze von ${cap}.`,
    tip: isTreadmillType(run.type) ? `Stell das Band etwas langsamer und den Pulsalarm auf ${cap}.` : alarm(cap),
  };
}

/* ---------------------------------------------------------------------------
 * Vergleichbare Läufe
 * ------------------------------------------------------------------------- */
interface CompareRun {
  run: RunInput;
  analysis: RunAnalysis | null;
  treadmill_kmh: number | null;
}

const sensorWord = (s: "wrist" | "chest") => (s === "chest" ? "mit Brustgurt" : "am Handgelenk");
const avgPaceOf = (r: RunInput) =>
  isNum(r.duration_s) && isNum(r.distance_m) && r.distance_m >= 200 ? r.duration_s / (r.distance_m / 1000) : null;

function paceSentence(diff: number | null): string {
  if (diff === null) return "";
  const n = Math.abs(Math.round(diff));
  if (n <= 3) return "Gleiches Tempo.";
  const dir = diff > 0 ? "schneller" : "langsamer";
  return n <= SAME_PACE_S ? `${n} Sekunden pro km ${dir}, das ist Tagesform.` : `${n} Sekunden pro km ${dir}.`;
}

function hrSentence(delta: number, sameLabel: boolean): string {
  const n = Math.abs(delta);
  if (n <= SAME_HR_BPM) return sameLabel ? "Gleich gut, das ist Tagesform." : "";
  return delta < 0
    ? `Bei gleichem Tempo ${n} Schläge weniger als damals.`
    : `Bei gleichem Tempo ${n} Schläge mehr als damals. Das kann Tagesform sein.`;
}

/**
 * Vergleichbare frühere Läufe (6.3, 9.4): gleicher Typ; draußen Startpunkt ≤ 500 m und Distanz ±15 %;
 * Laufband nur mit gleicher Geschwindigkeitsangabe (und ähnlicher Dauer, weil der Puls mit der Zeit steigt).
 * Höchstens 3, neueste zuerst. Sensorwechsel wird markiert.
 */
export function comparableRuns(
  current: { run: RunInput; analysis: RunAnalysis; treadmill_kmh: number | null },
  others: CompareRun[],
): ComparableRun[] {
  const cur = current.run;
  const treadmill = isTreadmillType(cur.type);
  const curSensor = current.analysis.sensor ?? cur.hr_sensor;
  const out: { started: string; c: ComparableRun }[] = [];

  for (const o of others) {
    const r = o.run;
    if (r.external_id === cur.external_id || r.type !== cur.type || r.started_at_local >= cur.started_at_local) continue;
    const oSensor = o.analysis?.sensor ?? r.hr_sensor;
    const mismatch = !!curSensor && !!oSensor && curSensor !== oSensor;
    const date = r.started_at_local.slice(0, 10);
    const day = shortDate(r.started_at_local);
    const mismatchText = mismatch
      ? ` Heute ${sensorWord(curSensor as "wrist" | "chest")} gemessen, damals ${sensorWord(oSensor as "wrist" | "chest")}. Der Puls-Vergleich ist unsicher.`
      : "";

    if (treadmill) {
      const k1 = current.treadmill_kmh;
      const k2 = o.treadmill_kmh;
      if (!isNum(k1) || !isNum(k2) || Math.abs(k1 - k2) >= 0.05) continue;
      if (isNum(cur.duration_s) && isNum(r.duration_s) && Math.abs(r.duration_s / cur.duration_s - 1) > SAME_TREADMILL_DURATION) continue;
      if (!isNum(cur.avg_hr) || !isNum(r.avg_hr)) continue;
      const delta = cur.avg_hr - r.avg_hr;
      const head = `${kmhText(k1)} wie am ${day}: Ø Puls ${cur.avg_hr}, damals ${r.avg_hr}.`;
      const verdict = mismatch ? mismatchText : " " + (Math.abs(delta) <= SAME_HR_BPM
        ? "Gleich gut, das ist Tagesform."
        : delta < 0 ? `${-delta} Schläge weniger bei gleichem Tempo.` : `${delta} Schläge mehr bei gleichem Tempo, das kann Tagesform sein.`);
      out.push({
        started: r.started_at_local,
        c: { id: r.external_id, date, delta_hr_at_same_pace: delta, text: head + verdict, ...(mismatch ? { sensor_mismatch: true } : {}) },
      });
      continue;
    }

    const sp1 = current.analysis.start_point;
    const sp2 = o.analysis?.start_point ?? null;
    if (!sp1 || !sp2 || haversine(sp1, sp2) > SAME_START_M) continue;
    if (!isNum(cur.distance_m) || !isNum(r.distance_m) || cur.distance_m <= 0) continue;
    if (Math.abs(r.distance_m / cur.distance_m - 1) > SAME_DIST) continue;

    // Puls bei gleichem Tempo: damaligen Puls auf das heutige flache Tempo umrechnen (über Meter pro Schlag)
    const f1 = current.analysis.flat_efficiency;
    const f2 = o.analysis?.flat_efficiency ?? null;
    let delta: number | null = null;
    if (f1 && f2 && Math.abs(f1.pace_s_per_km - f2.pace_s_per_km) <= MAX_PACE_SCALE_S) {
      const speedToday = 1000 / f1.pace_s_per_km;
      delta = Math.round(f1.hr - (speedToday * 60) / f2.m_per_beat);
    }
    const p1 = avgPaceOf(cur);
    const p2 = avgPaceOf(r);
    const paceDiff = p1 !== null && p2 !== null ? p2 - p1 : null; // positiv = heute schneller
    // Für den Text: ohne flache Abschnitte nur bei fast gleichem Tempo den Ø Puls vergleichen
    const textDelta = delta ?? (paceDiff !== null && Math.abs(paceDiff) <= SAME_PACE_S && isNum(cur.avg_hr) && isNum(r.avg_hr)
      ? cur.avg_hr - r.avg_hr
      : null);

    const head = `Gleiche Runde wie am ${day}`;
    let text: string;
    const pace = paceSentence(paceDiff);
    if (mismatch || textDelta === null) {
      text = `${head}${pace ? ": " + pace : "."}${mismatchText}`;
    } else if (Math.abs(textDelta) <= SAME_HR_BPM) {
      text = `${head}: gleich gut.${pace ? " " + pace : ""}`;
    } else {
      const hr = hrSentence(textDelta, false);
      text = `${head}: ${pace ? pace.replace(", das ist Tagesform.", ".") + " " : ""}${hr}`;
    }
    out.push({
      started: r.started_at_local,
      c: { id: r.external_id, date, delta_hr_at_same_pace: delta, text, ...(mismatch ? { sensor_mismatch: true } : {}) },
    });
  }

  return out
    .sort((a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0))
    .slice(0, 3)
    .map((x) => x.c);
}
