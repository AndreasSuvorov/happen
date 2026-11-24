import type { Profile } from '../../lib/supabase'
import { SubBar } from '../../components/ui'

// Platzhalter. Wird nach dem Design „Einstellungen“ umgesetzt.
export default function Einstellungen({ profile: _profile, onProfileSaved: _onProfileSaved }: { profile: Profile; onProfileSaved: () => void }) {
  return (
    <>
      <SubBar title="Einstellungen" back="/heute" />
      <div className="page">
        <h1 className="page-title">Einstellungen</h1>
        <p className="t-muted">Kommt gleich.</p>
      </div>
    </>
  )
}
