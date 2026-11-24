import type { Profile } from '../../lib/supabase'

// Platzhalter. Wird nach dem Design „Heute“ umgesetzt.
export default function Heute({ profile: _profile }: { profile: Profile }) {
  return (
    <>
      <div className="page">
        <h1 className="page-title">Heute</h1>
        <p className="t-muted">Kommt gleich.</p>
      </div>
    </>
  )
}
