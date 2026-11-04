import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const requestLink = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    })
    setBusy(false)
    if (error) setError(error.message)
    else setSent(true)
  }

  const verifyCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.verifyOtp({ email, token: code.trim(), type: 'email' })
    setBusy(false)
    if (error) setError('Code falsch oder abgelaufen. Neuen Link/Code anfordern.')
  }

  if (sent) {
    return (
      <div className="screen centered">
        <h1>Happen</h1>
        <p>Mail ist unterwegs an {email}.</p>
        <form onSubmit={verifyCode} className="stack">
          <label>
            6-stelliger Code aus der Mail
            <input
              inputMode="numeric"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
          </label>
          <button type="submit" disabled={busy || code.trim().length < 6}>
            {busy ? 'Prüfe …' : 'Code bestätigen'}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
        <p className="muted">
          Auf dem Gerät mit dem Postfach reicht auch ein Klick auf den Link in der Mail.
        </p>
      </div>
    )
  }

  return (
    <div className="screen centered">
      <h1>Happen</h1>
      <p className="muted">Ernährungstagebuch mit ehrlichen Kalorienspannen.</p>
      <form onSubmit={requestLink} className="stack">
        <input
          type="email"
          required
          placeholder="E-Mail"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Sende …' : 'Login-Code senden'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  )
}
