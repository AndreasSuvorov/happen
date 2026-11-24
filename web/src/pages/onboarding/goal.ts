// Ziel im Feld coach_settings.goal (jsonb). Das Backend (_shared/coach.ts) liest es nur als Kontext.
// Format: { goals: GoalId[], race?: { name: string, date: 'YYYY-MM-DD' | null, target: 'h:mm:ss' | null } }

export type GoalId = 'abnehmen' | 'fitter' | 'lauf' | 'schlaf'

export interface Race {
  name: string
  date: string | null
  target: string | null
}

export interface Goal {
  goals: GoalId[]
  race?: Race
}

export const GOAL_OPTIONS: [GoalId, string][] = [
  ['abnehmen', 'Abnehmen'],
  ['fitter', 'Fitter werden'],
  ['lauf', 'Für einen Lauf trainieren'],
  ['schlaf', 'Besser schlafen'],
]

const ids = new Set(GOAL_OPTIONS.map(([id]) => id))

export function parseGoal(raw: unknown): Goal | null {
  if (!raw || typeof raw !== 'object') return null
  const g = raw as { goals?: unknown; race?: unknown }
  const goals = Array.isArray(g.goals) ? (g.goals.filter((x) => ids.has(x as GoalId)) as GoalId[]) : []
  let race: Race | undefined
  if (g.race && typeof g.race === 'object') {
    const r = g.race as Record<string, unknown>
    race = {
      name: typeof r.name === 'string' ? r.name : '',
      date: typeof r.date === 'string' ? r.date : null,
      target: typeof r.target === 'string' ? r.target : null,
    }
  }
  return { goals, race }
}

/** 'TT.MM.JJJJ' → 'JJJJ-MM-TT', sonst null. */
export function parseGermanDate(text: string): string | null {
  const t = text.trim()
  // Auf dem iPhone fehlt im Ziffernblock der Punkt: „14022027“ ist auch erlaubt.
  const m = t.match(/^(\d{1,2})[.,/-](\d{1,2})[.,/-](\d{4})$/) ?? t.match(/^(\d{2})(\d{2})(\d{4})$/)
  if (!m) return null
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function germanDate(iso: string | null): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

/** 'h:mm:ss' oder 'h:mm' → normalisiert 'h:mm:ss', sonst null. */
export function parseTarget(text: string): string | null {
  const t = text.trim()
  // Nur Ziffern (Ziffernblock ohne Doppelpunkt): „21000“ = 2:10:00.
  const m = t.match(/^(\d{1,2})[:.]([0-5]\d)(?:[:.]([0-5]\d))?$/) ?? t.match(/^(\d{1,2})([0-5]\d)([0-5]\d)$/)
  if (!m) return null
  return `${Number(m[1])}:${m[2]}:${m[3] ?? '00'}`
}

/** Für die Einstellungen: Wert rechts und Unterzeile. */
export function goalSummary(goal: Goal | null): { value: string; sub: string } {
  if (!goal || goal.goals.length === 0) return { value: 'Nicht festgelegt', sub: '' }
  const labels = GOAL_OPTIONS.filter(([id]) => goal.goals.includes(id)).map(([, l]) => l)
  if (goal.goals.includes('lauf') && goal.race?.name) {
    // „Halbmarathon Barcelona“ → Wert „Halbmarathon“, Unterzeile „Barcelona · 14.02.2027 · 2:10:00“
    const [first, ...rest] = goal.race.name.trim().split(/\s+/)
    const others = labels.filter((l) => l !== 'Für einen Lauf trainieren')
    const sub = [rest.join(' '), germanDate(goal.race.date), goal.race.target, others.join(', ')].filter(Boolean).join(' · ')
    return { value: first, sub }
  }
  return { value: labels.length === 1 ? labels[0] : `${labels.length} Ziele`, sub: labels.length > 1 ? labels.join(', ') : '' }
}

/* Entwurf für das Formular (Onboarding Schritt 1 und Einstellungen) */
export interface GoalDraft {
  goals: GoalId[]
  raceName: string
  raceDate: string
  raceTarget: string
}

export function draftFromGoal(goal: Goal | null): GoalDraft {
  return {
    goals: goal?.goals ?? [],
    raceName: goal?.race?.name ?? '',
    raceDate: germanDate(goal?.race?.date ?? null),
    raceTarget: goal?.race?.target ?? '',
  }
}

/** Prüft den Entwurf. Gibt entweder das fertige Ziel oder einen Fehlertext zurück. */
export function goalFromDraft(d: GoalDraft): { goal: Goal } | { error: string } {
  if (d.goals.length === 0) return { error: 'Wähl mindestens ein Ziel.' }
  const goal: Goal = { goals: d.goals }
  if (d.goals.includes('lauf')) {
    const date = d.raceDate.trim() ? parseGermanDate(d.raceDate) : null
    if (d.raceDate.trim() && !date) return { error: 'Das Datum bitte als TT.MM.JJJJ.' }
    const target = d.raceTarget.trim() ? parseTarget(d.raceTarget) : null
    if (d.raceTarget.trim() && !target) return { error: 'Die Wunschzeit bitte als h:mm:ss, z. B. 2:10:00.' }
    goal.race = { name: d.raceName.trim(), date, target }
  }
  return { goal }
}
