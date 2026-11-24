import type { Profile } from '../../lib/supabase'
import { SubBar } from '../../components/ui'

// Platzhalter. Wird nach dem Design „Wochenrückblick“ umgesetzt.
export default function Rueckblick({ profile: _profile }: { profile: Profile }) {
  return (
    <>
      <SubBar title="Wochenrückblick" back="/verlauf" />
      <div className="page">
        <h1 className="page-title">Wochenrückblick</h1>
        <p className="t-muted">Kommt gleich.</p>
      </div>
    </>
  )
}
