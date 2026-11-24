import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { Profile } from '../../lib/supabase'
import { Icon, Ring } from '../../components/ui'
import { addDays, clock, longDate, localDate, useCached } from '../../lib/coach'
import { fmt, fmtRange } from '../../lib/format'
import { MealIcon } from './MealIcon'
import {
  contextLine,
  dayKind,
  emptySlots,
  kg1,
  loadEssen,
  protein,
  proteinGoal,
  signedKg,
  totals,
  weightSummary,
  type EssenData,
} from './data'
import './essen.css'

export default function Essen({ profile }: { profile: Profile }) {
  const today = localDate()
  const { data, error } = useCached<EssenData>(`essen:${profile.id}:${today}`, () => loadEssen(profile), [
    profile.id,
    today,
  ])
  // Ein Cache von gestern gehört nicht auf den heutigen Screen.
  const d = data && data.today === today ? data : null
  const kind = d ? dayKind(d) : null

  return (
    <div className="page essen">
      <header className="essen-header">
        <div className="essen-title">
          <h1 className="page-title">Essen</h1>
          <span className="t-13 t-muted">
            {longDate(today)}
            {kind && ` · ${kind}`}
          </span>
        </div>
        <Link to="/essen/erfassen" className="essen-add">
          <Icon name="plus" size={18} strokeWidth={2.4} />
          Erfassen
        </Link>
      </header>

      {!d && error && (
        <div className="card warn" role="alert">
          <p>Ich konnte deine Mahlzeiten gerade nicht laden. {error}</p>
        </div>
      )}
      {!d && !error && <Skeleton />}
      {d && <Content d={d} kind={kind} />}
    </div>
  )
}

function Skeleton() {
  return (
    <>
      <div className="card essen-balance" aria-busy="true" aria-label="Lädt">
        <div className="skeleton" style={{ height: 76, width: '60%' }} />
        <div className="skeleton" style={{ height: 12 }} />
        <div className="skeleton" style={{ height: 40 }} />
      </div>
      <div className="skeleton" style={{ height: 150, borderRadius: 18 }} />
    </>
  )
}

function Content({ d, kind }: { d: EssenData; kind: ReturnType<typeof dayKind> }) {
  const sum = totals(d.entries)
  const pGoal = proteinGoal(d.weights)
  const [hour] = useState(() => new Date().getHours())
  const slots = emptySlots(d.entries, hour)
  const weight = weightSummary(d.weights, d.today)
  const yest = totals(d.yesterday)
  const yesterday = addDays(d.today, -1)

  return (
    <>
      <Balance
        d={d}
        sum={sum}
        pGoal={pGoal}
        line={contextLine({ sum, count: d.entries.length, target: d.target, kind, proteinGoal: pGoal, hour })}
      />

      <section aria-label="Mahlzeiten heute" className="essen-meals">
        <h2 className="section-title">Heute</h2>
        <div className="card flush rows">
          {d.entries.map((e) => (
            <Link key={e.id} to="/tageslinie" className="row essen-row">
              <span className="icon-tile">
                <MealIcon meal={e.meal} title={e.title} />
              </span>
              <span className="essen-row-text">
                <span className="essen-row-title">{e.title}</span>
                <span className="t-13 t-muted">
                  {clock(e.eaten_at)} · {fmtRange(e.kcal_low, e.kcal_high)} kcal
                  {e.protein_g != null && ` · ${protein(e.protein_g)}`}
                </span>
              </span>
              <Icon name="chevronRight" size={16} strokeWidth={2} className="t-muted" />
            </Link>
          ))}
          {slots.map((s) => (
            <div key={s.label} className="row essen-row">
              <span className="essen-slot-tile" aria-hidden="true" />
              <span className="essen-row-text">
                <span className="essen-row-title t-muted">{s.label}</span>
                <span className="t-13 t-muted">Noch nichts erfasst</span>
              </span>
              <Link to="/essen/erfassen" aria-label={s.aria} className="essen-slot-add">
                <Icon name="plus" size={18} strokeWidth={2.2} />
              </Link>
            </div>
          ))}
          {d.entries.length === 0 && slots.length === 0 && (
            <div className="row essen-row">
              <span className="essen-slot-tile" aria-hidden="true" />
              <span className="essen-row-text">
                <span className="essen-row-title t-muted">Heute</span>
                <span className="t-13 t-muted">Noch nichts erfasst</span>
              </span>
              <Link to="/essen/erfassen" aria-label="Mahlzeit erfassen" className="essen-slot-add">
                <Icon name="plus" size={18} strokeWidth={2.2} />
              </Link>
            </div>
          )}
        </div>
      </section>

      <section aria-label="Gewicht" className="card essen-weight">
        <div className="essen-weight-text">
          <span className="t-13 t-muted">{weight ? weightLabel(weight.date, d.today) : 'Gewicht'}</span>
          {weight ? (
            <>
              <span className="essen-weight-value">
                {kg1(weight.kg)} <span className="essen-unit">kg</span>
              </span>
              {weight.week !== null && (
                <span className="t-13 t-muted">
                  7-Tage-Mittel {kg1(weight.week)} kg
                  {weight.diff !== null && ` · ${signedKg(weight.diff)} kg zur Vorwoche`}
                </span>
              )}
            </>
          ) : (
            <span className="t-15">Noch kein Gewicht erfasst.</span>
          )}
        </div>
        <Link to="/verlauf/trends" className="link-arrow" style={{ alignSelf: 'center' }}>
          Verlauf
          <Icon name="chevronRight" size={16} strokeWidth={2} />
        </Link>
      </section>

      <Link to={`/tageslinie/${yesterday}`} className="essen-yesterday">
        <span className="essen-row-text">
          <span className="t-13 t-muted">Gestern</span>
          <span className="essen-row-title">
            {d.yesterday.length ? `${fmtRange(yest.low, yest.high)} kcal · ${protein(yest.protein)}` : 'Nichts erfasst'}
          </span>
        </span>
        <Icon name="chevronRight" size={16} strokeWidth={2} className="t-muted" />
      </Link>
    </>
  )
}

function weightLabel(date: string, today: string): string {
  if (date === today) return 'Gewicht heute'
  if (date === addDays(today, -1)) return 'Gewicht gestern'
  return `Gewicht vom ${Number(date.slice(8))}.${Number(date.slice(5, 7))}.`
}

function Balance({
  d,
  sum,
  pGoal,
  line,
}: {
  d: EssenData
  sum: ReturnType<typeof totals>
  pGoal: number | null
  line: string
}) {
  const t = d.target
  const max = Math.max(t ? Math.round((t.high * 1.15) / 100) * 100 : 2800, Math.ceil(sum.high / 100) * 100)
  const pct = (v: number) => Math.max(0, Math.min(100, (v / max) * 100))
  const p = Math.round(sum.protein)

  return (
    <section aria-label="Bilanz heute" className="card essen-balance">
      <div className="essen-balance-top">
        <div className="essen-balance-text">
          <span className="t-13 t-muted">Bisher gegessen</span>
          <span className="essen-big">
            {d.entries.length ? fmtRange(sum.low, sum.high) : '0'} <span className="essen-unit">kcal</span>
          </span>
          <span className="t-13 t-muted">
            Schätzung · {t ? `Ziel heute ${fmtRange(t.low, t.high)}` : 'Ziel fehlt noch'}
          </span>
        </div>
        <div className={p > 0 ? undefined : 'essen-ring-empty'}>
          <Ring value={p} goal={pGoal ?? 1} label={pGoal ? `Eiweiß ${p} von ${pGoal} Gramm` : `Eiweiß ${p} Gramm`}>
            <span style={{ fontSize: 17, fontWeight: 600 }}>{p} g</span>
            <span className="t-12 t-muted">{pGoal ? `von ${pGoal}` : 'Eiweiß'}</span>
          </Ring>
        </div>
      </div>

      <div className="essen-bar-wrap">
        <div
          className="essen-bar"
          role="img"
          aria-label={`Gegessen ${fmtRange(sum.low, sum.high)} kcal${t ? `, Ziel ${fmtRange(t.low, t.high)} kcal` : ''}`}
        >
          {t && (
            <div
              className="essen-bar-target"
              style={{ left: `${pct(t.low)}%`, width: `${pct(t.high) - pct(t.low)}%` }}
            />
          )}
          {sum.low > 0 && <div className="essen-bar-solid" style={{ width: `${pct(sum.low)}%` }} />}
          {sum.high > sum.low && (
            <div
              className="essen-bar-fuzz"
              style={{ left: `${pct(sum.low)}%`, width: `${pct(sum.high) - pct(sum.low)}%` }}
            />
          )}
        </div>
        <div className="essen-axis t-12 t-muted" aria-hidden="true">
          <span style={{ left: 0 }}>0</span>
          {t && <span style={{ left: `${pct(t.low)}%` }}>Ziel</span>}
          <span style={{ right: 0 }}>{fmt(max)}</span>
        </div>
      </div>

      <p className="t-15">{line}</p>
    </section>
  )
}
