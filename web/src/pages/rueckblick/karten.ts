// Werte für die 5 Karten des Wochenrückblicks (letzte abgeschlossene Woche Mo–So). Reine Funktionen.
import type { Entry, Weight } from '../../lib/supabase'
import {
  addDays,
  isRun,
  shortWeekday,
  type CoachSettings,
  type ContextNote,
  type DailyMetrics,
  type WearableActivity,
} from '../../lib/coach'
import { fmt } from '../../lib/format'
import {
  activityDay,
  countWord,
  dateRange,
  hardMinutes,
  hours,
  isEasyRun,
  isPatternTag,
  kcalByDay,
  mean,
  median,
  minutes,
  nums,
  tagKey,
} from '../verlauf/werte'
import { noteDays } from '../verlauf/muster'

export interface WeekInput {
  from: string // Montag
  metrics: DailyMetrics[] // ab from − 28 bis from + 7
  activities: WearableActivity[] // Woche
  entries: Entry[] // Woche
  weights: Weight[] // ab from − 7
  notes: ContextNote[] // 90 Tage bis heute
  settings: CoachSettings | null
}

export interface CardText {
  kicker: string
  head: string
  sub: string
}

const weekdayLong = (date: string) =>
  new Intl.DateTimeFormat('de-DE', { weekday: 'long', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'))

const km = (m: number) => fmt(m / 1000, 1)
const round50 = (n: number) => Math.round(n / 50) * 50
const times = (n: number) => (n === 1 ? 'Einmal' : n === 2 ? 'Zweimal' : n === 3 ? 'Dreimal' : `${n}-mal`)

/* 1 Training ---------------------------------------------------------------- */
export interface RunRow {
  id: string
  title: string
  detail: string
  ok: boolean
}

export function trainingCard(w: WeekInput): CardText & { runs: RunRow[]; more: number } {
  const cap = w.settings?.easy_hr_cap ?? 145
  const runs = w.activities.filter((a) => isRun(a.type))
  const kicker = 'Training'
  if (!runs.length) {
    const other = w.activities.length
    return {
      kicker,
      head: 'Keine Läufe.',
      sub: other
        ? `Von deiner Uhr kamen ${other === 1 ? 'eine andere Einheit' : `${other} andere Einheiten`}, aber kein Lauf. Ruhige Wochen gehören dazu.`
        : 'Diese Woche ist kein Training von deiner Uhr angekommen.',
      runs: [],
      more: 0,
    }
  }
  const dist = runs.reduce((s, a) => s + (a.distance_m ?? 0), 0)
  const withHr = runs.filter((a) => a.analysis?.verdict || a.hr_zone_s || a.avg_hr != null)
  const easy = runs.filter((a) => isEasyRun(a, cap)).length
  const surges = runs.filter((a) => a.analysis?.verdict === 'late_surge').length
  const longest = Math.max(...runs.map((a) => a.duration_s ?? 0))

  let sub: string
  if (!withHr.length) sub = 'Ohne Pulsdaten kann ich nicht sagen, wie locker sie waren.'
  else if (easy === runs.length) sub = runs.length === 1 ? 'Er war wirklich locker.' : 'Alle wirklich locker.'
  else if (easy === 0) sub = runs.length === 1 ? 'Er war nicht wirklich locker.' : 'Keiner davon wirklich locker.'
  else sub = `${easy === 1 ? 'Einer' : easy} davon wirklich locker.`
  if (surges) sub += ` ${times(surges)} bist du am Ende schneller geworden.`

  const rows: RunRow[] = runs.map((a) => {
    const min = minutes(a)
    const ok = isEasyRun(a, cap)
    const label =
      a.type === 'treadmill_running' ? 'Laufband' : (a.duration_s ?? 0) === longest && min >= 60 && runs.length > 1 ? 'lang' : ok ? 'locker' : ''
    const surge = a.analysis?.surge as { detected?: boolean; from_min?: number } | undefined
    const share = typeof a.analysis?.share_below_cap === 'number' ? (a.analysis.share_below_cap as number) : null
    const parts: string[] = []
    if (a.distance_m) parts.push(`${km(a.distance_m)} km`)
    if (surge?.detected && surge.from_min != null) {
      parts.push(`Ab Minute ${surge.from_min} zu schnell geworden`)
    } else if (share != null) {
      parts.push(`${Math.round(share * 100)} % unter ${cap}`)
    } else if (a.hr_zone_s && a.duration_s) {
      const hard = hardMinutes(a, cap) / (a.duration_s / 60)
      parts.push(`${Math.round((1 - hard) * 100)} % unter Zone 4`)
    } else if (a.avg_hr != null) {
      parts.push(`Ø Puls ${a.avg_hr}`)
    }
    return {
      id: a.external_id,
      title: `${shortWeekday(activityDay(a))} · ${min} Min.${label ? ' ' + label : ''}`,
      detail: parts.join(' · ') || 'Keine Pulsdaten',
      ok,
    }
  })
  return {
    kicker,
    head: `${runs.length} ${runs.length === 1 ? 'Lauf' : 'Läufe'}, ${km(dist)} km.`,
    sub,
    runs: rows.slice(0, 4),
    more: Math.max(0, rows.length - 4),
  }
}

/* 2 Schlaf ------------------------------------------------------------------- */
export interface Night {
  date: string
  day: string
  hours: number | null
  best: boolean
}

export function sleepCard(w: WeekInput): CardText & { nights: Night[]; avg: number | null } {
  const days = dateRange(w.from, addDays(w.from, 6))
  const byDate = new Map(w.metrics.map((m) => [m.date, m]))
  const vals = days.map((d) => {
    const m = byDate.get(d)
    return { date: d, min: m?.sleep_minutes && !m.sleep_uncertain ? m.sleep_minutes : null }
  })
  const have = vals.filter((v) => v.min != null)
  const kicker = 'Schlaf'
  if (have.length < 3) {
    return {
      kicker,
      head: have.length ? 'Zu wenig Nächte.' : 'Keine Schlafdaten.',
      sub: have.length
        ? `Nur ${have.length === 1 ? 'eine Nacht ist' : `${have.length} Nächte sind`} von deiner Uhr angekommen. Ab 3 Nächten zeige ich dir den Schnitt.`
        : 'Diese Woche ist keine Nacht von deiner Uhr angekommen.',
      nights: [],
      avg: null,
    }
  }
  const avgMin = mean(have.map((v) => v.min!))!
  const best = have.reduce((a, b) => (b.min! > a.min! ? b : a))
  const eveNotes = w.notes.filter((n) => n.date === addDays(best.date, -1) && n.tag && isPatternTag(n.tag))
  let sub = `Deine beste Nacht: ${weekdayLong(best.date)}, ${hours(best.min!).replace(' h', ' Stunden')}.`
  if (eveNotes.length) sub += ` Am Abend davor hast du „${eveNotes.map((n) => n.tag).join('“, „')}“ notiert.`
  return {
    kicker,
    head: `Ø ${hours(avgMin).replace(' h', ' Stunden')}.`,
    sub,
    avg: avgMin / 60,
    nights: vals.map((v) => ({ date: v.date, day: shortWeekday(v.date), hours: v.min != null ? v.min / 60 : null, best: v.date === best.date })),
  }
}

/* 3 Essen und Gewicht -------------------------------------------------------- */
export interface FoodBar {
  low: number
  high: number
  burn: number | null
  max: number
  weightDiff: number | null
}

export function foodCard(w: WeekInput): CardText & { bar: FoodBar | null } {
  const kicker = 'Essen und Gewicht'
  const end = addDays(w.from, 6)
  const perDay = [...kcalByDay(w.entries)].filter(([d]) => d >= w.from && d <= end).map(([, v]) => v)
  const burns = nums(w.metrics.filter((m) => m.date >= w.from && m.date <= end).map((m) => m.kcal_total))
  const burn = burns.length >= 3 ? mean(burns) : null
  const thisW = nums(w.weights.filter((x) => x.measured_on >= w.from && x.measured_on <= end).map((x) => Number(x.kg)))
  const prevW = nums(w.weights.filter((x) => x.measured_on >= addDays(w.from, -7) && x.measured_on < w.from).map((x) => Number(x.kg)))
  const weightDiff = thisW.length && prevW.length ? mean(thisW)! - mean(prevW)! : null

  const weightText =
    weightDiff == null
      ? 'Für das Gewicht fehlen mir Wiegungen aus dieser und der Woche davor.'
      : Math.abs(weightDiff) < 0.1
        ? 'Dein Gewicht ist im Mittel gleich geblieben.'
        : `Dein Gewicht ist im Mittel um ${fmt(Math.abs(weightDiff), 1)} kg ${weightDiff < 0 ? 'gesunken' : 'gestiegen'}.`

  if (!perDay.length) {
    return { kicker, head: 'Kein Essen erfasst.', sub: `Diese Woche hast du keine Mahlzeit eingetragen. ${weightText}`, bar: null }
  }
  const mid = mean(perDay.map((d) => d.mid))!
  const low = mean(perDay.map((d) => d.low))!
  const high = mean(perDay.map((d) => d.high))!
  const parts: string[] = []
  parts.push(burn != null ? `Bei etwa ${fmt(round50(burn))} Verbrauch.` : 'Deinen Verbrauch kenne ich diese Woche nicht.')
  parts.push(weightText)
  if (perDay.length < 5) {
    parts.push(`Erfasst hast du an ${perDay.length} von 7 Tagen, deshalb ist der Schnitt unsicher.`)
  } else if (burn != null && weightDiff != null) {
    const balance = burn - mid
    const expected = balance > 300 ? -1 : balance < -300 ? 1 : 0
    const actual = weightDiff < -0.1 ? -1 : weightDiff > 0.1 ? 1 : 0
    parts.push(
      expected === actual
        ? 'Das passt zusammen.'
        : 'Das passt nicht ganz zusammen. Wasser und nicht erfasste Kleinigkeiten machen da oft den Unterschied.',
    )
  }
  const max = Math.ceil((Math.max(high, burn ?? 0) * 1.3) / 500) * 500
  return {
    kicker,
    head: `Ø ${fmt(round50(mid))} kcal.`,
    sub: parts.join(' '),
    bar: { low: round50(low), high: round50(high), burn: burn != null ? round50(burn) : null, max, weightDiff },
  }
}

/* 4 Muster der Woche --------------------------------------------------------- */
export interface NightAfter {
  label: string
  value: number | null
  weaker: boolean
  base: boolean
}

export function patternCard(w: WeekInput): CardText & { rows: NightAfter[]; total: number; tag: string | null } {
  const kicker = 'Muster der Woche'
  const end = addDays(w.from, 6)
  const weekNotes = w.notes.filter((n) => n.date >= w.from && n.date <= end && isPatternTag(n.tag))
  if (!weekNotes.length) {
    return {
      kicker,
      head: 'Keine Notizen.',
      sub: 'Diese Woche hast du keinen Abend notiert. Wenn ich morgens nachfrage, reicht ein Tippen.',
      rows: [],
      total: 0,
      tag: null,
    }
  }
  const groups = new Map<string, { tag: string; dates: Set<string> }>()
  for (const n of weekNotes) {
    const g = groups.get(tagKey(n.tag!)) ?? { tag: n.tag!.trim(), dates: new Set<string>() }
    g.dates.add(n.date)
    groups.set(tagKey(n.tag!), g)
  }
  const sorted = [...groups.values()].sort((a, b) => b.dates.size - a.dates.size)
  const main = sorted[0]
  const dates = [...main.dates].sort()
  const n = dates.length
  const byDate = new Map(w.metrics.map((m) => [m.date, m]))

  // „Sonst“: Median der HRV nach Abenden ohne Notiz, in den 28 Tagen vor der Woche und in der Woche.
  const noted = noteDays(w.notes)
  const base = median(
    nums(
      dateRange(addDays(w.from, -28), end)
        .filter((d) => !noted.has(d))
        .map((d) => byDate.get(addDays(d, 1))?.hrv_last_night),
    ),
  )
  const rows: NightAfter[] = dates.map((d) => {
    const v = byDate.get(addDays(d, 1))?.hrv_last_night ?? null
    return { label: `Nach ${shortWeekday(d)}`, value: v, weaker: v != null && base != null && v < base, base: false }
  })
  rows.push({ label: 'Sonst', value: base != null ? Math.round(base) : null, weaker: false, base: true })

  const single = !/\s/.test(main.tag)
  const head = single
    ? `${countWord(n)} ${main.tag}-${n === 1 ? 'Abend' : 'Abende'}.`
    : `${countWord(n)} ${n === 1 ? 'Abend' : 'Abende'} mit „${main.tag}“.`
  const measured = rows.filter((r) => !r.base && r.value != null)
  const weaker = measured.filter((r) => r.weaker).length
  let sub: string
  if (base == null || !measured.length) sub = 'Für die Nächte danach fehlen mir noch HRV-Werte zum Vergleich.'
  else if (weaker === measured.length)
    sub = measured.length === 1 ? 'Mit schwächerer Nacht danach.' : measured.length === 2 ? 'Beide mit schwächerer Nacht danach.' : 'Alle mit schwächerer Nacht danach.'
  else if (weaker === 0) sub = 'Die Nächte danach waren nicht schwächer als sonst.'
  else sub = `${weaker} von ${measured.length} mit schwächerer Nacht danach.`
  if (sorted.length > 1) sub += ` Außerdem notiert: ${sorted.slice(1).map((g) => g.tag).join(', ')}.`

  const total = new Set(w.notes.filter((x) => x.tag && tagKey(x.tag) === tagKey(main.tag)).map((x) => x.date)).size
  return { kicker, head, sub, rows, total, tag: main.tag }
}

/* 5 Nächste Woche ------------------------------------------------------------ */
// Wochenvorlage wie supabase/functions/_shared/coach.ts (baseWeek): So lang 60, Mo/Fr Kraft, Di/Do locker 40.
export function planRows(settings: CoachSettings | null) {
  const cap = settings?.easy_hr_cap ?? 145
  return [
    { days: 'Mo, Fr', what: 'Kraft' },
    { days: 'Di, Do', what: `40 Min. locker, Puls unter ${cap}` },
    { days: 'So', what: 'Langer Lauf, 60 Min.' },
  ]
}

export const ANSWERS = ['Ja', 'Weniger Zeit', 'Mehr Zeit'] as const
export type Answer = (typeof ANSWERS)[number]

export const answerText: Record<Answer, string> = {
  Ja: 'Super. Der Plan steht, bis Sonntag.',
  'Weniger Zeit': 'Notiert: weniger Zeit. Sag mir im Chat, welcher Tag wegfallen soll.',
  'Mehr Zeit': 'Notiert: mehr Zeit. Sag mir im Chat, an welchem Tag du noch laufen kannst.',
}

export const planCard: CardText = {
  kicker: 'Nächste Woche',
  head: 'Passt das?',
  sub: 'Deine Wochenvorlage: 3 Läufe, 2× Kraft. Sieht ein Morgen nicht gut aus, verschiebe ich den Lauf.',
}

