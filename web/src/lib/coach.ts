// Gemeinsame Datenschicht für die Coach-Screens. RLS beschränkt alle Abfragen auf den angemeldeten Nutzer.
// Nur lesen, was die Tabellen wirklich haben. Fehlt etwas, zeigt der Screen einen ehrlichen Leerzustand.
import { useEffect, useState } from 'react'
import { supabase, type Entry, type Weight } from './supabase'
import type { RecoveryStatus } from './format'

/* ---------------------------------------------------------------------------
 * Datum
 * ------------------------------------------------------------------------- */
/** YYYY-MM-DD in der lokalen Zeitzone des Geräts. */
export function localDate(d = new Date()): string {
  return d.toLocaleDateString('en-CA')
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Montag der Woche, in der `date` liegt. */
export function weekStart(date: string): string {
  const dow = new Date(date + 'T12:00:00Z').getUTCDay() // 0 = So
  return addDays(date, dow === 0 ? -6 : 1 - dow)
}

const dateFmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('de-DE', { ...opts, timeZone: 'UTC' })

/** „Dienstag, 24. November“ */
export function longDate(date: string): string {
  return dateFmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(date + 'T12:00:00Z'))
}

/** „Di“ */
export function shortWeekday(date: string): string {
  return dateFmt({ weekday: 'short' }).format(new Date(date + 'T12:00:00Z')).replace('.', '')
}

/** „24.11.“ */
export function shortDate(date: string): string {
  const [, m, d] = date.split('-')
  return `${Number(d)}.${Number(m)}.`
}

/** „07:30“ aus einem ISO-Zeitstempel oder einem lokalen Zeitstempel ohne Zone. */
export function clock(ts: string): string {
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(ts)) {
    return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  }
  return ts.slice(11, 16)
}

/* ---------------------------------------------------------------------------
 * Typen (Spalten aus supabase/migrations/20261123000000_coach_data.sql)
 * ------------------------------------------------------------------------- */
export interface DailyMetrics {
  date: string
  sleep_start_local: string | null
  sleep_end_local: string | null
  sleep_minutes: number | null
  sleep_score: number | null
  deep_min: number | null
  rem_min: number | null
  light_min: number | null
  awake_min: number | null
  awake_count: number | null
  sleep_hr_avg: number | null
  sleep_resp_avg: number | null
  sleep_stress_avg: number | null
  sleep_need_min: number | null
  sleep_uncertain: boolean
  hrv_last_night: number | null
  hrv_status: string | null
  hrv_baseline_low: number | null
  hrv_baseline_high: number | null
  resting_hr: number | null
  bb_wake: number | null
  bb_max: number | null
  bb_min: number | null
  steps: number | null
  kcal_total: number | null
  kcal_active: number | null
  stress_avg: number | null
  stress_high_min: number | null
  evening_hr_avg: number | null
  wear_hours: number | null
  is_complete: boolean
  updated_at: string
}

export interface RunAnalysis {
  verdict?: 'easy' | 'drifted' | 'hard' | string
  headline?: string
  explanation?: string
  [key: string]: unknown
}

export interface WearableActivity {
  provider: string
  external_id: string
  started_at_local: string
  type: string
  name: string | null
  duration_s: number | null
  distance_m: number | null
  elevation_gain_m: number | null
  avg_hr: number | null
  max_hr: number | null
  hr_zone_s: number[] | null
  training_load: number | null
  aerobic_te: number | null
  anaerobic_te: number | null
  te_label: string | null
  avg_cadence: number | null
  feel: number | null
  rpe: number | null
  run_s: number | null
  walk_s: number | null
  hr_sensor: 'wrist' | 'chest' | null
  analysis: RunAnalysis | null
}

export type ReasonMetric = 'hrv_last_night' | 'sleep_hr_avg' | 'sleep_resp_avg' | 'bb_wake' | 'sleep_minutes'

export interface BriefingReason {
  metric: ReasonMetric
  value: number
  normal_low: number | null
  normal_high: number | null
  severity: 'red' | 'yellow'
}

export type TrainingType = 'easy_run' | 'long_run' | 'strength' | 'rest'

export interface MorningBriefing {
  status: RecoveryStatus
  headline: string
  why: string
  reasons: BriefingReason[]
  today: { type: TrainingType; duration_min: number | null; hr_cap: number | null; text: string }
  food: string
  question: { text: string; options: string[]; date: string } | null
  weigh: boolean
  deferral: { from: string; to: string; training: { type: TrainingType; duration_min: number | null; hr_cap: number | null } } | null
}

export interface ContextNote {
  id: string
  date: string
  tag: string | null
  text: string | null
  source: 'question' | 'chat' | 'manual'
  created_at: string
}

export interface CoachSettings {
  user_id: string
  channel: 'push' | 'telegram' | 'both'
  briefing_mode: 'after_wake' | 'fixed'
  briefing_time: string | null
  quiet_from: string | null
  quiet_to: string | null
  easy_hr_cap: number
  lthr: number | null
  goal: unknown
  kcal_target_low: number | null
  kcal_target_high: number | null
  bedtime_target: string | null
  max_pushes_per_day: number
}

export interface WearableStatus {
  connected: boolean
  status?: 'active' | 'expired' | 'error' | 'disconnected'
  lastSyncAt?: string | null
  lastDataAt?: string | null
  backfillPending?: boolean
  lastError?: string | null
}

/* ---------------------------------------------------------------------------
 * Labels
 * ------------------------------------------------------------------------- */
export const metricLabel: Record<ReasonMetric | 'resting_hr' | 'evening_hr_avg' | 'sleep_score', string> = {
  hrv_last_night: 'HRV',
  sleep_hr_avg: 'Schlafpuls',
  sleep_resp_avg: 'Atmung',
  bb_wake: 'Body Battery',
  sleep_minutes: 'Schlaf',
  resting_hr: 'Ruhepuls',
  evening_hr_avg: 'Abendpuls',
  sleep_score: 'Schlafscore',
}

export const metricUnit: Record<string, string> = {
  hrv_last_night: 'ms',
  sleep_hr_avg: 'bpm',
  sleep_resp_avg: '/min',
  bb_wake: '',
  sleep_minutes: 'Min.',
  resting_hr: 'bpm',
  evening_hr_avg: 'bpm',
}

export const isRun = (type: string) => /running|run/.test(type)

export function activityLabel(type: string): string {
  if (type === 'treadmill_running') return 'Laufband'
  if (isRun(type)) return 'Lauf'
  if (/strength/.test(type)) return 'Kraft'
  if (/cycling|bike/.test(type)) return 'Rad'
  if (/walk|hiking/.test(type)) return 'Spaziergang'
  return 'Training'
}

export function trainingTitle(t: { type: TrainingType; duration_min: number | null }): string {
  switch (t.type) {
    case 'easy_run':
      return `${t.duration_min ?? 40} Min. locker laufen`
    case 'long_run':
      return `${t.duration_min ?? 60} Min. langer Lauf`
    case 'strength':
      return 'Krafttraining'
    default:
      return 'Ruhetag'
  }
}

/* ---------------------------------------------------------------------------
 * Normalbereich (wie signals.normalRanges: 28 Tage, Quartile, ab 10 Werten)
 * ------------------------------------------------------------------------- */
export const BASELINE_MIN_VALUES = 10

export interface Baseline {
  median: number
  low: number
  high: number
  count: number
}

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo)
}

export function baseline(days: DailyMetrics[], metric: keyof DailyMetrics, before: string): Baseline | null {
  const start = addDays(before, -28)
  const values = days
    .filter((d) => d.date >= start && d.date < before && !(d.sleep_uncertain && String(metric).startsWith('sleep')))
    .map((d) => d[metric])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b)
  if (values.length < BASELINE_MIN_VALUES) return null
  return { median: quantile(values, 0.5), low: quantile(values, 0.25), high: quantile(values, 0.75), count: values.length }
}

/** Wie viele Tage mit Messwerten noch fehlen, bis es einen Normalbereich gibt (0 = fertig). */
export function daysUntilBaseline(days: DailyMetrics[], date: string): number {
  const start = addDays(date, -28)
  const window = days.filter((d) => d.date >= start && d.date < date)
  const metrics: (keyof DailyMetrics)[] = ['hrv_last_night', 'sleep_hr_avg', 'sleep_resp_avg', 'bb_wake', 'sleep_minutes']
  const best = Math.max(0, ...metrics.map((m) => window.filter((d) => typeof d[m] === 'number').length))
  return Math.max(0, BASELINE_MIN_VALUES - best)
}

/* ---------------------------------------------------------------------------
 * Abfragen
 * ------------------------------------------------------------------------- */
function rows<T>(res: { data: unknown; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}

export async function fetchMorningBriefing(date?: string): Promise<{ date: string; payload: MorningBriefing } | null> {
  let q = supabase.from('briefings').select('date,payload').eq('kind', 'morning').eq('ref', '')
  if (date) q = q.eq('date', date)
  const res = await q.order('date', { ascending: false }).limit(1).maybeSingle()
  const row = rows<{ date: string; payload: MorningBriefing } | null>(res)
  return row?.payload?.headline ? row : null
}

export async function fetchDailyMetrics(from: string, to: string): Promise<DailyMetrics[]> {
  return rows(await supabase.from('daily_metrics').select('*').gte('date', from).lte('date', to).order('date'))
}

export async function fetchActivities(from: string, to: string): Promise<WearableActivity[]> {
  return rows(
    await supabase
      .from('wearable_activities')
      .select('*')
      .gte('started_at_local', from)
      .lt('started_at_local', addDays(to, 1))
      .order('started_at_local'),
  )
}

export async function fetchActivity(externalId: string): Promise<WearableActivity | null> {
  return rows(await supabase.from('wearable_activities').select('*').eq('external_id', externalId).maybeSingle())
}

/** Mahlzeiten zwischen zwei lokalen Tagen (inklusive). */
export async function fetchEntries(from: string, to: string): Promise<Entry[]> {
  const start = new Date(from + 'T00:00:00')
  const end = new Date(addDays(to, 1) + 'T00:00:00')
  return rows(
    await supabase
      .from('entries')
      .select('*')
      .neq('status', 'deleted')
      .gte('eaten_at', start.toISOString())
      .lt('eaten_at', end.toISOString())
      .order('eaten_at'),
  )
}

export async function fetchWeights(from: string): Promise<Weight[]> {
  return rows(await supabase.from('weights').select('measured_on,kg').gte('measured_on', from).order('measured_on'))
}

export async function fetchNotes(from: string, to: string): Promise<ContextNote[]> {
  return rows(await supabase.from('context_notes').select('*').gte('date', from).lte('date', to).order('created_at'))
}

/** Antwort auf eine Rückfrage oder eigene Notiz speichern. */
export async function saveNote(userId: string, note: { date: string; tag?: string | null; text?: string | null; source?: ContextNote['source'] }) {
  const res = await supabase
    .from('context_notes')
    .insert({ user_id: userId, date: note.date, tag: note.tag ?? null, text: note.text ?? null, source: note.source ?? 'question' })
    .select()
    .single()
  return rows<ContextNote>(res)
}

export async function fetchCoachSettings(): Promise<CoachSettings | null> {
  return rows(await supabase.from('coach_settings').select('*').maybeSingle())
}

export async function updateCoachSettings(userId: string, patch: Partial<CoachSettings>) {
  return rows(await supabase.from('coach_settings').upsert({ user_id: userId, ...patch }).select().single())
}

/** Verbindungsstatus der Uhr (Tabelle ist per RLS gesperrt, deshalb über die Edge Function). */
export async function fetchWearableStatus(): Promise<WearableStatus | null> {
  const { data, error } = await supabase.functions.invoke('wearable-connect', { body: { action: 'status' } })
  if (error) return null
  return data as WearableStatus
}

/** „Nochmal prüfen“: Sync für diesen Nutzer sofort auslösen. */
export async function triggerSync(): Promise<{ status: string; newData?: boolean; skipped?: string } | null> {
  const { data, error } = await supabase.functions.invoke('garmin-sync', { body: {} })
  if (error) return null
  return data
}

/* ---------------------------------------------------------------------------
 * Hook: lädt asynchron, merkt sich das letzte Ergebnis im localStorage,
 * damit Screens aus dem Cache sofort etwas zeigen (Ziel: Heute < 1 s).
 * ------------------------------------------------------------------------- */
export function useCached<T>(key: string, load: () => Promise<T>, deps: unknown[] = []) {
  const storageKey = `happen-cache:${key}`
  const [data, setData] = useState<T | null>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      return raw ? (JSON.parse(raw) as T) : null
    } catch {
      return null
    }
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    load()
      .then((value) => {
        if (!active) return
        setData(value)
        setError(null)
        try {
          localStorage.setItem(storageKey, JSON.stringify(value))
        } catch {
          // Ohne Speicher geht es auch, nur ohne Offline-Cache.
        }
      })
      .catch((e: Error) => active && setError(e.message))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, nonce, ...deps])

  return { data, loading, error, reload: () => setNonce((n) => n + 1), setData }
}
