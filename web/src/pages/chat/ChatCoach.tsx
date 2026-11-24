import type { Profile } from '../../lib/supabase'

// Platzhalter. Wird nach dem Design „Chat“ umgesetzt.
export default function ChatCoach({ profile: _profile }: { profile: Profile }) {
  return (
    <>
      <div className="page">
        <h1 className="page-title">Chat</h1>
        <p className="t-muted">Kommt gleich.</p>
      </div>
    </>
  )
}
