import type { Profile } from '../../lib/supabase'
import { SubBar } from '../../components/ui'

// Platzhalter. Wird nach dem Design „Warum?“ umgesetzt.
export default function Warum({ profile: _profile }: { profile: Profile }) {
  return (
    <>
      <SubBar title="Warum?" back="/heute" />
      <div className="page">
        <h1 className="page-title">Warum?</h1>
        <p className="t-muted">Kommt gleich.</p>
      </div>
    </>
  )
}
