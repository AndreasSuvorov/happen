import { useCallback, useEffect, useRef, useState } from 'react'
import { addDays } from '../../../supabase/functions/_shared/garmin/transform.ts'
import { supabase } from '../lib/supabase'
import TodayIcon from '../components/TodayIcon'
import RunAnalysis from './RunAnalysis'
import recoveryLandscape from '../assets/recovery-landscape.webp'
import {
  activityKind, buildTimeline, cacheToday, number, prettyDate, readToday, todayNutrition,
  todayRecovery, wearableSummary, nutritionContext, showRange, type ContextNote, type PlanAction, type TodayData, type WearableActivity,
} from '../lib/today'

const recoveryLabels = {
  green: ['●', 'Gut erholt'], yellow: ['◐', 'Etwas müde'], red: ['○', 'Heute schonen'],
  learning: ['◌', 'Ich lerne dich noch kennen'], missing: ['–', 'Deine Nacht ist noch nicht da'],
  unknown: ['◌', 'Erholung noch offen'],
} as const
const otherActivities = ['Krafttraining', 'Radfahren', 'Spaziergang', 'Laufen', 'Schwimmen', 'Sonstiges']

export default function Today({ authUserId, profileInitial, openSettings, openCapture }: {
  authUserId: string; profileInitial?: string; openSettings: () => void; openCapture: () => void
}) {
  const [snapshot, setSnapshot] = useState(() => readToday(authUserId))
  const [selectedRun, setSelectedRun] = useState<WearableActivity | null>(null)
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

  const recovery = todayRecovery(snapshot)
  const question = snapshot.briefing?.question
  const pending = question && !snapshot.notes.some((note) => note.date === question.date)

  return (
    <div className="screen today-screen">
      {selectedRun && <RunAnalysis activity={selectedRun} onClose={() => setSelectedRun(null)} />}
      <header className="today-heading">
        <h1>Heute</h1>
        <time className="date-heading" dateTime={snapshot.date}>{prettyDate(snapshot.date)}</time>
        <button className="today-profile" aria-label="Einstellungen" onClick={openSettings}>
          {profileInitial || <TodayIcon name="person" size={19} />}
        </button>
      </header>
      {(message || !navigator.onLine) && <p className="muted" role="status">{message || 'Offline · letzter gespeicherter Stand'}</p>}
      <RecoveryCard snapshot={snapshot} recovery={recovery} openSettings={openSettings} refresh={refresh} />
      <div className="today-summary">
        {snapshot.connection && snapshot.briefing?.today && <PlanCard
          key={snapshot.date} snapshot={snapshot} state={recovery.state} openRun={setSelectedRun}
          onChange={(plan_action) => update({ plan_action })}
        />}
        <NutritionCard snapshot={snapshot} openCapture={openCapture} />
      </div>
      <QuestionCard key={`${snapshot.date}:${question?.date ?? ''}`} snapshot={snapshot}
        open={!!pending} onAnswer={(note) => update({ notes: [...snapshot.notes, note] })} />
      <Timeline snapshot={snapshot} openRun={setSelectedRun} />
    </div>
  )
}

function RecoveryCard({ snapshot, recovery, openSettings, refresh }: {
  snapshot: TodayData; recovery: ReturnType<typeof todayRecovery>; openSettings: () => void; refresh: () => Promise<void>
}) {
  const [syncing, setSyncing] = useState(false)
  const [feedback, setFeedback] = useState('')
  const why = useRef<HTMLDialogElement>(null)
  const { state, days, metrics, explain } = recovery
  const [symbol, label] = recoveryLabels[state]
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
  const showingMetrics = state !== 'missing' && state !== 'learning'

  return (
    <section className={`recovery-hero recovery-${state}`} data-recovery={state}>
      <div className="recovery-landscape" aria-hidden="true">
        <img src={recoveryLandscape} alt="" fetchPriority="high" />
        {state === 'learning' && <img className="landscape-learned" src={recoveryLandscape} alt=""
          style={{ clipPath: `inset(0 ${(10 - days) * 10}% 0 0)` }} />}
      </div>
      <div className="recovery-content">
        <div className="recovery-title">
          <div className="recovery-heading">
            <h2><span className="recovery-symbol" aria-hidden="true">{symbol}</span>{label}</h2>
            {showingMetrics && metrics.length > 0 && <button className="recovery-action" onClick={() => why.current?.showModal()}>
              Warum? <TodayIcon name="chevron" size={15} />
            </button>}
          </div>
          <p className="recovery-description">{explain}</p>
        </div>
        {state === 'learning' && <progress className="recovery-progress" value={days} max={10} aria-label="Messtage für deinen Normalbereich" />}
        {state === 'missing' && <button className="recovery-action" onClick={sync} disabled={syncing || !navigator.onLine}>
            <TodayIcon name="sync" size={15} /> {syncing ? 'Prüft …' : 'Nochmal prüfen'}
        </button>}
        {feedback && <p className="recovery-description" role="status">{feedback}</p>}
      </div>
      <dialog ref={why} className="today-dialog" aria-labelledby="why-heading">
        <form method="dialog" className="dialog-heading">
          <h2 id="why-heading">Warum?</h2>
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
                <span className="muted">Normalbereich {showRange(baseline)} {unit}</span>
              </>}
              <p className="muted">{explanation}</p>
            </div>
          )
        })}
      </dialog>
    </section>
  )
}

function PlanCard({ snapshot, state, openRun, onChange }: {
  snapshot: TodayData; state: ReturnType<typeof todayRecovery>['state']
  openRun: (run: WearableActivity) => void; onChange: (action: PlanAction) => void
}) {
  const [busy, setBusy] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState('')
  const briefing = snapshot.briefing!
  const plan = state === 'red' ? { type: 'rest', text: 'Ruhetag. Ein Spaziergang ist optional.' } : briefing.today
  const planText = state === 'yellow' && briefing.status === 'green' && plan.type.endsWith('_run')
    ? 'Lauf heute kürzer und lockerer.' : plan.text
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
      <h2>Dein Plan</h2>
      {state !== 'red' && run && runSummary && plannedKind !== 'strength' ? (
        <a className="today-run" href={`#garmin-${run.provider}-${run.external_id}`} onClick={(event) => {
          if (run.analysis?.verdict) {
            event.preventDefault()
            openRun(run)
            return
          }
          const item = document.getElementById(`garmin-${run.provider}-${run.external_id}`)
          if (item instanceof HTMLDetailsElement) item.open = true
        }}>
          <strong>{runSummary.verdict || 'Lauf aufgezeichnet'}{run.analysis?.verdict === 'easy_ok' && ' ✓'}</strong>
          {run.analysis?.share_below_cap != null && run.analysis.easy_hr_cap != null
            ? <span>{number(run.analysis.share_below_cap * 100)} % unter {number(run.analysis.easy_hr_cap)} bpm</span>
            : runSummary.duration != null && <span>{number(runSummary.duration)} min</span>}
        </a>
      ) : <p className="plan-text">{planText}</p>}
      {state !== 'red' && (action ? <p className="today-confirm" role="status">{action.action === 'move' ? 'Auf morgen verschoben.'
        : action.action === 'other' ? `Notiert: ${action.activity}` : 'Erledigt ✓'}</p>
        : <>{(completed || manualMatch) ? <p className="today-confirm">Erledigt · Aktivität erkannt</p>
          : plannedKind && <div className="today-actions plan-actions">
            <button className="today-chip" disabled={busy} onClick={() => save('done')}><TodayIcon name="check" size={16} />Erledigt</button>
            <details className="plan-menu">
              <summary>Plan ändern <TodayIcon name="chevron" size={16} /></summary>
              <div className="today-actions">
                {!snapshot.briefing?.deferral && <button className="today-link" disabled={busy} onClick={() => save('move')}>Verschieben</button>}
                <button className="today-link" disabled={busy} aria-expanded={choosing}
                  onClick={() => setChoosing(!choosing)}>Andere Aktivität</button>
              </div>
              {choosing && <div className="today-actions plan-options">
                {otherActivities.map((activity) => <button key={activity} className="today-chip" disabled={busy}
                  onClick={() => save('other', activity)}>{activity}</button>)}
              </div>}
            </details>
          </div>}</>)}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}

function NutritionCard({ snapshot, openCapture }: { snapshot: TodayData; openCapture: () => void }) {
  const intake = todayNutrition(snapshot)
  const { count, low, high, protein, proteinTarget, target } = intake
  const foodTip = nutritionContext(snapshot, intake)
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
              <div className="today-energy"><strong>{number(low)}–{number(high)}</strong> <span>kcal erfasst</span></div>
              <div className="today-meter kcal-meter" aria-hidden="true">
                {target && <i className="meter-target" style={{ left: percent(target.low), width: percent(target.high - target.low) }} />}
                <i className="meter-intake" style={{ left: percent(low), width: percent(high - low) }} />
              </div>
              {target && <p className="muted kcal-key"><i aria-hidden="true" />Ziel {number(target.low)}{target.low !== target.high && `–${number(target.high)}`} kcal</p>}
            </div>
            <div className="today-protein">
              <div className="protein-value">
                {proteinTarget != null && <span className="protein-ring" style={{ '--progress': `${ring * 360}deg` } as React.CSSProperties} aria-hidden="true" />}
                <strong>{number(protein)} g</strong>
              </div>
              <span className="muted">Eiweiß{proteinTarget != null && ` · Richtwert ${proteinTarget} g`}</span>
            </div>
          </div>
          {foodTip && <p className="muted food-context">{foodTip}</p>}
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
  const [selected, setSelected] = useState<string | null>(null)
  const timer = useRef<number>(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const question = snapshot.briefing?.question
  if (!question || (!open && !noted)) return null

  async function answer(option: string, text?: string) {
    setBusy(true)
    setSelected(option)
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
      setSelected(null)
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
          {question.options.map((option) => <button className="today-chip" aria-pressed={option === selected} disabled={busy} key={option}
            onClick={() => {
              if (option === 'Andere…') {
                setCustom(true)
                setSelected(option)
              } else {
                void answer(option)
              }
            }}>{option}</button>)}
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

function Timeline({ snapshot, openRun }: { snapshot: TodayData; openRun: (run: WearableActivity) => void }) {
  const yesterday = addDays(snapshot.date, -1)
  const events = buildTimeline(snapshot).filter((event) => event.date !== yesterday || !event.time || event.time >= '18:00')
  return (
    <section className="today-timeline" id="tageslinie">
      <h2>Tageslinie</h2>
      {[yesterday, snapshot.date].map((date) => (
        <div key={date}>
          <h3>{date === snapshot.date ? 'Heute' : 'Gestern'} <span className="muted">· {prettyDate(date)}</span></h3>
          {events.some((event) => event.date === date) ? (
            <ol className="timeline-list">
              {events.filter((event) => event.date === date).map((event) => {
                const facts = event.facts.filter(Boolean)
                const run = snapshot.wearable_activities.find((item) =>
                  `garmin-${item.provider}-${item.external_id}` === event.id && item.analysis?.verdict && activityKind(item.type) === 'run')
                const line = <>
                  <span className="timeline-time">{event.time || '—'}</span>
                  <span className="timeline-icon" aria-hidden="true"><TodayIcon name={event.icon === '☾' ? 'moon' : event.icon === '☀' ? 'sun'
                    : event.icon === '◈' ? 'meal' : event.icon === '·' ? 'note' : 'pulse'} size={16} /></span>
                  <span className="timeline-label"><strong>{event.title}</strong>{event.summary && <span className="muted">{event.summary}</span>}</span>
                </>
                return <li key={event.id}>{run ? (
                  <button className="timeline-row timeline-open" onClick={() => openRun(run)}>{line}<TodayIcon name="chevron" size={16} /></button>
                ) : facts.length || event.id.startsWith('garmin-') ? (
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
