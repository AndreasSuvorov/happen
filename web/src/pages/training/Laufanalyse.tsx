import { useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import type { Profile } from '../../lib/supabase'
import {
  activityLabel,
  addDays,
  clock,
  fetchActivities,
  fetchActivity,
  fetchCoachSettings,
  fetchNotes,
  isRun,
  localDate,
  saveNote,
  shortDate,
  shortWeekday,
  useCached,
  type ContextNote,
  type WearableActivity,
} from '../../lib/coach'
import { fmt } from '../../lib/format'
import { Icon, SubBar } from '../../components/ui'
import { LAUFBAND_TAG } from './data'
import { HrChart, ZoneBars } from './HrChart'
import { DEFAULT_HR_CAP, nextLongRun } from './plan'
import {
  analysisOf,
  compareText,
  feelLine,
  findComparable,
  isTreadmill,
  judgeRun,
  km,
  minutes,
  validSeries,
  type RunJudgement,
} from './run'
import './training.css'

interface RunData {
  run: WearableActivity | null
  cap: number
  history: WearableActivity[]
  speedNotes: ContextNote[]
}

const COMPARE_DAYS = 120
const SPEEDS = ['7,0', '7,5', '8,0', '8,5']

const dateOf = (a: WearableActivity) => a.started_at_local.slice(0, 10)
const weekdayLong = (date: string) =>
  new Intl.DateTimeFormat('de-DE', { weekday: 'long', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'))

function metaLine(a: WearableActivity): string {
  const date = dateOf(a)
  const parts = [`${shortWeekday(date)}, ${shortDate(date)}`, clock(a.started_at_local).replace(/^0(\d)/, '$1')]
  if (a.duration_s) parts.push(`${minutes(a.duration_s)} Min.`)
  if (isTreadmill(a)) parts.push('Laufband')
  else {
    if (a.distance_m && a.distance_m >= 200) parts.push(`${km(a.distance_m)} km`)
    if (isRun(a.type)) parts.push('draußen')
    else parts.push(activityLabel(a.type))
  }
  return parts.join(' · ')
}

function SpeedQuestion({
  run,
  profileId,
  saved,
  onSaved,
}: {
  run: WearableActivity
  profileId: string
  saved: string | null
  onSaved: (note: ContextNote) => void
}) {
  const [busy, setBusy] = useState(false)
  const [other, setOther] = useState(false)
  const [value, setValue] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)

  async function pick(v: string) {
    setBusy(true)
    setErr(null)
    try {
      const note = await saveNote(profileId, { date: dateOf(run), tag: LAUFBAND_TAG, text: v, source: 'manual' })
      setJustSaved(true)
      onSaved(note)
    } catch {
      setErr('Speichern hat nicht geklappt. Versuch es gleich noch mal.')
    } finally {
      setBusy(false)
    }
  }

  function submitOther(e: FormEvent) {
    e.preventDefault()
    const n = Number(value.replace(',', '.'))
    if (!Number.isFinite(n) || n < 3 || n > 25) {
      setErr('Bitte eine Geschwindigkeit zwischen 3 und 25 km/h.')
      return
    }
    void pick(n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }))
  }

  return (
    <section aria-label="Laufband-Geschwindigkeit" className="card soft la-question">
      {saved ? (
        <p aria-live="polite" className={`t-15${justSaved ? ' pop-in' : ''}`}>
          <strong>Notiert: {saved} km/h.</strong> Ab jetzt vergleiche ich deine Laufband-Läufe bei gleicher Geschwindigkeit.
        </p>
      ) : (
        <>
          <span className="kicker">Eine Frage</span>
          <p className="t-15" style={{ fontWeight: 600 }}>
            Welche Geschwindigkeit hatte das Laufband?
          </p>
          {other ? (
            <form className="la-other" onSubmit={submitOther}>
              <label className="sr-only" htmlFor="la-speed">
                Geschwindigkeit in km/h
              </label>
              <input
                id="la-speed"
                className="input"
                inputMode="decimal"
                placeholder="z. B. 9,0"
                value={value}
                autoFocus
                onChange={(e) => setValue(e.target.value)}
              />
              <span className="t-15">km/h</span>
              <button type="submit" className="btn primary" disabled={busy || !value.trim()}>
                Speichern
              </button>
            </form>
          ) : (
            <div className="chips">
              {SPEEDS.map((s) => (
                <button key={s} type="button" className="chip" disabled={busy} onClick={() => void pick(s)}>
                  {s} km/h
                </button>
              ))}
              <button type="button" className="chip" disabled={busy} onClick={() => setOther(true)}>
                Andere…
              </button>
            </div>
          )}
          {err && (
            <p className="t-13" role="alert" style={{ color: 'var(--c-danger)', marginTop: 6 }}>
              {err}
            </p>
          )}
        </>
      )}
    </section>
  )
}

export default function Laufanalyse({ profile }: { profile: Profile }) {
  const { id = '' } = useParams()
  const { data, error, setData } = useCached<RunData>(
    `lauf:${id}`,
    async () => {
      const [run, settings] = await Promise.all([fetchActivity(id), fetchCoachSettings()])
      const cap = settings?.easy_hr_cap ?? DEFAULT_HR_CAP
      if (!run) return { run: null, cap, history: [], speedNotes: [] }
      const date = dateOf(run)
      const from = addDays(date, -COMPARE_DAYS)
      const [history, notes] = await Promise.all([fetchActivities(from, date), fetchNotes(from, date)])
      return { run, cap, history, speedNotes: notes.filter((n) => n.tag === LAUFBAND_TAG && n.text) }
    },
    [id],
  )

  if (!data) {
    return (
      <>
        <SubBar title="Laufanalyse" />
        <div className="page la-page">
          {error ? (
            <p className="empty">Der Lauf lässt sich gerade nicht laden. Prüf deine Verbindung.</p>
          ) : (
            <>
              <div className="skeleton" style={{ height: 90 }} />
              <div className="skeleton" style={{ height: 230, borderRadius: 18 }} />
              <div className="skeleton" style={{ height: 76, borderRadius: 16 }} />
            </>
          )}
        </div>
      </>
    )
  }

  const { run, cap, history, speedNotes } = data
  if (!run) {
    return (
      <>
        <SubBar title="Laufanalyse" />
        <div className="page la-page">
          <p className="empty">Diesen Lauf finde ich nicht. Vielleicht ist er noch nicht von der Uhr synchronisiert.</p>
        </div>
      </>
    )
  }

  const date = dateOf(run)
  const today = localDate()
  const running = isRun(run.type)
  const analysis = analysisOf(run)
  const series = validSeries(analysis)
  const recent = date >= addDays(today, -1)
  const longDay = recent ? nextLongRun(today, cap, []) : null
  const judgement: RunJudgement = running
    ? judgeRun(run, cap, { nextLongRunDay: longDay && longDay !== today ? weekdayLong(longDay) : null })
    : {
        kind: 'unknown',
        ok: true,
        headline: activityLabel(run.type),
        sentence: run.avg_hr ? `Ø Puls ${run.avg_hr}${run.max_hr ? `, höchstens ${run.max_hr}` : ''}.` : '',
        tip: '',
        shareBelow: null,
      }

  // Geschwindigkeit vom Laufband: Notiz am Tag des Laufs (neueste gewinnt)
  const speedOn = (d: string) => [...speedNotes].reverse().find((n) => n.date === d)?.text ?? null
  const speedOf = (a: WearableActivity) => (isTreadmill(a) ? speedOn(dateOf(a)) : null)
  const speed = isTreadmill(run) ? speedOn(date) : null

  // Sensorwechsel: nur wenn die letzten Läufe davor überwiegend mit dem anderen Sensor gemessen wurden
  const prevSensors = history
    .filter((a) => isRun(a.type) && a.external_id !== run.external_id && a.started_at_local < run.started_at_local && a.hr_sensor)
    .sort((x, y) => (x.started_at_local < y.started_at_local ? 1 : -1))
    .slice(0, 5)
    .map((a) => a.hr_sensor)
  const same = prevSensors.filter((s) => s === run.hr_sensor).length
  const sensorChanged = !!(running && run.hr_sensor && prevSensors.length > 0 && prevSensors.length - same > same)

  // Vergleich: zuerst aus analysis (analyzeRun), sonst nur wenn belastbar
  let compare: string | null = null
  const cr = analysis?.comparable_runs?.[0]
  if (running && cr) {
    if (cr.text) compare = cr.text
    else if (typeof cr.delta_hr_at_same_pace === 'number') {
      const d = Math.round(cr.delta_hr_at_same_pace)
      compare =
        d === 0
          ? `Vergleichbarer Lauf am ${shortDate(cr.date)}: bei gleichem Tempo derselbe Puls.`
          : `Vergleichbarer Lauf am ${shortDate(cr.date)}: bei gleichem Tempo ${Math.abs(d)} Schläge ${d < 0 ? 'weniger' : 'mehr'}.`
    }
  } else if (running && !sensorChanged) {
    const other = findComparable(run, history, speedOf)
    if (other) compare = compareText(run, other, shortDate(dateOf(other)), speed)
  }

  const tiles: { v: string; l: string }[] = []
  if (judgement.shareBelow !== null && run.duration_s) {
    tiles.push({
      v: `${Math.round(judgement.shareBelow * 100)} %`,
      l: `unter ${cap} (${Math.floor(judgement.shareBelow * minutes(run.duration_s))} Min.)`,
    })
  }
  if (run.avg_hr) tiles.push({ v: String(run.avg_hr), l: 'Ø Puls' })
  if (judgement.shareBelow === null && run.max_hr) tiles.push({ v: String(run.max_hr), l: 'Max. Puls' })
  if (run.training_load !== null) tiles.push({ v: fmt(Math.round(run.training_load)), l: 'Last' })

  const zones = run.hr_zone_s && run.hr_zone_s.some((s) => s > 0) ? run.hr_zone_s : null
  const otherSensor = run.hr_sensor === 'chest' ? 'am Handgelenk' : 'mit Brustgurt'

  return (
    <>
      <SubBar title="Laufanalyse" />
      <div className="page la-page">
        <section aria-label="Urteil" className="la-verdict">
          <span className="t-13 t-muted">{metaLine(run)}</span>
          <div className="la-verdict-head">
            <span className={`la-verdict-icon${judgement.ok ? '' : ' warn'}`}>
              <Icon name={!running ? 'dumbbell' : judgement.ok ? 'check' : 'trendUp'} size={18} strokeWidth={judgement.ok ? 2.6 : 2.2} />
            </span>
            <h1>{judgement.headline}</h1>
          </div>
          {judgement.sentence && <p className="la-sentence">{judgement.sentence}</p>}
        </section>

        {(series || zones) && (
          <section aria-label="Pulsverlauf" className="card la-chart-card">
            {series ? <HrChart series={series} cap={cap} summary={judgement.sentence} /> : <ZoneBars zones={zones!} />}
          </section>
        )}

        {tiles.length > 0 && (
          <div className="tiles la-tiles">
            {tiles.slice(0, 3).map((k) => (
              <div key={k.l} className="tile">
                <span className="tile-value">{k.v}</span>
                <span className="t-13 t-muted">{k.l}</span>
              </div>
            ))}
          </div>
        )}

        {compare && (
          <section aria-label="Vergleich" className="card">
            <span className="kicker">Vergleich</span>
            <p className="t-15">{compare}</p>
          </section>
        )}

        {sensorChanged && (
          <p className="la-sensor">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5M12 16.5v.5" />
            </svg>
            {date === today ? 'Heute' : 'Diesmal'} {run.hr_sensor === 'chest' ? 'mit Brustgurt' : 'am Handgelenk'} gemessen, sonst{' '}
            {otherSensor}. Ein Puls-Vergleich mit früheren Läufen ist deshalb unsicher.
          </p>
        )}

        {isTreadmill(run) && (
          <SpeedQuestion
            run={run}
            profileId={profile.id}
            saved={speed}
            onSaved={(note) => setData({ ...data, speedNotes: [...speedNotes, note] })}
          />
        )}

        {judgement.tip && (
          <section aria-label="Tipp für das nächste Mal" className="card">
            <span className="kicker">Für das nächste Mal</span>
            <p className="la-tip">{judgement.tip}</p>
          </section>
        )}

        <p className="la-feel">{feelLine(run)}</p>
      </div>
    </>
  )
}
