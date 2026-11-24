import type { Profile } from '../../lib/supabase'

// Platzhalter. Wird nach dem Design „Training“ umgesetzt.
export default function Training({ profile: _profile }: { profile: Profile }) {
  return (
    <>
      <div className="page">
        <h1 className="page-title">Training</h1>
        <p className="t-muted">Kommt gleich.</p>
      </div>
    </>
  )
}
