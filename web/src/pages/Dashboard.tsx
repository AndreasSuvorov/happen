import { useEffect, useState } from 'react'
import { supabase, type Entry, type Profile, type Weight } from '../lib/supabase'
import { baseTdee, dailyBudget } from '../lib/nutrition'

function localDate(d = new Date()) {
  return d.toLocaleDateString('en-CA') // YYYY-MM-DD, lokale Zeitzone
}

const MEAL_ICON: Record<string, string> = {
  breakfast: '🍳',
  lunch: '🍲',
  dinner: '🍽️',
  snack: '🍎',
  drink: '🥤',
}

function Sparkline({ points }: { points: { x: string; kg: number }[] }) {
  if (points.length < 2) return null
  const w = 280
  const h = 56
  const pad = 6
  const kgs = points.map((p) => p.kg)
  const min = Math.min(...kgs)
  const max = Math.max(...kgs)
  const span = max - min || 1
  const coords = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2)
    const y = pad + (1 - (p.kg - min) / span) * (h - pad * 2)
    return [x, y] as const
  })
  const path = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const [lastX, lastY] = coords[coords.length - 1]
  const trendUp = points[points.length - 1].kg > points[0].kg
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="sparkline">
      <path d={path} fill="none" stroke={trendUp ? '#f87171' : '#4ade80'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r="3.5" fill={trendUp ? '#f87171' : '#4ade80'} />
    </svg>
  )
}

function CalorieBar({ low, mid, high, max }: { low: number; mid: number; high: number; max: number }) {
  const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`
  return (
    <div className="kcal-bar">
      <div className="kcal-bar-track">
        <div className="kcal-bar-range" style={{ left: pct(low), width: `calc(${pct(high)} - ${pct(low)})` }} />
        <div className="kcal-bar-mid" style={{ left: pct(mid) }} />
      </div>
    </div>
  )
}

export default function Dashboard({ profile }: { profile: Profile }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [weights, setWeights] = useState<Weight[]>([])
  const [runKcalToday, setRunKcalToday] = useState(0)
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
      supabase
        .from('activities')
        .select('kcal_gross')
        .eq('user_id', profile.id)
        .eq('status', 'active')
        .gte('started_at', from),
    ]).then(([e, w, a]) => {
      setEntries((e.data as Entry[]) ?? [])
      setWeights((w.data as Weight[]) ?? [])
      const runs = (a.data as { kcal_gross: number | null }[]) ?? []
      setRunKcalToday(runs.reduce((s, r) => s + (r.kcal_gross ?? 0), 0))
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
  const tdee = latestWeight
    ? baseTdee(
        {
          heightCm: profile.height_cm,
          birthYear: profile.birth_year,
          sex: profile.sex,
          goalKgPerWeek: Number(profile.goal_kg_per_week),
        },
        Number(latestWeight.kg),
      )
    : null
  const budget = tdee ? dailyBudget(tdee, Number(profile.goal_kg_per_week), runKcalToday) : null
  const left = budget !== null ? budget - totals.mid : null
  const trend =
    weights.length >= 2 ? Number((weights[0].kg - weights[weights.length - 1].kg).toFixed(1)) : null
  const sparkPoints = [...weights].reverse().map((w) => ({ x: w.measured_on, kg: Number(w.kg) }))

  const today = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="screen">
      <p className="date-heading">{today}</p>

      <section className="card">
        <h2>Heute</h2>
        {entries.length === 0 ? (
          <p className="muted">Noch nichts erfasst – schick Happen ein Foto oder eine Nachricht.</p>
        ) : (
          <>
            <div className="kcal-row">
              <span className="big">{totals.mid}</span>
              <span className="muted"> kcal · {totals.low}–{totals.high}</span>
            </div>
            {budget !== null && left !== null ? (
              <>
                <CalorieBar low={totals.low} mid={totals.mid} high={totals.high} max={budget} />
                <p className={left >= 0 ? 'budget-line' : 'budget-line over'}>
                  {left >= 0 ? `noch ≈ ${left} kcal von ${budget} übrig` : `≈ ${-left} kcal über dem Tagesbudget (${budget})`}
                </p>
              </>
            ) : (
              <p className="muted small">
                Tagesbudget fehlt noch – dafür Größe, Geburtsjahr, Geschlecht in den Einstellungen eintragen und
                mindestens ein Gewicht erfassen.
              </p>
            )}
            <p className="muted small">{totals.protein} g Protein · {entries.length} Einträge</p>
          </>
        )}
      </section>

      <section className="card">
        <h2>Gewicht</h2>
        {latestWeight ? (
          <div className="weight-row">
            <div>
              <p className="big">{latestWeight.kg} kg</p>
              <p className="muted small">
                {new Date(latestWeight.measured_on).toLocaleDateString('de-DE')}
                {trend !== null && (
                  <span className={trend > 0 ? 'pill up' : trend < 0 ? 'pill down' : 'pill'}>
                    {trend > 0 ? '+' : ''}
                    {trend} kg
                  </span>
                )}
              </p>
            </div>
            <Sparkline points={sparkPoints} />
          </div>
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
                <span className="meal-icon">{MEAL_ICON[e.meal ?? ''] ?? '🍴'}</span>
                <div className="entry-main">
                  <strong>{e.title}</strong>
                  <span className="muted small">
                    {new Date(e.eaten_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="entry-kcal">
                  <span>{e.kcal_mid} kcal</span>
                  <span className="muted small">
                    {e.kcal_low}–{e.kcal_high}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
