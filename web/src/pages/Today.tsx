import { useCallback, useEffect, useRef, useState } from 'react'
import { addDays } from '../../../supabase/functions/_shared/garmin/transform.ts'
import { supabase } from '../lib/supabase'
import TodayIcon from '../components/TodayIcon'
import recoveryLandscape from '../assets/recovery-landscape.webp'
import {
  activityKind, buildTimeline, cacheToday, number, prettyDate, readToday, todayNutrition,
  todayRecovery, wearableSummary, type ContextNote, type PlanAction, type TodayData,
} from '../lib/today'

const recoveryLabels = { green: 'Gut erholt', yellow: 'Etwas müde',
  red: 'Heute schonen', unknown: 'Erholung noch offen' } as const
const recoveryIcons = { green: 'pulse', yellow: 'moon', red: 'rest', unknown: 'more' } as const
const otherActivities = ['Krafttraining', 'Radfahren', 'Spaziergang', 'Laufen', 'Schwimmen', 'Sonstiges']

export default function Today({ authUserId, openSettings, openCapture }: {
  authUserId: string; openSettings: () => void; openCapture: () => void
}) {
  const [snapshot, setSnapshot] = useState(() => readToday(authUserId))
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const revision = useRef(0)
  const snapshotRef = useRef(snapshot)
  const lifecycle = useRef<AbortController | null>(null)

  const commit = useCallback((next: TodayData | null) => {
    snapshotRef.current = next
    cacheToday(authUserId, next)
    setSnapshot(next)
  }, [authUserId])

  const refresh = useCallback(async () => {
    const signal = lifecycle.current?.signal
    if (signal?.aborted) return
    const current = ++revision.current
    const request = supabase.rpc('happen_today').retry(false)
    const { data, error, status } = await (signal ? request.abortSignal(signal) : request)
    if (signal?.aborted || current !== revision.current) return
    setLoading(false)
    if (error) {
      if (status === 401 || status === 403) {
        commit(null)
      }
      setMessage(status === 0 ? 'Offline · letzter gespeicherter Stand' : 'Heute konnte nicht aktualisiert werden.')
      return
    }
    commit(data as TodayData | null)
    setMessage('')
  }, [commit])

  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    const visible = () => {
      if (!controller.signal.aborted && document.visibilityState === 'visible' && navigator.onLine) void refresh()
    }
    queueMicrotask(visible)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', visible)
    return () => {
      controller.abort()
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh])

  function update(patch: Partial<TodayData>) {
    if (lifecycle.current?.signal.aborted || !snapshotRef.current || snapshotRef.current.date !== snapshot?.date) return
    revision.current++
    commit({ ...snapshotRef.current, ...patch })
  }

  if (!snapshot) return (
    <div className="screen today-screen">
      <h1>Heute</h1>
      <p role="status">{!navigator.onLine ? 'Für heute ist auf diesem Gerät noch kein Stand gespeichert.'
        : message || (loading ? 'Lädt …' : 'Dein Profil wird vorbereitet.')}</p>
      {message && navigator.onLine && <button onClick={refresh}>Erneut laden</button>}
    </div>
  )

  const question = snapshot.briefing?.question
  const pending = question && !snapshot.notes.some((note) => note.date === question.date)

  return (
    <div className="screen today-screen">
      <header className="today-heading">
        <h1>Heute</h1>
        <time className="date-heading" dateTime={snapshot.date}>{prettyDate(snapshot.date)}</time>
      </header>
      {(message || !navigator.onLine) && <p className="muted" role="status">{message || 'Offline · letzter gespeicherter Stand'}</p>}
      <RecoveryCard snapshot={snapshot} openSettings={openSettings} refresh={refresh} />
      <div className="today-summary">
        {snapshot.connection && snapshot.briefing?.today && <PlanCard
          key={snapshot.date} snapshot={snapshot} onChange={(plan_action) => update({ plan_action })}
        />}
        <NutritionCard snapshot={snapshot} openCapture={openCapture} />
      </div>
      <QuestionCard key={`${snapshot.date}:${question?.date ?? ''}`} snapshot={snapshot}
        open={!!pending} onAnswer={(note) => update({ notes: [...snapshot.notes, note] })} />
      <Timeline snapshot={snapshot} />
    </div>
  )
}

function RecoveryCard({ snapshot, openSettings, refresh }: {
  snapshot: TodayData; openSettings: () => void; refresh: () => Promise<void>
}) {
  const [syncing, setSyncing] = useState(false)
  const [feedback, setFeedback] = useState('')
  const why = useRef<HTMLDialogElement>(null)
  const { day, status, days, metrics } = todayRecovery(snapshot)
  const label = recoveryLabels[status]
  const { connection, garmin } = snapshot
  if (!connection) return (
    <section className="card today-card">
      <h2>Erholung</h2>
      <p>Verbinde deine Uhr, dann kann ich dir sagen, wie erholt du bist.</p>
      {garmin && <button className="today-link" onClick={openSettings}>Garmin verbinden</button>}
    </section>
  )
  if (connection.status === 'expired') return (
    <section className="card today-card today-expired">
      <h2>Garmin-Verbindung abgelaufen</h2>
      <p>Erstell in Garmin Connect einen neuen Personal API Key und füge ihn in Happen ein.</p>
      <button className="today-link" onClick={openSettings}>Garmin-Schlüssel erneuern</button>
    </section>
  )

  async function sync() {
    setSyncing(true)
    setFeedback('')
    try {
      const { data, error } = await supabase.functions.invoke('garmin-sync', { body: {} })
      if (error || data?.status === 'error') throw error ?? new Error('garmin-sync')
      await refresh()
      if (data?.skipped === 'too_soon') setFeedback('Vor Kurzem geprüft. Versuch es in einer Minute nochmal.')
      else if (data?.status === 'ok' && !data?.newData) setFeedback('Garmin hat noch keine neuen Daten.')
      else if (data?.status === 'ok') setFeedback('Garmin-Daten aktualisiert.')
    } catch {
      setFeedback('Garmin konnte gerade nicht geprüft werden. Versuch es später nochmal.')
    } finally {
      setSyncing(false)
    }
  }
  const needsNight = !day?.sleep_end_local || day.sleep_uncertain || day.hrv_last_night == null
  const comparisons = metrics.filter((metric) => metric.baseline).slice(0, 2)
  const description = needsNight ? 'Deine Nacht ist noch nicht da. Öffne kurz Garmin Connect auf dem Handy.'
    : days < 10 ? `Ich lerne dich noch kennen (Tag ${days} von 10).`
      : comparisons.length ? '' : snapshot.briefing?.why || 'Für heute fehlen vergleichbare Werte.'

  return (
    <section className={`recovery-hero recovery-${status}`}>
      <div className="recovery-landscape" aria-hidden="true">
        <img src={recoveryLandscape} alt="" fetchPriority="high" />
      </div>
      <div className="recovery-overview">
        <div className="recovery-title">
          <h2>Erholung</h2>
          <strong>{label}</strong>
        </div>
        <div className="recovery-orbit" aria-hidden="true"><TodayIcon name={recoveryIcons[status]} size={31} /></div>
      </div>
      {description && <p className="recovery-description">{description}</p>}
      {!description && <div className="recovery-metrics">
        {comparisons.map(({ id, label, value, unit, baseline }) => baseline && (
          <div key={id}>
            <span>{label}</span>
            <strong>{number(value)} <small>{unit}</small></strong>
            <small>Normal {number(baseline.low)}{baseline.high !== baseline.low && '–' + number(baseline.high)}</small>
          </div>
        ))}
      </div>}
      {connection.backfill && days < 10 && <p className="recovery-description">Ich lade deine letzten vier Wochen.</p>}
      <div className="recovery-actions">
        {metrics.length > 0 && <button onClick={() => why.current?.showModal()}>Warum? <TodayIcon name="chevron" size={15} /></button>}
        <button onClick={sync} disabled={syncing || !navigator.onLine}>
          <TodayIcon name="sync" size={15} /> {syncing ? 'Prüft …' : 'Nochmal prüfen'}
        </button>
      </div>
      {feedback && <p className="recovery-description" role="status">{feedback}</p>}
      <dialog ref={why} className="today-dialog" aria-labelledby="why-heading">
        <form method="dialog" className="dialog-heading">
          <h2 id="why-heading">Warum {label.toLowerCase()}?</h2>
          <button className="today-link">Schließen</button>
        </form>
        {metrics.map(({ id, label: name, value, unit, baseline, explanation }) => {
          const low = Math.min(value, baseline?.low ?? value)
          const high = Math.max(value, baseline?.high ?? value)
          const margin = Math.max((high - low) * 0.2, 1)
          const position = (n: number) => 100 * (n - low + margin) / (high - low + 2 * margin)
          return (
            <div className="why-metric" key={id}>
              <strong>{name} · {number(value)} {unit}</strong>
              {baseline && <>
                <div className="today-meter" aria-hidden="true">
                  <i className="meter-target" style={{ left: `${position(baseline.low)}%`, width: `${position(baseline.high) - position(baseline.low)}%` }} />
                  <i className="meter-marker" style={{ left: `${position(value)}%` }} />
                </div>
                <span className="muted">Normalbereich {number(baseline.low)}–{number(baseline.high)} {unit}</span>
              </>}
              <p className="muted">{explanation}</p>
            </div>
          )
        })}
      </dialog>
    </section>
  )
}

function PlanCard({ snapshot, onChange }: { snapshot: TodayData; onChange: (action: PlanAction) => void }) {
  const [busy, setBusy] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState('')
  const plan = snapshot.briefing!.today
  const action = snapshot.plan_action
  const plannedKind = plan.type === 'strength' ? 'strength' : plan.type.endsWith('_run') ? 'run' : null
  const completed = snapshot.wearable_activities.find((item) => item.started_at_local.startsWith(snapshot.date) &&
    plannedKind !== null && activityKind(item.type) === plannedKind)
  const run = snapshot.wearable_activities.find((item) => item.started_at_local.startsWith(snapshot.date) && activityKind(item.type) === 'run')
  const runSummary = run && wearableSummary(run)
  const manualMatch = snapshot.activities.some((item) => item.local_time.startsWith(snapshot.date) &&
    plannedKind !== null && activityKind(item.type) === plannedKind)

  async function save(action: PlanAction['action'], activity: string | null = null) {
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.from('coach_plan_actions').upsert({ user_id: snapshot.user_id, date: snapshot.date, action, activity })
      if (error) throw error
      onChange({ action, activity })
      setChoosing(false)
    } catch {
      setError('Die Planänderung konnte nicht gespeichert werden.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="today-card plan-card">
      <div className="plan-content">
        <span className="plan-icon"><TodayIcon name="route" /></span>
        <div><h2>Dein Plan</h2>
      {run && runSummary && plannedKind !== 'strength' ? (
        <a className="today-run" href={`#garmin-${run.provider}-${run.external_id}`} onClick={() => {
          const item = document.getElementById(`garmin-${run.provider}-${run.external_id}`)
          if (item instanceof HTMLDetailsElement) item.open = true
        }}>
          <strong>{runSummary.verdict || 'Lauf aufgezeichnet'}</strong>
          {runSummary.duration != null && <span>{number(runSummary.duration)} min</span>}
        </a>
      ) : <p className="plan-text">{plan.text}</p>}
        </div>
      </div>
      {action ? <p className="today-confirm" role="status">{action.action === 'move' ? 'Auf morgen verschoben.'
        : action.action === 'other' ? `Notiert: ${action.activity}` : 'Erledigt ✓'}</p>
        : <>{(completed || manualMatch) ? <p className="today-confirm">Erledigt · Aktivität erkannt</p>
          : plannedKind && <div className="today-actions plan-actions">
            <button className="today-chip" disabled={busy} onClick={() => save('done')}><TodayIcon name="check" size={17} />Erledigt</button>
            {!snapshot.briefing?.deferral && <button className="today-link" disabled={busy} onClick={() => save('move')}>Verschieben</button>}
            <button className="plan-more" aria-label="Hab was anderes gemacht" title="Hab was anderes gemacht" disabled={busy}
              aria-expanded={choosing} onClick={() => setChoosing(!choosing)}><TodayIcon name="more" size={22} /></button>
          </div>}</>}
      {choosing && <div className="plan-options">
        <p className="muted">Andere Aktivität</p>
        <div className="today-actions">
          {otherActivities.map((activity) => <button key={activity} className="today-chip" disabled={busy}
            onClick={() => save('other', activity)}>{activity}</button>)}
        </div>
      </div>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}

function NutritionCard({ snapshot, openCapture }: { snapshot: TodayData; openCapture: () => void }) {
  const { count, low, high, protein, proteinTarget, target } = todayNutrition(snapshot)
  const max = Math.max(high, target?.high ?? 0, 1) * 1.08
  const percent = (n: number) => `${100 * n / max}%`
  const ring = Math.min(1, protein / (proteinTarget || 1))
  return (
    <section className="today-card nutrition-card">
      <h2>Essen heute</h2>
      {!count ? <button className="today-link" onClick={openCapture}>Erste Mahlzeit eintragen</button> : (
        <>
          <div className="nutrition-grid">
            <div>
              <div className="today-energy"><strong>{number(low)}–{number(high)}</strong> <span>kcal</span></div>
              <div className="today-meter" aria-hidden="true">
                {target && <i className="meter-target" style={{ left: percent(target.low), width: percent(target.high - target.low) }} />}
                <i className="meter-intake" style={{ left: percent(low), width: percent(high - low) }} />
              </div>
              {target && <p className="muted">Ziel {number(target.low)}{target.low !== target.high && `–${number(target.high)}`} kcal</p>}
            </div>
            <div className="today-protein">
              {proteinTarget != null && <span className="protein-ring" style={{ '--progress': `${ring * 360}deg` } as React.CSSProperties} aria-hidden="true" />}
              <strong>{number(protein)} g</strong>
              <span className="muted">Eiweiß{proteinTarget != null && ` · Richtwert ${proteinTarget} g`}</span>
            </div>
          </div>
          {snapshot.briefing?.food && !snapshot.briefing.food.startsWith('Für gestern') && <p className="muted">{snapshot.briefing.food}</p>}
        </>
      )}
      {snapshot.briefing?.weigh && snapshot.weight?.date !== snapshot.date && <p className="muted">Ab halb acht kannst du dich kurz wiegen.</p>}
    </section>

  )
}

function QuestionCard({ snapshot, open, onAnswer }: { snapshot: TodayData; open: boolean; onAnswer: (note: ContextNote) => void }) {
  const [custom, setCustom] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [noted, setNoted] = useState(false)
  const timer = useRef<number>(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const question = snapshot.briefing?.question
  if (!question || (!open && !noted)) return null

  async function answer(option: string, text?: string) {
    setBusy(true)
    setError('')
    try {
      const { data, error } = await supabase.rpc('answer_coach_question', {
        p_briefing_date: snapshot.date, p_option: option, p_text: text ?? null,
      })
      if (error || !data) throw error
      setNoted(true)
      onAnswer(data as ContextNote)
      timer.current = window.setTimeout(() => setNoted(false), 1800)
    } catch {
      setError('Die Antwort konnte nicht gespeichert werden.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="today-card question-card" aria-label="Coach-Rückfrage">
      {noted ? <p className="today-confirm" role="status">Notiert ✓</p> : <>
        <h2>Eine Frage</h2>
        <p className="question-text">{question.text}</p>
        <div className="today-actions question-options">
          {question.options.map((option) => <button className="today-chip" disabled={busy} key={option}
            onClick={() => option === 'Andere…' ? setCustom(true) : answer(option)}>{option}</button>)}
        </div>
        {custom && <form className="today-answer" onSubmit={(event) => {
          event.preventDefault()
          if (value.trim()) void answer('Andere…', value.trim())
        }}>
          <label>Deine Antwort<input value={value} maxLength={200} required onChange={(event) => setValue(event.target.value)} /></label>
          <button disabled={busy || !value.trim()}>Notieren</button>
        </form>}
        {error && <p className="error" role="alert">{error}</p>}
      </>}
    </section>
  )
}

function Timeline({ snapshot }: { snapshot: TodayData }) {
  const events = buildTimeline(snapshot)
  const yesterday = addDays(snapshot.date, -1)
  return (
    <section className="today-timeline" id="tageslinie">
      <h2>Tageslinie</h2>
      {[snapshot.date, yesterday].map((date) => (
        <div key={date}>
          <h3>{date === snapshot.date ? 'Heute' : 'Gestern'} <span className="muted">· {prettyDate(date)}</span></h3>
          {events.some((event) => event.date === date) ? (
            <ol className="timeline-list">
              {events.filter((event) => event.date === date).map((event) => {
                const facts = event.facts.filter(Boolean)
                const line = <>
                  <span className="timeline-time">{event.time || '—'}</span>
                  <span className="timeline-icon" aria-hidden="true"><TodayIcon name={event.icon === '☾' ? 'moon' : event.icon === '☀' ? 'sun'
                    : event.icon === '◈' ? 'meal' : event.icon === '·' ? 'note' : 'pulse'} size={16} /></span>
                  <span className="timeline-label"><strong>{event.title}</strong>{event.summary && <span className="muted">{event.summary}</span>}</span>
                </>
                return <li key={event.id}>{facts.length || event.id.startsWith('garmin-') ? (
                  <details id={event.id}>
                    <summary>{line}<span className="timeline-arrow"><TodayIcon name="chevron" size={16} /></span></summary>
                    <div className="timeline-details">
                      {facts.length ? facts.map((fact, i) => <div key={i}>{fact}</div>) : 'Aktivität von Garmin übernommen.'}
                    </div>
                  </details>
                ) : <div className="timeline-row">{line}</div>}</li>
              })}
            </ol>
          ) : <p className="muted">Noch keine Einträge.</p>}
        </div>
      ))}
    </section>
  )
}
