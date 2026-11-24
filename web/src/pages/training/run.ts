// Laufurteil für die Laufanalyse und den Wochenplan.
// Vorrang hat `wearable_activities.analysis` (Ergebnis von analyzeRun, Coach-Plan 6.3, Meilenstein 4).
// Solange das Backend das nicht liefert, leiten wir ein vorsichtiges Urteil aus den Zusammenfassungsfeldern ab
// und sagen nichts, was diese Felder nicht hergeben (kein „ab Minute X“, kein „Anstieg am Ende“ ohne Zeitreihe).
import { isRun, type WearableActivity } from '../../lib/coach'

/** Ein Punkt der Pulsreihe, wie ihn analyzeRun in `analysis.hr_series` liefern soll (z. B. alle 30 s). */
export interface HrPoint {
  /** Minute seit Start */
  t_min: number
  /** Puls in bpm */
  hr: number
  /** Tempo in Sekunden pro km (nur draußen mit GPS) */
  pace_s_per_km?: number | null
  /** Höhe in m (nur draußen), für das blasse Höhenprofil */
  elev_m?: number | null
}

export type Verdict = 'easy_ok' | 'easy_too_hard' | 'late_surge' | 'hard_session' | 'race_like' | 'unknown'

/** Erwartete Form von `analysis` (Coach-Plan 6.3 plus die Felder, die die Detailseite braucht). Alles optional. */
export interface RunAnalysisFull {
  verdict?: Verdict | string
  headline?: string
  explanation?: string
  tip?: string
  share_below_cap?: number
  share_above_cap_plus5?: number
  hr_first_half?: number | null
  hr_second_half?: number | null
  pace_first_half_s_per_km?: number | null
  pace_second_half_s_per_km?: number | null
  surge?: { detected: boolean; from_min: number | null; peak_hr: number | null }
  drift_pct?: number | null
  comparable_runs?: { id: string; date: string; delta_hr_at_same_pace?: number | null; text?: string }[]
  notes?: string[]
  sensor?: 'wrist' | 'chest'
  hr_series?: HrPoint[]
}

export function analysisOf(a: WearableActivity): RunAnalysisFull | null {
  return (a.analysis as RunAnalysisFull | null) ?? null
}

export function validSeries(a: RunAnalysisFull | null): HrPoint[] | null {
  const s = a?.hr_series
  if (!Array.isArray(s)) return null
  const pts = s.filter((p) => p && Number.isFinite(p.t_min) && Number.isFinite(p.hr))
  return pts.length >= 2 ? pts : null
}

/* ---------------------------------------------------------------------------
 * Formatierung
 * ------------------------------------------------------------------------- */
export const minutes = (s: number | null | undefined) => (s ? Math.round(s / 60) : 0)

export function km(m: number | null | undefined): string {
  return ((m ?? 0) / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** „6:42/km“ */
export function pace(sPerKm: number | null | undefined): string | null {
  if (!sPerKm || !Number.isFinite(sPerKm)) return null
  const s = Math.round(sPerKm)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}/km`
}

export function avgPace(a: WearableActivity): number | null {
  if (!a.duration_s || !a.distance_m || a.distance_m < 200) return null
  return a.duration_s / (a.distance_m / 1000)
}

/** „41 Min.“ oder „2:06 Std.“ */
export function duration(min: number): string {
  if (min < 60) return `${min} Min.`
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} Std.`
}

export const isTreadmill = (a: Pick<WearableActivity, 'type'>) => a.type === 'treadmill_running'
export const isStrength = (a: Pick<WearableActivity, 'type'>) => /strength/.test(a.type)

/** Garmin „Wie hat es sich angefühlt?“: 0..100 in Schritten von 25. */
const feelWord: Record<number, string> = { 0: 'sehr schwach', 25: 'schwach', 50: 'normal', 75: 'stark', 100: 'sehr stark' }

export function feelLine(a: WearableActivity): string {
  const parts: string[] = []
  if (a.feel !== null) {
    const step = Math.max(0, Math.min(100, Math.round(a.feel / 25) * 25))
    parts.push(`fühlte sich ${feelWord[step]} an`)
  }
  if (a.rpe !== null) parts.push(`Anstrengung ${Math.round(a.rpe / 10)} von 10`)
  return parts.length ? `Laut dir: ${parts.join(' · ')}` : 'Keine eigene Bewertung auf der Uhr.'
}

/* ---------------------------------------------------------------------------
 * Urteil
 * ------------------------------------------------------------------------- */
/** Trainingseffekt-Labels von Garmin, die klar „hart“ bedeuten. */
const HARD_TE = /TEMPO|THRESHOLD|VO2|ANAEROBIC|SPRINT/i
/** Toleranz für einzelne Spitzen (Steigung, Ampel), wie `share_above_cap_plus5` in 6.3. */
const SPIKE_TOLERANCE = 5

export interface RunJudgement {
  kind: Verdict
  /** true = Häkchen (gut), false = Warn-Symbol */
  ok: boolean
  headline: string
  sentence: string
  tip: string
  /** Anteil unter der Grenze (0..1), nur wenn aus analysis/Serie bekannt */
  shareBelow: number | null
}

/** Anteil der Zeit unter der Grenze aus der Pulsreihe (ohne die ersten 5 Minuten, wie in 6.3). */
export function shareBelowFromSeries(series: HrPoint[], cap: number): number | null {
  const pts = series.filter((p) => p.t_min >= 5)
  if (pts.length < 2) return null
  return pts.filter((p) => p.hr <= cap).length / pts.length
}

const pct = (share: number) => `${Math.round(share * 100)} %`

export function judgeRun(a: WearableActivity, cap: number, opts: { nextLongRunDay?: string | null } = {}): RunJudgement {
  const an = analysisOf(a)
  const series = validSeries(an)
  const shareBelow =
    typeof an?.share_below_cap === 'number' ? an.share_below_cap : series ? shareBelowFromSeries(series, cap) : null
  const keepCalm = opts.nextLongRunDay
    ? `Weiter so. Am ${opts.nextLongRunDay} beim langen Lauf genauso ruhig anfangen.`
    : 'Weiter so. Beim nächsten Lauf genauso ruhig anfangen.'
  const alarm = isTreadmill(a)
    ? 'Halte das Band bis zum Schluss bei deinem Starttempo. Steigern kannst du an einem anderen Tag.'
    : `Stell den Pulsalarm auf ${cap}. Und bergab nicht Gas geben.`

  // 1) Urteil aus dem Backend (analyzeRun)
  if (an?.verdict && an.verdict !== 'unknown') {
    const v = an.verdict as Verdict
    const halves =
      an.hr_first_half && an.hr_second_half
        ? `Erste Hälfte Ø ${an.hr_first_half}${pace(an.pace_first_half_s_per_km) ? ' bei ' + pace(an.pace_first_half_s_per_km) : ''}, zweite Hälfte Ø ${an.hr_second_half}${pace(an.pace_second_half_s_per_km) ? ' bei ' + pace(an.pace_second_half_s_per_km) : ''}.`
        : ''
    const defaults: Record<Verdict, { ok: boolean; headline: string; sentence: string; tip: string }> = {
      easy_ok: {
        ok: true,
        headline: 'Locker gelaufen',
        sentence: `${shareBelow !== null ? pct(shareBelow) + ` der Zeit unter ${cap}. ` : ''}Genau so war es gedacht.`,
        tip: keepCalm,
      },
      late_surge: {
        ok: false,
        headline: an.surge?.from_min != null ? `Ab Minute ${Math.round(an.surge.from_min)} zu schnell geworden` : 'Am Ende zu schnell geworden',
        sentence: halves || (an.surge?.peak_hr ? `Zum Schluss bis ${an.surge.peak_hr} Puls.` : ''),
        tip: alarm,
      },
      easy_too_hard: {
        ok: false,
        headline: 'Zu schnell für locker',
        sentence: `${shareBelow !== null ? 'Nur ' + pct(shareBelow) + ` der Zeit unter ${cap}.` : `Der Puls lag meist über ${cap}.`}`,
        tip: alarm,
      },
      hard_session: { ok: true, headline: 'Harte Einheit', sentence: halves, tip: 'Morgen locker bleiben oder pausieren.' },
      race_like: { ok: true, headline: 'Wie ein Wettkampf gelaufen', sentence: halves, tip: 'Gönn dir jetzt ein, zwei ruhige Tage.' },
      unknown: { ok: true, headline: '', sentence: '', tip: '' },
    }
    const d = defaults[v] ?? defaults.unknown
    return {
      kind: v,
      ok: d.ok,
      headline: an.headline || d.headline || 'Lauf',
      sentence: an.explanation || d.sentence,
      tip: an.tip || d.tip,
      shareBelow,
    }
  }

  // 2) Ohne analysis: nur aus Ø/Max-Puls, Trainingseffekt und (falls vorhanden) Pulsreihe
  if (a.avg_hr === null) {
    return {
      kind: 'unknown',
      ok: true,
      headline: 'Ohne Puls gelaufen',
      sentence: 'Die Uhr hat für diesen Lauf keinen Puls geliefert. Deshalb kann ich nicht sagen, ob er locker war.',
      tip: 'Trag die Uhr beim nächsten Lauf etwas enger, dann misst sie zuverlässiger.',
      shareBelow,
    }
  }
  const max = a.max_hr
  const hardLabel = a.te_label !== null && HARD_TE.test(a.te_label)
  if (shareBelow !== null && shareBelow >= 0.85) {
    return {
      kind: 'easy_ok',
      ok: true,
      headline: 'Locker gelaufen',
      sentence: `${pct(shareBelow)} der Zeit unter ${cap}. Genau so war es gedacht.`,
      tip: keepCalm,
      shareBelow,
    }
  }
  if (a.avg_hr <= cap && (max === null || max <= cap + SPIKE_TOLERANCE) && shareBelow === null) {
    return {
      kind: 'easy_ok',
      ok: true,
      headline: 'Locker gelaufen',
      sentence: `Ø Puls ${a.avg_hr}${max !== null ? `, höchstens ${max}` : ''}. Unter deiner Grenze von ${cap}, genau so war es gedacht.`,
      tip: keepCalm,
      shareBelow,
    }
  }
  if (a.avg_hr <= cap) {
    return {
      kind: 'easy_too_hard',
      ok: false,
      headline: 'Meist locker gelaufen',
      sentence:
        shareBelow !== null
          ? `${pct(shareBelow)} der Zeit unter ${cap}, zwischendurch bis ${max ?? '–'}.`
          : `Ø Puls ${a.avg_hr} unter ${cap}, aber zwischendurch bis ${max}. Wann genau, zeigt erst der Pulsverlauf.`,
      tip: isTreadmill(a) ? alarm : `Stell den Pulsalarm auf ${cap}. Dann merkst du sofort, wenn es zu schnell wird.`,
      shareBelow,
    }
  }
  if (hardLabel) {
    return {
      kind: 'hard_session',
      ok: false,
      headline: 'Harte Einheit',
      sentence: `Ø Puls ${a.avg_hr}, über deiner Grenze von ${cap}. Deine Uhr wertet den Lauf als ${teWord(a.te_label)}.`,
      tip: 'Morgen locker bleiben oder pausieren.',
      shareBelow,
    }
  }
  return {
    kind: 'easy_too_hard',
    ok: false,
    headline: 'Zu schnell für locker',
    sentence: `Ø Puls ${a.avg_hr}${max !== null ? `, höchstens ${max}` : ''}. Für einen lockeren Lauf liegt das über deiner Grenze von ${cap}.`,
    tip: alarm,
    shareBelow,
  }
}

/** Kurzform für Listen: war der Lauf wirklich locker? (null = unbekannt) */
export function wasEasy(a: WearableActivity, cap: number): boolean | null {
  if (!isRun(a.type)) return null
  const j = judgeRun(a, cap)
  if (j.kind === 'unknown') return null
  return j.kind === 'easy_ok'
}

export function wasLateSurge(a: WearableActivity): boolean {
  const an = analysisOf(a)
  return an?.verdict === 'late_surge' || an?.surge?.detected === true
}

function teWord(label: string | null): string {
  const l = (label ?? '').toUpperCase()
  if (l.includes('TEMPO')) return 'Tempo-Training'
  if (l.includes('THRESHOLD')) return 'Schwellen-Training'
  if (l.includes('VO2')) return 'VO2max-Training'
  if (l.includes('ANAEROBIC')) return 'anaerobes Training'
  if (l.includes('SPRINT')) return 'Sprint-Training'
  return 'harte Einheit'
}

/* ---------------------------------------------------------------------------
 * Vergleich (nur wenn belastbar: gleicher Typ, Distanz ±10 %, gleicher Sensor)
 * ------------------------------------------------------------------------- */
export function findComparable(
  run: WearableActivity,
  candidates: WearableActivity[],
  treadmillSpeed: (a: WearableActivity) => string | null,
): WearableActivity | null {
  const before = candidates
    .filter((c) => c.external_id !== run.external_id && c.started_at_local < run.started_at_local)
    .filter((c) => c.type === run.type && c.hr_sensor !== null && c.hr_sensor === run.hr_sensor && c.avg_hr !== null)
    .sort((x, y) => (x.started_at_local < y.started_at_local ? 1 : -1))
  if (run.avg_hr === null || run.hr_sensor === null) return null
  if (isTreadmill(run)) {
    // Laufband: Distanz ist geschätzt, deshalb nur bei gleicher Geschwindigkeitsangabe und ähnlicher Dauer
    const speed = treadmillSpeed(run)
    if (!speed) return null
    return (
      before.find(
        (c) => treadmillSpeed(c) === speed && c.duration_s && run.duration_s && Math.abs(c.duration_s / run.duration_s - 1) <= 0.1,
      ) ?? null
    )
  }
  if (!run.distance_m) return null
  return before.find((c) => c.distance_m && Math.abs(c.distance_m / run.distance_m! - 1) <= 0.1) ?? null
}

export function compareText(run: WearableActivity, other: WearableActivity, date: string, speed: string | null): string {
  const dHr = (run.avg_hr ?? 0) - (other.avg_hr ?? 0)
  const hrPart =
    Math.abs(dHr) <= 2
      ? `Ø Puls ${run.avg_hr}, damals ${other.avg_hr}: gleich gut.`
      : `Ø Puls ${run.avg_hr}, damals ${other.avg_hr}.`
  if (isTreadmill(run)) return `Gleiche Geschwindigkeit (${speed} km/h) wie am ${date}. ${hrPart}`
  const p1 = avgPace(run)
  const p2 = avgPace(other)
  let pacePart = ''
  if (p1 && p2) {
    const d = Math.round(p2 - p1)
    if (Math.abs(d) <= 3) pacePart = ' Gleiches Tempo.'
    else pacePart = ` ${Math.abs(d)} Sekunden pro km ${d > 0 ? 'schneller' : 'langsamer'}.`
  }
  return `Ähnliche Strecke wie am ${date} (${km(other.distance_m)} km). ${hrPart}${pacePart}`
}
