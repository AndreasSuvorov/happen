import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Profile } from '../../lib/supabase'
import { Icon, RangeBar, SpanBar, StatusIcon } from '../../components/ui'
import { fmt, statusWord, type RecoveryStatus } from '../../lib/format'
import {
  daysUntilBaseline,
  localDate,
  longDate,
  saveNote,
  triggerSync,
  useCached,
  type ContextNote,
  type WearableActivity,
} from '../../lib/coach'
import {
  foodTotals,
  headlineMetrics,
  currentHour,
  hoursSince,
  isRunActivity,
  kcalGoal,
  loadHeute,
  planView,
  questionView,
  round10,
  round50,
  runSummary,
  shortLabel,
  shortUnit,
  statusSentence,
  templateTraining,
  type HeuteData,
  type PlanView,
  type QuestionView,
} from './data'
import './heute.css'

type Zustand = 'normal' | 'keine-uhr' | 'lernen' | 'nicht-sync' | 'abgelaufen'

const LEARN_DAYS = 10

export default function Heute({ profile }: { profile: Profile }) {
  const today = localDate()
  const { data, error, setData } = useCached<HeuteData>(`heute:${today}`, () => loadHeute(today), [today])
  const initial = profile.first_name?.trim().charAt(0).toUpperCase()

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title small">{longDate(today)}</h1>
        <Link to="/einstellungen" className="heute-avatar" aria-label="Profil und Einstellungen">
          {initial || <Icon name="settings" size={20} />}
        </Link>
      </header>
      {data ? (
        <HeuteBody profile={profile} data={data} setData={setData} />
      ) : error ? (
        <p className="empty">Ich konnte deinen Tag gerade nicht laden. Prüfe die Verbindung und öffne Heute nochmal.</p>
      ) : (
        <HeuteSkeleton />
      )}
    </div>
  )
}

function HeuteSkeleton() {
  return (
    <div aria-busy="true" aria-label="Lädt" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 4px' }}>
      <div className="skeleton" style={{ height: 34, width: '60%' }} />
      <div className="skeleton" style={{ height: 40 }} />
      <div className="skeleton" style={{ height: 130, borderRadius: 18 }} />
      <div className="skeleton" style={{ height: 150, borderRadius: 18 }} />
    </div>
  )
}

function zustandOf(data: HeuteData): Zustand {
  if (!data.wearable || !data.wearable.connected) return 'keine-uhr'
  if (data.wearable.status === 'expired') return 'abgelaufen'
  const night = data.days.find((d) => d.date === data.date)
  if (!night || (night.sleep_minutes == null && night.hrv_last_night == null)) return 'nicht-sync'
  if (daysUntilBaseline(data.days, data.date) > 0) return 'lernen'
  return 'normal'
}

function HeuteBody({
  profile,
  data,
  setData,
}: {
  profile: Profile
  data: HeuteData
  setData: (d: HeuteData) => void
}) {
  const zustand = zustandOf(data)
  const briefing = data.briefing
  const status: RecoveryStatus | null = zustand === 'normal' ? (briefing?.status ?? 'unknown') : null
  const cap = data.settings?.easy_hr_cap ?? 145
  const useTemplate = zustand !== 'normal' || !briefing || briefing.status === 'unknown'
  const training = useTemplate ? templateTraining(data.date, cap) : briefing.today
  const plan = planView(training, useTemplate ? null : briefing, status ?? 'unknown')
  const run = [...data.activities].reverse().find(isRunActivity)
  const addNote = (note: ContextNote) => setData({ ...data, notes: [...data.notes, note] })

  return (
    <>
      {zustand === 'abgelaufen' && <ExpiredCard lastDataAt={data.wearable?.lastDataAt} />}
      {zustand === 'normal' && <StatusSection data={data} status={status ?? 'unknown'} />}
      {zustand === 'lernen' && <LearnSection data={data} />}
      {zustand === 'nicht-sync' && <NotSyncedSection data={data} setData={setData} />}
      {zustand === 'abgelaufen' && (
        <section aria-label="Erholung" style={{ padding: '4px 4px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h2 className="section-title" style={{ padding: 0 }}>Heute kein Erholungsstatus</h2>
          <p className="heute-muted-p">Ohne neue Daten von deiner Uhr kann ich nicht sagen, wie erholt du bist.</p>
        </section>
      )}
      {zustand === 'keine-uhr' && <ConnectCard />}

      {zustand !== 'keine-uhr' &&
        (run ? (
          <RunDoneCard run={run} cap={cap} planned={plan.isRun} />
        ) : (
          <PlanCard plan={plan} zustand={zustand} profile={profile} data={data} onNote={addNote} />
        ))}

      <FoodCard profile={profile} data={data} status={status} ran={!!run} planRun={zustand !== 'keine-uhr' && plan.isRun} />

      <QuestionCard
        key={data.date}
        profile={profile}
        q={questionView(data, status, zustand === 'keine-uhr')}
        onNote={addNote}
      />

      <Link to="/tageslinie" className="link-arrow heute-linie-link">
        Tageslinie
        <Icon name="chevronDown" size={16} strokeWidth={2} />
      </Link>
    </>
  )
}

/* ---------------------------------------------------------------------------
 * Erholung
 * ------------------------------------------------------------------------- */
function StatusSection({ data, status }: { data: HeuteData; status: RecoveryStatus }) {
  const briefing = data.briefing
  const reasons = briefing?.reasons ?? []
  const metrics = headlineMetrics(status, data.days, data.date, reasons)
  const sentence = briefing
    ? statusSentence(status, briefing, data.days, data.date)
    : 'Dein Morgenbriefing ist noch nicht fertig. Bis dahin siehst du hier deine Werte von heute Nacht.'
  return (
    <section aria-label="Erholung" className="heute-status">
      <div className="heute-status-head">
        <div className="heute-status-row">
          <div className="heute-status-word">
            <StatusIcon status={status} size={16} />
            <h2 className="heute-big">{statusWord[status]}</h2>
          </div>
          <Link to="/warum" className="heute-why">
            Warum?
            <Icon name="chevronRight" size={16} strokeWidth={2} />
          </Link>
        </div>
        <p className="heute-muted-p">{sentence}</p>
        {status === 'red' && (
          <Link to="/warum#achten" className="link-arrow">
            Worauf du achten solltest
            <Icon name="chevronRight" size={16} strokeWidth={2} />
          </Link>
        )}
      </div>
      {metrics.length > 0 && (
        <div className="heute-metrics">
          {metrics.map((m) => (
            <div key={m.metric} className="heute-metric">
              <div className="heute-metric-top">
                <span className="t-13 t-muted">{shortLabel[m.metric]}</span>
                <b>
                  {m.display} {shortUnit[m.metric] && <span className="heute-unit">{shortUnit[m.metric]}</span>}
                </b>
              </div>
              <RangeBar
                value={m.value}
                low={m.low}
                high={m.high}
                min={m.min}
                max={m.max}
                label={`${shortLabel[m.metric]} ${m.display}, normal ${m.normal}`}
              />
              <span className="t-12 t-muted">Normal {m.normal}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function LearnSection({ data }: { data: HeuteData }) {
  const day = Math.max(1, Math.min(LEARN_DAYS, LEARN_DAYS - daysUntilBaseline(data.days, data.date)))
  const night = data.days.find((d) => d.date === data.date)
  const values = [
    { label: 'HRV', value: night?.hrv_last_night, unit: 'ms' },
    { label: 'Schlafpuls', value: night?.sleep_hr_avg, unit: 'bpm' },
  ].filter((v): v is { label: string; value: number; unit: string } => v.value != null)
  return (
    <section aria-label="Erholung" className="heute-status">
      <div className="heute-status-word">
        <StatusIcon status="unknown" size={16} />
        <h2 className="heute-big">Ich lerne dich kennen</h2>
      </div>
      <p className="heute-muted-p">
        Nach etwa 10 Tagen kenne ich deinen Normalbereich. Bis dahin zeige ich dir deine Werte, aber noch ohne Urteil.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div
          className="heute-learn"
          role="progressbar"
          aria-label={`Tag ${day} von ${LEARN_DAYS}`}
          aria-valuemin={0}
          aria-valuemax={LEARN_DAYS}
          aria-valuenow={day}
        >
          {Array.from({ length: LEARN_DAYS }, (_, i) => (
            <span key={i} className={i < day ? 'on' : undefined} />
          ))}
        </div>
        <span className="t-13 t-muted">
          Tag {day} von {LEARN_DAYS}
        </span>
      </div>
      {values.length > 0 && (
        <div className="heute-metrics">
          {values.map((v) => (
            <div key={v.label} className="heute-value">
              <span className="t-13 t-muted">{v.label}</span>
              <b>
                {fmt(Math.round(v.value))} <span className="heute-unit">{v.unit}</span>
              </b>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function NotSyncedSection({ data, setData }: { data: HeuteData; setData: (d: HeuteData) => void }) {
  const [checking, setChecking] = useState(false)
  const [nothingNew, setNothingNew] = useState(false)
  const hours = hoursSince(data.wearable?.lastDataAt ?? data.wearable?.lastSyncAt)
  const since =
    hours === null
      ? 'Deine Uhr hat heute noch nicht mit dem Handy abgeglichen.'
      : `Deine Uhr hat seit ${hours === 1 ? 'einer Stunde' : `${hours} Stunden`} nicht mit dem Handy abgeglichen.`

  async function recheck() {
    setChecking(true)
    setNothingNew(false)
    try {
      await triggerSync()
      const fresh = await loadHeute(data.date)
      setData(fresh)
      if (zustandOf(fresh) === 'nicht-sync') setNothingNew(true)
    } catch {
      setNothingNew(true)
    } finally {
      setChecking(false)
    }
  }

  return (
    <section aria-label="Erholung" className="heute-status tight">
      <div className="heute-status-word">
        <Icon name="sync" size={18} strokeWidth={2} style={{ color: 'var(--c-muted)', flexShrink: 0 }} />
        <h2 className="heute-big">Deine Nacht ist noch nicht da</h2>
      </div>
      <p className="heute-muted-p">{since} Öffne kurz Garmin Connect, dann prüfe ich nochmal.</p>
      <button type="button" className="heute-secondary-btn" onClick={recheck} disabled={checking}>
        <Icon name="sync" size={16} strokeWidth={2} />
        {checking ? 'Prüfe …' : 'Nochmal prüfen'}
      </button>
      <p className="t-13 t-muted" aria-live="polite" style={{ margin: 0 }}>
        {nothingNew ? 'Noch nichts Neues angekommen. Versuch es gleich nochmal.' : ''}
      </p>
    </section>
  )
}

function ExpiredCard({ lastDataAt }: { lastDataAt?: string | null }) {
  const hours = hoursSince(lastDataAt)
  const since =
    hours === null
      ? 'Gerade kommen keine neuen Daten.'
      : hours < 24
        ? `Seit ${hours <= 1 ? 'einer Stunde' : `${hours} Stunden`} kommen keine neuen Daten.`
        : hours < 48
          ? 'Seit gestern kommen keine neuen Daten.'
          : `Seit ${Math.floor(hours / 24)} Tagen kommen keine neuen Daten.`
  return (
    <section role="status" aria-label="Garmin-Verbindung abgelaufen" className="heute-warn">
      <span className="heute-warn-title">
        <Icon name="key" size={18} strokeWidth={2} />
        Garmin-Verbindung abgelaufen
      </span>
      <span className="t-15">{since} Ein neuer Schlüssel dauert 2 Minuten.</span>
      <Link to="/onboarding/2?erneuern" className="heute-warn-link">
        So erneuerst du ihn
        <Icon name="chevronRight" size={16} strokeWidth={2} />
      </Link>
    </section>
  )
}

function ConnectCard() {
  return (
    <section aria-label="Uhr verbinden" className="card" style={{ gap: 6, marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="icon-tile sm">
          <Icon name="watch" size={20} />
        </span>
        <span style={{ fontSize: 17, fontWeight: 600 }}>Verbinde deine Uhr</span>
      </div>
      <p className="heute-muted-p">
        Dann kann ich dir jeden Morgen sagen, wie erholt du bist, und deine Läufe einordnen.
      </p>
      <Link to="/onboarding/2" className="btn primary" style={{ alignSelf: 'flex-start', marginTop: 6 }}>
        Uhr verbinden
      </Link>
    </section>
  )
}

/* ---------------------------------------------------------------------------
 * Plan
 * ------------------------------------------------------------------------- */
const OTHER_CHOICES = ['Kraft', 'Radfahren', 'Spaziergang', 'Anderes']

function PlanCard({
  plan,
  zustand,
  profile,
  data,
  onNote,
}: {
  plan: PlanView
  zustand: Zustand
  profile: Profile
  data: HeuteData
  onNote: (n: ContextNote) => void
}) {
  const [mode, setMode] = useState<'closed' | 'menu' | 'anders'>('closed')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const existing = [...data.notes]
    .reverse()
    .find((n) => n.date === data.date && (n.tag === 'plan_verschoben' || n.tag === 'plan_anders'))

  const autoText =
    zustand === 'nicht-sync'
      ? 'Ich passe ihn an, sobald deine Nacht da ist'
      : zustand === 'abgelaufen'
        ? 'Heute ohne Anpassung. Hör auf dein Gefühl'
        : zustand === 'lernen'
          ? 'Aus deiner Wochenvorlage. Anpassen kann ich ab Tag 10'
          : plan.isRun
            ? 'Hakt sich nach dem Lauf selbst ab'
            : ''
  const canChange = plan.type !== 'rest'

  async function store(tag: 'plan_verschoben' | 'plan_anders', text: string) {
    setSaving(true)
    setFailed(false)
    try {
      const note = await saveNote(profile.id, { date: data.date, tag, text, source: 'manual' })
      onNote(note)
      setMode('closed')
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const confirmation = existing
    ? existing.tag === 'plan_verschoben'
      ? 'Notiert. Kein Problem, dann verschieben wir das.'
      : `Notiert: ${existing.text ?? 'was anderes'} statt Plan.`
    : null

  return (
    <section aria-label="Dein Plan" className="card">
      <span className="t-13 t-muted">Dein Plan heute</span>
      <p className="heute-card-title">{plan.title}</p>
      {plan.sub && <p className="heute-muted-p">{plan.sub}</p>}
      {autoText && !confirmation && (
        <span className="heute-auto">
          <Icon name="sync" size={14} strokeWidth={2} />
          {autoText}
        </span>
      )}
      {confirmation && (
        <div className="heute-done-row pop-in" role="status" style={{ marginTop: 6 }}>
          <span className="heute-check">
            <Icon name="check" size={16} strokeWidth={2.6} />
          </span>
          <span className="t-15">{confirmation}</span>
        </div>
      )}
      <div className="heute-plan-actions">
        <Link to="/training" className="heute-plan-btn">
          Woche ansehen
          <Icon name="chevronRight" size={16} strokeWidth={2} />
        </Link>
        {canChange && !confirmation && (
          <button
            type="button"
            className="heute-plan-more"
            aria-label="Weitere Optionen"
            aria-expanded={mode !== 'closed'}
            onClick={() => setMode(mode === 'closed' ? 'menu' : 'closed')}
          >
            <Icon name="more" size={20} />
          </button>
        )}
      </div>
      {mode === 'menu' && (
        <div className="heute-plan-options">
          <button
            type="button"
            className="heute-plan-option"
            disabled={saving}
            onClick={() => store('plan_verschoben', plan.title)}
          >
            Verschieben
          </button>
          <button type="button" className="heute-plan-option" disabled={saving} onClick={() => setMode('anders')}>
            Was anderes gemacht
          </button>
        </div>
      )}
      {mode === 'anders' && (
        <div className="chips wrap" role="group" aria-label="Was hast du gemacht?" style={{ marginTop: 6 }}>
          {OTHER_CHOICES.map((c) => (
            <button key={c} type="button" className="chip" disabled={saving} onClick={() => store('plan_anders', c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      {failed && (
        <p className="t-13" role="alert" style={{ color: 'var(--c-danger)' }}>
          Konnte ich nicht speichern. Versuch es nochmal.
        </p>
      )}
    </section>
  )
}

function endClock(a: WearableActivity): string {
  const [h, m] = a.started_at_local.slice(11, 16).split(':').map(Number)
  const total = (h * 60 + m + Math.round((a.duration_s ?? 0) / 60)) % (24 * 60)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function RunDoneCard({ run, cap, planned }: { run: WearableActivity; cap: number; planned: boolean }) {
  const s = runSummary(run, cap)
  return (
    <section aria-label="Dein Lauf" className="card">
      <span className="t-13 t-muted">
        {planned ? 'Dein Plan · erledigt' : 'Dein Lauf'} · von deiner Uhr, {endClock(run)}
      </span>
      <div className="heute-done-row pop-in">
        <span className="heute-check">
          <Icon name="check" size={16} strokeWidth={2.6} />
        </span>
        <p className="heute-card-title">{s.title}</p>
      </div>
      <p className="heute-muted-p">{s.sub}</p>
      <Link to={`/lauf/${encodeURIComponent(run.external_id)}`} className="link-arrow">
        Zur Laufanalyse
        <Icon name="chevronRight" size={16} strokeWidth={2} />
      </Link>
    </section>
  )
}

/* ---------------------------------------------------------------------------
 * Essen
 * ------------------------------------------------------------------------- */
function FoodCard({
  profile,
  data,
  status,
  ran,
  planRun,
}: {
  profile: Profile
  data: HeuteData
  status: RecoveryStatus | null
  ran: boolean
  planRun: boolean
}) {
  const t = foodTotals(data.entries, data.date)
  const goal = kcalGoal(profile, data)
  const proteinGoal = data.weightKg ? Math.round(data.weightKg * 1.2) : null
  const left = goal !== null ? goal - t.mid : null
  const hour = currentHour()
  const little = goal !== null && t.mid < goal * 0.3 && hour >= 10

  let hint = data.briefing?.food?.trim() ?? ''
  if (!hint) {
    if (status === 'red') hint = 'Auch ohne Training: Iss heute normal. Erholung braucht Energie.'
    else if (ran)
      hint =
        data.runKcal > 0
          ? `Nach dem Lauf darfst du heute etwa ${fmt(round50(data.runKcal * 0.5))} kcal mehr essen, am besten mit Eiweiß.`
          : 'Nach dem Lauf darfst du heute etwas mehr essen, am besten mit Eiweiß.'
    else if (little && status === 'yellow') hint = 'Bisher wenig gegessen. Ein richtiges Mittagessen hilft dir beim Erholen.'
    else if (little && planRun) hint = 'Lauftag und bisher wenig gegessen. Plane ein sättigendes Mittagessen ein.'
    else if (little) hint = 'Bisher wenig gegessen. Plane ein sättigendes Mittagessen ein.'
  }

  const headline =
    left === null ? (
      <>
        {t.count ? `Bisher etwa ${fmt(round10(t.mid))}` : 'Noch nichts erfasst'}{' '}
        {t.count > 0 && <small>kcal</small>}
      </>
    ) : left > 0 ? (
      <>
        Noch etwa {fmt(round50(left))} <small>kcal</small>
      </>
    ) : (
      <>Tagesziel erreicht</>
    )

  const max = Math.max(goal ?? 0, t.high, 1)
  return (
    <section aria-label="Essen heute" className="card heute-food">
      <div className="heute-food-head">
        <Link to="/essen" className="heute-food-link">
          <span className="t-13 t-muted">Essen heute</span>
          <span className="heute-food-left">{headline}</span>
        </Link>
        <Link to="/essen/erfassen" className="heute-add">
          <Icon name="plus" size={18} strokeWidth={2.4} />
          Erfassen
        </Link>
      </div>
      <div className="heute-bars">
        <div className="heute-bar">
          <div className="heute-bar-label">
            <span className="t-muted">Energie</span>
            <span>
              <b>{t.count ? `ca. ${fmt(round10(t.mid))}` : '0'}</b>{' '}
              {goal !== null && <span className="t-muted">von {fmt(goal)} kcal</span>}
              {goal === null && <span className="t-muted">kcal</span>}
            </span>
          </div>
          <SpanBar
            low={t.low}
            high={t.high}
            max={max}
            label={`Bisher ${fmt(round10(t.low))} bis ${fmt(round10(t.high))} kcal${goal ? ` von ${fmt(goal)}` : ''}`}
          />
        </div>
        {proteinGoal !== null && (
          <div className="heute-bar">
            <div className="heute-bar-label">
              <span className="t-muted">Eiweiß</span>
              <span>
                <b>{fmt(Math.round(t.protein))}</b> <span className="t-muted">von {fmt(proteinGoal)} g</span>
              </span>
            </div>
            <SpanBar
              low={t.protein}
              high={t.protein}
              max={proteinGoal}
              label={`${fmt(Math.round(t.protein))} von ${fmt(proteinGoal)} g Eiweiß`}
            />
          </div>
        )}
      </div>
      {goal === null && (
        <p className="t-13 t-muted" style={{ margin: 0 }}>
          Für ein Tagesziel fehlen mir Größe, Geburtsjahr, Geschlecht oder dein Gewicht.
        </p>
      )}
      {hint && <p className="heute-p">{hint}</p>}
    </section>
  )
}

/* ---------------------------------------------------------------------------
 * Frage
 * ------------------------------------------------------------------------- */
function QuestionCard({
  profile,
  q,
  onNote,
}: {
  profile: Profile
  q: QuestionView | null
  onNote: (n: ContextNote) => void
}) {
  const navigate = useNavigate()
  const [answered, setAnswered] = useState<{ label: string; thanks: string } | null>(null)
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherText, setOtherText] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  if (answered) {
    return (
      <section aria-live="polite" className="heute-thanks pop-in">
        <span className="heute-check lg">
          <Icon name="check" size={18} strokeWidth={2.4} />
        </span>
        <p className="heute-p">
          <strong>Notiert: {answered.label}.</strong> {answered.thanks}
        </p>
      </section>
    )
  }
  if (!q) return null

  async function answer(label: string, tag: string, text: string) {
    if (!q) return
    setSaving(true)
    setFailed(false)
    try {
      const note = await saveNote(profile.id, { date: q.date, tag, text, source: 'question' })
      setAnswered({ label, thanks: q.thanks })
      onNote(note)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  function pick(option: string) {
    if (q?.food && option === 'Ja, nachtragen') {
      navigate('/essen/erfassen')
      return
    }
    if (option === 'Andere…') {
      setOtherOpen(true)
      return
    }
    void answer(option, option.toLocaleLowerCase('de-DE'), option)
  }

  function submitOther(e: FormEvent) {
    e.preventDefault()
    const text = otherText.trim()
    if (text) void answer(text, 'andere', text)
  }

  return (
    <section aria-label="Eine Frage" className="heute-question">
      <span className="t-13 t-muted pad">{q.kicker}</span>
      <p className="heute-p pad" style={{ fontWeight: 600 }}>
        {q.text}
      </p>
      {otherOpen ? (
        <form className="heute-question-form" onSubmit={submitOther}>
          <label className="sr-only" htmlFor="heute-andere">
            Was war los?
          </label>
          <input
            id="heute-andere"
            className="input"
            autoFocus
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="Kurz in eigenen Worten"
            enterKeyHint="send"
          />
          <button type="submit" className="btn primary" disabled={saving || !otherText.trim()}>
            Senden
          </button>
        </form>
      ) : (
        <div className="chips">
          {q.options.map((o) => (
            <button key={o} type="button" className="chip" disabled={saving} onClick={() => pick(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      {failed && (
        <p className="t-13 pad" role="alert" style={{ margin: '6px 0 0', color: 'var(--c-danger)' }}>
          Konnte ich nicht speichern. Versuch es nochmal.
        </p>
      )}
    </section>
  )
}
