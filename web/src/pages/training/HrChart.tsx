import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { HrPoint } from './run'
import { pace } from './run'

const H = 160 // Höhe der Zeichenfläche, darunter die Minuten-Beschriftung (184 gesamt)

/** Pulsverlauf als Fläche, gestrichelte Grenze bei `cap`, darüber Warnfarbe, Fadenkreuz mit Tooltip. */
export function HrChart({ series, cap, summary }: { series: HrPoint[]; cap: number; summary: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(326)
  const clipId = useId().replace(/:/g, '')
  const total = series[series.length - 1].t_min
  const peak = series.reduce((a, p) => (p.hr > a.hr ? p : a), series[0])
  const [minute, setMinute] = useState<number>(peak.t_min)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setW(Math.max(200, Math.round(el.getBoundingClientRect().width)))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const hrs = series.map((p) => p.hr)
  const lo = Math.min(100, Math.floor((Math.min(...hrs) - 5) / 10) * 10)
  const hi = Math.max(185, cap + 20, Math.ceil((Math.max(...hrs) + 5) / 10) * 10)
  const X = (m: number) => (total > 0 ? (m / total) * W : 0)
  const Y = (b: number) => H - ((b - lo) / (hi - lo)) * H

  const line = series.map((p, i) => `${i ? 'L' : 'M'}${X(p.t_min).toFixed(1)} ${Y(p.hr).toFixed(1)}`).join(' ')
  const area = `${line} L${W} ${H} L0 ${H} Z`

  const elevPts = series.filter((p) => typeof p.elev_m === 'number') as (HrPoint & { elev_m: number })[]
  let elev = ''
  if (elevPts.length >= 2) {
    const eMin = Math.min(...elevPts.map((p) => p.elev_m))
    const eMax = Math.max(...elevPts.map((p) => p.elev_m))
    const span = Math.max(eMax - eMin, 10)
    elev =
      elevPts
        .map((p, i) => `${i ? 'L' : 'M'}${X(p.t_min).toFixed(1)} ${(H - 6 - ((p.elev_m - eMin) / span) * 28).toFixed(1)}`)
        .join(' ') + ` L${X(elevPts[elevPts.length - 1].t_min).toFixed(1)} ${H} L${X(elevPts[0].t_min).toFixed(1)} ${H} Z`
  }

  const step = total > 60 ? 20 : 10
  const ticks: { x: number; label: string; anchor: 'start' | 'middle' | 'end' }[] = []
  for (let m = 0; m <= total; m += step) {
    const x = X(m)
    ticks.push({ x, label: m === 0 ? '0 Min.' : String(m), anchor: m === 0 ? 'start' : x > W - 10 ? 'end' : 'middle' })
  }

  const near = series.reduce((a, p) => (Math.abs(p.t_min - minute) < Math.abs(a.t_min - minute) ? p : a), series[0])
  const p = pace(near.pace_s_per_km)
  const tipText = `Min. ${Math.round(near.t_min)} · ${Math.round(near.hr)} Puls${p ? ' · ' + p : ''}`
  const capY = Y(cap)

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    setMinute(ratio * total)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!d) return
    e.preventDefault()
    setMinute(Math.max(0, Math.min(total, Math.round(near.t_min) + d * (e.shiftKey ? 5 : 1))))
  }

  return (
    <>
      <div className="la-chart-head">
        <h2>Puls</h2>
        <span className="t-13 t-muted" aria-live="polite">
          {tipText}
        </span>
      </div>
      <div
        ref={ref}
        className="la-chart"
        onPointerMove={move}
        onPointerDown={move}
        tabIndex={0}
        role="slider"
        aria-label="Pulsverlauf, mit Pfeiltasten durch die Minuten"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(near.t_min)}
        aria-valuetext={tipText}
        onKeyDown={key}
      >
        <svg width={W} height={184} viewBox={`0 0 ${W} 184`} role="img" aria-label={`Pulsverlauf über ${Math.round(total)} Minuten mit der Grenze ${cap} für lockere Läufe. ${summary}`}>
          <defs>
            <clipPath id={clipId}>
              <rect x="0" y="0" width={W} height={Math.max(0, capY)} />
            </clipPath>
          </defs>
          {elev && <path d={elev} fill="var(--c-track)" opacity="0.8" />}
          <path d={area} fill="var(--c-band)" opacity="0.6" />
          <path d={area} fill="var(--c-warn)" opacity="0.35" clipPath={`url(#${clipId})`} />
          <path d={line} fill="none" stroke="var(--c-fill)" strokeWidth="2" strokeLinejoin="round" />
          <line x1="0" y1={capY} x2={W} y2={capY} stroke="var(--c-ink)" strokeWidth="1.2" strokeDasharray="4 4" />
          <text x={W} y={capY - 5} textAnchor="end" fontSize="12" fontWeight="600" fill="var(--c-ink)">
            {cap}
          </text>
          <line x1={X(near.t_min)} y1="0" x2={X(near.t_min)} y2={H} stroke="var(--c-muted)" strokeWidth="1" />
          <circle cx={X(near.t_min)} cy={Y(near.hr)} r="5" fill="var(--c-surface)" stroke="var(--c-ink)" strokeWidth="2" />
          {ticks.map((k) => (
            <text key={k.label} x={k.x} y="178" textAnchor={k.anchor} fontSize="11" fill="var(--c-muted)">
              {k.label}
            </text>
          ))}
        </svg>
      </div>
      <div className="la-legend">
        <span>
          <svg width="16" height="4" aria-hidden="true">
            <line x1="0" y1="2" x2="16" y2="2" stroke="var(--c-ink)" strokeWidth="1.5" strokeDasharray="4 3" />
          </svg>
          Grenze für locker
        </span>
        <span>
          <span className="la-swatch" style={{ background: 'var(--c-warn)', opacity: 0.5 }} />
          darüber
        </span>
        {elev && (
          <span>
            <span className="la-swatch" style={{ background: 'var(--c-track)' }} />
            Höhe
          </span>
        )}
      </div>
    </>
  )
}

/** Ohne Pulsreihe: Zeit in den Pulszonen der Uhr als Balken (gleiche Farben wie das Diagramm). */
export function ZoneBars({ zones }: { zones: number[] }) {
  const max = Math.max(...zones, 1)
  return (
    <>
      <div className="la-chart-head">
        <h2>Puls</h2>
        <span className="t-13 t-muted">Zeit in den Pulszonen</span>
      </div>
      <ul className="la-zones">
        {zones.map((s, i) => {
          const min = Math.round(s / 60)
          return (
            <li key={i} className="la-zone">
              <span className="t-muted">Zone {i + 1}</span>
              <span className="la-zone-track" aria-hidden="true">
                <span className={`la-zone-fill${i >= 3 ? ' hard' : ''}`} style={{ width: `${(s / max) * 100}%`, display: 'block' }} />
              </span>
              <span className="la-zone-val">{min} Min.</span>
            </li>
          )
        })}
      </ul>
      <div className="la-legend">
        <span>
          <span className="la-swatch" style={{ background: 'var(--c-band)' }} />
          Zone 1–3
        </span>
        <span>
          <span className="la-swatch" style={{ background: 'var(--c-warn)', opacity: 0.55 }} />
          Zone 4–5 (hart)
        </span>
      </div>
      <p className="t-12 t-muted">Zonen von deiner Uhr. Den Pulsverlauf Minute für Minute gibt es für diesen Lauf noch nicht.</p>
    </>
  )
}
