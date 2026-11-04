import { useEffect, useState } from 'react'
import { supabase, type Entry, type Profile, type Weight } from '../lib/supabase'

function localDate(d = new Date()) {
  return d.toLocaleDateString('en-CA') // YYYY-MM-DD, lokale Zeitzone
}

export default function Dashboard({ profile }: { profile: Profile }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [weights, setWeights] = useState<Weight[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const today = localDate()
    const from = `${today}T00:00:00`
    Promise.all([
      supabase
        .from('entries')
        .select('id, eaten_at, meal, title, kcal_low, kcal_mid, kcal_high, protein_g, confidence, status')
        .eq('user_id', profile.id)
        .neq('status', 'deleted')
        .gte('eaten_at', from)
        .order('eaten_at', { ascending: false }),
      supabase
        .from('weights')
        .select('measured_on, kg')
        .eq('user_id', profile.id)
        .order('measured_on', { ascending: false })
        .limit(14),
    ]).then(([e, w]) => {
      setEntries((e.data as Entry[]) ?? [])
      setWeights((w.data as Weight[]) ?? [])
      setLoading(false)
    })
  }, [profile.id])

  if (loading) return <div className="screen centered">Lädt …</div>

  const totals = entries.reduce(
    (acc, e) => ({
      low: acc.low + e.kcal_low,
      mid: acc.mid + e.kcal_mid,
      high: acc.high + e.kcal_high,
      protein: acc.protein + (e.protein_g ?? 0),
    }),
    { low: 0, mid: 0, high: 0, protein: 0 },
  )
  const latestWeight = weights[0]
  const trend =
    weights.length >= 2 ? Number((weights[0].kg - weights[weights.length - 1].kg).toFixed(1)) : null

  return (
    <div className="screen">
      <section className="card">
        <h2>Heute</h2>
        {entries.length === 0 ? (
          <p className="muted">Noch nichts erfasst – schick Happen ein Foto oder eine Nachricht.</p>
        ) : (
          <>
            <p className="big">
              ≈ {totals.mid} kcal{' '}
              <span className="muted">
                ({totals.low}–{totals.high})
              </span>
            </p>
            <p className="muted">{totals.protein} g Protein · {entries.length} Einträge</p>
          </>
        )}
      </section>

      <section className="card">
        <h2>Gewicht</h2>
        {latestWeight ? (
          <>
            <p className="big">{latestWeight.kg} kg</p>
            <p className="muted">
              zuletzt {new Date(latestWeight.measured_on).toLocaleDateString('de-DE')}
              {trend !== null && ` · ${trend > 0 ? '+' : ''}${trend} kg über ${weights.length} Messungen`}
            </p>
          </>
        ) : (
          <p className="muted">Noch kein Gewicht erfasst.</p>
        )}
      </section>

      <section className="card">
        <h2>Verlauf</h2>
        {entries.length === 0 ? (
          <p className="muted">–</p>
        ) : (
          <ul className="entry-list">
            {entries.map((e) => (
              <li key={e.id}>
                <div>
                  <strong>{e.title}</strong>
                  <span className="muted">
                    {' '}
                    · {new Date(e.eaten_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <span>
                  {e.kcal_mid} kcal{' '}
                  <span className="muted">
                    ({e.kcal_low}–{e.kcal_high})
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
