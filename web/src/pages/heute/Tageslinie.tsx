import type { Profile } from '../../lib/supabase'

// Platzhalter. Wird nach dem Design „Tageslinie“ umgesetzt.
export default function Tageslinie({ profile: _profile }: { profile: Profile }) {
  return (
    <>
      <div className="page">
        <h1 className="page-title">Tageslinie</h1>
        <p className="t-muted">Kommt gleich.</p>
      </div>
    </>
  )
}
