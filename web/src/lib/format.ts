// Zahlen, Status-Wörter und Skalen. Getrennt von ui.tsx, damit dort nur Komponenten stehen.

export type RecoveryStatus = 'green' | 'yellow' | 'red' | 'unknown'

export const statusWord: Record<RecoveryStatus, string> = {
  green: 'Gut erholt',
  yellow: 'Etwas müde',
  red: 'Heute schonen',
  unknown: 'Noch kein Urteil',
}

/** Skala für Wert gegen Normalbereich, in Prozent. `min`/`max` legen die Skala fest; ohne Angabe aus Band und Wert. */
export function rangeScale(value: number, low: number, high: number, min?: number, max?: number) {
  const span = Math.max(high - low, 1)
  const lo = min ?? Math.min(value, low) - span * 0.8
  const hi = max ?? Math.max(value, high) + span * 0.8
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))
  return { bandL: pct(low), bandW: pct(high) - pct(low), dot: pct(value) }
}

/* Zahlen (deutsch) */
export function fmt(n: number, digits = 0): string {
  return n.toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

export function fmtRange(low: number, high: number): string {
  return `${fmt(Math.round(low))}–${fmt(Math.round(high))}`
}
