// Persönliche Muster (Coach-Plan 6.5), im Frontend berechnet. Reine Funktionen.
// Pro Stichwort: Abendpuls am Tag der Notiz und HRV der folgenden Nacht gegen den Median der Tage ohne Notiz.
// Unter 3 Notizen (bzw. 3 Messwerten) wird nichts behauptet.
import { addDays, type ContextNote, type DailyMetrics } from '../../lib/coach'
import { isPatternTag, mean, median, minutesAfterNoon, nums, signed, tagKey } from './werte'

export const MIN_N = 3

export interface Stat {
  /** Unterschied zum Median der Vergleichstage (null = zu wenige Werte) */
  diff: number | null
  label: string
  n: number
}

export interface Pattern {
  key: string
  tag: string
  n: number
  enough: boolean
  stats: Stat[]
  text: string
}

function compare(tagValues: number[], baseValues: number[], label: string): Stat {
  if (tagValues.length < MIN_N || baseValues.length < MIN_N) return { diff: null, label, n: tagValues.length }
  return { diff: mean(tagValues)! - median(baseValues)!, label, n: tagValues.length }
}

export const statValue = (s: Stat) => (s.diff == null ? '–' : signed(s.diff))

const sig = (s: Stat, min = 5) => s.diff != null && Math.abs(s.diff) >= min

function tagText(evening: Stat, hrv: Stat): string {
  if (evening.diff == null && hrv.diff == null) return 'Dazu fehlen mir noch Messwerte von der Uhr. Ab 3 Abenden mit Werten sage ich mehr.'
  const parts: string[] = []
  if (sig(evening)) parts.push(`dein Puls ist an diesen Abenden ${evening.diff! > 0 ? 'höher' : 'niedriger'}`)
  if (sig(hrv)) parts.push(`die HRV in der Nacht danach ${hrv.diff! > 0 ? 'höher' : 'niedriger'}`)
  if (!parts.length) return 'Bisher kaum ein Unterschied zu Abenden ohne Notiz.'
  const s = parts.join(', ')
  return s[0].toUpperCase() + s.slice(1) + '.'
}

/** Notizen nach Stichwort gruppieren (Groß/Klein egal, ein Eintrag pro Tag). */
export function groupNotes(notes: ContextNote[]): Map<string, { tag: string; dates: Set<string> }> {
  const out = new Map<string, { tag: string; dates: Set<string> }>()
  for (const n of notes) {
    if (!isPatternTag(n.tag)) continue
    const key = tagKey(n.tag)
    const g = out.get(key) ?? { tag: n.tag.trim(), dates: new Set<string>() }
    g.dates.add(n.date)
    out.set(key, g)
  }
  return out
}

/** Tage mit irgendeiner Abend-Notiz. */
export const noteDays = (notes: ContextNote[]) => new Set(notes.filter((n) => isPatternTag(n.tag) || (!n.tag && n.text)).map((n) => n.date))

export function tagPatterns(days: DailyMetrics[], notes: ContextNote[]): Pattern[] {
  const byDate = new Map(days.map((d) => [d.date, d]))
  const anyNote = noteDays(notes)
  const plain = days.filter((d) => !anyNote.has(d.date))
  const baseEvening = nums(plain.map((d) => d.evening_hr_avg))
  const baseHrv = nums(plain.map((d) => byDate.get(addDays(d.date, 1))?.hrv_last_night))

  const out: Pattern[] = []
  for (const [key, g] of groupNotes(notes)) {
    const dates = [...g.dates]
    const n = dates.length
    if (n < MIN_N) {
      out.push({
        key,
        tag: g.tag,
        n,
        enough: false,
        stats: [],
        text: `Mit ${n === 1 ? '1 Abend' : `${n} Abenden`} kann ich noch nichts sagen. Ab 3 zeige ich dir mehr.`,
      })
      continue
    }
    const evening = compare(nums(dates.map((d) => byDate.get(d)?.evening_hr_avg)), baseEvening, 'Puls am Abend')
    const hrv = compare(nums(dates.map((d) => byDate.get(addDays(d, 1))?.hrv_last_night)), baseHrv, 'HRV in der Nacht danach')
    out.push({ key, tag: g.tag, n, enough: true, stats: [evening, hrv], text: tagText(evening, hrv) })
  }
  return out
}

/** „22:30“ → Minuten nach 12 Uhr. */
export function bedtimeMinutes(target: string | null | undefined): number {
  return minutesAfterNoon(target && /^\d\d:\d\d/.test(target) ? target.slice(0, 5) : '22:30') ?? 630
}

/** Muster „Vor 22:30 im Bett“: HRV und Sleep Score der Nacht gegen Nächte mit späterem Einschlafen. */
export function bedtimePattern(days: DailyMetrics[], target: string | null | undefined): Pattern | null {
  const limit = bedtimeMinutes(target)
  const label = `Vor ${(target && /^\d\d:\d\d/.test(target) ? target.slice(0, 5) : '22:30')} im Bett`
  const withStart = days
    .filter((d) => d.sleep_start_local && !d.sleep_uncertain)
    .map((d) => ({ d, early: (minutesAfterNoon(d.sleep_start_local!) ?? 9999) < limit }))
  if (!withStart.length) return null
  const early = withStart.filter((x) => x.early).map((x) => x.d)
  const late = withStart.filter((x) => !x.early).map((x) => x.d)
  const n = early.length
  if (n < MIN_N) {
    return {
      key: '__bedtime',
      tag: label,
      n,
      enough: false,
      stats: [],
      text: `Mit ${n === 1 ? '1 Nacht' : `${n} Nächten`} kann ich noch nichts sagen. Ab 3 zeige ich dir mehr.`,
    }
  }
  const hrv = compare(nums(early.map((d) => d.hrv_last_night)), nums(late.map((d) => d.hrv_last_night)), 'HRV in der Nacht')
  const score = compare(nums(early.map((d) => d.sleep_score)), nums(late.map((d) => d.sleep_score)), 'Sleep Score')

  // Aktuelle Serie: wie viele der letzten Nächte in Folge vor der Zielzeit?
  let streak = 0
  for (let i = withStart.length - 1; i >= 0 && withStart[i].early; i--) streak++

  const parts: string[] = []
  if (hrv.diff == null && score.diff == null) parts.push('Zum Vergleich fehlen mir noch Nächte mit späterem Einschlafen.')
  else if (sig(hrv) || sig(score)) parts.push(hrv.diff != null && hrv.diff > 0 ? 'Deine HRV liegt in diesen Nächten höher.' : 'Diese Nächte unterscheiden sich deutlich von den späteren.')
  else parts.push('Bisher kaum ein Unterschied zu späteren Nächten.')
  if (streak >= 2) parts.push(`${streak} Nächte in Folge hast du es gerade geschafft.`)
  return { key: '__bedtime', tag: label, n, enough: true, stats: [hrv, score], text: parts.join(' ') }
}

/** Alle Muster: genügend Daten zuerst (nach n), dann die Hinweise. */
export function allPatterns(days: DailyMetrics[], notes: ContextNote[], bedtime: string | null | undefined): Pattern[] {
  const list = tagPatterns(days, notes)
  const bed = bedtimePattern(days, bedtime)
  if (bed) list.push(bed)
  return list.sort((a, b) => Number(b.enough) - Number(a.enough) || (a.key === '__bedtime' ? -1 : b.key === '__bedtime' ? 1 : 0) || b.n - a.n)
}
