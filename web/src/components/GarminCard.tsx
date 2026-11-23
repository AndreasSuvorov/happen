import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// Garmin verbinden (Personal API Key). Nur sichtbar, wenn das Feature "garmin" freigeschaltet ist.
// Ausführliches Onboarding folgt später (Plan 9.6); das hier ist die schlanke Version für M1.

interface Status {
  connected: boolean
  status?: 'active' | 'expired' | 'error' | 'disconnected'
  lastSyncAt?: string | null
  lastDataAt?: string | null
  backfillPending?: boolean
  lastError?: string | null
}

const ERRORS: Record<string, string> = {
  key_rejected: 'Garmin hat den Schlüssel abgelehnt. Ist er abgelaufen oder unvollständig kopiert?',
  consent_required: 'Bitte bestätige zuerst die Einwilligung.',
  invalid_key: 'Das sieht nicht nach einem Garmin-Schlüssel aus.',
  garmin_unreachable: 'Garmin ist gerade nicht erreichbar. Versuch es in ein paar Minuten nochmal.',
}

async function call<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body })
  if (error) {
    let code = 'unknown'
    try {
      code = (await (error as { context?: Response }).context?.json())?.error ?? code
    } catch {
      // keine JSON-Antwort
    }
    throw new Error(code)
  }
  return data as T
}

function ago(iso: string | null | undefined): string {
  if (!iso) return 'noch nie'
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (min < 1) return 'gerade eben'
  if (min < 60) return `vor ${min} min`
  const h = Math.round(min / 60)
  return h < 48 ? `vor ${h} h` : `vor ${Math.round(h / 24)} Tagen`
}

export default function GarminCard({ userId }: { userId: string }) {
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setStatus(await call<Status>('wearable-connect', { action: 'status' }))
    } catch {
      setError('Status konnte nicht geladen werden.')
    }
  }, [])

  useEffect(() => {
    supabase
      .from('user_features')
      .select('feature')
      .eq('user_id', userId)
      .eq('feature', 'garmin')
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setEnabled(true)
          void load()
        }
      })
  }, [userId, load])

  if (!enabled) return null

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(ERRORS[(e as Error).message] ?? 'Das hat nicht geklappt.')
    } finally {
      setBusy(false)
    }
  }

  const connect = (e: React.FormEvent) => {
    e.preventDefault()
    void run(async () => {
      setStatus(await call<Status>('wearable-connect', { action: 'connect', apiKey, consent }))
      setApiKey('')
    })
  }

  const syncNow = () =>
    run(async () => {
      await call('garmin-sync', {})
      await load()
    })

  const disconnect = (deleteData: boolean) => {
    const question = deleteData
      ? 'Verbindung trennen und alle Garmin-Daten in happen löschen? Deine Mahlzeiten und Gewichte bleiben.'
      : 'Verbindung trennen? Die bisher geladenen Daten bleiben erhalten.'
    if (!window.confirm(question)) return
    void run(async () => {
      setStatus(await call<Status>('wearable-connect', { action: 'disconnect', deleteData }))
    })
  }

  const showForm = status && (!status.connected || status.status === 'expired')

  return (
    <section className="card">
      <h2>Garmin</h2>
      {!status && <p className="muted">Lade …</p>}

      {status?.connected && status.status === 'active' && (
        <div className="stack">
          <p>✓ Verbunden · letzter Abgleich {ago(status.lastSyncAt)}</p>
          {status.backfillPending && <p className="muted">Ich lade gerade deine letzten 4 Wochen.</p>}
          {status.lastDataAt && Date.now() - Date.parse(status.lastDataAt) > 12 * 3_600_000 && (
            <p className="muted">
              Seit {ago(status.lastDataAt).replace('vor ', '')} kamen keine neuen Daten. Öffne kurz Garmin Connect auf dem Handy.
            </p>
          )}
          <button onClick={syncNow} disabled={busy}>
            {busy ? 'Prüfe …' : 'Nochmal prüfen'}
          </button>
        </div>
      )}

      {status?.connected && status.status === 'expired' && (
        <p className="error">Garmin-Verbindung abgelaufen. Erstell einen neuen Schlüssel und füg ihn hier ein.</p>
      )}

      {showForm && (
        <form onSubmit={connect} className="stack">
          <p className="muted">Verbinde deine Uhr, dann kann ich dir sagen, wie erholt du bist.</p>
          <ol className="muted">
            <li>
              Öffne <a href="https://connect.garmin.com/" target="_blank" rel="noreferrer">Garmin Connect</a> im
              Browser und such den Bereich „Personal API Key“.
            </li>
            <li>„Create Key“, Bedingungen akzeptieren, Ablaufdatum wählen.</li>
            <li>Schlüssel kopieren (er wird nur einmal angezeigt) und hier einfügen.</li>
          </ol>
          <label>
            Personal API Key
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
            />
          </label>
          <label style={{ flexDirection: 'row', alignItems: 'flex-start', gap: '0.5rem' }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              Ich willige ein, dass happen meine Gesundheitsdaten von Garmin (Schlaf, HRV, Puls, Body Battery, Stress,
              Aktivitäten) speichert und auswertet. Für Auswertungen werden aufbereitete Werte an Anthropic (Claude)
              übermittelt, keine GPS-Daten. Ich kann die Verbindung jederzeit trennen und die Daten löschen.
            </span>
          </label>
          <button type="submit" disabled={busy || !consent || !apiKey}>
            {busy ? 'Verbinde …' : 'Verbinden'}
          </button>
        </form>
      )}

      {error && <p className="error">{error}</p>}

      {status?.connected && (
        <div className="stack" style={{ marginTop: '0.75rem' }}>
          <button className="ghost" style={{ margin: 0 }} onClick={() => disconnect(false)} disabled={busy}>
            Trennen
          </button>
          <button className="ghost" style={{ margin: 0 }} onClick={() => disconnect(true)} disabled={busy}>
            Trennen und Garmin-Daten löschen
          </button>
        </div>
      )}
    </section>
  )
}
