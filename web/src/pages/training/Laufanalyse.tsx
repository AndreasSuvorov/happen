import type { Profile } from '../../lib/supabase'
import { SubBar } from '../../components/ui'

// Platzhalter. Wird nach dem Design „Laufanalyse“ umgesetzt.
export default function Laufanalyse({ profile: _profile }: { profile: Profile }) {
  return (
    <>
      <SubBar title="Laufanalyse" />
      <div className="page">
        <h1 className="page-title">Laufanalyse</h1>
        <p className="t-muted">Kommt gleich.</p>
      </div>
    </>
  )
}
