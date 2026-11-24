// Laufanalyse im Sync (Meilenstein 4): neue Läufe finden, FIT laden, analyzeRun, vergleichbare Läufe, speichern.
// Alle Zugriffe gehen über `RunStore` und `fetchFit`, damit die Logik ohne Supabase und Garmin testbar ist.
// Ohne Deno-/npm-Importe (Node-Tests laden die Datei direkt).
import { analyzeRun, comparableRuns } from "./analyze.ts";
import { parseFit, unzipFirstFit } from "./fit.ts";
import type { FitActivity, RunAnalysis, RunInput } from "./types.ts";
import { ANALYSIS_VERSION } from "./types.ts";

/** Gespeicherte Analyse plus Eingaben, an denen wir erkennen, ob neu gerechnet werden muss. */
export type StoredAnalysis = RunAnalysis & { input_kmh?: number | null; input_cap?: number };

export interface RunCandidate extends RunInput {
  analysis: StoredAnalysis | null;
}

export interface RunStore {
  /** Läufe der letzten `days` Tage (lokales Startdatum ≥ sinceLocal), Details schon geladen, neueste zuerst. */
  recentRuns(userId: string, sinceLocal: string): Promise<RunCandidate[]>;
  /** coach_settings.easy_hr_cap, Standard 145. */
  easyHrCap(userId: string): Promise<number>;
  /** Laufband-Geschwindigkeit laut Nutzer je Datum (context_notes, tag 'laufband_kmh', letzte Notiz zählt). */
  treadmillSpeeds(userId: string, sinceDate: string): Promise<Map<string, number>>;
  saveAnalysis(userId: string, externalId: string, analysis: StoredAnalysis): Promise<void>;
}

export interface PipelineOptions {
  /** höchstens so viele FIT-Downloads pro Sync-Lauf */
  limit?: number;
  /** Zeitraum, der analysiert und für Vergleiche herangezogen wird */
  lookbackDays?: number;
  log?: (msg: string) => void;
}

export interface PipelineResult {
  analyzed: string[];
  /** davon neu (vorher ohne Analyse), für den Push nach dem Lauf */
  fresh: { run: RunInput; analysis: RunAnalysis }[];
}

export const RUN_ANALYSIS_LIMIT = 3;
export const RUN_LOOKBACK_DAYS = 90;
const LAUFBAND = "treadmill_running";

export const isRunType = (type: string) => /running/.test(type) || type === "run";

function addDaysLocal(date: string, days: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Muss dieser Lauf (neu) analysiert werden? */
export function needsAnalysis(run: RunCandidate, cap: number, kmh: number | null): boolean {
  const a = run.analysis;
  if (!a) return true;
  if ((a.version ?? 0) < ANALYSIS_VERSION) return true;
  if ((a.input_cap ?? cap) !== cap) return true;
  // Laufband: Nutzer hat die Geschwindigkeit nachgetragen oder geändert.
  if (run.type === LAUFBAND && (a.input_kmh ?? null) !== kmh) return true;
  return false;
}

/**
 * Analysiert ausstehende Läufe eines Nutzers. Wirft nicht für einzelne Läufe: Ist die FIT-Datei nicht
 * zu haben, wird ohne FIT geurteilt (notes enthält dann "no_fit"), damit wir nicht endlos neu laden.
 */
export async function analyzePendingRuns(
  userId: string,
  today: string,
  store: RunStore,
  fetchFit: (externalId: string) => Promise<Uint8Array | null>,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const limit = opts.limit ?? RUN_ANALYSIS_LIMIT;
  const since = addDaysLocal(today, -(opts.lookbackDays ?? RUN_LOOKBACK_DAYS));
  const [runs, cap, speeds] = await Promise.all([
    store.recentRuns(userId, since),
    store.easyHrCap(userId),
    store.treadmillSpeeds(userId, since),
  ]);
  const kmhOf = (r: RunInput) => (r.type === LAUFBAND ? speeds.get(r.started_at_local.slice(0, 10)) ?? null : null);

  const pending = runs.filter((r) => isRunType(r.type) && needsAnalysis(r, cap, kmhOf(r))).slice(0, limit);
  const result: PipelineResult = { analyzed: [], fresh: [] };

  for (const run of pending) {
    const kmh = kmhOf(run);
    const wasNew = run.analysis === null;
    let fit: FitActivity | null = null;
    try {
      const raw = await fetchFit(run.external_id);
      if (raw) fit = parseFit(await unzipFirstFit(raw));
    } catch (e) {
      opts.log?.(`run ${run.external_id}: fit failed: ${(e as Error).message}`);
    }
    const analysis = analyzeRun(run, fit, { easy_hr_cap: cap, treadmill_kmh: kmh });
    const others = runs
      .filter((o) => o.external_id !== run.external_id && o.started_at_local < run.started_at_local)
      .map((o) => ({ run: o, analysis: o.analysis, treadmill_kmh: kmhOf(o) }));
    analysis.comparable_runs = comparableRuns({ run, analysis, treadmill_kmh: kmh }, others);
    const stored: StoredAnalysis = { ...analysis, input_kmh: kmh, input_cap: cap };
    await store.saveAnalysis(userId, run.external_id, stored);
    run.analysis = stored; // spätere Läufe in dieser Runde vergleichen mit dem neuen Stand
    result.analyzed.push(run.external_id);
    if (wasNew) result.fresh.push({ run, analysis });
  }
  return result;
}
