import type { ReactNode } from 'react'
import { Icon } from '../../components/ui'

// Strich-Icons je Mahlzeit im Stil von components/ui (24er-Raster, 1.8 Strich, currentColor).
const meal: Record<string, ReactNode> = {
  // Tasse
  breakfast: (
    <>
      <path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z" />
      <path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16" />
      <path d="M9 3.5c-.8 1 .8 2-.2 3M12.5 3.5c-.8 1 .8 2-.2 3" />
    </>
  ),
  // Schüssel
  lunch: (
    <>
      <path d="M3.5 11h17a8.5 8.5 0 0 1-17 0z" />
      <path d="M9 19.5h6M8 7.5c1-1.5 2.5-1.5 3.5 0s2.5 1.5 3.5 0" />
    </>
  ),
  // Teller mit Besteck
  dinner: (
    <>
      <circle cx="12" cy="12" r="5.5" />
      <path d="M2.5 4v5a1.5 1.5 0 0 0 3 0V4M4 10.5V20M21 4c-1.5 1.5-2 4-2 7h2v9" />
    </>
  ),
  // Apfel
  snack: (
    <>
      <path d="M12 7.5c-2-1.5-7-1.5-7 4.5 0 4.5 3 8.5 5 8.5 1 0 1.3-.5 2-.5s1 .5 2 .5c2 0 5-4 5-8.5 0-6-5-6-7-4.5z" />
      <path d="M12 7.5c0-2 .8-3.5 2.5-4.5" />
    </>
  ),
}

export function MealIcon({ meal: m, title }: { meal: string | null; title: string }) {
  if (m === 'drink' || /shake|smoothie/i.test(title)) return <Icon name="shake" size={22} />
  const p = m ? meal[m] : undefined
  if (!p) return <Icon name="food" size={22} />
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {p}
    </svg>
  )
}
