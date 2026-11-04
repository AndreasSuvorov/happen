import { useState } from 'react'
import { supabase, type Profile } from '../lib/supabase'

export default function Settings({
  profile,
  onProfileSaved,
}: {
  profile: Profile
  onProfileSaved: () => void
}) {
  const [heightCm, setHeightCm] = useState(profile.height_cm?.toString() ?? '')
  const [birthYear, setBirthYear] = useState(profile.birth_year?.toString() ?? '')
  const [sex, setSex] = useState(profile.sex ?? '')
  const [goal, setGoal] = useState(profile.goal_kg_per_week.toString())
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [linkCode, setLinkCode] = useState<{ code: string; deepLink: string | null } | null>(null)
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    await supabase
      .from('users')
      .update({
        height_cm: heightCm ? Number(heightCm) : null,
        birth_year: birthYear ? Number(birthYear) : null,
        sex: sex || null,
        goal_kg_per_week: Number(goal),
      })
      .eq('id', profile.id)
    setSaving(false)
    setSaved(true)
    onProfileSaved()
  }

  const requestLinkCode = async () => {
    setLinking(true)
    setLinkError(null)
    const { data: session } = await supabase.auth.getSession()
    const token = session.session?.access_token
    const { data, error } = await supabase.functions.invoke('link-code', {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    setLinking(false)
    if (error) setLinkError('Konnte keinen Code erzeugen.')
    else setLinkCode(data as { code: string; deepLink: string | null })
  }

  const signOut = () => supabase.auth.signOut()

  return (
    <div className="screen">
      <section className="card">
        <h2>Telegram</h2>
        {profile.telegram_chat_id ? (
          <p>
            ✓ Verbunden (Chat-ID <code>{profile.telegram_chat_id}</code>)
          </p>
        ) : linkCode ? (
          <>
            <p>
              Schick dem Bot: <code>/start {linkCode.code}</code>
            </p>
            {linkCode.deepLink && (
              <a className="button" href={linkCode.deepLink} target="_blank" rel="noreferrer">
                In Telegram öffnen
              </a>
            )}
            <p className="muted">Code läuft in 10 Minuten ab.</p>
          </>
        ) : (
          <>
            <p className="muted">Optional: Happen auch per Telegram nutzen.</p>
            <button onClick={requestLinkCode} disabled={linking}>
              {linking ? 'Erzeuge Code …' : 'Mit Telegram verbinden'}
            </button>
            {linkError && <p className="error">{linkError}</p>}
          </>
        )}
      </section>

      <section className="card">
        <h2>Profil</h2>
        <form onSubmit={saveProfile} className="stack">
          <label>
            Größe (cm)
            <input type="number" value={heightCm} onChange={(e) => setHeightCm(e.target.value)} />
          </label>
          <label>
            Geburtsjahr
            <input type="number" value={birthYear} onChange={(e) => setBirthYear(e.target.value)} />
          </label>
          <label>
            Geschlecht
            <select value={sex} onChange={(e) => setSex(e.target.value)}>
              <option value="">–</option>
              <option value="m">männlich</option>
              <option value="f">weiblich</option>
            </select>
          </label>
          <label>
            Ziel (kg/Woche)
            <input type="number" step="0.1" value={goal} onChange={(e) => setGoal(e.target.value)} />
          </label>
          <button type="submit" disabled={saving}>
            {saving ? 'Speichere …' : 'Speichern'}
          </button>
          {saved && <p className="muted">Gespeichert.</p>}
        </form>
      </section>

      <button className="ghost" onClick={signOut}>
        Abmelden
      </button>
    </div>
  )
}
