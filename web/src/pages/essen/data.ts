// Daten und Regeln für den Essen-Tab. Nur lesen; Schreiben läuft über die Edge Function `web-chat`.
import { supabase, type Entry, type Profile, type Weight } from '../../lib/supabase'
import {
  addDays,
  fetchActivities,
  fetchCoachSettings,
  fetchEntries,
  fetchMorningBriefing,
  fetchWeights,
  isRun,
  localDate,
  type TrainingType,
} from '../../lib/coach'
import { baseTdee, dailyBudget } from '../../lib/nutrition'
import { fmt, fmtRange } from '../../lib/format'

export interface EssenData {
  today: string
  entries: Entry[]
  yesterday: Entry[]
  weights: Weight[]
  /** Lauf-kcal heute (brutto), für das Tagesbudget. */
  runKcal: number
  ranToday: boolean
  plan: TrainingType | null
  target: { low: number; high: number } | null
}

/** Bruttoverbrauch beim Laufen wie im Backend (_shared/nutrition.ts runKcalGross): ca. 1 kcal pro kg und km. */
const runKcalGross = (kg: number, km: number) => Math.round(kg * km)

const entryDay = (e: Entry) => localDate(new Date(e.eaten_at))

export async function loadEssen(profile: Profile): Promise<EssenData> {
  const today = localDate()
  const yesterday = addDays(today, -1)
  const startOfToday = new Date(today + 'T00:00:00').toISOString()

  const [entries, weights, chatRuns, watchRuns, briefing, settings] = await Promise.all([
    fetchEntries(yesterday, today),
    fetchWeights(addDays(today, -90)).catch(() => [] as Weight[]),
    supabase
      .from('activities')
      .select('type,kcal_gross')
      .eq('status', 'active')
      .gte('started_at', startOfToday)
      .then((r) => (r.error ? [] : (r.data as { type: string; kcal_gross: number | null }[]))),
    fetchActivities(today, today).catch(() => []),
    fetchMorningBriefing(today).catch(() => null),
    fetchCoachSettings().catch(() => null),
  ])

  const lastKg = weights.length ? Number(weights[weights.length - 1].kg) : null

  // Läufe aus dem Chat haben kcal_gross, Läufe von der Uhr nur Distanz. Beide können denselben Lauf meinen,
  // deshalb die größere Summe statt beider zusammen.
  const chatKcal = chatRuns.reduce((s, a) => s + (a.kcal_gross ?? 0), 0)
  const watch = watchRuns.filter((a) => isRun(a.type))
  const watchKcal = lastKg ? watch.reduce((s, a) => s + runKcalGross(lastKg, Number(a.distance_m ?? 0) / 1000), 0) : 0
  const runKcal = Math.max(chatKcal, watchKcal)
  const ranToday = watch.length > 0 || chatRuns.some((a) => a.type === 'run')

  let target: EssenData['target'] = null
  if (settings?.kcal_target_low && settings.kcal_target_high) {
    target = { low: settings.kcal_target_low, high: settings.kcal_target_high }
  } else if (lastKg) {
    const goal = Number(profile.goal_kg_per_week)
    const tdee = baseTdee(
      { heightCm: profile.height_cm, birthYear: profile.birth_year, sex: profile.sex, goalKgPerWeek: goal },
      lastKg,
    )
    if (tdee) {
      // Das Budget ist selbst eine Schätzung, deshalb als Spanne von etwa ±7 %.
      const budget = dailyBudget(tdee, goal, runKcal)
      target = { low: round10(budget * 0.93), high: round10(budget * 1.07) }
    }
  }

  return {
    today,
    entries: entries.filter((e) => entryDay(e) === today),
    yesterday: entries.filter((e) => entryDay(e) === yesterday),
    weights,
    runKcal,
    ranToday,
    plan: briefing?.payload?.today?.type ?? null,
    target,
  }
}

const round10 = (n: number) => Math.round(n / 10) * 10

export function totals(entries: Entry[]) {
  return entries.reduce(
    (acc, e) => ({
      low: acc.low + e.kcal_low,
      mid: acc.mid + e.kcal_mid,
      high: acc.high + e.kcal_high,
      protein: acc.protein + (e.protein_g ?? 0),
    }),
    { low: 0, mid: 0, high: 0, protein: 0 },
  )
}

export type DayKind = 'Lauftag' | 'Krafttag' | 'Ruhetag' | null

export function dayKind(d: Pick<EssenData, 'ranToday' | 'plan'>): DayKind {
  if (d.ranToday || d.plan === 'easy_run' || d.plan === 'long_run') return 'Lauftag'
  if (d.plan === 'strength') return 'Krafttag'
  if (d.plan === 'rest') return 'Ruhetag'
  return null
}

/** Eiweißziel: 1,2 g pro kg letztes Gewicht. */
export function proteinGoal(weights: Weight[]): number | null {
  if (!weights.length) return null
  return Math.round(Number(weights[weights.length - 1].kg) * 1.2)
}

/** Ein kurzer Satz zur Lage, nach festen Regeln. */
export function contextLine(opts: {
  sum: ReturnType<typeof totals>
  count: number
  target: EssenData['target']
  kind: DayKind
  proteinGoal: number | null
  hour: number
}): string {
  const { sum, count, target, kind, hour } = opts
  if (!target) {
    return 'Für ein Tagesziel fehlen noch Größe, Geburtsjahr und Geschlecht in den Einstellungen und ein Gewicht.'
  }
  const mid = (target.low + target.high) / 2
  if (count === 0) {
    if (hour < 11) return 'Noch nichts erfasst. Ein Foto vom Frühstück reicht, den Rest schätze ich.'
    return kind === 'Lauftag'
      ? 'Lauftag und noch nichts erfasst. Iss bald etwas Richtiges, sonst kommt abends der Heißhunger.'
      : 'Noch nichts erfasst. Ein Foto oder ein Satz reicht, den Rest schätze ich.'
  }
  if (sum.low > target.high) {
    return 'Heute schon über dem Ziel. Kein Drama: ein leichtes Abendessen mit viel Eiweiß reicht.'
  }
  if (sum.high >= target.low) {
    return 'Du bist im Zielbereich. Wenn noch Hunger kommt, lieber Eiweiß als Süßes.'
  }
  if (kind === 'Lauftag' && hour < 15 && sum.mid < mid * 0.35) {
    return 'Lauftag und bisher wenig gegessen. Plane ein sättigendes Mittagessen ein, sonst kommt abends der Heißhunger.'
  }
  if (hour >= 14 && opts.proteinGoal && sum.protein < opts.proteinGoal * 0.5) {
    return 'Eiweiß ist noch knapp. Nimm zum nächsten Essen Quark, Skyr, Eier oder Fleisch dazu.'
  }
  if (hour >= 19 && sum.high < target.low * 0.7) {
    return 'Heute deutlich unter dem Ziel. Ein richtiges Abendessen hilft, morgen wieder fit zu sein.'
  }
  return `Läuft nach Plan. Bis zum Ziel ist noch Platz für etwa ${fmtRange(
    Math.max(0, target.low - sum.high),
    Math.max(0, target.high - sum.low),
  )} kcal.`
}

/** Fehlende Hauptmahlzeiten als leere Plätze. Nach 15 Uhr gilt das Mittagessen als ausgelassen. */
export function emptySlots(entries: Entry[], hour: number) {
  const meals = new Set(entries.map((e) => e.meal))
  const slots: { label: string; aria: string }[] = []
  if (!meals.has('lunch') && !meals.has('dinner') && hour < 15)
    slots.push({ label: 'Mittag', aria: 'Mittagessen erfassen' })
  if (!meals.has('dinner') && hour < 23) slots.push({ label: 'Abend', aria: 'Abendessen erfassen' })
  return slots
}

/** Gewicht: letzter Wert, 7-Tage-Mittel und Differenz zum Mittel der Vorwoche. */
export function weightSummary(weights: Weight[], today: string) {
  if (!weights.length) return null
  const last = weights[weights.length - 1]
  const mean = (from: string, to: string) => {
    const v = weights.filter((w) => w.measured_on >= from && w.measured_on <= to).map((w) => Number(w.kg))
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
  }
  const week = mean(addDays(today, -6), today)
  const prev = mean(addDays(today, -13), addDays(today, -7))
  return {
    kg: Number(last.kg),
    date: last.measured_on,
    week,
    diff: week !== null && prev !== null ? week - prev : null,
  }
}

export const kg1 = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

export function signedKg(n: number): string {
  const r = Math.round(n * 10) / 10
  if (r === 0) return '±0,0'
  return (r > 0 ? '+' : '−') + kg1(Math.abs(r))
}

/** „Nochmal das Gleiche?“: häufigste Titel der letzten 14 Tage, mit der Spanne des letzten Eintrags. */
export async function loadRecent(): Promise<{ title: string; kcal: string }[]> {
  const today = localDate()
  const entries = await fetchEntries(addDays(today, -13), today)
  const byTitle = new Map<string, { title: string; n: number; last: Entry }>()
  for (const e of entries) {
    const key = e.title.trim().toLowerCase()
    if (!key) continue
    const cur = byTitle.get(key)
    if (cur) {
      cur.n++
      if (e.eaten_at > cur.last.eaten_at) cur.last = e
    } else byTitle.set(key, { title: e.title.trim(), n: 1, last: e })
  }
  return [...byTitle.values()]
    .sort((a, b) => b.n - a.n || b.last.eaten_at.localeCompare(a.last.eaten_at))
    .slice(0, 6)
    .map((r) => ({ title: r.title, kcal: fmtRange(r.last.kcal_low, r.last.kcal_high) }))
}

export const protein = (g: number) => `${fmt(Math.round(g))} g Eiweiß`
