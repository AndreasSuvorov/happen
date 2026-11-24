import type { Profile } from '../../lib/supabase'

// Platzhalter. Wird nach dem Design „Essen“ umgesetzt.
export default function Essen({ profile: _profile }: { profile: Profile }) {
  return (
    <>
      <div className="page">
        <h1 className="page-title">Essen</h1>
        <p className="t-muted">Kommt gleich.</p>
      </div>
    </>
  )
}
