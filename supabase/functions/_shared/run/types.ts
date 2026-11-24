// Gemeinsame Typen für Meilenstein 4 (Laufanalyse).
// fit.ts liefert `FitActivity`, analyze.ts macht daraus `RunAnalysis` (gespeichert in wearable_activities.analysis).
// Reines TypeScript ohne Deno- oder npm-Importe, damit `node --test` die Module direkt laden kann.

/** Ein Datensatz aus der FIT-Datei (meist einer pro Sekunde). */
export interface FitRecord {
  /** Sekunden seit dem ersten Datensatz */
  t_s: number;
  hr: number | null;
  /** m/s (enhanced_speed, sonst speed) */
  speed_mps: number | null;
  /** zurückgelegte Strecke in m */
  dist_m: number | null;
  /** Höhe in m (enhanced_altitude, sonst altitude) */
  alt_m: number | null;
  /** Schritte pro Minute (FIT liefert pro Bein, hier schon ×2) */
  cadence_spm: number | null;
  /** Grad, nur draußen mit GPS */
  lat: number | null;
  lon: number | null;
}

export interface FitActivity {
  records: FitRecord[];
  /** Pulsquelle aus device_info: Brustgurt, wenn ein externer HR-Sensor (ANT+/BLE) dabei war */
  hr_sensor: "chest" | "wrist" | null;
  /** Startzeit (UTC, ISO) des ersten Datensatzes */
  start_time_utc: string | null;
}

export type Verdict = "easy_ok" | "easy_too_hard" | "late_surge" | "hard_session" | "race_like" | "unknown";

/** Punkt der Pulsreihe für das Diagramm, alle 30 s. */
export interface HrPoint {
  t_min: number;
  hr: number;
  pace_s_per_km?: number | null;
  elev_m?: number | null;
}

export interface ComparableRun {
  id: string;
  date: string;
  /** Puls bei gleichem Tempo heute minus damals (negativ = besser). */
  delta_hr_at_same_pace?: number | null;
  /** Ein Satz für die Anzeige, z. B. „Gleiche Runde wie am 6.11.: …“ */
  text?: string;
  /** true, wenn Pulsquelle anders war (Handgelenk ↔ Brustgurt) */
  sensor_mismatch?: boolean;
}

/** Ergebnis von analyzeRun (Coach-Plan 6.3), Form passend zu web/src/pages/training/run.ts. */
export interface RunAnalysis {
  version: number;
  verdict: Verdict;
  headline: string;
  explanation: string;
  tip: string | null;
  share_below_cap: number | null;
  share_above_cap_plus5: number | null;
  hr_first_half: number | null;
  hr_second_half: number | null;
  pace_first_half_s_per_km: number | null;
  pace_second_half_s_per_km: number | null;
  surge: { detected: boolean; from_min: number | null; peak_hr: number | null };
  drift_pct: number | null;
  flat_efficiency: { pace_s_per_km: number; hr: number; m_per_beat: number; n_windows: number } | null;
  comparable_runs: ComparableRun[];
  /** z. B. "heat_suspected", "no_fit", "no_hr" */
  notes: string[];
  sensor: "wrist" | "chest" | null;
  hr_cap: number;
  hr_series: HrPoint[];
  /** Startpunkt auf ~100 m gerundet, nur für „gleiche Runde“; nie an ein LLM geben */
  start_point: { lat: number; lon: number } | null;
}

/** Was analyzeRun über die Aktivität wissen muss (Spalten aus wearable_activities). */
export interface RunInput {
  external_id: string;
  type: string;
  started_at_local: string;
  duration_s: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  hr_sensor: "wrist" | "chest" | null;
}

export interface AnalyzeOptions {
  easy_hr_cap: number;
  /** Laufband-Geschwindigkeit laut Nutzer (km/h), sonst null */
  treadmill_kmh?: number | null;
  /** Geplanter Lauftyp aus dem Briefing, falls bekannt */
  planned?: "easy_run" | "long_run" | null;
}

export const ANALYSIS_VERSION = 1;
