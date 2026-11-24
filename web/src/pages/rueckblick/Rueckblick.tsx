import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Profile } from '../../lib/supabase'
import {
  addDays,
  fetchActivities,
  fetchCoachSettings,
  fetchDailyMetrics,
  fetchEntries,
  fetchNotes,
  fetchWeights,
  localDate,
  saveNote,
  useCached,
  weekStart,
} from '../../lib/coach'
import { fmt } from '../../lib/format'
import { Icon } from '../../components/ui'
import { signed } from '../verlauf/werte'
import {
  ANSWERS,
  answerText,
  foodCard,
  patternCard,
  planCard,
  planRows,
  sleepCard,
  trainingCard,
  type Answer,
  type WeekInput,
} from './karten'
import './rueckblick.css'

async function loadWeek(from: string, today: string): Promise<WeekInput> {
  const end = addDays(from, 6)
  const [metrics, activities, entries, weights, notes, settings] = await Promise.all([
    fetchDailyMetrics(addDays(from, -29), addDays(end, 1)),
    fetchActivities(from, end),
    fetchEntries(from, end),
    fetchWeights(addDays(from, -7)),
    fetchNotes(addDays(today, -90), today),
    fetchCoachSettings(),
  ])
  return { from, metrics, activities, entries, weights: weights.filter((w) => w.measured_on <= end), notes, settings }
}

const monthLong = (date: string) =>
  new Intl.DateTimeFormat('de-DE', { month: 'long', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'))

function weekLabel(from: string) {
  const to = addDays(from, 6)
  const d = (x: string) => Number(x.slice(8, 10))
  return from.slice(5, 7) === to.slice(5, 7)
    ? `${d(from)}.–${d(to)}. ${monthLong(to)}`
    : `${d(from)}. ${monthLong(from)}–${d(to)}. ${monthLong(to)}`
}

/* ---------------------------------------------------------------- Karten */
function TrainingBody({ c }: { c: ReturnType<typeof trainingCard> }) {
  return (
    <>
      {c.runs.map((r) => (
        <div key={r.id} className="rb-run">
          <span className={'rb-run-icon' + (r.ok ? ' is-ok' : ' is-warn')}>
            <Icon name={r.ok ? 'check' : 'trendUp'} size={16} strokeWidth={r.ok ? 2.6 : 2.2} />
          </span>
          <span className="rb-run-text">
            <span className="rb-run-title">
              {r.title}
              <span className="sr-only">{r.ok ? ', locker' : ', nicht locker'}</span>
            </span>
            <span className="t-13 t-muted">{r.detail}</span>
          </span>
        </div>
      ))}
      {c.more > 0 && <span className="t-13 t-muted">und {c.more} weitere</span>}
    </>
  )
}

function SleepBody({ c }: { c: ReturnType<typeof sleepCard> }) {
  if (!c.nights.length || c.avg == null) return null
  const yH = (h: number) => 160 - ((Math.max(4, Math.min(9.5, h)) - 4) / 5) * 140
  const best = c.nights.find((n) => n.best)
  const label =
    'Schlaf pro Nacht, Montag bis Sonntag: ' +
    c.nights.map((n) => `${n.day} ${n.hours != null ? fmt(n.hours, 1) + ' Stunden' : 'keine Daten'}`).join(', ') +
    `. Gestrichelt der Durchschnitt ${fmt(c.avg, 1)} Stunden.` +
    (best?.hours != null ? ` Beste Nacht ${best.day} mit ${fmt(best.hours, 1)} Stunden.` : '')
  return (
    <svg viewBox="0 0 342 190" role="img" aria-label={label} className="rb-svg">
      <line x1="0" y1={yH(c.avg)} x2="342" y2={yH(c.avg)} stroke="var(--c-muted)" strokeWidth="1" strokeDasharray="4 4" />
      {c.nights.map((n, i) => {
        const x = i * 51
        const y = n.hours != null ? yH(n.hours) : 160
        return (
          <g key={n.date}>
            {n.hours != null ? (
              <>
                <rect x={x} y={y} width="34" height={160 - y} rx="8" fill={n.best ? 'var(--c-fill)' : 'var(--c-band)'} />
                <text x={x + 17} y={y - 6} textAnchor="middle" fontSize="12" fontWeight={n.best ? 700 : 400} fill="var(--c-ink)" stroke="var(--c-bg)" strokeWidth="4" paintOrder="stroke">
                  {fmt(n.hours, 1)}
                </text>
              </>
            ) : (
              <>
                <rect x={x} y="157" width="34" height="3" rx="1.5" fill="var(--c-track)" />
                <text x={x + 17} y="151" textAnchor="middle" fontSize="12" fill="var(--c-muted)">
                  –
                </text>
              </>
            )}
            <text x={x + 17} y="186" textAnchor="middle" fontSize="12" fill="var(--c-muted)">
              {n.day}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function FoodBody({ c }: { c: ReturnType<typeof foodCard> }) {
  const b = c.bar
  if (!b) return null
  const pct = (v: number) => `${Math.min(100, (v / b.max) * 100)}%`
  return (
    <div className="rb-box">
      <span className="t-13 t-muted">Gegessen pro Tag (Spanne){b.burn != null ? ' und Verbrauch' : ''}</span>
      <div
        className="rb-track"
        role="img"
        aria-label={`Gegessen im Schnitt ${fmt(b.low)} bis ${fmt(b.high)} kcal pro Tag${b.burn != null ? `, Verbrauch etwa ${fmt(b.burn)} kcal` : ''}`}
      >
        <div className="rb-span" style={{ left: pct(b.low), width: `calc(${pct(b.high)} - ${pct(b.low)})` }} />
        {b.burn != null && <div className="rb-tick" style={{ left: pct(b.burn) }} />}
      </div>
      <div className="rb-track-labels t-12 t-muted" aria-hidden="true">
        <span>
          Gegessen {fmt(b.low)}–{fmt(b.high)}
        </span>
        {b.burn != null && <span>Verbrauch ~{fmt(b.burn)}</span>}
      </div>
      <div className="rb-hr" />
      <div className="rb-weight">
        <span className="t-15">Gewicht, 7-Tage-Mittel</span>
        <span className="rb-weight-v">{b.weightDiff != null ? `${signed(b.weightDiff, 1)} kg` : '–'}</span>
      </div>
    </div>
  )
}

function PatternBody({ c }: { c: ReturnType<typeof patternCard> }) {
  if (!c.rows.length) return null
  const max = Math.max(1, ...c.rows.map((r) => r.value ?? 0)) * 1.2
  return (
    <div className="rb-box rb-gap-12">
      <span className="t-13 t-muted">HRV in der Nacht danach</span>
      {c.rows.map((r) => (
        <div key={r.label} className="rb-after">
          <span className="t-15">{r.label}</span>
          <div className="rb-after-track" aria-hidden="true">
            {r.value != null && (
              <div className="rb-after-fill" style={{ width: `${(r.value / max) * 100}%`, background: r.weaker ? 'var(--c-warn)' : 'var(--c-fill)' }} />
            )}
          </div>
          <span className="rb-after-v">
            {r.value != null ? fmt(r.value) : '–'}
            {r.weaker && <span className="sr-only"> (schwächer als sonst)</span>}
          </span>
        </div>
      ))}
      <span className="t-13 t-muted">
        Insgesamt {c.total}× „{c.tag}“ in den letzten 90 Tagen. Mehr dazu unter{' '}
        <Link to="/verlauf/muster" className="rb-inline-link">
          Verlauf, Muster
        </Link>
        .
      </span>
    </div>
  )
}

function PlanBody({ rows }: { rows: { days: string; what: string }[] }) {
  return (
    <div className="rb-plan">
      {rows.map((p) => (
        <div key={p.days} className="rb-plan-row">
          <span className="rb-plan-days">{p.days}</span>
          <span className="t-15">{p.what}</span>
        </div>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- Screen */
export default function Rueckblick({ profile }: { profile: Profile }) {
  const { karte } = useParams()
  const navigate = useNavigate()
  const num = Math.max(1, Math.min(5, Number(karte) || 1))
  const today = localDate()
  const from = addDays(weekStart(today), -7)
  const { data, error } = useCached(`rueckblick-${from}`, () => loadWeek(from, today), [from, today])

  const [answer, setAnswer] = useState<Answer | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const saved = useMemo(() => {
    const thisWeek = weekStart(today)
    const n = data?.notes.filter((x) => x.tag === 'wochenplan_feedback' && x.date >= thisWeek).at(-1)
    return n && (ANSWERS as readonly string[]).includes(n.text ?? '') ? (n.text as Answer) : null
  }, [data, today])
  const chosen = answer ?? saved

  const go = (n: number) => {
    const k = Math.max(1, Math.min(5, n))
    if (k !== num) navigate(`/rueckblick/${k}`, { replace: true })
  }
  const close = () => navigate('/verlauf')

  // Pfeiltasten und Escape
  const goRef = useRef(go)
  const closeRef = useRef(close)
  useEffect(() => {
    goRef.current = go
    closeRef.current = close
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goRef.current(num + 1)
      else if (e.key === 'ArrowLeft') goRef.current(num - 1)
      else if (e.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [num])

  // Wischen
  const touch = useRef<{ x: number; y: number } | null>(null)
  const onTouchStart = (e: TouchEvent) => {
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  }
  const onTouchEnd = (e: TouchEvent) => {
    const s = touch.current
    touch.current = null
    if (!s) return
    const dx = e.changedTouches[0].clientX - s.x
    const dy = e.changedTouches[0].clientY - s.y
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(num + (dx < 0 ? 1 : -1))
  }

  const pick = async (a: Answer) => {
    setAnswer(a)
    setSaving(true)
    setSaveError(null)
    try {
      await saveNote(profile.id, { date: today, tag: 'wochenplan_feedback', text: a, source: 'manual' })
    } catch (e) {
      setAnswer(null)
      setSaveError(`Das hat nicht geklappt. ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const cards = useMemo(() => {
    if (!data) return null
    return { t: trainingCard(data), s: sleepCard(data), f: foodCard(data), p: patternCard(data) }
  }, [data])

  const head = !cards
    ? null
    : num === 1
      ? cards.t
      : num === 2
        ? cards.s
        : num === 3
          ? cards.f
          : num === 4
            ? cards.p
            : planCard

  return (
    <div className="rb" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="rb-top">
        <div role="progressbar" aria-label={`Karte ${num} von 5`} aria-valuemin={1} aria-valuemax={5} aria-valuenow={num} className="rb-progress">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className={i <= num ? 'is-on' : ''} />
          ))}
        </div>
        <div className="rb-bar">
          <span className="t-13 t-muted">Deine Woche · {weekLabel(from)}</span>
          <Link to="/verlauf" aria-label="Rückblick schließen" className="rb-close">
            <Icon name="close" size={22} strokeWidth={2.2} />
          </Link>
        </div>
      </div>

      <div className="rb-stage">
        <button type="button" className="rb-tap rb-tap-prev" aria-label="Vorherige Karte" onClick={() => go(num - 1)} disabled={num === 1} />
        <button type="button" className="rb-tap rb-tap-next" aria-label="Nächste Karte" onClick={() => go(num + 1)} disabled={num === 5} />

        <div className="rb-content" key={num} aria-live="polite">
          {!head && error && <p className="card warn rb-live">Der Rückblick lässt sich gerade nicht laden. {error}</p>}
          {!head && !error && (
            <div aria-busy="true" className="rb-stack">
              <div className="skeleton" style={{ width: 120 }} />
              <div className="skeleton" style={{ height: 90 }} />
              <div className="skeleton" style={{ height: 48 }} />
            </div>
          )}
          {head && cards && (
            <>
              <span className="rb-kicker">{head.kicker}</span>
              <h1 className="rb-head">{head.head}</h1>
              <p className="rb-sub">{head.sub}</p>
              <div className="rb-body">
                {num === 1 && <TrainingBody c={cards.t} />}
                {num === 2 && <SleepBody c={cards.s} />}
                {num === 3 && <FoodBody c={cards.f} />}
                {num === 4 && <PatternBody c={cards.p} />}
                {num === 5 && <PlanBody rows={planRows(data!.settings)} />}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="rb-actions">
        {num === 5 && !chosen && (
          <>
            {saveError && (
              <p className="t-13 rb-center" role="alert">
                {saveError}
              </p>
            )}
            <div role="group" aria-label="Passt das?" className="rb-answers">
              {ANSWERS.map((a, i) => (
                <button key={a} type="button" className={i === 0 ? 'is-primary' : ''} onClick={() => void pick(a)} disabled={saving}>
                  {a}
                </button>
              ))}
            </div>
          </>
        )}
        {num === 5 && chosen && (
          <>
            <p aria-live="polite" className="rb-done pop-in">
              {answerText[chosen]}
            </p>
            <Link to="/training" className="rb-primary">
              Zur neuen Woche
            </Link>
          </>
        )}
        {num < 5 && (
          <button type="button" className="rb-next" onClick={() => go(num + 1)}>
            Weiter
          </button>
        )}
      </div>
    </div>
  )
}
