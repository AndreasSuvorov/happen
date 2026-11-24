// Abfragen, die nur der Trainingsbereich braucht (lib/coach.ts bietet nur das jeweils neueste Briefing).
import { supabase } from '../../lib/supabase'
import type { MorningBriefing } from '../../lib/coach'

export interface BriefingRow {
  date: string
  payload: MorningBriefing
}

/** Alle Morgenbriefings zwischen zwei Tagen (inklusive). */
export async function fetchMorningBriefings(from: string, to: string): Promise<BriefingRow[]> {
  const res = await supabase
    .from('briefings')
    .select('date,payload')
    .eq('kind', 'morning')
    .eq('ref', '')
    .gte('date', from)
    .lte('date', to)
    .order('date')
  if (res.error) throw new Error(res.error.message)
  return ((res.data ?? []) as BriefingRow[]).filter((r) => r.payload && typeof r.payload === 'object')
}

/** Ziel aus coach_settings.goal, z. B. { type: 'race', name, date, target }. */
export interface RaceGoal {
  name: string
  date: string | null
  target: string | null
  phase: string | null
}

export function parseGoal(goal: unknown): RaceGoal | null {
  if (!goal || typeof goal !== 'object') return null
  const g = goal as Record<string, unknown>
  const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim() : null
  if (!name) return null
  const date = typeof g.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(g.date) ? g.date.slice(0, 10) : null
  const target = typeof g.target === 'string' && g.target.trim() ? g.target.trim() : null
  const phase = typeof g.phase === 'string' ? g.phase : null
  return { name, date, target, phase }
}

export const LAUFBAND_TAG = 'laufband_kmh'
