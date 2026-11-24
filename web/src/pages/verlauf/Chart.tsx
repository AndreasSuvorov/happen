// Eigene SVG-Diagramme für Trends: dünne Linie, blasses Normalband, Tooltip bei Berührung.
import { useRef, useState, type PointerEvent } from 'react'

export const W = 326
export const H = 80
const SVG_H = 96

export interface Pt {
  x: number // 0..1
  value: number
}

export interface Tip {
  x: number // 0..1
  value: number
  text: string
}

function useTip<T extends { x: number }>(tips: T[]) {
  const ref = useRef<SVGSVGElement>(null)
  const [idx, setIdx] = useState<number | null>(null)
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const box = ref.current?.getBoundingClientRect()
    if (!box || !tips.length) return
    const frac = (e.clientX - box.left) / box.width
    let best = 0
    tips.forEach((t, i) => {
      if (Math.abs(t.x - frac) < Math.abs(tips[best].x - frac)) best = i
    })
    setIdx(best)
  }
  const handlers = {
    ref,
    onPointerDown: pick,
    onPointerMove: (e: PointerEvent<SVGSVGElement>) => {
      if (e.pointerType === 'mouse' || e.buttons) pick(e)
    },
    onPointerLeave: (e: PointerEvent<SVGSVGElement>) => {
      if (e.pointerType === 'mouse') setIdx(null)
    },
  }
  return { idx: idx != null && idx < tips.length ? idx : null, handlers }
}

function TipLabel({ x, text }: { x: number; text: string }) {
  // Links/rechts am Rand festhalten, damit der Text nicht abgeschnitten wird.
  const style = x < 0.2 ? { left: 0 } : x > 0.8 ? { right: 0 } : { left: `${x * 100}%`, transform: 'translateX(-50%)' }
  return (
    <div className="vl-tip" style={style} aria-live="polite">
      {text}
    </div>
  )
}

export function LineChart({
  line,
  dots = [],
  band,
  domain,
  mark,
  tips,
  label,
}: {
  line: Pt[]
  dots?: Pt[]
  band?: { low: number; high: number } | null
  domain: [number, number]
  mark?: { x: number; value: number; text: string } | null
  tips: Tip[]
  label: string
}) {
  const [lo, hi] = domain
  const y = (v: number) => H - ((v - lo) / (hi - lo || 1)) * H
  const path = line.map((p, i) => `${i ? 'L' : 'M'}${(p.x * W).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')
  const last = line[line.length - 1]
  const { idx, handlers } = useTip(tips)
  const tip = idx != null ? tips[idx] : null
  const markRight = mark && mark.x > 0.55
  return (
    <div className="vl-chart">
      {tip && <TipLabel x={tip.x} text={tip.text} />}
      <svg viewBox={`0 0 ${W} ${SVG_H}`} role="img" aria-label={label} className="vl-svg" {...handlers}>
        {band && (
          <rect x="0" y={y(band.high)} width={W} height={Math.max(1, y(band.low) - y(band.high))} fill="var(--c-band)" opacity="0.55" />
        )}
        {dots.map((p, i) => (
          <circle key={i} cx={p.x * W} cy={y(p.value)} r="2.5" fill="var(--c-muted)" opacity="0.55" />
        ))}
        {line.length > 1 && (
          <path d={path} fill="none" stroke="var(--c-fill)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        )}
        {mark && (
          <>
            <circle cx={mark.x * W} cy={y(mark.value)} r="5" fill="none" stroke="var(--c-ink)" strokeWidth="1.5" />
            <text
              x={mark.x * W + (markRight ? -9 : 9)}
              y={Math.min(H, Math.max(10, y(mark.value) + 4))}
              textAnchor={markRight ? 'end' : 'start'}
              fontSize="11"
              fill="var(--c-ink)"
            >
              {mark.text}
            </text>
          </>
        )}
        {last && <circle cx={last.x * W} cy={y(last.value)} r="4" fill="var(--c-fill)" />}
        {tip && (
          <>
            <line x1={tip.x * W} x2={tip.x * W} y1="0" y2={H} stroke="var(--c-muted)" strokeWidth="1" strokeDasharray="2 3" />
            <circle cx={tip.x * W} cy={y(tip.value)} r="4" fill="var(--c-surface)" stroke="var(--c-ink)" strokeWidth="1.5" />
          </>
        )}
      </svg>
    </div>
  )
}

export interface WeekBar {
  label: string
  easy: number
  hard: number
  tip: string
}

export function BarChart({ bars, label }: { bars: WeekBar[]; label: string }) {
  const max = Math.max(60, ...bars.map((b) => b.easy + b.hard)) * 1.05
  const bw = 44
  const gap = bars.length > 1 ? (W - bars.length * bw) / (bars.length - 1) : 0
  const pos = bars.map((_, i) => i * (bw + gap))
  const tips = bars.map((b, i) => ({ x: (pos[i] + bw / 2) / W, text: b.tip }))
  const { idx, handlers } = useTip(tips)
  return (
    <div className="vl-chart">
      {idx != null && <TipLabel x={tips[idx].x} text={tips[idx].text} />}
      <svg viewBox={`0 0 ${W} ${SVG_H}`} role="img" aria-label={label} className="vl-svg" {...handlers}>
        {bars.map((b, i) => {
          const hE = (b.easy / max) * 76
          const hH = (b.hard / max) * 76
          const x = pos[i]
          return (
            <g key={b.label} opacity={idx == null || idx === i ? 1 : 0.55}>
              {hE > 0 && <rect x={x} y={80 - hE} width={bw} height={hE} rx="3" fill="var(--c-fill)" />}
              {hH > 0 && <rect x={x} y={80 - hE - hH - (hE > 0 ? 2 : 0)} width={bw} height={hH} rx="3" fill="var(--c-warn)" />}
              {!hE && !hH && <rect x={x} y={78} width={bw} height={2} rx="1" fill="var(--c-track)" />}
              <text x={x + bw / 2} y="94" textAnchor="middle" fontSize="11" fill="var(--c-muted)">
                {b.label}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
