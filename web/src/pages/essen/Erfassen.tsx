import type { Profile } from '../../lib/supabase'

// Platzhalter. Wird nach dem Design „Mahlzeit erfassen“ umgesetzt.
export default function Erfassen({ profile: _profile }: { profile: Profile }) {
  return (
    <>
      <div className="page">
        <h1 className="page-title">Mahlzeit erfassen</h1>
        <p className="t-muted">Kommt gleich.</p>
      </div>
    </>
  )
}
