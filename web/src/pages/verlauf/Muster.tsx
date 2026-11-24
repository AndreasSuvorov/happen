import { addDays, fetchCoachSettings, fetchDailyMetrics, fetchNotes, localDate, useCached } from '../../lib/coach'
import { allPatterns, statValue } from './muster'

const WINDOW = 90

async function loadMuster(today: string) {
  const from = addDays(today, -WINDOW)
  const [metrics, notes, settings] = await Promise.all([
    fetchDailyMetrics(from, today),
    fetchNotes(from, today),
    fetchCoachSettings(),
  ])
  return { metrics, notes, bedtime: settings?.bedtime_target ?? null }
}

export default function Muster() {
  const today = localDate()
  const { data, error } = useCached(`verlauf-muster-${today}`, () => loadMuster(today), [today])

  const patterns = data ? allPatterns(data.metrics, data.notes, data.bedtime) : []
  return (
    <div className="vl-stack-12">
      <p className="vl-intro">Was deine Abende mit deinen Nächten machen. Verglichen mit Tagen ohne Notiz, ab 3 gleichen Notizen.</p>
      {!data && error && <p className="card warn">Die Muster lassen sich gerade nicht laden. {error}</p>}
      {!data && !error && [0, 1].map((i) => <div key={i} className="vl-pattern skeleton" style={{ height: 130 }} />)}
      {data && patterns.length === 0 && (
        <section className="vl-pattern is-thin">
          <h2>Noch keine Muster</h2>
          <p className="t-15">
            Ab drei Notizen mit demselben Stichwort zeige ich dir, was solche Abende mit deinen Nächten machen. Notizen
            entstehen, wenn du meine Rückfrage am Morgen beantwortest.
          </p>
        </section>
      )}
      {patterns.map((p) => (
        <section key={p.key} aria-label={p.tag} className={'vl-pattern' + (p.enough ? '' : ' is-thin')}>
          <div className="vl-pattern-head">
            <h2>{p.tag}</h2>
            <span className="vl-count" aria-label={`${p.n}-mal`}>
              {p.n}×
            </span>
          </div>
          {p.enough && (
            <div className="vl-stats">
              {p.stats.map((s) => (
                <div key={s.label} className="vl-stat">
                  <span className="vl-stat-v">{statValue(s)}</span>
                  <span className="t-13 t-muted">{s.label}</span>
                </div>
              ))}
            </div>
          )}
          <p className="t-15">{p.text}</p>
        </section>
      ))}
    </div>
  )
}
