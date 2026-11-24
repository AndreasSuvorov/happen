import { addDays } from '../../../supabase/functions/_shared/garmin/transform.ts'
import { daysUntilBaseline, normalRanges, recovery, type SignalDay, type Status } from '../../../supabase/functions/_shared/signals.ts'
import { baseTdee, dailyBudget } from './nutrition.ts'
import type { Entry, Profile } from './supabase.ts'

export type MetricDay = SignalDay & { sleep_start_local: string | null; resting_hr: number | null }
type Meal = Pick<Entry, 'id' | 'meal' | 'title' | 'kcal_low' | 'kcal_mid' | 'kcal_high' | 'protein_g' |
  'carbs_g' | 'fat_g' | 'confidence'> & { local_time: string; note: string | null }
type Activity = { local_time: string; id: string; type: string; distance_km: number | null; duration_min: number | null; kcal_gross: number | null }
type WearableActivity = {
  started_at_local: string; provider: string; external_id: string; type: string; name: string | null
  duration_s: number | null; distance_m: number | null; avg_hr: number | null
  analysis: { verdict?: string } | null
}
export type ContextNote = { id: string; date: string; tag: string | null; text: string | null }
export type PlanAction = { action: 'done' | 'move' | 'other'; activity: string | null }
type Briefing = {
  status: Status; headline: string; why: string; food: string; weigh: boolean
  today: { type: 'easy_run' | 'long_run' | 'strength' | 'rest'; text: string }
  question: { text: string; options: string[]; date: string } | null
  deferral?: { to: string } | null
}
export type TodayData = {
  date: string; user_id: string; timezone: string; garmin: boolean
  connection: { status: 'active' | 'expired' | 'error' | 'disconnected'; backfill: boolean } | null
  profile: Pick<Profile, 'height_cm' | 'birth_year' | 'sex' | 'goal_kg_per_week'>
  briefing: Briefing | null; metrics: MetricDay[]; entries: Meal[]; activities: Activity[]
  wearable_activities: WearableActivity[]; notes: ContextNote[]
  weight: { kg: number; date: string } | null
  nutrition_target: { low: number | null; high: number | null } | null
  plan_action: PlanAction | null
}

const cacheKey = (id: string) => `happen-today-v1:${id}`
export function readToday(id: string): TodayData | null {
  try {
    const snapshot = JSON.parse(localStorage.getItem(cacheKey(id)) ?? 'null') as TodayData | null
    // A cached snapshot from yesterday is useful as history, but today's plan and question need current data.
    return snapshot && snapshot.date === new Date().toLocaleDateString('en-CA', { timeZone: snapshot.timezone }) ? snapshot : null
  } catch {
    return null
  }
}

export function cacheToday(id: string, snapshot: TodayData | null) {
  try {
    if (snapshot) localStorage.setItem(cacheKey(id), JSON.stringify(snapshot))
    else {
      localStorage.removeItem(cacheKey(id))
      localStorage.removeItem(`happen-morning:${id}`)
    }
  } catch {
    // A storage quota or privacy setting should not block the online view.
  }
}

export const number = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 })
export const prettyDate = (date: string) => new Date(date + 'T12:00:00Z').toLocaleDateString('de-DE', {
  weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
})

const metricSpecs = [
  ['hrv_last_night', 'HRV', 'ms', 'Zeigt, wie sich der Abstand zwischen deinen Herzschlägen nachts verändert.'],
  ['sleep_hr_avg', 'Schlafpuls', 'bpm', 'Dein mittlerer Puls im Schlaf.'],
  ['sleep_resp_avg', 'Atmung im Schlaf', '/min', 'Deine Atemzüge pro Minute im Schlaf.'],
  ['bb_wake', 'Body Battery', '', 'Garmins Schätzung deiner Energiereserven beim Aufwachen.'],
  ['sleep_minutes', 'Schlafdauer', 'min', 'Die Zeit, die Garmin als Schlaf erkannt hat.'],
] as const

export function todayRecovery(snapshot: TodayData) {
  const day = snapshot.metrics.find((m) => m.date === snapshot.date)
  const ranges = normalRanges(snapshot.metrics, snapshot.date)
  const signal = recovery(day, ranges)
  const days = 10 - daysUntilBaseline(snapshot.metrics, snapshot.date)
  const metrics = metricSpecs.flatMap(([id, label, unit, explanation]) => {
    const value = day?.[id]
    if (value == null || !day || day.sleep_uncertain) return []
    const reason = signal.reasons.find((item) => item.metric === id)
    const low = id === 'hrv_last_night' ? day.hrv_baseline_low : null
    const high = id === 'hrv_last_night' ? day.hrv_baseline_high : null
    const baseline = low != null && high != null && low <= high ? { low, high } : ranges[id]
    return [{ id, label, unit, explanation, value, baseline, flagged: !!reason }]
  }).sort((a, b) => Number(b.flagged) - Number(a.flagged))
  return { day, status: signal.status, days, metrics }
}

export function todayNutrition(snapshot: TodayData) {
  const meals = snapshot.entries.filter((meal) => meal.local_time.startsWith(snapshot.date))
  const totals = meals.reduce((total, meal) => ({
    low: total.low + meal.kcal_low, high: total.high + meal.kcal_high,
    protein: total.protein + (meal.protein_g ?? 0),
  }), { low: 0, high: 0, protein: 0 })
  const { profile, weight } = snapshot
  const { low, high } = snapshot.nutrition_target ?? {}
  let target: { low: number; high: number } | null = null
  if (low != null && high != null && low > 0 && high >= low) target = { low, high }
  else if (weight) {
    const goal = Number(profile.goal_kg_per_week)
    const tdee = baseTdee({ heightCm: profile.height_cm, birthYear: profile.birth_year, sex: profile.sex, goalKgPerWeek: goal }, weight.kg)
    if (tdee) {
      const activityCredit = snapshot.activities.filter((a) => a.local_time.startsWith(snapshot.date))
        .reduce((sum, a) => sum + (a.kcal_gross ?? 0), 0)
      const budget = dailyBudget(tdee, goal, activityCredit)
      target = { low: budget, high: budget }
    }
  }
  const proteinTarget = weight ? Math.round(weight.kg * 1.2) : null
  return { ...totals, count: meals.length, target, proteinTarget }
}

const activityLabels = { run: 'Lauf', strength: 'Krafttraining', bike: 'Radfahren', walk: 'Spaziergang', swim: 'Schwimmen' }
export function activityKind(type: string): keyof typeof activityLabels | 'other' {
  if (/run/i.test(type)) return 'run'
  if (/strength|weight/i.test(type)) return 'strength'
  if (/bike|cycling/i.test(type)) return 'bike'
  if (/walk|hik/i.test(type)) return 'walk'
  if (/swim/i.test(type)) return 'swim'
  return 'other'
}
const verdicts: Record<string, string> = {
  easy_ok: 'Locker gelaufen', easy_too_hard: 'Für einen lockeren Lauf zu schnell', late_surge: 'Am Ende schneller',
  hard_session: 'Intensive Einheit', race_like: 'Wettkampftempo',
}
export function wearableSummary(activity: WearableActivity) {
  const kind = activityKind(activity.type)
  return {
    kind, title: activity.name || (kind === 'other' ? 'Aktivität' : activityLabels[kind]),
    distance: activity.distance_m == null ? null : activity.distance_m / 1000,
    duration: activity.duration_s == null ? null : Math.round(activity.duration_s / 60),
    verdict: verdicts[activity.analysis?.verdict ?? ''] ?? null,
  }
}

type Event = { id: string; date: string; time?: string; icon: string; title: string; summary?: string; facts: (string | null)[] }
const summary = (...pieces: (string | null)[]) => pieces.filter(Boolean).join(' · ')
const asDuration = (minutes: number | null) => minutes == null ? null : `${number(minutes)} min`
const asDistance = (km: number | null) => km == null ? null : `${number(km)} km`
const stamped = (iso: string) => ({ date: iso.slice(0, 10), time: iso.slice(11, 16) })

export function buildTimeline(snapshot: TodayData): Event[] {
  const events: Event[] = []
  const yesterday = addDays(snapshot.date, -1)
  for (const day of snapshot.metrics) {
    if (day.sleep_uncertain) continue
    const score = day.sleep_score == null ? null : `Sleep Score ${number(day.sleep_score)}`
    if (day.sleep_start_local) events.push({
      id: `sleep-${day.date}`, ...stamped(day.sleep_start_local), icon: '☾', title: 'Eingeschlafen',
      summary: summary(day.sleep_minutes == null ? null : `${number(day.sleep_minutes / 60)} h`, score),
      facts: [asDuration(day.sleep_minutes), score, day.sleep_hr_avg == null ? null : `Schlafpuls ${number(day.sleep_hr_avg)} bpm`],
    })
    if (day.sleep_end_local) events.push({
      id: `wake-${day.date}`, ...stamped(day.sleep_end_local), icon: '☀', title: 'Aufgewacht',
      summary: day.bb_wake == null ? undefined : `Body Battery ${number(day.bb_wake)}`,
      facts: [day.hrv_last_night == null ? null : `HRV ${number(day.hrv_last_night)} ms`],
    })
    if (day.date < yesterday || day.evening_hr_avg == null) continue
    const pulse = normalRanges(snapshot.metrics, day.date).evening_hr_avg
    if (pulse && day.evening_hr_avg >= pulse.median + 12) events.push({
      id: `pulse-${day.date}`, date: day.date, time: '19–22', icon: '↗', title: 'Abendpuls erhöht',
      summary: `${number(day.evening_hr_avg)} bpm · sonst etwa ${number(pulse.median)}`,
      facts: ['Durchschnitt zwischen 19 und 22 Uhr, außerhalb aufgezeichneter Aktivitäten.'],
    })
  }
  for (const meal of snapshot.entries) {
    events.push({
      id: meal.id, ...stamped(meal.local_time), icon: '◈', title: meal.title,
      summary: `${number(meal.kcal_low)}–${number(meal.kcal_high)} kcal`,
      facts: [meal.protein_g == null ? null : `Eiweiß ${number(meal.protein_g)} g`,
        meal.carbs_g == null ? null : `Kohlenhydrate ${number(meal.carbs_g)} g`,
        meal.fat_g == null ? null : `Fett ${number(meal.fat_g)} g`, meal.note],
    })
  }
  for (const activity of snapshot.wearable_activities) {
    const details = wearableSummary(activity)
    events.push({
      id: `garmin-${activity.provider}-${activity.external_id}`, ...stamped(activity.started_at_local),
      icon: '↗', title: details.title,
      summary: summary(asDuration(details.duration), asDistance(details.distance)),
      facts: [details.verdict, activity.avg_hr == null ? null : `Ø Puls ${number(activity.avg_hr)} bpm`],
    })
  }
  for (const activity of snapshot.activities) {
    const kind = activityKind(activity.type)
    const synced = snapshot.wearable_activities.some((garmin) => kind !== 'other' && activityKind(garmin.type) === kind &&
      Math.abs(Date.parse(garmin.started_at_local + 'Z') - Date.parse(activity.local_time + 'Z')) < 20 * 60_000)
    if (synced) continue
    events.push({
      id: activity.id, ...stamped(activity.local_time), icon: '↗',
      title: kind === 'other' ? 'Aktivität' : activityLabels[kind],
      summary: summary(asDuration(activity.duration_min), asDistance(activity.distance_km)),
      facts: [activity.kcal_gross == null ? null : `Etwa ${number(activity.kcal_gross)} kcal brutto`],
    })
  }
  for (const note of snapshot.notes) events.push({
    id: note.id, date: note.date, icon: '·', title: note.tag === 'Andere…' ? 'Notiz' : note.tag || 'Notiz',
    summary: note.text ?? undefined, facts: [],
  })
  const question = snapshot.briefing?.question
  if (question && !events.some((event) => event.id === `pulse-${question.date}`) &&
    !snapshot.notes.some((note) => note.date === question.date)) {
    events.push({ id: `question-${question.date}`, date: question.date, icon: '↗', title: 'Auffälligkeit',
      summary: question.text, facts: [] })
  }
  return events.filter(({ date }) => date === snapshot.date || date === yesterday)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '99').localeCompare(b.time ?? '99'))
}
