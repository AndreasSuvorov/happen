import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeRun, comparableRuns, formatPace } from "../supabase/functions/_shared/run/analyze.ts";
import type { FitActivity, FitRecord, RunAnalysis, RunInput } from "../supabase/functions/_shared/run/types.ts";

/* ---------------------------------------------------------------------------
 * Synthetische FIT-Dateien: ein Datensatz pro Sekunde
 * ------------------------------------------------------------------------- */
interface Gen {
  minutes: number;
  hr: (min: number) => number | null;
  /** m/s; draußen aus GPS, auf dem Laufband vom Handgelenk (zu hoch) */
  speed?: (min: number) => number;
  alt?: (min: number) => number;
  gps?: { lat: number; lon: number };
  cadence?: (min: number) => number;
  sensor?: "chest" | "wrist" | null;
}

function makeFit(g: Gen): FitActivity {
  const records: FitRecord[] = [];
  let dist = 0;
  for (let t = 0; t <= g.minutes * 60; t++) {
    const m = t / 60;
    const sp = g.speed ? g.speed(m) : null;
    if (sp !== null && t > 0) dist += sp;
    const hr = g.hr(m);
    records.push({
      t_s: t,
      hr: hr === null ? null : Math.round(hr),
      speed_mps: sp,
      dist_m: sp !== null ? dist : null,
      alt_m: g.alt ? g.alt(m) : null,
      cadence_spm: g.cadence ? g.cadence(m) : sp !== null ? 166 : null,
      // nach Norden laufen: 1 m ≈ 1/111320 Grad
      lat: g.gps ? g.gps.lat + dist / 111320 : null,
      lon: g.gps ? g.gps.lon : null,
    });
  }
  return { records, hr_sensor: g.sensor === undefined ? "wrist" : g.sensor, start_time_utc: "2026-11-24T09:00:00Z" };
}

const avgOf = (fit: FitActivity) => {
  const hrs = fit.records.map((r) => r.hr).filter((h): h is number => h !== null);
  return Math.round(hrs.reduce((s, h) => s + h, 0) / hrs.length);
};

function runOf(fit: FitActivity | null, over: Partial<RunInput> = {}): RunInput {
  const last = fit?.records[fit.records.length - 1];
  const hrs = fit?.records.map((r) => r.hr).filter((h): h is number => h !== null) ?? [];
  return {
    external_id: "run-1",
    type: "running",
    started_at_local: "2026-11-24T10:11:00",
    duration_s: last ? last.t_s : 2400,
    distance_m: last?.dist_m ?? 6000,
    avg_hr: hrs.length ? avgOf(fit as FitActivity) : null,
    max_hr: hrs.length ? Math.max(...hrs) : null,
    hr_sensor: fit?.hr_sensor ?? "wrist",
    ...over,
  };
}

const cap = 145;
const warmup = (from: number, to: number) => (m: number) => from + (to - from) * (m / 5);
const noEmoji = (s: string) => !/\p{Extended_Pictographic}/u.test(s);

function assertTexts(a: RunAnalysis) {
  for (const s of [a.headline, a.explanation, a.tip ?? ""]) {
    assert.ok(noEmoji(s), `kein Emoji: ${s}`);
    assert.ok(!/\bSie\b/.test(s), `Du-Form: ${s}`);
  }
  assert.ok(a.headline.length > 0 && a.explanation.length > 0);
}

/* ---------------------------------------------------------------------------
 * Pflichtfälle aus Coach-Plan 12
 * ------------------------------------------------------------------------- */
test("easy_ok: Laufband 33 min, Ø 139, 94 % unter 145, kein Anstieg am Ende", () => {
  const fit = makeFit({
    minutes: 33,
    // nach dem Einlaufen 139 ± 3, zweimal kurz über der Grenze (Minute 20 und 27)
    hr: (m) => (m < 5 ? warmup(118, 136)(m) : (m >= 20 && m < 21) || (m >= 27 && m < 28) ? 150 : 140 + 3 * Math.sin(m * 0.7)),
    speed: () => 2.8, // Handgelenk, ~35 % zu hoch: muss ignoriert werden
    sensor: "wrist",
  });
  const run = runOf(fit, { type: "treadmill_running", distance_m: 5500 });
  assert.ok(Math.abs(avgOf(fit) - 139) <= 1);
  const a = analyzeRun(run, fit, { easy_hr_cap: cap, treadmill_kmh: 7.5, planned: "easy_run" });
  assert.equal(a.verdict, "easy_ok");
  assert.ok(a.share_below_cap! >= 0.9 && a.share_below_cap! <= 0.96, String(a.share_below_cap));
  assert.equal(a.surge.detected, false);
  assert.equal(a.headline, "Locker gelaufen");
  assert.match(a.explanation, /^Bei 7,5 km\/h 9\d % der Zeit unter 145, kein Anstieg am Ende\. Genau so war es gedacht\.$/);
  assert.equal(a.tip, "Weiter so. Beim nächsten Lauf genauso ruhig anfangen.");
  // Laufband: kein Tempo aus der FIT-Datei, kein Startpunkt, keine flachen Abschnitte
  assert.equal(a.pace_first_half_s_per_km, null);
  assert.equal(a.pace_second_half_s_per_km, null);
  assert.equal(a.flat_efficiency, null);
  assert.equal(a.drift_pct, null);
  assert.equal(a.start_point, null);
  assert.ok(a.hr_series.every((p) => !("pace_s_per_km" in p) && !("elev_m" in p)));
  assert.equal(a.hr_series.length, 66);
  assert.deepEqual(a.hr_series.slice(0, 2).map((p) => p.t_min), [0, 0.5]);
  assert.deepEqual(a.notes, []);
  assert.equal(a.sensor, "wrist");
  assert.equal(a.hr_cap, 145);
  assert.equal(a.version, 1);
  assertTexts(a);
});

test("late_surge: Laufband 49 min, 40 min bei 130–152, dann Minute 42–46 bis 179", () => {
  const fit = makeFit({
    minutes: 49,
    hr: (m) =>
      m < 5 ? warmup(115, 133)(m)
      : m < 42 ? 138 + (m - 5) * 0.2 + 4 * Math.sin(m * 0.9)
      : m < 46 ? 152 + (m - 42) * 6.75
      : 179 - (m - 46) * 3,
    speed: (m) => (m < 42 ? 2.6 : 3.0),
  });
  const a = analyzeRun(runOf(fit, { type: "treadmill_running" }), fit, { easy_hr_cap: cap, treadmill_kmh: null });
  assert.equal(a.verdict, "late_surge");
  assert.equal(a.surge.detected, true);
  assert.ok(a.surge.from_min! >= 41 && a.surge.from_min! <= 43, String(a.surge.from_min));
  assert.ok(a.surge.peak_hr! >= 177 && a.surge.peak_hr! <= 179);
  assert.equal(a.headline, `Ab Minute ${a.surge.from_min} zu schnell geworden`);
  assert.match(a.explanation, /^4\d Minuten ruhig zwischen 1[34]\d und 1[45]\d, dann in [3-5] Minuten auf 17\d\. Locker heißt: bis zum Ende unter 145\.$/);
  assert.equal(a.tip, "Halte das Band bis zum Schluss bei deinem Starttempo. Steigern kannst du an einem anderen Tag.");
  assert.ok(!a.notes.includes("heat_suspected"));
  assertTexts(a);
});

const munich = { lat: 48.13712, lon: 11.57541 };

function outdoorSurgeFit() {
  return makeFit({
    minutes: 86,
    hr: (m) =>
      (m < 3 ? 135 + m * 4.5 : m < 43 ? 149 : m < 46 ? 149 + (m - 43) * 4.3 : 162) + 2 * Math.sin(m * 0.8),
    speed: (m) => (m < 43 ? 1000 / 459 : 1000 / 431),
    alt: (m) => 520 + 0.5 * Math.sin(m),
    gps: munich,
    sensor: "chest",
  });
}

test("late_surge draußen: 86 min, 1. Hälfte Ø 149 bei 7:39/km, 2. Hälfte Ø 162 bei 7:11/km", () => {
  const fit = outdoorSurgeFit();
  const a = analyzeRun(runOf(fit), fit, { easy_hr_cap: cap, planned: "long_run" });
  assert.equal(a.verdict, "late_surge");
  assert.ok(Math.abs(a.hr_first_half! - 149) <= 1, String(a.hr_first_half));
  assert.ok(Math.abs(a.hr_second_half! - 162) <= 1, String(a.hr_second_half));
  assert.equal(a.pace_first_half_s_per_km, 459);
  assert.equal(a.pace_second_half_s_per_km, 431);
  assert.equal(formatPace(459), "7:39/km");
  assert.ok(a.surge.from_min! >= 42 && a.surge.from_min! <= 44, String(a.surge.from_min));
  assert.equal(a.headline, `Ab Minute ${a.surge.from_min} zu schnell geworden`);
  assert.equal(
    a.explanation,
    `Erste Hälfte Ø ${a.hr_first_half} bei 7:39/km, zweite Hälfte Ø ${a.hr_second_half} bei 7:11/km. Ein langer Lauf sollte bis zum Ende ruhig bleiben.`,
  );
  assert.equal(a.tip, "Stell den Pulsalarm auf 145. Dann merkst du sofort, wenn es zu schnell wird.");
  // Tempo war nicht gleichmäßig: keine Drift
  assert.equal(a.drift_pct, null);
  // draußen mit GPS: Startpunkt gerundet, Tempo und Höhe in der Reihe, flache Abschnitte
  assert.deepEqual(a.start_point, { lat: 48.137, lon: 11.575 });
  assert.equal(a.hr_series[20].pace_s_per_km, 459);
  assert.ok(a.hr_series.every((p) => typeof p.elev_m === "number"));
  assert.ok(a.flat_efficiency && a.flat_efficiency.n_windows > 100);
  assert.equal(a.sensor, "chest");
  assertTexts(a);
});

test("draußen bergab schneller geworden: Tipp nennt bergab", () => {
  const fit = makeFit({
    minutes: 60,
    hr: (m) => (m < 5 ? warmup(120, 138)(m) : m < 35 ? 140 : 155),
    speed: (m) => (m < 35 ? 2.4 : 2.8),
    alt: (m) => (m < 35 ? 600 : 600 - (m - 35) * 2),
    gps: munich,
  });
  const a = analyzeRun(runOf(fit), fit, { easy_hr_cap: cap });
  assert.equal(a.verdict, "late_surge");
  assert.equal(a.tip, "Stell den Pulsalarm auf 145. Und bergab nicht Gas geben.");
});

/* ---------------------------------------------------------------------------
 * Weitere Fälle
 * ------------------------------------------------------------------------- */
test("gleichmäßig locker draußen: Drift und flache Abschnitte", () => {
  const fit = makeFit({
    minutes: 50,
    hr: (m) => (m < 5 ? warmup(115, 135)(m) : 136 + (m - 5) * 0.1),
    speed: () => 1000 / 420,
    alt: () => 500,
    gps: munich,
  });
  const a = analyzeRun(runOf(fit), fit, { easy_hr_cap: cap });
  assert.equal(a.verdict, "easy_ok");
  assert.equal(a.share_below_cap, 1);
  assert.equal(a.share_above_cap_plus5, 0);
  assert.ok(a.drift_pct! > 1 && a.drift_pct! < 5, String(a.drift_pct));
  assert.equal(a.flat_efficiency!.pace_s_per_km, 420);
  assert.ok(Math.abs(a.flat_efficiency!.m_per_beat - (1000 / 420) * 60 / a.flat_efficiency!.hr) < 0.01);
  assert.equal(a.explanation, "100 % der Zeit unter 145, kein Anstieg am Ende. Genau so war es gedacht.");
});

test("ohne FIT: vorsichtiges Urteil aus Ø und Max, keine Minuten, keine Hälften", () => {
  const easy = analyzeRun(runOf(null, { avg_hr: 139, max_hr: 147 }), null, { easy_hr_cap: cap });
  assert.equal(easy.verdict, "easy_ok");
  assert.deepEqual(easy.notes, ["no_fit"]);
  assert.deepEqual(easy.hr_series, []);
  assert.equal(easy.share_below_cap, null);
  assert.equal(easy.hr_first_half, null);
  assert.deepEqual(easy.surge, { detected: false, from_min: null, peak_hr: null });
  assert.equal(easy.explanation, "Ø Puls 139, höchstens 147. Unter deiner Grenze von 145, genau so war es gedacht.");

  const spikes = analyzeRun(runOf(null, { avg_hr: 140, max_hr: 168 }), null, { easy_hr_cap: cap });
  assert.equal(spikes.verdict, "easy_too_hard");
  assert.equal(spikes.headline, "Meist locker gelaufen");
  assert.doesNotMatch(spikes.explanation + spikes.headline, /Minute/);

  const tooHard = analyzeRun(runOf(null, { avg_hr: 151, max_hr: 160 }), null, { easy_hr_cap: cap, planned: "easy_run" });
  assert.equal(tooHard.verdict, "easy_too_hard");
  const hard = analyzeRun(runOf(null, { avg_hr: 162, max_hr: 175 }), null, { easy_hr_cap: cap });
  assert.equal(hard.verdict, "hard_session");
  assert.match(hard.explanation, /Den genauen Verlauf habe ich für diesen Lauf nicht\./);

  const emptyFit = analyzeRun(runOf(null, { avg_hr: 139, max_hr: 147 }), { records: [], hr_sensor: null, start_time_utc: null }, { easy_hr_cap: cap });
  assert.deepEqual(emptyFit.notes, ["no_fit"]);
  assert.equal(emptyFit.verdict, "easy_ok");
});

test("ohne Puls: unknown", () => {
  const fit = makeFit({ minutes: 30, hr: () => null, speed: () => 2.5, gps: munich, alt: () => 500 });
  const a = analyzeRun(runOf(fit, { avg_hr: null, max_hr: null }), fit, { easy_hr_cap: cap });
  assert.equal(a.verdict, "unknown");
  assert.deepEqual(a.notes, ["no_hr"]);
  assert.deepEqual(a.hr_series, []);
  assert.equal(a.headline, "Ohne Puls gelaufen");
  assert.ok(a.start_point); // gleiche Runde geht auch ohne Puls

  const none = analyzeRun(runOf(null, { avg_hr: null, max_hr: null, hr_sensor: "chest" }), null, { easy_hr_cap: cap });
  assert.equal(none.verdict, "unknown");
  assert.deepEqual(none.notes, ["no_fit", "no_hr"]);
  assert.match(none.tip!, /Brustgurt/);
  assertTexts(none);
});

test("harte Einheit, wettkampfähnlich und zu schnell für locker", () => {
  const steadyHard = (hr: number) =>
    makeFit({ minutes: 45, hr: (m) => (m < 5 ? warmup(125, hr - 3)(m) : hr + 2 * Math.sin(m)), speed: () => 3.3, alt: () => 500, gps: munich });

  const hard = analyzeRun(runOf(steadyHard(158)), steadyHard(158), { easy_hr_cap: cap });
  assert.equal(hard.verdict, "hard_session");
  assert.equal(hard.headline, "Harte Einheit");
  assert.match(hard.explanation, /^Nach dem Einlaufen lag dein Puls im Schnitt bei 158, 13 über deiner Grenze für lockere Läufe von 145\./);
  assert.equal(hard.tip, "Morgen locker bleiben oder pausieren.");
  assertTexts(hard);

  // Geplant war locker: ehrliches Urteil statt „harte Einheit“
  const planned = analyzeRun(runOf(steadyHard(158)), steadyHard(158), { easy_hr_cap: cap, planned: "easy_run" });
  assert.equal(planned.verdict, "easy_too_hard");
  assert.equal(planned.headline, "Zu schnell für locker");
  assert.match(planned.explanation, /^Fast die ganze Zeit über 145, Ø Puls 15\d\. Für einen lockeren Lauf sollten mindestens 85 % der Zeit darunter liegen\.$/);

  const race = analyzeRun(runOf(steadyHard(172)), steadyHard(172), { easy_hr_cap: cap });
  assert.equal(race.verdict, "race_like");
  assert.equal(race.headline, "Wie ein Wettkampf gelaufen");
  assert.equal(race.tip, "Gönn dir jetzt ein, zwei ruhige Tage.");

  // knapp über der Grenze
  const close = analyzeRun(runOf(steadyHard(147)), steadyHard(147), { easy_hr_cap: cap });
  assert.equal(close.verdict, "easy_too_hard");
  assert.equal(close.headline, "Knapp über locker");
});

test("Hitze-Verdacht: Laufband, gleichmäßiges Tempo, Puls +10 % in 30 min", () => {
  const heat = (speed: (m: number) => number) =>
    makeFit({ minutes: 45, hr: (m) => (m < 5 ? warmup(115, 130)(m) : 131 + (m - 5) * 0.45), speed });
  const fit = heat(() => 2.9);
  const a = analyzeRun(runOf(fit, { type: "treadmill_running" }), fit, { easy_hr_cap: cap, treadmill_kmh: 8 });
  assert.ok(a.notes.includes("heat_suspected"));
  assert.equal(a.surge.detected, false);
  assert.equal(a.verdict, "easy_too_hard");
  assert.equal(a.tip, "Stell das Band beim nächsten Mal etwas langsamer, etwa auf 7,5 km/h.");

  // gleiches Pulsbild, aber das Band wurde schneller gestellt: kein Hitze-Verdacht
  const faster = heat((m) => 2.5 + m * 0.02);
  const b = analyzeRun(runOf(faster, { type: "treadmill_running" }), faster, { easy_hr_cap: cap });
  assert.ok(!b.notes.includes("heat_suspected"));

  // draußen gibt es den Hinweis nicht
  const out = makeFit({ minutes: 45, hr: (m) => (m < 5 ? 125 : 131 + (m - 5) * 0.45), speed: () => 2.9, gps: munich, alt: () => 500 });
  assert.ok(!analyzeRun(runOf(out), out, { easy_hr_cap: cap }).notes.includes("heat_suspected"));
});

test("Hitze-Verdacht bei lockerem Lauf erklärt den Anstieg", () => {
  const fit = makeFit({ minutes: 40, hr: (m) => (m < 5 ? warmup(110, 122)(m) : 123 + (m - 5) * 0.45), speed: () => 2.9 });
  const a = analyzeRun(runOf(fit, { type: "treadmill_running" }), fit, { easy_hr_cap: cap, treadmill_kmh: 8 });
  assert.equal(a.verdict, "easy_ok");
  assert.ok(a.notes.includes("heat_suspected"));
  assert.match(a.explanation, /^Bei 8,0 km\/h 100 % der Zeit unter 145\. Bei gleichem Tempo stieg der Puls aber langsam von 1\d\d auf 1\d\d, vielleicht war es warm im Raum\.$/);
});

test("Ausreißer vom Sensor werden geglättet", () => {
  const fit = makeFit({ minutes: 30, hr: (m) => (m < 5 ? 125 : Math.round(m * 60) % 97 === 0 ? 210 : 138), speed: () => 2.9 });
  const a = analyzeRun(runOf(fit, { type: "treadmill_running" }), fit, { easy_hr_cap: cap });
  assert.equal(a.share_below_cap, 1);
  assert.ok(a.hr_series.every((p) => p.hr < 145));
});

/* ---------------------------------------------------------------------------
 * comparableRuns
 * ------------------------------------------------------------------------- */
function analysisWith(over: Partial<RunAnalysis>): RunAnalysis {
  const fit = makeFit({ minutes: 20, hr: () => 138, speed: () => 2.5, gps: munich, alt: () => 500 });
  return { ...analyzeRun(runOf(fit), fit, { easy_hr_cap: cap }), ...over };
}

const flat = (pace: number, hr: number) => ({ pace_s_per_km: pace, hr, m_per_beat: (1000 / pace) * 60 / hr, n_windows: 60 });

function outdoorRun(id: string, day: string, over: Partial<RunInput> = {}): RunInput {
  return {
    external_id: id, type: "running", started_at_local: `2026-11-${day}T10:00:00`,
    duration_s: 2460, distance_m: 6100, avg_hr: 139, max_hr: 150, hr_sensor: "chest", ...over,
  };
}

test("comparableRuns draußen: gleiche Runde, andere Runde, Sensorwechsel, neueste zuerst", () => {
  const near = { lat: 48.138, lon: 11.575 }; // ~100 m
  const far = { lat: 48.145, lon: 11.575 }; // ~900 m
  const current = {
    run: outdoorRun("now", "24", { duration_s: 2460 - 6 * 14 }), // 14 s/km schneller
    analysis: analysisWith({ start_point: { lat: 48.137, lon: 11.575 }, flat_efficiency: flat(400, 140), sensor: "chest" }),
    treadmill_kmh: null,
  };
  const others = [
    { run: outdoorRun("same", "06"), analysis: analysisWith({ start_point: near, flat_efficiency: flat(410, 139), sensor: "chest" }), treadmill_kmh: null },
    { run: outdoorRun("other-loop", "10"), analysis: analysisWith({ start_point: far, flat_efficiency: flat(400, 140), sensor: "chest" }), treadmill_kmh: null },
    { run: outdoorRun("longer", "12", { distance_m: 8000 }), analysis: analysisWith({ start_point: near, sensor: "chest" }), treadmill_kmh: null },
    { run: outdoorRun("wrist", "16", { hr_sensor: "wrist" }), analysis: analysisWith({ start_point: near, flat_efficiency: flat(400, 150), sensor: "wrist" }), treadmill_kmh: null },
    { run: outdoorRun("better", "18"), analysis: analysisWith({ start_point: near, flat_efficiency: flat(400, 147), sensor: "chest" }), treadmill_kmh: null },
    { run: outdoorRun("no-analysis", "20"), analysis: null, treadmill_kmh: null },
    { run: outdoorRun("later", "25"), analysis: analysisWith({ start_point: near, sensor: "chest" }), treadmill_kmh: null },
    { run: { ...outdoorRun("trail", "21"), type: "trail_running" }, analysis: analysisWith({ start_point: near }), treadmill_kmh: null },
  ];
  const result = comparableRuns(current, others);
  assert.deepEqual(result.map((c) => c.id), ["better", "wrist", "same"]);

  const [better, wrist, same] = result;
  assert.equal(better.delta_hr_at_same_pace, -7);
  assert.equal(better.text, "Gleiche Runde wie am 18.11.: 14 Sekunden pro km schneller. Bei gleichem Tempo 7 Schläge weniger als damals.");
  assert.equal(wrist.sensor_mismatch, true);
  assert.match(wrist.text!, /Heute mit Brustgurt gemessen, damals am Handgelenk\. Der Puls-Vergleich ist unsicher\.$/);
  assert.equal(same.date, "2026-11-06");
  assert.ok(Math.abs(same.delta_hr_at_same_pace!) <= 3);
  assert.equal(same.text, "Gleiche Runde wie am 6.11.: gleich gut. 14 Sekunden pro km schneller, das ist Tagesform.");
  assert.equal(same.sensor_mismatch, undefined);
});

test("comparableRuns Laufband: nur gleiche Geschwindigkeit", () => {
  const tm = (id: string, day: string, avg: number, sensor: "wrist" | "chest" = "wrist"): RunInput => ({
    external_id: id, type: "treadmill_running", started_at_local: `2026-11-${day}T18:00:00`,
    duration_s: 2400, distance_m: 6500, avg_hr: avg, max_hr: avg + 8, hr_sensor: sensor,
  });
  const a = analyzeRun(tm("now", "18", 142), null, { easy_hr_cap: cap, treadmill_kmh: 7.5 });
  const current = { run: tm("now", "18", 142), analysis: a, treadmill_kmh: 7.5 };
  const result = comparableRuns(current, [
    { run: tm("same-speed", "04", 145), analysis: null, treadmill_kmh: 7.5 },
    { run: tm("other-speed", "10", 140), analysis: null, treadmill_kmh: 8 },
    { run: tm("no-speed", "12", 140), analysis: null, treadmill_kmh: null },
    { run: tm("chest", "14", 141, "chest"), analysis: null, treadmill_kmh: 7.5 },
    { run: { ...tm("short", "15", 135), duration_s: 1200 }, analysis: null, treadmill_kmh: 7.5 },
  ]);
  assert.deepEqual(result.map((c) => c.id), ["chest", "same-speed"]);
  assert.equal(result[0].sensor_mismatch, true);
  assert.equal(result[0].text, "7,5 km/h wie am 14.11.: Ø Puls 142, damals 141. Heute am Handgelenk gemessen, damals mit Brustgurt. Der Puls-Vergleich ist unsicher.");
  assert.equal(result[1].delta_hr_at_same_pace, -3);
  assert.equal(result[1].text, "7,5 km/h wie am 4.11.: Ø Puls 142, damals 145. Gleich gut, das ist Tagesform.");

  // ohne eigene Geschwindigkeitsangabe kein Vergleich
  assert.deepEqual(comparableRuns({ ...current, treadmill_kmh: null }, [{ run: tm("x", "04", 145), analysis: null, treadmill_kmh: 7.5 }]), []);
});
