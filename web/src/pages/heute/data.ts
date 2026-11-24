// Daten und Texte für Heute, Warum? und Tageslinie.
// Alles hier ist aus echten Werten abgeleitet; fehlt etwas, liefern die Funktionen null.
import { supabase, type Entry, type Profile } from '../../lib/supabase'
import { baseTdee, dailyBudget } from '../../lib/nutrition'
import {
  addDays,
  baseline,
  fetchCoachSettings,
  fetchDailyMetrics,
  fetchActivities,
  fetchEntries,
  fetchMorningBriefing,
  fetchNotes,
  fetchWearableStatus,
  isRun,
  localDate,
  type BriefingReason,
  type CoachSettings,
  type ContextNote,
  type DailyMetrics,
  type MorningBriefing,
  type ReasonMetric,
  type TrainingType,
  type WearableActivity,
  type WearableStatus,
} from '../../lib/coach'
import { fmt, type RecoveryStatus } from '../../lib/format'

/* ---------------------------------------------------------------------------
 * Laden
 * ------------------------------------------------------------------------- */
const soft = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback)

export interface HeuteData {
  date: string
  wearable: WearableStatus | null
  briefing: MorningBriefing | null
  days: DailyMetrics[]
  activities: WearableActivity[]
  entries: Entry[]
  notes: ContextNote[]
  settings: CoachSettings | null
  weightKg: number | null
  runKcal: number
}

/** Lauf-kcal von heute aus der alten Tabelle `activities` (wie im Dashboard für das Tagesbudget). */
async function fetchRunKcal(date: string): Promise<number> {
  const res = await supabase
    .from('activities')
    .select('kcal_gross')
    .eq('status', 'active')
    .gte('started_at', new Date(date + 'T00:00:00').toISOString())
    .lt('started_at', new Date(addDays(date, 1) + 'T00:00:00').toISOString())
  if (res.error) return 0
  return ((res.data ?? []) as { kcal_gross: number | null }[]).reduce((s, a) => s + (a.kcal_gross ?? 0), 0)
}

async function fetchLatestWeight(): Promise<number | null> {
  const res = await supabase.from('weights').select('kg').order('measured_on', { ascending: false }).limit(1)
  const row = (res.data as { kg: number }[] | null)?.[0]
  return row ? Number(row.kg) : null
}

export async function loadHeute(date: string): Promise<HeuteData> {
  const yesterday = addDays(date, -1)
  const [wearable, briefing, days, activities, entries, notes, settings, weightKg, runKcal] = await Promise.all([
    soft(fetchWearableStatus(), null),
    soft(fetchMorningBriefing(date).then((b) => b?.payload ?? null), null),
    soft(fetchDailyMetrics(addDays(date, -29), date), [] as DailyMetrics[]),
    soft(fetchActivities(date, date), [] as WearableActivity[]),
    soft(fetchEntries(yesterday, date), [] as Entry[]),
    soft(fetchNotes(yesterday, date), [] as ContextNote[]),
    soft(fetchCoachSettings(), null),
    soft(fetchLatestWeight(), null),
    soft(fetchRunKcal(date), 0),
  ])
  return { date, wearable, briefing, days, activities, entries, notes, settings, weightKg, runKcal }
}

/* ---------------------------------------------------------------------------
 * Kennzahlen gegen Normalbereich
 * ------------------------------------------------------------------------- */
export type Level = 'ok' | 'warn' | 'bad'

export interface MetricView {
  metric: ReasonMetric
  value: number
  display: string
  low: number
  high: number
  /** „50–73“ oder „ab 60“ */
  normal: string
  /** Skala für den Balken (fest bei Body Battery und Schlaf) */
  min?: number
  max?: number
  level: Level
  dir: 'below' | 'in' | 'above'
}

export const ALL_METRICS: ReasonMetric[] = ['hrv_last_night', 'sleep_hr_avg', 'sleep_resp_avg', 'bb_wake', 'sleep_minutes']

export const shortLabel: Record<ReasonMetric, string> = {
  hrv_last_night: 'HRV',
  sleep_hr_avg: 'Schlafpuls',
  sleep_resp_avg: 'Atmung',
  bb_wake: 'Body Battery',
  sleep_minutes: 'Schlafdauer',
}

export const shortUnit: Record<ReasonMetric, string> = {
  hrv_last_night: 'ms',
  sleep_hr_avg: 'bpm',
  sleep_resp_avg: '/min',
  bb_wake: '',
  sleep_minutes: 'Std.',
}

function display(metric: ReasonMetric, v: number): string {
  if (metric === 'sleep_minutes') return fmt(Math.round((v / 60) * 10) / 10, 1)
  if (metric === 'sleep_resp_avg') return fmt(Math.round(v * 10) / 10, 1)
  return fmt(Math.round(v))
}

/** Normalbereich wie im Backend: HRV von der Uhr, Puls/Atmung aus 28 Tagen, Body Battery und Schlaf fest. */
function normalRange(metric: ReasonMetric, days: DailyMetrics[], date: string, today?: DailyMetrics) {
  if (metric === 'bb_wake') return { low: 60, high: 100, normal: 'ab 60', min: 0, max: 100 }
  if (metric === 'sleep_minutes') return { low: 360, high: 540, normal: 'ab 6 Std.', min: 240, max: 600 }
  if (metric === 'hrv_last_night' && today?.hrv_baseline_low != null && today.hrv_baseline_high != null) {
    return { low: today.hrv_baseline_low, high: today.hrv_baseline_high, normal: '' }
  }
  const b = baseline(days, metric, date)
  return b ? { low: b.low, high: b.high, normal: '' } : null
}

export function metricView(
  metric: ReasonMetric,
  days: DailyMetrics[],
  date: string,
  reasons: BriefingReason[] = [],
): MetricView | null {
  const today = days.find((d) => d.date === date)
  const reason = reasons.find((r) => r.metric === metric)
  const value = reason?.value ?? (today?.[metric] as number | null | undefined)
  if (value == null || !Number.isFinite(value)) return null
  const fixed = normalRange(metric, days, date, today)
  const low = reason?.normal_low ?? fixed?.low
  const high = reason?.normal_high ?? fixed?.high
  if (low == null || high == null) return null
  const fixedNormal = fixed?.normal && fixed.low === low ? fixed.normal : ''
  const normal = fixedNormal || `${display(metric, low)}–${display(metric, high)}`
  const dir = value < low ? 'below' : value > high ? 'above' : 'in'
  return {
    metric,
    value,
    display: display(metric, value),
    low,
    high,
    normal,
    min: fixed?.min,
    max: fixed?.max,
    level: reason ? (reason.severity === 'red' ? 'bad' : 'warn') : 'ok',
    dir,
  }
}

/** Die zwei Kennzahlen unter dem Status: grün HRV + Schlafpuls, sonst die Gründe. */
export function headlineMetrics(status: RecoveryStatus, days: DailyMetrics[], date: string, reasons: BriefingReason[]) {
  const order = [...reasons].sort((a, b) => Number(a.severity === 'yellow') - Number(b.severity === 'yellow'))
  const wanted: ReasonMetric[] =
    status === 'green' || !order.length ? ['hrv_last_night', 'sleep_hr_avg'] : order.map((r) => r.metric)
  const list = wanted.map((m) => metricView(m, days, date, reasons)).filter((m): m is MetricView => !!m)
  // Mit nur einem Grund die zweite Spalte mit HRV oder Schlafpuls füllen.
  for (const extra of ['hrv_last_night', 'sleep_hr_avg'] as ReasonMetric[]) {
    if (list.length >= 2) break
    if (list.some((m) => m.metric === extra)) continue
    const v = metricView(extra, days, date, reasons)
    if (v) list.push(v)
  }
  return list.slice(0, 2)
}

/* ---------------------------------------------------------------------------
 * Sätze
 * ------------------------------------------------------------------------- */
const noun: Record<ReasonMetric, string> = {
  hrv_last_night: 'Deine HRV',
  sleep_hr_avg: 'Dein Schlafpuls',
  sleep_resp_avg: 'Deine Atmung im Schlaf',
  bb_wake: 'Deine Body Battery',
  sleep_minutes: 'Deine Schlafdauer',
}

function joinDe(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return parts.slice(0, -1).join(', ') + ' und ' + parts[parts.length - 1]
}

function groupPhrase(views: MetricView[], strong: boolean): string {
  const names = views.map((v) => shortLabel[v.metric])
  const up = views.every((v) => v.dir === 'above')
  const down = views.every((v) => v.dir === 'below')
  const adj = up ? 'erhöht' : down ? 'niedrig' : 'auffällig'
  return `${joinDe(names)} ${views.length > 1 ? 'sind' : 'ist'} ${strong ? 'deutlich ' : ''}${adj}`
}

/** „Atmung und Schlafpuls sind deutlich erhöht, die HRV ist niedrig“ */
function reasonsPhrase(views: MetricView[]): string {
  const up = views.filter((v) => v.dir === 'above')
  const down = views.filter((v) => v.dir !== 'above')
  const groups = [up, down].filter((g) => g.length).sort((a, b) => b.length - a.length)
  return groups
    .map((g, i) => {
      const p = groupPhrase(g, g.some((v) => v.level === 'bad'))
      return i === 0 ? p.replace(/^HRV/, 'Die HRV') : p.replace(/^HRV/, 'die HRV')
    })
    .join(', ')
}

const isRunType = (t: TrainingType) => t === 'easy_run' || t === 'long_run'

/** Satz unter dem Status auf Heute, aus den echten Werten. */
export function statusSentence(
  status: RecoveryStatus,
  briefing: MorningBriefing,
  days: DailyMetrics[],
  date: string,
): string {
  const reasons = briefing.reasons ?? []
  if (status === 'green') {
    const hrv = metricView('hrv_last_night', days, date)
    const hr = metricView('sleep_hr_avg', days, date)
    const parts: string[] = []
    if (hrv) parts.push(`Deine HRV liegt ${hrv.dir === 'above' ? 'über' : hrv.dir === 'below' ? 'knapp unter' : 'in'} deinem Normalbereich`)
    if (hr) parts.push(`${parts.length ? 'dein' : 'Dein'} Schlafpuls ist ${hr.dir === 'below' ? 'niedriger als sonst' : hr.dir === 'above' ? 'etwas höher als sonst' : 'wie immer'}`)
    const close = isRunType(briefing.today.type)
      ? 'Laufen passt heute.'
      : briefing.today.type === 'strength'
        ? 'Krafttraining passt heute.'
        : 'Ein guter Tag zum Erholen.'
    return parts.length ? `${parts.join(', ')}. ${close}` : `Deine Werte liegen in deinem Normalbereich. ${close}`
  }
  if (status === 'yellow' || status === 'red') {
    const views = reasons.map((r) => metricView(r.metric, days, date, reasons)).filter((v): v is MetricView => !!v)
    if (!views.length) return briefing.why
    let first: string
    if (views.length === 1) {
      const v = views[0]
      const how = v.level === 'bad' ? 'deutlich' : 'knapp'
      first = `${noun[v.metric]} liegt ${how} ${v.dir === 'above' ? 'über' : 'unter'} deinem Normalbereich.`
    } else {
      first = reasonsPhrase(views.slice(0, 3)) + '.'
    }
    if (status === 'yellow') {
      return `${first} ${isRunType(briefing.today.type) ? 'Heute lieber kürzer und lockerer.' : 'Heute lieber ruhig angehen.'}`
    }
    const resp = views.find((v) => v.metric === 'sleep_resp_avg' && v.dir === 'above')
    return `${first} ${resp ? 'Oft heißt das: Dein Körper arbeitet gerade gegen etwas.' : 'Heute braucht dein Körper Erholung.'}`
  }
  return briefing.why
}

const numberWord = ['Kein', 'Ein', 'Zwei', 'Drei', 'Vier', 'Fünf']

/** Satz oben auf „Warum?“. */
export function whySentence(status: RecoveryStatus, briefing: MorningBriefing | null, views: MetricView[]): string {
  if (!briefing) return 'Für heute gibt es noch kein Morgenbriefing.'
  const off = views.filter((v) => v.level !== 'ok')
  if (status === 'green') {
    const n = views.length
    if (!n) return briefing.why
    const allOk = views.every((v) => v.dir !== 'below')
    if (n === 1) return `Dein Wert der letzten Nacht liegt ${allOk ? 'in oder über' : 'nahe an'} deinem Normalbereich.`
    return `${n === 5 ? 'Alle fünf' : `Alle ${numberWord[n]?.toLowerCase() ?? n}`} Werte der letzten Nacht liegen ${allOk ? 'in oder über deinem Normalbereich' : 'in oder nahe an deinem Normalbereich'}.`
  }
  if (status === 'yellow') {
    if (!off.length) return briefing.why
    const where = off.every((v) => v.dir === 'below')
      ? 'unter deinem Normalbereich'
      : off.every((v) => v.dir === 'above')
        ? 'über deinem Normalbereich'
        : 'außerhalb deines Normalbereichs'
    const n = off.length
    return `${numberWord[n] ?? n} ${n === 1 ? 'Wert liegt' : 'Werte liegen'} ${where}. Das reicht für „etwas müde“, nicht für mehr.`
  }
  if (status === 'red') {
    if (!off.length) return briefing.why
    const s = reasonsPhrase(off)
    return `${s}. ${off.length > 1 ? 'Diese Kombination nehme ich ernst.' : 'Das nehme ich ernst.'}`
  }
  return briefing.why
}

/* ---------------------------------------------------------------------------
 * Plan
 * ------------------------------------------------------------------------- */
// Wochenvorlage wie in supabase/functions/_shared/coach.ts (baseWeek), nur für Tage ohne Briefing.
const baseWeek: Record<number, TrainingType> = { 0: 'long_run', 1: 'strength', 2: 'easy_run', 4: 'easy_run', 5: 'strength' }

export function templateTraining(date: string, cap: number): MorningBriefing['today'] {
  const type = baseWeek[new Date(date + 'T12:00:00Z').getUTCDay()] ?? 'rest'
  const duration_min = type === 'long_run' ? 60 : type === 'easy_run' ? 40 : null
  return { type, duration_min, hr_cap: duration_min ? cap : null, text: '' }
}

const weekday = (date: string) =>
  new Intl.DateTimeFormat('de-DE', { weekday: 'long', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'))

export interface PlanView {
  type: TrainingType
  title: string
  sub: string
  isRun: boolean
}

export function planView(today: MorningBriefing['today'], briefing: MorningBriefing | null, status: RecoveryStatus): PlanView {
  const deferral = briefing?.deferral ?? null
  const run = isRunType(today.type)
  let title: string
  let sub: string
  if (run) {
    const min = today.duration_min ?? (today.type === 'long_run' ? 60 : 40)
    const before = deferral?.training.duration_min
    title =
      today.type === 'long_run'
        ? `${min} Min. langer Lauf`
        : before && before !== min
          ? `${min} Min. locker statt ${before}`
          : `${min} Min. locker laufen`
    sub = today.hr_cap ? `Puls unter ${today.hr_cap}.` : ''
    if (deferral) {
      const what = deferral.training.type === 'long_run' ? 'Den langen Lauf' : 'Den geplanten Lauf'
      sub += ` ${what} schieben wir auf ${weekday(deferral.to)}.`
    }
  } else if (today.type === 'strength') {
    title = 'Krafttraining'
    sub = 'Heute steht Krafttraining an.'
  } else if (status === 'unknown' && briefing) {
    title = 'Nach Gefühl'
    sub = briefing.today.text
  } else {
    title = 'Ruhetag'
    sub = 'Ein kurzer Spaziergang tut gut.'
    if (deferral) sub += ` Deinen Lauf habe ich auf ${weekday(deferral.to)} verschoben.`
  }
  return { type: today.type, title, sub: sub.trim(), isRun: run }
}

/** Urteil für die Mini-Laufkarte: aus `analysis`, sonst neutral aus Dauer und Ø Puls. */
export function runSummary(a: WearableActivity, cap: number) {
  const min = Math.round((a.duration_s ?? 0) / 60)
  const an = a.analysis
  const verdictTitle: Record<string, string> = {
    easy_ok: 'Locker gelaufen',
    easy: 'Locker gelaufen',
    easy_too_hard: 'Etwas zu flott',
    late_surge: 'Zum Ende schneller geworden',
    drifted: 'Zum Ende schneller geworden',
    hard_session: 'Harte Einheit',
    hard: 'Harte Einheit',
    race_like: 'Fast wie ein Wettkampf',
  }
  const share = typeof an?.share_below_cap === 'number' ? Math.round((an.share_below_cap as number) * 100) : null
  const parts = [`${min} Min.`]
  if (share !== null) parts.push(`${share} % unter ${cap}`)
  if (a.avg_hr) parts.push(`Ø Puls ${a.avg_hr}`)
  let title = an?.headline || (an?.verdict ? verdictTitle[an.verdict] : undefined)
  let close = an?.explanation ?? ''
  if (!title) {
    if (a.avg_hr && a.avg_hr <= cap) {
      title = 'Locker gelaufen'
      close = 'Genau so war es gedacht.'
    } else if (a.avg_hr) {
      title = 'Gelaufen'
      close = `Im Schnitt über ${cap}, also eher zügig.`
    } else {
      title = 'Gelaufen'
    }
  } else if (!close && (an?.verdict === 'easy_ok' || an?.verdict === 'easy')) {
    close = 'Genau so war es gedacht.'
  }
  return { title, sub: parts.join(' · ') + (close ? `. ${close}` : '') }
}

/* ---------------------------------------------------------------------------
 * Essen
 * ------------------------------------------------------------------------- */
export function foodTotals(entries: Entry[], date: string) {
  const today = entries.filter((e) => localDate(new Date(e.eaten_at)) === date)
  return today.reduce(
    (acc, e) => ({
      low: acc.low + (e.kcal_low ?? 0),
      mid: acc.mid + (e.kcal_mid ?? 0),
      high: acc.high + (e.kcal_high ?? 0),
      protein: acc.protein + (e.protein_g ?? 0),
      count: acc.count + 1,
    }),
    { low: 0, mid: 0, high: 0, protein: 0, count: 0 },
  )
}

/** Tagesziel: eigene Vorgabe aus coach_settings, sonst Tagesbudget wie im Dashboard. */
export function kcalGoal(profile: Profile, data: HeuteData): number | null {
  const s = data.settings
  if (s?.kcal_target_low && s.kcal_target_high) return Math.round((s.kcal_target_low + s.kcal_target_high) / 2)
  if (s?.kcal_target_high) return s.kcal_target_high
  if (!data.weightKg) return null
  const goalKg = Number(profile.goal_kg_per_week)
  const tdee = baseTdee(
    { heightCm: profile.height_cm, birthYear: profile.birth_year, sex: profile.sex, goalKgPerWeek: goalKg },
    data.weightKg,
  )
  return tdee ? dailyBudget(tdee, goalKg, data.runKcal) : null
}

export const round50 = (n: number) => Math.round(n / 50) * 50
export const round10 = (n: number) => Math.round(n / 10) * 10

/* ---------------------------------------------------------------------------
 * Frage
 * ------------------------------------------------------------------------- */
export interface QuestionView {
  date: string
  kicker: string
  text: string
  options: string[]
  thanks: string
  /** Frage aus happen-Daten (ohne Uhr) */
  food?: boolean
}

export function questionView(data: HeuteData, status: RecoveryStatus | null, noWatch: boolean): QuestionView | null {
  const { date, days, notes, entries } = data
  const yesterday = addDays(date, -1)
  const answered = (d: string) => notes.some((n) => n.date === d && n.source === 'question')

  if (noWatch) {
    const yEntries = entries.filter((e) => localDate(new Date(e.eaten_at)) === yesterday)
    const late = yEntries.some((e) => new Date(e.eaten_at).getHours() >= 18)
    if (!yEntries.length || late || answered(yesterday)) return null
    return {
      date: yesterday,
      kicker: 'Eine Frage zu gestern',
      text: 'Nach 18 Uhr hast du nichts eingetragen. Hast du noch etwas gegessen?',
      options: ['Ja, nachtragen', 'Nein, nichts'],
      thanks: 'Danke, dann stimmt deine Bilanz von gestern.',
      food: true,
    }
  }

  const q = data.briefing?.question
  if (q) {
    if (answered(q.date)) return null
    let text = q.text
    let kicker = q.date === yesterday ? 'Eine Frage zu gestern' : 'Eine Frage zu letzter Nacht'
    let thanks = 'Ab drei solchen Tagen zeige ich dir, was sie mit deiner Nacht machen.'
    const day = days.find((d) => d.date === q.date)
    if (/Abendpuls/.test(q.text)) {
      kicker = 'Eine Frage zu gestern Abend'
      thanks = 'Ab drei solchen Abenden zeige ich dir, was sie mit deiner Nacht machen.'
      const b = baseline(days, 'evening_hr_avg', q.date)
      if (day?.evening_hr_avg != null && b) {
        text = `Dein Abendpuls lag bei ${Math.round(day.evening_hr_avg)}, sonst um ${Math.round(b.median)}. Was war los?`
      }
    } else if (/Stress/.test(q.text)) {
      const b = baseline(days, 'stress_high_min', q.date)
      if (day?.stress_high_min != null && b) {
        const more = Math.round((day.stress_high_min - b.median) / 5) * 5
        if (more > 0) text = `Du warst tagsüber ${more} Min. länger gestresst als sonst. Was war los?`
      }
    }
    return { date: q.date, kicker, text, options: q.options, thanks }
  }

  if (status === 'red' && !answered(date)) {
    return {
      date,
      kicker: 'Eine Frage',
      text: 'Wie fühlst du dich heute?',
      options: ['Angeschlagen', 'Nur müde', 'Eigentlich gut', 'Andere…'],
      thanks: 'Ich schaue morgen früh, ob sich deine Werte erholen.',
    }
  }
  return null
}

/** Stunden seit einem Zeitstempel, abgerundet. */
export function hoursSince(ts: string | null | undefined): number | null {
  if (!ts) return null
  const h = Math.floor((Date.now() - new Date(ts).getTime()) / 3_600_000)
  return Number.isFinite(h) && h >= 0 ? h : null
}

export function isRunActivity(a: WearableActivity) {
  return isRun(a.type)
}

export const currentHour = () => new Date().getHours()
