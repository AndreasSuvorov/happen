import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import type { Profile } from '../../lib/supabase'
import { Icon, RangeBar, StatusIcon, SubBar } from '../../components/ui'
import { statusWord, type RecoveryStatus } from '../../lib/format'
import {
  addDays,
  fetchDailyMetrics,
  fetchMorningBriefing,
  localDate,
  useCached,
  type DailyMetrics,
  type MorningBriefing,
  type ReasonMetric,
} from '../../lib/coach'
import { ALL_METRICS, metricView, whySentence, type Level, type MetricView } from './data'
import './heute.css'

interface WarumData {
  briefing: MorningBriefing | null
  days: DailyMetrics[]
}

const label: Record<ReasonMetric, string> = {
  hrv_last_night: 'HRV letzte Nacht',
  sleep_hr_avg: 'Puls im Schlaf',
  sleep_resp_avg: 'Atmung im Schlaf',
  bb_wake: 'Body Battery beim Aufwachen',
  sleep_minutes: 'Schlafdauer',
}

const unit: Record<ReasonMetric, string> = {
  hrv_last_night: 'ms',
  sleep_hr_avg: 'Schläge/Min.',
  sleep_resp_avg: 'pro Min.',
  bb_wake: 'von 100',
  sleep_minutes: 'Std.',
}

const sevLabel: Record<Level, string> = {
  ok: 'im Normalbereich',
  warn: 'auffällig',
  bad: 'deutlich abweichend',
}

function explain(m: MetricView): string {
  const t: Record<ReasonMetric, Record<Level, string>> = {
    hrv_last_night: {
      ok:
        m.dir === 'above'
          ? 'Über deinem Bereich. Dein Nervensystem ist gut erholt.'
          : m.dir === 'below'
            ? 'Knapp unter deinem Bereich, aber noch kein Grund zur Sorge.'
            : 'Im Bereich. Dein Nervensystem ist erholt.',
      warn: 'Unter deinem Bereich. Dein Körper verarbeitet noch etwas, zum Beispiel eine harte Einheit oder einen langen Tag.',
      bad: 'Deutlich unter deinem Bereich. Dein Körper ist mit etwas beschäftigt.',
    },
    sleep_hr_avg: {
      ok: m.dir === 'below' ? 'Niedriger als sonst. Eine ruhige Nacht.' : 'Wie immer. Kein Zeichen von Stress in der Nacht.',
      warn: 'Etwas höher als sonst. Oft nach spätem Essen, Alkohol oder einem harten Tag.',
      bad: 'Deutlich höher als sonst. Dein Körper hat nachts gearbeitet.',
    },
    sleep_resp_avg: {
      ok: 'Ruhig und gleichmäßig.',
      warn: 'Etwas schneller als sonst.',
      bad: 'Deutlich schneller als sonst. Zusammen mit dem Puls ist das ein Muster, das oft vor einem Infekt auftritt.',
    },
    bb_wake: {
      ok: 'Gut aufgeladen.',
      warn: 'Nicht ganz aufgeladen. Die Nacht hat nicht alles zurückgegeben.',
      bad: 'Kaum aufgeladen. Heute ist ein Tag zum Schonen.',
    },
    sleep_minutes: {
      ok: 'Genug Schlaf.',
      warn: 'Etwas kurz.',
      bad: 'Zu kurz für eine gute Erholung.',
    },
  }
  return t[m.metric][m.level]
}

function SevIcon({ level }: { level: Level }) {
  if (level === 'ok') return <Icon name="check" size={14} strokeWidth={2.6} />
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {level === 'warn' ? (
        <>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M7 1.5 A5.5 5.5 0 0 1 7 12.5 Z" fill="currentColor" />
        </>
      ) : (
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
      )}
    </svg>
  )
}

export default function Warum({ profile: _profile }: { profile: Profile }) {
  const today = localDate()
  const { data, error } = useCached<WarumData>(
    `warum:${today}`,
    async () => {
      const [b, days] = await Promise.all([
        fetchMorningBriefing(today).catch(() => null),
        fetchDailyMetrics(addDays(today, -29), today),
      ])
      return { briefing: b?.payload ?? null, days }
    },
    [today],
  )
  const location = useLocation()

  const status: RecoveryStatus = data?.briefing?.status ?? 'unknown'
  const reasons = data?.briefing?.reasons ?? []
  // Erst die Gründe (rot vor gelb), dann die übrigen Kennzahlen in fester Reihenfolge.
  const order = [
    ...[...reasons].sort((a, b) => Number(a.severity === 'yellow') - Number(b.severity === 'yellow')).map((r) => r.metric),
    ...ALL_METRICS,
  ].filter((m, i, all) => all.indexOf(m) === i)
  const views = data
    ? order.map((m) => metricView(m, data.days, today, reasons)).filter((v): v is MetricView => !!v)
    : []

  const ready = !!data
  useEffect(() => {
    if (ready && location.hash === '#achten') {
      document.getElementById('achten')?.scrollIntoView({ block: 'start' })
    }
  }, [ready, location.hash])

  return (
    <>
      <SubBar title="Warum?" back="/heute" />
      <div className="page warum-page" style={{ paddingTop: 4 }}>
        {!data ? (
          error ? (
            <p className="empty">Ich konnte die Werte gerade nicht laden.</p>
          ) : (
            <div className="skeleton" style={{ height: 120 }} aria-busy="true" />
          )
        ) : (
          <>
            <section aria-label="Dein Status" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 4px' }}>
              <div className="heute-status-word">
                <StatusIcon status={status} size={18} />
                <h1 className="heute-big">{statusWord[status]}</h1>
              </div>
              <p className="heute-muted-p">{whySentence(status, data.briefing, views)}</p>
            </section>

            {views.length === 0 && (
              <p className="empty">
                Für heute Nacht habe ich noch keine Werte mit Normalbereich. Nach etwa 10 Tagen mit Messwerten kann ich sie
                einordnen.
              </p>
            )}

            {views.map((m) => (
              <section key={m.metric} aria-label={label[m.metric]} className="card warum-card">
                <div className="warum-card-head">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span className="t-13 t-muted">{label[m.metric]}</span>
                    <span className="warum-value">
                      {m.display} <small>{unit[m.metric]}</small>
                    </span>
                  </div>
                  <span className={`warum-sev ${m.level}`}>
                    <SevIcon level={m.level} />
                    {sevLabel[m.level]}
                  </span>
                </div>
                <RangeBar
                  value={m.value}
                  low={m.low}
                  high={m.high}
                  min={m.min}
                  max={m.max}
                  label={`${label[m.metric]} ${m.display}, Normalbereich ${m.normal}`}
                />
                <span className="t-12 t-muted">
                  Dein Normalbereich: {m.normal}
                  {m.metric === 'hrv_last_night' && !/^ab/.test(m.normal) ? ' ms' : ''}
                </span>
                <p className="t-15">{explain(m)}</p>
              </section>
            ))}

            {status === 'red' && (
              <section id="achten" aria-label="Worauf du achten solltest" className="warum-achten">
                <h2>Worauf du achten solltest</h2>
                <p className="t-15" style={{ margin: 0 }}>
                  Fieber, Halsschmerzen, Gliederschmerzen oder ungewöhnliche Müdigkeit. Wenn du dich krank fühlst, lass das
                  Training aus, bis du ein paar Tage ohne Beschwerden bist. Im Zweifel frag ärztlich nach.
                </p>
                <p className="t-13 t-muted" style={{ margin: 0, lineHeight: 1.4 }}>
                  Ich sehe nur Abweichungen von deinem Normalbereich. Eine Diagnose ist das nicht.
                </p>
              </section>
            )}

            <p className="t-13 t-muted" style={{ margin: 0, padding: '0 4px', lineHeight: 1.4 }}>
              Normalbereich heißt: deine eigenen Werte der letzten 28 Tage. Für die HRV nehme ich den Bereich, den deine Uhr
              berechnet.
            </p>
          </>
        )}
      </div>
    </>
  )
}
