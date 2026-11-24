import type { Profile } from '../../lib/supabase'

// Platzhalter. Wird nach dem Design „Verlauf“ umgesetzt.
export default function Verlauf({ profile: _profile }: { profile: Profile }) {
  return (
    <>
      <div className="page">
        <h1 className="page-title">Verlauf</h1>
        <p className="t-muted">Kommt gleich.</p>
      </div>
    </>
  )
}
