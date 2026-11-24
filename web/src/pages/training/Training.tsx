import { Link } from 'react-router-dom'
import type { Profile } from '../../lib/supabase'
import {
  activityLabel,
  addDays,
  fetchActivities,
  fetchCoachSettings,
  isRun,
  localDate,
  useCached,
  weekStart,
  type CoachSettings,
  type WearableActivity,
} from '../../lib/coach'
import { ArrowLink, Icon, type IconName } from '../../components/ui'
import { fetchMorningBriefings, parseGoal, type BriefingRow, type RaceGoal } from './data'
import { DEFAULT_HR_CAP, plannedTraining, templateSummary, weekday, type Deferral, type PlannedTraining } from './plan'
import { duration, isStrength, km, minutes, wasEasy, wasLateSurge } from './run'
import './training.css'

interface TrainingData {
  settings: CoachSettings | null
  briefings: BriefingRow[]
  activities: WearableActivity[]
}

const weekdayLong = (date: string) =>
  new Intl.DateTimeFormat('de-DE', { weekday: 'long', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'))
const weekdayShort = (date: string) =>
  new Intl.DateTimeFormat('de-DE', { weekday: 'short', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z')).replace('.', '')
const monthLong = (date: string) =>
  new Intl.DateTimeFormat('de-DE', { month: 'long', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'))
const dayNum = (date: string) => Number(date.slice(8, 10))

/** „23.–29. November“ bzw. „30. November – 6. Dezember“ */
function weekRange(from: string, to: string): string {
  if (from.slice(5, 7) === to.slice(5, 7)) return `${dayNum(from)}.–${dayNum(to)}. ${monthLong(to)}`
  return `${dayNum(from)}. ${monthLong(from)} – ${dayNum(to)}. ${monthLong(to)}`
}

const countWord = ['Keiner', 'Einer', 'Zwei', 'Drei', 'Vier', 'Fünf', 'Sechs', 'Sieben']
const timesWord = ['Nie', 'Einmal', 'Zweimal', 'Dreimal', 'Viermal', 'Fünfmal', 'Sechsmal', 'Siebenmal']
const n2w = (list: string[], n: number) => list[n] ?? String(n)

function planTitle(t: PlannedTraining): string {
  switch (t.type) {
    case 'easy_run':
      return `${t.duration_min ?? 40} Min. locker`
    case 'long_run':
      return `Langer Lauf, ${t.duration_min ?? 60} Min.`
    case 'strength':
      return 'Kraft'
    default:
      return 'Ruhetag'
  }
}

function planDetail(t: PlannedTraining, date: string, cap: number): string {
  switch (t.type) {
    case 'easy_run':
      return `Puls unter ${t.hr_cap ?? cap}`
    case 'long_run':
      return `Puls unter ${t.hr_cap ?? cap}, ruhig anfangen`
    case 'strength':
      return 'Kraft nach deinem Programm'
    default:
      return weekday(date) === 0 ? 'Abends kommt dein Wochenrückblick' : 'Spazieren tut gut'
  }
}

type RowKind = 'run' | 'strength' | 'rest' | 'other'

interface DayRow {
  date: string
  kind: RowKind
  icon: IconName
  title: string
  detail: string
  done: boolean
  today: boolean
  href: string
}

const fitsPlan = (a: WearableActivity, t: PlannedTraining) =>
  (t.type === 'easy_run' || t.type === 'long_run') ? isRun(a.type) : t.type === 'strength' ? isStrength(a) : false

function activityIcon(a: WearableActivity): IconName {
  if (isRun(a.type)) return 'run'
  if (isStrength(a)) return 'dumbbell'
  if (/cycling|bike/.test(a.type)) return 'bike'
  if (/walk|hiking/.test(a.type)) return 'walk'
  return 'bolt'
}

function activitySummary(a: WearableActivity): string {
  const parts = [`${minutes(a.duration_s)} Min.`]
  if (isRun(a.type) && a.distance_m && a.type !== 'treadmill_running') parts.push(`${km(a.distance_m)} km`)
  return parts.join(' · ')
}

function buildWeek(data: TrainingData, today: string, cap: number): DayRow[] {
  const ws = weekStart(today)
  const allDeferrals = data.briefings
    .filter((b) => b.payload.deferral)
    .map((b) => ({ date: b.date, deferral: b.payload.deferral as Deferral }))
  // Wie buildContext in coach.ts: Verschiebungen aus den Briefings der 14 Tage vor dem Tag
  const deferralsFor = (date: string) =>
    allDeferrals.filter((d) => d.date >= addDays(date, -14) && d.date < date).map((d) => d.deferral)

  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(ws, i)
    const deferrals = deferralsFor(date)
    const base = plannedTraining(date, cap, deferrals)
    const briefing = data.briefings.find((b) => b.date === date)?.payload
    // Für Tage mit Briefing gilt, was das Briefing für den Tag festgelegt hat (inkl. Anpassung bei Gelb/Rot)
    const plan: PlannedTraining = briefing?.today
      ? { type: briefing.today.type, duration_min: briefing.today.duration_min, hr_cap: briefing.today.hr_cap }
      : base
    const movedIn = deferrals.find((d) => d.to === date)
    const movedOut = briefing?.deferral && briefing.deferral.from === date ? briefing.deferral : null
    const acts = data.activities.filter((a) => a.started_at_local.slice(0, 10) === date)
    const match = acts.find((a) => fitsPlan(a, plan)) ?? acts.find((a) => fitsPlan(a, base))
    const other = match ?? acts[0]
    const isToday = date === today

    let title = planTitle(plan)
    let detail = planDetail(plan, date, cap)
    if (movedOut) detail = `Geplanter Lauf rückt auf ${weekdayLong(movedOut.to)}`
    else if (briefing && plan.type !== base.type && briefing.today.text) detail = briefing.today.text.replace(/\.$/, '')
    if (movedIn && !movedOut) detail += ` · verschoben vom ${weekdayLong(movedIn.from)}`

    let kind: RowKind = plan.type === 'rest' ? 'rest' : plan.type === 'strength' ? 'strength' : 'run'
    let icon: DayRow['icon'] = kind === 'rest' ? 'moon' : kind === 'strength' ? 'dumbbell' : 'run'
    let href = isToday ? '/heute' : plan.type === 'rest' && weekday(date) === 0 ? '/rueckblick' : '/chat'

    if (other) {
      if (match) {
        detail = activitySummary(match)
      } else {
        title = `${activityLabel(other.type)}, ${minutes(other.duration_s)} Min.`
        detail = `Geplant war: ${planTitle(plan)}`
        kind = isRun(other.type) ? 'run' : isStrength(other) ? 'strength' : 'other'
        icon = activityIcon(other)
      }
      if (acts.length > 1) detail += ` · +${acts.length - 1} weitere`
      href = isRun(other.type) ? `/lauf/${encodeURIComponent(other.external_id)}` : '/verlauf/woche'
    }

    return { date, kind, icon, title, detail, done: !!other, today: isToday, href }
  })
}

interface WeekSums {
  runs: WearableActivity[]
  runKm: number
  runMin: number
  easyMin: number
  hardMin: number
  strengthMin: number
  easyCount: number
  judged: number
  surges: number
  tooHard: number
}

function sums(acts: WearableActivity[], cap: number): WeekSums {
  const runs = acts.filter((a) => isRun(a.type))
  const s: WeekSums = { runs, runKm: 0, runMin: 0, easyMin: 0, hardMin: 0, strengthMin: 0, easyCount: 0, judged: 0, surges: 0, tooHard: 0 }
  for (const r of runs) {
    const m = minutes(r.duration_s)
    s.runMin += m
    if (r.type !== 'treadmill_running') s.runKm += (r.distance_m ?? 0) / 1000
    const easy = wasEasy(r, cap)
    if (easy !== null) {
      s.judged++
      if (easy) {
        s.easyCount++
        s.easyMin += m
      } else {
        s.hardMin += m
        s.tooHard++
      }
    }
    if (wasLateSurge(r)) s.surges++
  }
  for (const a of acts) if (isStrength(a)) s.strengthMin += minutes(a.duration_s)
  return s
}

function sumsLine(s: WeekSums, prefix: string): string | null {
  const parts: string[] = []
  if (s.runMin) {
    let p = `Laufen ${duration(s.runMin)}`
    if (s.judged) p += `, davon ${duration(s.easyMin)} locker${s.hardMin ? ` und ${duration(s.hardMin)} härter` : ''}`
    parts.push(p)
  }
  if (s.strengthMin) parts.push(`Kraft ${duration(s.strengthMin)}`)
  return parts.length ? `${prefix} ${parts.join(' · ')}` : null
}

function lastWeekText(s: WeekSums, cap: number): { headline: string; body: string | null } {
  const n = s.runs.length
  if (n === 0) {
    return {
      headline: s.strengthMin ? 'Kein Lauf, aber Kraft trainiert.' : 'Letzte Woche hat deine Uhr kein Training geliefert.',
      body: null,
    }
  }
  const indoor = s.runs.some((r) => r.type === 'treadmill_running')
  const outdoorKm = s.runKm > 0 ? `, ${km(s.runKm * 1000)} km${indoor ? ' draußen' : ''}` : ''
  let headline = `${n === 1 ? '1 Lauf' : `${n} Läufe`}${outdoorKm}.`
  if (s.judged === n) {
    if (s.easyCount === n && n > 1) headline += ' Alle wirklich locker.'
    else if (s.easyCount === n) headline += ' Wirklich locker.'
    else if (n > 1) headline += ` ${n2w(countWord, s.easyCount)} davon wirklich locker.`
  }
  let body: string | null = null
  if (s.surges > 0) body = `${n2w(timesWord, s.surges)} bist du am Ende zu schnell geworden. Der Pulsalarm auf ${cap} hilft.`
  else if (s.tooHard > 0)
    body = `${n2w(timesWord, s.tooHard)} lag der Puls über deiner Grenze von ${cap}. Der Pulsalarm auf ${cap} hilft.`
  return { headline, body }
}

function GoalCard({ goal, today }: { goal: RaceGoal | null; today: string }) {
  if (!goal) {
    return (
      <section aria-label="Dein Ziel" className="card soft">
        <span className="kicker">Dein Ziel</span>
        <p className="t-15">Noch kein Ziel festgelegt. Ein Wettkampf gibt dem Plan eine Richtung.</p>
        <ArrowLink to="/chat">Mit dem Coach festlegen</ArrowLink>
      </section>
    )
  }
  const days = goal.date ? Math.round((Date.parse(goal.date + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000) : null
  const weeks = days !== null && days >= 7 ? Math.ceil(days / 7) : null
  const phases = ['Grundlage', 'Aufbau', 'Spezifisch', 'Taper']
  // Das Backend kennt bisher nur die Vorlage der Grundlagen-Phase; eine explizite Phase in goal.phase gewinnt.
  const found = goal.phase ? phases.findIndex((p) => p.toLowerCase().startsWith(goal.phase!.toLowerCase().slice(0, 4))) : -1
  const current = found >= 0 ? found : 0
  const sub = [
    goal.date
      ? new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' })
          .format(new Date(goal.date + 'T12:00:00Z'))
          .replace('.,', ',')
      : null,
    goal.target ? `Wunschzeit ${goal.target}` : null,
  ].filter(Boolean)
  return (
    <section aria-label="Dein Ziel" className="card tr-goal">
      <div className="tr-goal-head">
        <div className="tr-goal-text">
          <span className="kicker">Dein Ziel</span>
          <p className="tr-goal-name">{goal.name}</p>
          {sub.length > 0 && <span className="t-15 t-muted">{sub.join(' · ')}</span>}
        </div>
        {weeks !== null ? (
          <div className="tr-goal-count">
            <span className="tr-goal-num">{weeks}</span>
            <span className="t-13 t-muted">Wochen</span>
          </div>
        ) : days !== null && days >= 0 ? (
          <div className="tr-goal-count">
            <span className="tr-goal-num">{days}</span>
            <span className="t-13 t-muted">{days === 1 ? 'Tag' : 'Tage'}</span>
          </div>
        ) : null}
      </div>
      <ol className="tr-phases" aria-label={`Phase: ${phases[current]}`}>
        {phases.map((p, i) => (
          <li key={p} className={i === current ? 'now' : undefined} aria-current={i === current ? 'step' : undefined}>
            <span className={`tr-phase-bar${i <= current ? ' on' : ''}`} />
            <span>{p}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function DayIcon({ row }: { row: DayRow }) {
  const cls = row.done ? 'done' : row.kind === 'rest' ? 'rest' : row.today ? 'today' : ''
  return (
    <span className={`tr-day-icon ${cls}`}>
      <Icon name={row.icon} size={18} strokeWidth={2} />
    </span>
  )
}

export default function Training({ profile }: { profile: Profile }) {
  const today = localDate()
  const ws = weekStart(today)
  const we = addDays(ws, 6)
  const lastWs = addDays(ws, -7)
  const { data, error, loading } = useCached<TrainingData>(
    `training:${ws}`,
    async () => {
      const [settings, briefings, activities] = await Promise.all([
        fetchCoachSettings(),
        fetchMorningBriefings(addDays(ws, -14), we),
        fetchActivities(lastWs, we),
      ])
      return { settings, briefings, activities }
    },
    [ws],
  )

  const initial = (profile.first_name ?? '').trim().charAt(0).toUpperCase()
  const header = (
    <header className="page-header">
      <h1 className="page-title">Training</h1>
      <Link to="/einstellungen" className="tr-avatar" aria-label="Profil und Einstellungen">
        {initial || <Icon name="settings" size={20} />}
      </Link>
    </header>
  )

  if (!data) {
    return (
      <div className="page tr-page">
        {header}
        {error ? (
          <p className="empty">Der Plan lässt sich gerade nicht laden. Prüf deine Verbindung.</p>
        ) : (
          <>
            <div className="skeleton" style={{ height: 120, borderRadius: 18 }} />
            <div className="skeleton" style={{ height: 420, borderRadius: 18 }} />
          </>
        )}
      </div>
    )
  }

  const cap = data.settings?.easy_hr_cap ?? DEFAULT_HR_CAP
  const rows = buildWeek(data, today, cap)
  const thisWeek = sums(data.activities.filter((a) => a.started_at_local.slice(0, 10) >= ws), cap)
  const lastWeek = sums(data.activities.filter((a) => a.started_at_local.slice(0, 10) < ws), cap)
  const last = lastWeekText(lastWeek, cap)
  const lastLine = sumsLine(lastWeek, 'Insgesamt:')
  const thisLine = sumsLine(thisWeek, 'Bisher:')

  return (
    <div className="page tr-page" aria-busy={loading}>
      {header}

      <GoalCard goal={parseGoal(data.settings?.goal)} today={today} />

      <section aria-label="Diese Woche" className="tr-week">
        <div className="tr-week-head">
          <h2 className="section-title" style={{ padding: 0 }}>Diese Woche</h2>
          <span className="t-13 t-muted">{weekRange(ws, we)}</span>
        </div>
        <ul className="card flush tr-days">
          {rows.map((r) => (
            <li key={r.date}>
              <Link to={r.href} className={`tr-day${r.today ? ' is-today' : ''}`}>
                <span className="tr-day-date">
                  <span className="tr-day-wd">{weekdayShort(r.date)}</span>
                  <span className="t-12 t-muted">{dayNum(r.date)}.</span>
                </span>
                <DayIcon row={r} />
                <span className="tr-day-text">
                  <span className={`tr-day-title${r.kind === 'rest' && !r.done ? ' rest' : ''}`}>{r.title}</span>
                  <span className="t-13 t-muted">{r.detail}</span>
                </span>
                <span className="tr-day-end">
                  {r.done && (
                    <span className="tr-done">
                      <Icon name="check" size={16} strokeWidth={2.6} />
                      Erledigt
                    </span>
                  )}
                  {r.today && !r.done && <span className="tr-today">Heute</span>}
                  {!r.today && !r.done && <Icon name="chevronRight" size={16} strokeWidth={2} className="t-muted" />}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {thisLine && <p className="tr-note">{thisLine}</p>}
        <p className="tr-note">
          Bei „Etwas müde“ oder „Heute schonen“ passe ich den Tag an und schiebe den Lauf auf den nächsten freien Tag. Das
          siehst du dann hier und auf „Heute“.
        </p>
      </section>

      <section aria-label="Letzte Woche" className="card soft">
        <span className="kicker">Letzte Woche</span>
        <p className="tr-last-head">{last.headline}</p>
        {last.body && <p className="t-15">{last.body}</p>}
        {lastLine && <p className="t-13 t-muted">{lastLine}</p>}
        <ArrowLink to="/verlauf/woche">Im Verlauf ansehen</ArrowLink>
      </section>

      <section aria-label="Wochenvorlage" className="card">
        <span className="kicker">Vorlage für die Grundlagen-Phase</span>
        <p className="t-15">{templateSummary()}</p>
        <ArrowLink to="/chat">Mit dem Coach anpassen</ArrowLink>
      </section>
    </div>
  )
}
