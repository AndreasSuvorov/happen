// Wochenplan im Frontend.
// SPIEGELT supabase/functions/_shared/coach.ts (baseWeek + plannedTraining). Ändert sich dort die Vorlage,
// muss sie hier mitgezogen werden. Das Backend kennt nur diese eine Wochenvorlage (Grundlagen-Phase)
// und Verschiebungen über `deferral` in den Morgenbriefings der letzten 14 Tage.
import { addDays, type MorningBriefing, type TrainingType } from '../../lib/coach'

export interface PlannedTraining {
  type: TrainingType
  duration_min: number | null
  hr_cap: number | null
}

export type Deferral = NonNullable<MorningBriefing['deferral']>

/** Wochentag (0 = So) → Einheit. Fehlende Tage sind Ruhetage. Wie `baseWeek` in coach.ts. */
export const baseWeek: Record<number, TrainingType> = {
  0: 'long_run',
  1: 'strength',
  2: 'easy_run',
  4: 'easy_run',
  5: 'strength',
}

/** Dauer der Läufe in der Vorlage (wie plannedTraining in coach.ts). */
export const EASY_RUN_MIN = 40
export const LONG_RUN_MIN = 60
/** Standard für coach_settings.easy_hr_cap, falls keine Einstellung existiert. */
export const DEFAULT_HR_CAP = 145

export function weekday(date: string): number {
  return new Date(date + 'T12:00:00Z').getUTCDay()
}

/** Wie plannedTraining() in coach.ts: Verschiebung auf diesen Tag gewinnt, sonst die Vorlage. */
export function plannedTraining(date: string, cap: number, deferrals: Deferral[]): PlannedTraining {
  const postponed = deferrals.find(({ to }) => to === date)
  if (postponed) return postponed.training
  const type = baseWeek[weekday(date)] ?? 'rest'
  switch (type) {
    case 'long_run':
      return { type, duration_min: LONG_RUN_MIN, hr_cap: cap }
    case 'easy_run':
      return { type, duration_min: EASY_RUN_MIN, hr_cap: cap }
    default:
      return { type, duration_min: null, hr_cap: null }
  }
}

/** Nächster Tag nach `date` mit langem Lauf laut Vorlage (für Tipps wie „Am Sonntag …“). */
export function nextLongRun(date: string, cap: number, deferrals: Deferral[]): string | null {
  for (let i = 1; i <= 7; i++) {
    const d = addDays(date, i)
    if (plannedTraining(d, cap, deferrals).type === 'long_run') return d
  }
  return null
}

/** Kurzbeschreibung der Vorlage, aus denselben Zahlen abgeleitet. */
export function templateSummary(): string {
  const types = Object.values(baseWeek)
  const easy = types.filter((t) => t === 'easy_run').length
  const long = types.filter((t) => t === 'long_run').length
  const strength = types.filter((t) => t === 'strength').length
  const parts: string[] = []
  if (easy) parts.push(`${easy} lockere Läufe à ${EASY_RUN_MIN} Min.`)
  if (long) parts.push(`${long} langer Lauf (${LONG_RUN_MIN} Min.)`)
  if (strength) parts.push(`${strength}× Kraft`)
  return parts.join(', ')
}
