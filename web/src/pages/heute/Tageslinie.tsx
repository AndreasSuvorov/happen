import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Entry, Profile } from '../../lib/supabase'
import { Icon, StatusIcon, type IconName } from '../../components/ui'
import { fmt, statusWord, type RecoveryStatus } from '../../lib/format'
import {
  activityLabel,
  addDays,
  baseline,
  fetchActivities,
  fetchCoachSettings,
  fetchDailyMetrics,
  fetchEntries,
  fetchMorningBriefing,
  fetchNotes,
  isRun,
  localDate,
  longDate,
  shortDate,
  shortWeekday,
  useCached,
  type ContextNote,
  type DailyMetrics,
  type MorningBriefing,
  type WearableActivity,
} from '../../lib/coach'
import { metricView, round10, runSummary } from './data'
import './heute.css'

interface LinieData {
  date: string
  briefing: MorningBriefing | null
  days: DailyMetrics[]
  activities: WearableActivity[]
  entries: Entry[]
  notes: ContextNote[]
  cap: number
}

async function loadLinie(date: string): Promise<LinieData> {
  const prev = addDays(date, -1)
  const soft = <T,>(p: Promise<T>, f: T) => p.catch(() => f)
  const [b, days, activities, entries, notes, settings] = await Promise.all([
    soft(fetchMorningBriefing(date), null),
    soft(fetchDailyMetrics(addDays(date, -29), addDays(date, 1)), [] as DailyMetrics[]),
    soft(fetchActivities(prev, date), [] as WearableActivity[]),
    soft(fetchEntries(prev, date), [] as Entry[]),
    soft(fetchNotes(prev, date), [] as ContextNote[]),
    soft(fetchCoachSettings(), null),
  ])
  return { date, briefing: b?.payload ?? null, days, activities, entries, notes, cap: settings?.easy_hr_cap ?? 145 }
}

type Dot = 'normal' | 'flag' | 'planned' | 'now'

interface Ev {
  key: string
  /** lokaler Zeitstempel YYYY-MM-DDTHH:MM zum Sortieren */
  ts: string
  time: string
  icon?: IconName | 'pulse'
  dot?: Dot
  title: string
  detail?: string
  tag?: string
  tagNote?: boolean
  to?: string
  muted?: boolean
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const localTs = (iso: string) => {
  const d = new Date(iso)
  return `${localDate(d)}T${hhmm(d)}`
}
/** Lokale Zeit ohne Zone („2026-11-23T23:05:00“ oder mit Leerzeichen) */
const plainTs = (s: string) => `${s.slice(0, 10)}T${s.slice(11, 16)}`

const hours = (min: number) => fmt(Math.round((min / 60) * 10) / 10, 1)
const cap1 = (s: string) => s.charAt(0).toLocaleUpperCase('de-DE') + s.slice(1)

function activityIcon(type: string): IconName {
  if (isRun(type)) return 'run'
  if (/strength/.test(type)) return 'dumbbell'
  if (/cycling|bike/.test(type)) return 'bike'
  if (/walk|hiking/.test(type)) return 'walk'
  return 'bolt'
}

function noteTitle(n: ContextNote): string {
  if (n.tag === 'plan_verschoben') return 'Plan verschoben'
  if (n.tag === 'plan_anders') return `Statt Plan: ${n.text ?? 'was anderes'}`
  return n.text || (n.tag ? cap1(n.tag) : 'Notiz')
}

function buildEvents(data: LinieData, today: string): Ev[] {
  const { date, days, activities, entries, notes, briefing, cap } = data
  const prev = addDays(date, -1)
  const inRange = (ts: string) => ts.slice(0, 10) === prev || ts.slice(0, 10) === date
  const ev: Ev[] = []

  // Schlaf: Nächte, die am Vortag, am Tag und am Folgetag enden
  for (const d of days.filter((x) => x.date >= prev && x.date <= addDays(date, 1))) {
    if (d.sleep_start_local) {
      const parts = [d.sleep_minutes != null ? `${hours(d.sleep_minutes)} h Schlaf` : null, d.sleep_score != null ? `Score ${d.sleep_score}` : null]
      ev.push({
        key: `sleep-${d.date}`,
        ts: plainTs(d.sleep_start_local),
        time: d.sleep_start_local.slice(11, 16),
        icon: 'moon',
        title: 'Eingeschlafen',
        detail: parts.filter(Boolean).join(' · ') || undefined,
      })
    }
    if (d.sleep_end_local) {
      const hrv = metricView('hrv_last_night', days, d.date)
      const parts = [
        hrv ? `HRV ${hrv.display}, Normalbereich ${hrv.normal}` : d.hrv_last_night != null ? `HRV ${Math.round(d.hrv_last_night)}` : null,
        d.bb_wake != null ? `Body Battery ${d.bb_wake}` : null,
      ]
      ev.push({
        key: `wake-${d.date}`,
        ts: plainTs(d.sleep_end_local),
        time: d.sleep_end_local.slice(11, 16),
        icon: 'sun',
        title: 'Aufgewacht',
        detail: parts.filter(Boolean).join(' · ') || undefined,
        to: d.date === today ? '/warum' : undefined,
      })
    }
  }

  // Auffälligkeit: Abendpuls deutlich über dem Median (wie signals.detectAnomaly)
  const questionNotes = notes.filter((n) => n.source === 'question')
  const flagged = new Set<string>()
  for (const day of [prev, date]) {
    const d = days.find((x) => x.date === day)
    const b = baseline(days, 'evening_hr_avg', day)
    if (d?.evening_hr_avg == null || !b || d.evening_hr_avg < b.median + 12) continue
    if (day === today && new Date().getHours() < 22) continue
    flagged.add(day)
    const answer = questionNotes.find((n) => n.date === day)
    const open = !answer && (day === addDays(today, -1) || day === today)
    ev.push({
      key: `pulse-${day}`,
      ts: `${day}T19:00`,
      time: '19:00',
      icon: 'pulse',
      dot: open ? 'flag' : 'normal',
      title: `Abendpuls ${Math.round(d.evening_hr_avg)}`,
      detail: `Sonst um ${Math.round(b.median)}, zwischen 19 und 22 Uhr`,
      tag: answer ? noteTitle(answer) : open ? 'Frage offen' : undefined,
      tagNote: !!answer,
      to: open ? '/heute' : undefined,
    })
  }

  // Notizen (Antworten auf eine Abendpuls-Frage stehen schon als Etikett dort)
  for (const n of notes) {
    if (n.source === 'question' && flagged.has(n.date)) continue
    const created = localTs(n.created_at)
    const ts = created.slice(0, 10) === n.date ? created : `${n.date}T23:58`
    ev.push({
      key: `note-${n.id}`,
      ts,
      time: created.slice(0, 10) === n.date ? created.slice(11, 16) : '',
      icon: 'note',
      title: noteTitle(n),
      detail: n.source === 'question' ? 'Deine Antwort' : n.source === 'chat' ? 'Aus dem Chat' : 'Notiz',
    })
  }

  // Training von der Uhr
  for (const a of activities) {
    const min = Math.round((a.duration_s ?? 0) / 60)
    const run = isRun(a.type)
    const s = run ? runSummary(a, cap) : null
    ev.push({
      key: `act-${a.external_id}`,
      ts: plainTs(a.started_at_local),
      time: a.started_at_local.slice(11, 16),
      icon: activityIcon(a.type),
      title: `${activityLabel(a.type)}, ${min} Min.`,
      detail: s ? [s.title, a.avg_hr ? `Ø Puls ${a.avg_hr}` : null].filter(Boolean).join(' · ') : a.name ?? undefined,
      to: run ? `/lauf/${encodeURIComponent(a.external_id)}` : undefined,
    })
  }

  // Mahlzeiten
  for (const e of entries) {
    const ts = localTs(e.eaten_at)
    const kcal = `ca. ${fmt(round10(e.kcal_low))}–${fmt(round10(e.kcal_high))} kcal`
    ev.push({
      key: `meal-${e.id}`,
      ts,
      time: ts.slice(11, 16),
      icon: 'food',
      title: e.title,
      detail: e.protein_g ? `${kcal} · ${fmt(Math.round(e.protein_g))} g Eiweiß` : kcal,
      to: ts.slice(0, 10) === today ? '/essen' : undefined,
    })
  }

  const list = ev.filter((e) => inRange(e.ts)).sort((a, b) => a.ts.localeCompare(b.ts))

  // Heute: „Jetzt“ und der noch offene Lauf aus dem Plan
  if (date === today) {
    const now = new Date()
    const nowTs = `${today}T${hhmm(now)}`
    const todayMeals = entries.filter((e) => localDate(new Date(e.eaten_at)) === today)
    const lunch = todayMeals.some((e) => new Date(e.eaten_at).getHours() >= 11)
    const h = now.getHours()
    const mid = todayMeals.reduce((s, e) => s + e.kcal_mid, 0)
    const nowEv: Ev =
      h >= 11 && h < 15 && !lunch
        ? { key: 'now', ts: nowTs, time: 'Jetzt', dot: 'now', title: 'Noch kein Mittagessen', detail: 'Plane eins ein, sonst kommt abends der Heißhunger.' }
        : {
            key: 'now',
            ts: nowTs,
            time: 'Jetzt',
            dot: 'now',
            title: todayMeals.length ? `Bisher ca. ${fmt(round10(mid))} kcal` : 'Heute noch nichts gegessen eingetragen',
            to: '/essen',
          }
    const idx = list.findIndex((e) => e.ts > nowTs)
    list.splice(idx === -1 ? list.length : idx, 0, nowEv)

    const t = briefing?.today
    const ranToday = activities.some((a) => isRun(a.type) && a.started_at_local.startsWith(today))
    if (t && (t.type === 'easy_run' || t.type === 'long_run') && !ranToday) {
      list.push({
        key: 'planned',
        ts: `${today}T99`,
        time: '',
        icon: 'run',
        dot: 'planned',
        muted: true,
        title: `Lauf, ${t.duration_min ?? 40} Min. ${t.type === 'long_run' ? 'lang' : 'locker'}`,
        detail: t.hr_cap ? `Geplant · Puls unter ${t.hr_cap}` : 'Geplant',
        to: '/training',
      })
    }
  }
  return list
}

function PulseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12h4l2-5 4 10 2-5h6" />
    </svg>
  )
}

function Item({ e, last }: { e: Ev; last: boolean }) {
  const body = (
    <>
      <span className="linie-title-row">
        <span className={`linie-title${e.muted ? ' muted' : ''}`}>{e.title}</span>
        {e.tag && <span className={`linie-tag${e.tagNote ? ' note' : ''}`}>{e.tag}</span>}
      </span>
      {e.detail && <span className="linie-detail">{e.detail}</span>}
    </>
  )
  return (
    <li className={`linie-item${last ? ' last' : ''}`}>
      <span className="linie-time">{e.time}</span>
      <span className="linie-axis" aria-hidden="true">
        <span className={`linie-dot ${e.dot ?? 'normal'}`}>
          {e.icon === 'pulse' ? <PulseIcon /> : e.icon && e.dot !== 'now' ? <Icon name={e.icon} size={16} strokeWidth={2} /> : null}
        </span>
      </span>
      {e.to ? (
        <Link to={e.to} className="linie-text">
          {body}
        </Link>
      ) : (
        <div className="linie-text">{body}</div>
      )}
    </li>
  )
}

function planLabel(b: MorningBriefing | null): string {
  const t = b?.today
  if (!t) return ''
  if (t.type === 'easy_run') return `${t.duration_min ?? 40} Min. locker geplant`
  if (t.type === 'long_run') return `${t.duration_min ?? 60} Min. lang geplant`
  if (t.type === 'strength') return 'Kraft geplant'
  return 'Ruhetag'
}

export default function Tageslinie({ profile: _profile }: { profile: Profile }) {
  const params = useParams()
  const navigate = useNavigate()
  const today = localDate()
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : today
  const { data, error } = useCached<LinieData>(`linie:${date}`, () => loadLinie(date), [date])

  const isToday = date === today
  const prev = addDays(date, -1)
  const dayLabel = (d: string) =>
    isToday ? (d === today ? 'Heute' : 'Gestern') : `${longDate(d).split(',')[0]}, ${shortDate(d)}`

  const events = data ? buildEvents(data, today) : []
  // Neueste zuerst: oben „Heute“ mit dem Jüngsten (geplant, Jetzt, …), darunter der Vortag.
  const groups = [date, prev].map((d) => ({ day: d, items: events.filter((e) => e.ts.slice(0, 10) === d).reverse() }))
  const status: RecoveryStatus | null = data?.briefing?.status ?? null
  const plan = planLabel(data?.briefing ?? null)

  return (
    <>
      <div className="linie-top">
        <div className="linie-top-inner">
          <div className="linie-top-status">
            {params.date && (
              <button
                type="button"
                className="btn icon ghost"
                style={{ border: 0, color: 'var(--c-ink)', margin: '-10px 0 -10px -12px' }}
                aria-label="Zurück"
                onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/verlauf'))}
              >
                <Icon name="chevronLeft" size={22} strokeWidth={2} />
              </button>
            )}
            {status && (
              <>
                <StatusIcon status={status} size={12} />
                <span style={{ fontSize: 14, fontWeight: 600 }}>{statusWord[status]}</span>
              </>
            )}
            {plan && <span className="t-13 t-muted">{status ? '· ' : ''}{plan}</span>}
          </div>
          <span className="t-13 t-muted" style={{ flexShrink: 0 }}>
            {shortWeekday(date)}, {shortDate(date)}
          </span>
        </div>
      </div>

      <div className="linie-head">
        <h1>Tageslinie</h1>
        <p>Wie dein Abend, deine Nacht und dein Essen zusammenhängen.</p>
      </div>

      <div className="linie-body">
        {!data ? (
          error ? (
            <p className="empty">Ich konnte den Tag gerade nicht laden.</p>
          ) : (
            <div className="skeleton" style={{ height: 200, marginTop: 14 }} aria-busy="true" />
          )
        ) : events.length === 0 ? (
          <p className="empty">
            Für diesen Tag habe ich noch nichts. Sobald du isst, läufst oder schläfst, füllt sich die Linie.
          </p>
        ) : (
          groups
            .filter((g) => g.items.length > 0)
            .map((g, gi, all) => (
              <section key={g.day} aria-label={dayLabel(g.day)} style={{ display: 'flex', flexDirection: 'column' }}>
                <h2 className="linie-day-label">{dayLabel(g.day)}</h2>
                <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {g.items.map((e, i) => (
                    <Item key={e.key} e={e} last={gi === all.length - 1 && i === g.items.length - 1} />
                  ))}
                </ol>
              </section>
            ))
        )}
      </div>
    </>
  )
}
