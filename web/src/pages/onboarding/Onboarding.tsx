import type { Profile } from '../../lib/supabase'

// Platzhalter. Wird nach dem Design „Onboarding“ umgesetzt.
export default function Onboarding({ profile: _profile }: { profile: Profile }) {
  return (
    <>
      <div className="page">
        <h1 className="page-title">Onboarding</h1>
        <p className="t-muted">Kommt gleich.</p>
      </div>
    </>
  )
}
