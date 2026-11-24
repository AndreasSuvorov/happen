import { Link, useSearchParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import {
  addDays,
  fetchActivities,
  fetchDailyMetrics,
  fetchEntries,
  fetchNotes,
  localDate,
  shortWeekday,
  useCached,
  weekStart,
  type ContextNote,
  type DailyMetrics,
  type WearableActivity,
} from '../../lib/coach'
import type { Entry } from '../../lib/supabase'
import { fmt, statusWord, type RecoveryStatus } from '../../lib/format'
import { Icon, StatusIcon, type IconName } from '../../components/ui'
import { activityDay, activityKind, dateRange, hours, kcalByDay, minutes, type ActivityKind } from './werte'

interface WeekData {
  status: { date: string; status: RecoveryStatus | null }[]
  metrics: DailyMetrics[]
  activities: WearableActivity[]
  entries: Entry[]
  notes: ContextNote[]
}

async function loadWeeks(from: string, to: string): Promise<WeekData> {
  const [briefings, metrics, activities, entries, notes] = await Promise.all([
    supabase.from('briefings').select('date,status').eq('kind', 'morning').eq('ref', '').gte('date', from).lte('date', to),
    fetchDailyMetrics(from, to),
    fetchActivities(from, to),
    fetchEntries(from, to),
    fetchNotes(from, to),
  ])
  if (briefings.error) throw new Error(briefings.error.message)
  return { status: (briefings.data ?? []) as WeekData['status'], metrics, activities, entries, notes }
}

const MONTHS = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.']
const monthShort = (date: string) => MONTHS[Number(date.slice(5, 7)) - 1]

/** „23.–29. Nov.“ bzw. „30. Nov.–6. Dez.“ */
function weekRange(from: string): string {
  const to = addDays(from, 6)
  const d = (x: string) => Number(x.slice(8, 10))
  return from.slice(5, 7) === to.slice(5, 7)
    ? `${d(from)}.–${d(to)}. ${monthShort(to)}`
    : `${d(from)}. ${monthShort(from)}–${d(to)}. ${monthShort(to)}`
}

function weekTitle(offset: number, from: string) {
  if (offset === 0) return 'Diese Woche'
  if (offset === 1) return 'Letzte Woche'
  return `Woche ab ${Number(from.slice(8, 10))}. ${monthShort(from)}`
}

const kindIcon: Record<ActivityKind, IconName> = { run: 'run', strength: 'dumbbell', bike: 'bike', walk: 'walk', other: 'bolt' }

function DayRow({ date, today, data }: { date: string; today: string; data: WeekData }) {
  const status = data.status.find((s) => s.date === date)?.status ?? null
  const m = data.metrics.find((x) => x.date === date)
  const acts = data.activities.filter((a) => activityDay(a) === date)
  const trainMin = acts.reduce((s, a) => s + minutes(a), 0)
  // Wichtigstes Training: Lauf vor Kraft vor allem anderen, sonst das längste.
  const main = [...acts].sort((a, b) => {
    const rank = (x: WearableActivity) => ['run', 'strength', 'bike', 'walk', 'other'].indexOf(activityKind(x.type))
    return rank(a) - rank(b) || (b.duration_s ?? 0) - (a.duration_s ?? 0)
  })[0]
  const kcal = kcalByDay(data.entries).get(date)
  const notes = data.notes.filter((n) => n.date === date && n.tag !== 'wochenplan_feedback')
  const sleep = m?.sleep_minutes ? hours(m.sleep_minutes) : '–'
  const kcalText = kcal ? fmt(Math.round(kcal.mid / 10) * 10) : '–'
  const day = shortWeekday(date)
  const dnum = `${Number(date.slice(8, 10))}.`

  const aria = [
    `${day} ${dnum}`,
    status ? statusWord[status].toLowerCase() : 'kein Status',
    m?.sleep_minutes ? `Schlaf ${sleep}` : 'kein Schlaf erfasst',
    acts.length ? `Training ${trainMin} Min.` : 'kein Training',
    kcal ? `${kcalText} kcal` : 'kein Essen erfasst',
    notes.length ? `Notiz: ${notes.map((n) => n.tag ?? n.text).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <Link to={`/tageslinie/${date}`} className={'vl-row' + (date === today ? ' is-today' : '')} aria-label={aria}>
      <span className="vl-cell-icon">{status && <StatusIcon status={status} size={14} />}</span>
      <span className="vl-day">
        {day} <span className="t-muted">{dnum}</span>
      </span>
      <span>{sleep}</span>
      <span className="vl-train">
        {main && <Icon name={kindIcon[activityKind(main.type)]} size={16} strokeWidth={2} className="vl-accent" />}
        {acts.length ? trainMin : '–'}
      </span>
      <span>{kcalText}</span>
      <span className="vl-cell-icon">{notes.length > 0 && <Icon name="note" size={16} strokeWidth={2} className="t-muted" />}</span>
    </Link>
  )
}

export default function Woche() {
  const [params, setParams] = useSearchParams()
  const offset = Math.max(0, Number(params.get('woche')) || 0)
  const today = localDate()
  const thisMonday = weekStart(today)
  const newest = addDays(thisMonday, -7 * offset)
  const oldest = addDays(newest, -7)
  const to = offset === 0 ? today : addDays(newest, 6)
  const { data, error, loading } = useCached(`verlauf-woche-${oldest}`, () => loadWeeks(oldest, to), [oldest, to])

  const setOffset = (n: number) => setParams(n > 0 ? { woche: String(n) } : {}, { replace: true })
  const weeks = [
    { offset, from: newest },
    { offset: offset + 1, from: oldest },
  ]

  return (
    <div className="vl-stack-16">
      {error && !data && <p className="card warn">Der Verlauf lässt sich gerade nicht laden. {error}</p>}
      {weeks.map((w) => {
        const days = dateRange(w.from, w.offset === 0 ? today : addDays(w.from, 6))
        const title = weekTitle(w.offset, w.from)
        return (
          <section key={w.from} aria-label={title} className="vl-week">
            <div className="vl-week-head">
              <h2>{title}</h2>
              <span className="t-13 t-muted">{weekRange(w.from)}</span>
            </div>
            <div className="vl-table">
              <div className="vl-row vl-row-head" aria-hidden="true">
                <span />
                <span />
                <span>Schlaf</span>
                <span>Training</span>
                <span>kcal</span>
                <span />
              </div>
              {data
                ? days.map((d) => <DayRow key={d} date={d} today={today} data={data} />)
                : days.map((d) => (
                    <div key={d} className="vl-row" aria-hidden="true">
                      <span />
                      <span className="skeleton" />
                      <span className="skeleton" />
                      <span className="skeleton" />
                      <span className="skeleton" />
                      <span />
                    </div>
                  ))}
            </div>
          </section>
        )
      })}
      <div className="vl-weeknav">
        <button type="button" className="btn ghost" onClick={() => setOffset(offset + 2)}>
          <Icon name="chevronLeft" size={16} strokeWidth={2} />
          Frühere Wochen
        </button>
        {offset > 0 && (
          <button type="button" className="btn ghost" onClick={() => setOffset(Math.max(0, offset - 2))}>
            Neuere Wochen
            <Icon name="chevronRight" size={16} strokeWidth={2} />
          </button>
        )}
      </div>
      <p className="vl-foot">
        kcal ist die Mitte deiner Schätzung. Tippe auf einen Tag, um seine Tageslinie zu sehen.
        {loading && data ? <span className="sr-only"> Wird aktualisiert.</span> : null}
      </p>
    </div>
  )
}
