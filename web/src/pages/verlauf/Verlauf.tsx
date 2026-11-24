import { Navigate, useNavigate, useParams } from 'react-router-dom'
import type { Profile } from '../../lib/supabase'
import { ArrowLink } from '../../components/ui'
import Woche from './Woche'
import Trends from './Trends'
import Muster from './Muster'
import './verlauf.css'

const views = [
  ['woche', 'Woche'],
  ['trends', 'Trends'],
  ['muster', 'Muster'],
] as const

type View = (typeof views)[number][0]

export default function Verlauf({ profile: _profile }: { profile: Profile }) {
  const { ansicht } = useParams()
  const navigate = useNavigate()
  if (ansicht && !views.some(([id]) => id === ansicht)) return <Navigate to="/verlauf" replace />
  const view: View = (ansicht as View | undefined) ?? 'woche'

  return (
    <div className="page vl-page">
      <header className="vl-header">
        <h1 className="page-title">Verlauf</h1>
        <ArrowLink to="/rueckblick">Wochenrückblick</ArrowLink>
      </header>

      <div role="group" aria-label="Ansicht" className="vl-segments">
        {views.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={id === view}
            onClick={() => navigate(id === 'woche' ? '/verlauf' : `/verlauf/${id}`, { replace: true })}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'woche' && <Woche />}
      {view === 'trends' && <Trends />}
      {view === 'muster' && <Muster />}
    </div>
  )
}
