import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
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

  if (sent) {
    return (
      <div className="screen centered">
        <h1>Happen</h1>
        <p>Link ist unterwegs an {email}. Postfach checken und den Link öffnen.</p>
      </div>
    )
  }

  return (
    <div className="screen centered">
      <h1>Happen</h1>
      <p className="muted">Ernährungstagebuch mit ehrlichen Kalorienspannen.</p>
      <form onSubmit={submit} className="stack">
        <input
          type="email"
          required
          placeholder="E-Mail"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Sende Link …' : 'Login-Link senden'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  )
}
