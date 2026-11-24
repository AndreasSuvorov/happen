import { useEffect, useRef, useState } from 'react'
import { number, wearableSummary, type WearableActivity } from '../lib/today'

export default function RunAnalysis({ activity, onClose }: { activity: WearableActivity; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  useEffect(() => { dialog.current?.showModal() }, [])

  const analysis = activity.analysis
  const cap = analysis?.easy_hr_cap
  const series = (Array.isArray(analysis?.series) ? analysis.series : [])
    .filter((point) => Number.isFinite(point.minute) && Number.isFinite(point.bpm))
    .sort((a, b) => a.minute - b.minute)
  const last = series.at(-1)?.minute ?? 0
  const selected = series[cursor ?? Math.floor(series.length / 2)]
  const low = Math.floor(Math.min(...series.map((p) => p.bpm), cap ?? Infinity) / 10) * 10 - 5
  const high = Math.ceil(Math.max(...series.map((p) => p.bpm), cap ?? -Infinity) / 10) * 10 + 5
  const x = (minute: number) => 4 + (minute / (last || 1)) * 300
  const y = (bpm: number) => 116 - ((bpm - low) / Math.max(10, high - low)) * 104
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.minute)} ${y(p.bpm)}`).join(' ')
  const area = line + ` L${x(last)} 116 L${x(series[0]?.minute ?? 0)} 116 Z`
  const elevation = series.filter((p) => Number.isFinite(p.elevation_m))
  const minElevation = Math.min(...elevation.map((p) => p.elevation_m!))
  const elevationRange = Math.max(...elevation.map((p) => p.elevation_m!)) - minElevation
  const elevationArea = elevation.map((p, i) =>
    `${i ? 'L' : 'M'}${x(p.minute)} ${113 - (p.elevation_m! - minElevation) / (elevationRange || 1) * 48}`
  ).join(' ') + ` L${x(elevation.at(-1)?.minute ?? 0)} 116 L${x(elevation[0]?.minute ?? 0)} 116 Z`
  const summary = wearableSummary(activity)
  const showShare = analysis?.share_below_cap != null && cap != null

  return (
    <dialog ref={dialog} className="today-dialog run-dialog" onClose={onClose} aria-labelledby="run-title">
      <form method="dialog" className="dialog-heading">
        <span className="muted">Laufanalyse</span><button className="today-link">Schließen</button>
      </form>
      <h2 id="run-title">{summary.verdict || 'Lauf aufgezeichnet'}</h2>
      {analysis?.explanation && <p>{analysis.explanation}</p>}
      {series.length > 1 ? <section className="run-section">
        <div className="run-chart-head"><h3>Pulsverlauf</h3>{cap != null && <span>Grenze {number(cap)} bpm</span>}</div>
        <svg className="run-chart" viewBox="0 0 308 120" role="img" aria-label="Pulsfläche über den Lauf mit persönlicher Pulsgrenze">
          <defs><clipPath id="above-easy-cap"><rect x="0" y="0" width="308" height={cap == null ? 0 : y(cap)} /></clipPath></defs>
          {elevation.length > 1 && <path d={elevationArea} className="run-elevation" />}
          <path d={area} className="run-area" />
          {cap != null && <>
            <path d={area} className="run-over" clipPath="url(#above-easy-cap)" />
            <line x1="4" x2="304" y1={y(cap)} y2={y(cap)} className="run-limit" />
          </>}
          <path d={line} className="run-line" />
          {selected && <>
            <line x1={x(selected.minute)} x2={x(selected.minute)} y1="6" y2="116" className="run-cursor" />
            <circle cx={x(selected.minute)} cy={y(selected.bpm)} r="4" className="run-dot" />
          </>}
        </svg>
        <label className="run-scrub">
          <span>{selected && <>{number(selected.minute)} min · {number(selected.bpm)} bpm
            {selected.pace_min_km != null && ` · ${number(selected.pace_min_km)} min/km`}</>}</span>
          <input type="range" min={0} max={series.length - 1} value={cursor ?? Math.floor(series.length / 2)}
            onChange={(event) => setCursor(Number(event.target.value))} aria-label="Minute im Pulsverlauf" />
        </label>
      </section> : <p className="muted">Für diesen Lauf liegt kein Pulsverlauf vor.</p>}
      <dl className="run-facts">
        {showShare && <div><dt>Zeit unter {number(cap)} bpm</dt><dd>{number(analysis.share_below_cap! * 100)} %</dd></div>}
        {activity.avg_hr != null && <div><dt>Ø Puls</dt><dd>{number(activity.avg_hr)} bpm</dd>{cap != null && <small>Grenze {number(cap)}</small>}</div>}
        {activity.training_load != null && <div><dt>Trainingslast</dt><dd>{number(activity.training_load)}</dd><small>Garmin-Schätzung</small></div>}
      </dl>
      {analysis?.comparison && <section className="run-section"><h3>Vergleich</h3><p>{analysis.comparison}</p></section>}
      {analysis?.tip && <section className="run-section"><h3>Für den nächsten Lauf</h3><p>{analysis.tip}</p></section>}
    </dialog>
  )
}
