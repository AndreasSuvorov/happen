// Reine Hilfsfunktionen für Verlauf und Wochenrückblick (keine Abfragen, kein React).
import type { Entry } from '../../lib/supabase'
import { addDays, isRun, localDate, type WearableActivity } from '../../lib/coach'

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

export const nums = (xs: (number | null | undefined)[]): number[] =>
  xs.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

/** Alle Tage von `from` bis `to` (inklusive). */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

/** Lokaler Tag einer Mahlzeit (eaten_at ist ein Zeitstempel mit Zone). */
export const entryDay = (e: Pick<Entry, 'eaten_at'>) => localDate(new Date(e.eaten_at))

export interface DayKcal {
  low: number
  mid: number
  high: number
  count: number
}

/** Summe der Schätzungen pro Tag. Tage ohne Eintrag fehlen. */
export function kcalByDay(entries: Entry[]): Map<string, DayKcal> {
  const out = new Map<string, DayKcal>()
  for (const e of entries) {
    const day = entryDay(e)
    const cur = out.get(day) ?? { low: 0, mid: 0, high: 0, count: 0 }
    cur.low += Number(e.kcal_low) || 0
    cur.mid += Number(e.kcal_mid) || 0
    cur.high += Number(e.kcal_high) || 0
    cur.count += 1
    out.set(day, cur)
  }
  return out
}

/** Tag einer Aktivität (started_at_local ist lokale Zeit ohne Zone). */
export const activityDay = (a: Pick<WearableActivity, 'started_at_local'>) => a.started_at_local.slice(0, 10)

export const minutes = (a: Pick<WearableActivity, 'duration_s'>) => Math.round((a.duration_s ?? 0) / 60)

export type ActivityKind = 'run' | 'strength' | 'bike' | 'walk' | 'other'

export function activityKind(type: string): ActivityKind {
  if (isRun(type)) return 'run'
  if (/strength/.test(type)) return 'strength'
  if (/cycling|bike/.test(type)) return 'bike'
  if (/walk|hiking/.test(type)) return 'walk'
  return 'other'
}

/**
 * Harte Minuten eines Laufs: Anteil Zone 4–5 aus hr_zone_s, sonst alles hart,
 * wenn der Durchschnittspuls über der Locker-Grenze liegt.
 */
export function hardMinutes(a: WearableActivity, easyCap: number): number {
  const total = (a.duration_s ?? 0) / 60
  const zones = a.hr_zone_s
  if (zones && zones.length >= 5) {
    const sum = zones.reduce((s, z) => s + (z || 0), 0)
    if (sum > 0) return (total * ((zones[3] || 0) + (zones[4] || 0))) / sum
  }
  if (a.avg_hr != null && a.avg_hr > easyCap) return total
  return 0
}

/** Locker gelaufen? Laufurteil aus dem Backend, wenn vorhanden, sonst höchstens 15 % hart. */
export function isEasyRun(a: WearableActivity, easyCap: number): boolean {
  const verdict = a.analysis?.verdict
  if (verdict) return verdict === 'easy_ok' || verdict === 'easy'
  const total = (a.duration_s ?? 0) / 60
  if (!total) return false
  if (!a.hr_zone_s && a.avg_hr == null) return false
  return hardMinutes(a, easyCap) / total <= 0.15
}

/** „7,2 h“ */
export const hours = (min: number) => `${(Math.round(min / 6) / 10).toLocaleString('de-DE')} h`

/** Abendstunde aus einem lokalen Zeitstempel als Minuten nach 12 Uhr mittags (Mitternacht = 720). */
export function minutesAfterNoon(ts: string): number | null {
  const m = /T?(\d\d):(\d\d)/.exec(ts.length > 8 ? ts.slice(11) : ts)
  if (!m) return null
  const min = Number(m[1]) * 60 + Number(m[2])
  return (min - 720 + 1440) % 1440
}

/** Tags, die keine Abend-Ereignisse sind. */
const IGNORED_TAGS = new Set(['nichts besonderes', 'andere…', 'andere...', 'andere', 'wochenplan_feedback'])
export const isPatternTag = (tag: string | null | undefined): tag is string =>
  !!tag && !!tag.trim() && !IGNORED_TAGS.has(tag.trim().toLowerCase())
export const tagKey = (tag: string) => tag.trim().toLowerCase()

/** Vorzeichen-Zahl mit echtem Minus: „+19“, „−14“, „±0“. */
export function signed(n: number, digits = 0): string {
  const r = Number(n.toFixed(digits))
  if (r === 0) return '±0'
  const s = Math.abs(r).toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: digits })
  return (r > 0 ? '+' : '−') + s
}

const wordNums = ['Kein', 'Ein', 'Zwei', 'Drei', 'Vier', 'Fünf', 'Sechs', 'Sieben']
export const countWord = (n: number) => wordNums[n] ?? String(n)
