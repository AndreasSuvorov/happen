import type { ReactNode, SVGProps } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { fmt, rangeScale, statusWord, type RecoveryStatus } from '../lib/format'

export type { RecoveryStatus }

/* ---------------------------------------------------------------------------
 * Icons: dünne Strich-Icons aus dem Design, Farbe = currentColor.
 * ------------------------------------------------------------------------- */
const paths = {
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  run: (
    <>
      <circle cx="14" cy="4.5" r="1.8" />
      <path d="M9 21l2.5-6 3 2.5V22M7 11l3-3.5 4 1 2.5 3.5 3 .5M11.5 15L10 8" />
    </>
  ),
  food: <path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 2-2.5 5-2.5 8h2.5v10" />,
  chat: <path d="M4 5.5h16v10H9l-5 4z" />,
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3.5 4v4h4" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  text: <path d="M4 7h16M4 12h16M4 17h10" />,
  sync: (
    <>
      <path d="M20 11a8 8 0 0 0-14.5-4.5M4 4v3h3" />
      <path d="M4 13a8 8 0 0 0 14.5 4.5M20 20v-3h-3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 6l3 3M15 8l2 2" />
    </>
  ),
  watch: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="3" />
      <path d="M9 6l.5-3h5l.5 3M9 18l.5 3h5l.5-3M12 9.5V12l1.5 1" />
    </>
  ),
  trendUp: <path d="M4 16l5-5 4 4 7-7M15 8h5v5" />,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  shake: (
    <>
      <path d="M7 3h10l-1.5 18h-7z" />
      <path d="M7.5 9h9" />
    </>
  ),
  bolt: <path d="M13 3L5 14h6l-1 7 8-11h-6z" />,
  note: (
    <>
      <path d="M5 4h14v12l-4 4H5z" />
      <path d="M15 20v-4h4M8.5 9h7M8.5 12.5h4" />
    </>
  ),
  dumbbell: <path d="M3 9.5v5M6 7v10M18 7v10M21 9.5v5M6 12h12" />,
  bike: (
    <>
      <circle cx="6" cy="16" r="3.5" />
      <circle cx="18" cy="16" r="3.5" />
      <path d="M6 16l4-7h5l3 7M10 9l2.5 7M13 5.5h3" />
    </>
  ),
  walk: (
    <>
      <circle cx="13" cy="4.5" r="1.8" />
      <path d="M10 21l2-6 2.5 2.5V21M8 12l2-4 3.5 1 1.5 3M12 15l-1-6" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  share: (
    <>
      <path d="M12 3v12M8 7l4-4 4 4" />
      <path d="M5 12v8h14v-8" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </>
  ),
  more: null,
} as const

export type IconName = keyof typeof paths

export function Icon({
  name,
  size = 20,
  strokeWidth = 1.8,
  ...rest
}: { name: IconName; size?: number; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  if (name === 'more') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
        <circle cx="5" cy="12" r="1.8" />
        <circle cx="12" cy="12" r="1.8" />
        <circle cx="19" cy="12" r="1.8" />
      </svg>
    )
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths[name]}
    </svg>
  )
}

/* ---------------------------------------------------------------------------
 * Erholungsstatus: immer Symbol + Wort + Farbe, nie nur Farbe.
 * ------------------------------------------------------------------------- */


export function StatusIcon({ status, size = 16 }: { status: RecoveryStatus; size?: number }) {
  const color = status === 'unknown' ? 'var(--c-muted)' : `var(--c-status-${status})`
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" style={{ flexShrink: 0 }}>
      {status === 'green' && <circle cx="7" cy="7" r="6" fill={color} />}
      {status === 'yellow' && (
        <>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="1.6" />
          <path d="M7 1.5 A5.5 5.5 0 0 1 7 12.5 Z" fill={color} />
        </>
      )}
      {status === 'red' && <circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="2" />}
      {status === 'unknown' && (
        <circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="1.6" strokeDasharray="2 2.2" />
      )}
    </svg>
  )
}

/** Kleiner Punkt + Wort, z. B. in Listen (Verlauf, Training). */
export function StatusDot({ status, label }: { status: RecoveryStatus; label?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <StatusIcon status={status} size={12} />
      {label !== undefined ? label : <span className="sr-only">{statusWord[status]}</span>}
    </span>
  )
}

/* ---------------------------------------------------------------------------
 * Kennzahl gegen Normalbereich.
 * `min`/`max` legen die Skala fest; ohne Angabe wird sie aus Band und Wert abgeleitet.
 * ------------------------------------------------------------------------- */

export function RangeBar({
  value,
  low,
  high,
  min,
  max,
  label,
}: {
  value: number
  low: number
  high: number
  min?: number
  max?: number
  label?: string
}) {
  const s = rangeScale(value, low, high, min, max)
  return (
    <div className="range-bar" role="img" aria-label={label ?? `Wert ${fmt(value)}, normal ${fmt(low)} bis ${fmt(high)}`}>
      <div className="range-bar-band" style={{ left: `${s.bandL}%`, width: `${s.bandW}%` }} />
      <div className="range-bar-dot" style={{ left: `${s.dot}%` }} />
    </div>
  )
}

/** Kennzahl mit Beschriftung, Wert, Band und Notiz (Heute, Warum?, Chat). */
export function MetricRange({
  label,
  value,
  unit,
  low,
  high,
  note,
  min,
  max,
}: {
  label: string
  value: number
  unit?: string
  low: number
  high: number
  note?: string
  min?: number
  max?: number
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span className="t-13 t-muted">{label}</span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>
          {fmt(value)} {unit && <span className="t-12 t-muted" style={{ fontWeight: 400 }}>{unit}</span>}
        </span>
      </div>
      <RangeBar value={value} low={low} high={high} min={min} max={max} label={`${label} ${fmt(value)}, normal ${fmt(low)} bis ${fmt(high)}`} />
      <span className="t-12 t-muted">{note ?? `Normal ${fmt(low)}–${fmt(high)}`}</span>
    </div>
  )
}

/** Spannen-Balken: fester Teil bis `low`, weicher Übergang bis `high`, optional Zielband. */
export function SpanBar({
  low,
  high,
  max,
  targetLow,
  targetHigh,
  label,
}: {
  low: number
  high: number
  max: number
  targetLow?: number
  targetHigh?: number
  label?: string
}) {
  const pct = (v: number) => Math.max(0, Math.min(100, (v / Math.max(max, 1)) * 100))
  return (
    <div className="span-bar" role="img" aria-label={label}>
      {targetLow !== undefined && targetHigh !== undefined && (
        <div className="span-bar-target" style={{ left: `${pct(targetLow)}%`, width: `${pct(targetHigh) - pct(targetLow)}%` }} />
      )}
      <div className="span-bar-solid" style={{ width: `${pct(low)}%` }} />
      <div className="span-bar-fuzz" style={{ left: `${pct(low)}%`, width: `${pct(high) - pct(low)}%` }} />
    </div>
  )
}

/** Fortschrittsring (z. B. Eiweiß). */
export function Ring({
  value,
  goal,
  size = 76,
  stroke = 7,
  label,
  children,
}: {
  value: number
  goal: number
  size?: number
  stroke?: number
  label: string
  children?: ReactNode
}) {
  const r = (size - stroke) / 2 - 1
  const circ = 2 * Math.PI * r
  const share = Math.max(0, Math.min(1, value / Math.max(goal, 1)))
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--c-track)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--c-fill)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(circ * share).toFixed(1)} ${circ.toFixed(1)}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1.1,
        }}
      >
        {children}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Navigation
 * ------------------------------------------------------------------------- */
export function ArrowLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={className ?? 'link-arrow'}>
      {children}
      <Icon name="chevronRight" size={16} strokeWidth={2} />
    </Link>
  )
}

/** Oberer Balken für Unterseiten: Zurück + Titel. */
export function SubBar({ title, back = -1, right }: { title?: string; back?: string | -1; right?: ReactNode }) {
  const navigate = useNavigate()
  return (
    <div className="subbar">
      <button
        type="button"
        className="btn icon ghost"
        style={{ border: 0, color: 'var(--c-ink)' }}
        aria-label="Zurück"
        onClick={() => {
          if (back === -1 && window.history.length > 1) navigate(-1)
          else navigate(back === -1 ? '/' : back)
        }}
      >
        <Icon name="chevronLeft" size={22} strokeWidth={2} />
      </button>
      {title && <span className="subbar-title">{title}</span>}
      <span style={{ marginLeft: 'auto' }}>{right}</span>
    </div>
  )
}

/** Einfaches Bottom-Sheet mit Hintergrund zum Schließen. */
export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <button type="button" className="sheet-scrim" aria-label="Schließen" onClick={onClose} />
      <section className="sheet pop-in" role="dialog" aria-modal="true" aria-label={label}>
        <div className="sheet-grip" />
        {children}
      </section>
    </>
  )
}

