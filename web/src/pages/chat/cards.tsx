// Karten in Coach-Antworten: Vergleich mit dem Normalbereich, Mini-Laufkarte, kleine Tabelle, Antwort-Chips.
import { Link } from 'react-router-dom'
import { Icon, RangeBar } from '../../components/ui'
import { fmt } from '../../lib/format'
import type { Card, ChipsCard, MetricCompareCard, RunCard, TableCard } from './types'

const unitShown = (unit: string) => (unit === 'bpm' ? '' : unit)

function valueText(value: number, unit: string) {
  const digits = unit === 'h' ? 1 : 0
  const u = unitShown(unit)
  return u ? `${fmt(value, digits)} ${u}` : fmt(value, digits)
}

function rangeText(low: number, high: number, unit: string) {
  const digits = unit === 'h' ? 1 : 0
  return `${fmt(low, digits)}–${fmt(high, digits)}`
}

export function MetricCompare({ card }: { card: MetricCompareCard }) {
  return (
    <div className="chat-card chat-compare" role="group" aria-label="Vergleich mit deinem Normalbereich">
      {card.items.map((m) => (
        <div key={m.metric} className="chat-compare-row">
          <div className="chat-compare-head">
            <span className="t-muted">{m.label}</span>
            <span>
              <span className="chat-compare-value">{valueText(m.value, m.unit)}</span>{' '}
              <span className="t-muted">· normal {rangeText(m.low, m.high, m.unit)}</span>
            </span>
          </div>
          <RangeBar
            value={m.value}
            low={m.low}
            high={m.high}
            label={`${m.label} ${valueText(m.value, m.unit)}, normal ${rangeText(m.low, m.high, m.unit)}`}
          />
        </div>
      ))}
    </div>
  )
}

/** Mini-Pulslinie mit gestrichelter Obergrenze. */
function PulseLine({ hr, cap }: { hr: number[]; cap: number | null }) {
  const W = 270
  const H = 40
  const values = cap ? [...hr, cap] : hr
  const lo = Math.min(...values) - 5
  const hi = Math.max(...values) + 5
  const y = (v: number) => (H - ((v - lo) / (hi - lo)) * H).toFixed(1)
  const d = hr.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (hr.length - 1)) * W).toFixed(1)} ${y(v)}`).join(' ')
  return (
    <svg className="chat-run-line" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {cap && <line x1="0" x2={W} y1={y(cap)} y2={y(cap)} className="chat-run-cap" vectorEffect="non-scaling-stroke" />}
      <path d={d} className="chat-run-path" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function RunCardView({ card }: { card: RunCard }) {
  const icon = card.tone === 'warn' ? 'trendUp' : card.tone === 'good' ? 'check' : 'run'
  return (
    <Link to={`/lauf/${encodeURIComponent(card.activity_id)}`} className="chat-card chat-run">
      <span className="chat-run-head">
        <span className={`chat-run-icon ${card.tone}`}>
          <Icon name={icon} size={16} strokeWidth={2.2} />
        </span>
        <span className="chat-run-title">{card.title}</span>
      </span>
      {card.hr && card.hr.length >= 5 && <PulseLine hr={card.hr} cap={card.hr_cap} />}
      <span className="t-13 t-muted">{card.detail}</span>
      <span className="chat-run-link">
        Zur Laufanalyse
        <Icon name="chevronRight" size={16} strokeWidth={2} />
      </span>
    </Link>
  )
}

export function TableView({ card }: { card: TableCard }) {
  return (
    <div className="chat-card chat-table">
      <table>
        {card.title && <caption>{card.title}</caption>}
        <tbody>
          {card.rows.slice(0, 5).map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td>
                <span className="chat-table-value">{r.value}</span>
                {r.note && <span className="chat-table-note">{r.note}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ChipsView({
  card,
  onPick,
  answered,
}: {
  card: ChipsCard
  onPick: (option: string, noteDate?: string) => void
  answered?: string | null
}) {
  return (
    <div className="chips wrap chat-chips" role="group" aria-label="Antwortvorschläge">
      {card.options.map((o) => (
        <button
          key={o}
          type="button"
          className="chip accent-text"
          aria-pressed={answered === o}
          disabled={!!answered}
          onClick={() => onPick(o, card.note_date)}
        >
          {o}
        </button>
      ))}
    </div>
  )
}

export function CardView({
  card,
  onPick,
  answered,
}: {
  card: Card
  onPick: (option: string, noteDate?: string) => void
  answered?: string | null
}) {
  switch (card.type) {
    case 'metric_compare':
      return card.items.length ? <MetricCompare card={card} /> : null
    case 'run_card':
      return <RunCardView card={card} />
    case 'table':
      return card.rows.length ? <TableView card={card} /> : null
    case 'chips':
      return card.options.length ? <ChipsView card={card} onPick={onPick} answered={answered} /> : null
    default:
      return null
  }
}
