import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Profile } from '../../lib/supabase'
import { fetchCoachSettings, updateCoachSettings, type CoachSettings, type WearableStatus } from '../../lib/coach'
import { Icon } from '../../components/ui'
import GoalEditor from './GoalEditor'
import { draftFromGoal, goalFromDraft, parseGoal, type GoalDraft } from './goal'
import { isOnboardingDone, markOnboardingDone, rememberGoalSaved } from './state'
import { isIOSBrowser, permissionHelp, pushPermission, subscribePush, supportsPush } from './push'
import {
  BACKFILL_DAYS,
  connectWearable,
  errorText,
  garminEnabled,
  loadedDays,
  wearableStatus,
} from './wearable'
import './onboarding.css'

type Channel = CoachSettings['channel']

const GARMIN_URL = 'https://connect.garmin.com/'

const KEY_STEPS = [
  'Öffne in Garmin Connect die Seite „Personal API Key“.',
  'Tippe auf „Create Key“, akzeptiere die Bedingungen und wähle ein Ablaufdatum.',
  'Kopiere den Schlüssel. Er wird nur einmal angezeigt.',
  'Füge ihn unten ein. Er bleibt verschlüsselt bei uns und geht nie an die KI.',
]

const HOME_STEPS = [
  'Tippe unten in Safari auf „Teilen“.',
  'Wähle „Zum Home-Bildschirm“ und tippe auf „Hinzufügen“.',
  'Öffne happen ab jetzt über das neue Symbol.',
]

const CHANNELS: [Channel, string][] = [
  ['push', 'Mitteilung'],
  ['telegram', 'Telegram'],
  ['both', 'Beides'],
]

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="ob-steps">
      {items.map((text, i) => (
        <li key={text}>
          <span className="ob-step-n" aria-hidden="true">
            {i + 1}
          </span>
          <span className="ob-step-text">
            <span className="sr-only">{i + 1}. </span>
            {text}
          </span>
        </li>
      ))}
    </ol>
  )
}

function Head({ title, text }: { title: string; text: string }) {
  return (
    <div className="ob-head">
      <h1 className="page-title">{title}</h1>
      <p className="ob-lead">{text}</p>
    </div>
  )
}

export default function Onboarding({ profile }: { profile: Profile }) {
  const navigate = useNavigate()
  const params = useParams()
  const [search] = useSearchParams()
  const step = Math.max(1, Math.min(4, Number.parseInt(params.schritt ?? '1', 10) || 1))
  const showHomescreen = isIOSBrowser()
  const wasDone = isOnboardingDone(profile.id)
  const renewRequested = search.has('erneuern')

  // Schritt 1: Ziel
  const [draft, setDraft] = useState<GoalDraft>(() => draftFromGoal(null))
  const [goalTouched, setGoalTouched] = useState(false)
  // Schritt 2: Uhr
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [status, setStatus] = useState<WearableStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [consent, setConsent] = useState(false)
  const [days, setDays] = useState<number | null>(null)
  // Schritt 4: Kanal
  const [channel, setChannel] = useState<Channel>('push')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Bestehende Einstellungen laden (Ziel vorbelegen, Kanal übernehmen).
  useEffect(() => {
    let active = true
    fetchCoachSettings()
      .then((s) => {
        if (!active || !s) return
        const g = parseGoal(s.goal)
        if (g && !goalTouched) setDraft(draftFromGoal(g))
        if (s.channel) setChannel(s.channel)
      })
      .catch(() => {})
    return () => {
      active = false
    }
    // Nur einmal beim Öffnen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Uhr-Status (Schritt 2)
  useEffect(() => {
    if (step !== 2) return
    let active = true
    garminEnabled(profile.id)
      .then(async (on) => {
        if (!active) return
        setEnabled(on)
        if (on) {
          const s = await wearableStatus().catch(() => null)
          if (active) setStatus(s)
        }
      })
      .catch(() => active && setEnabled(false))
    return () => {
      active = false
    }
  }, [step, profile.id])

  const connected = !!status?.connected && status.status === 'active'
  const expired = !!status?.connected && status.status !== 'active'
  const renew = renewRequested || expired

  // Fortschritt des Backfills, solange er läuft.
  useEffect(() => {
    if (step !== 2 || !connected) return
    let active = true
    let timer: number | undefined
    const tick = async () => {
      const n = await loadedDays().catch(() => null)
      if (!active) return
      if (n !== null) setDays(n)
      if (status?.backfillPending && (n ?? 0) < BACKFILL_DAYS) {
        timer = window.setTimeout(() => {
          void wearableStatus()
            .then((s) => active && setStatus(s))
            .catch(() => {})
        }, 5000)
      }
    }
    void tick()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [step, connected, status])

  // Homescreen-Schritt nur auf iOS im Browser.
  useEffect(() => {
    if (step === 3 && !showHomescreen) navigate('/onboarding/4', { replace: true })
  }, [step, showHomescreen, navigate])

  const go = (n: number) => {
    setError(null)
    if (n === 3 && !showHomescreen) n = step < 3 ? 4 : 2
    navigate(`/onboarding/${Math.max(1, Math.min(4, n))}`)
  }

  const finish = () => {
    markOnboardingDone(profile.id)
    navigate('/heute', { replace: true })
  }

  /** Wer das Onboarding schon kennt (z. B. „So erneuerst du ihn“), landet nach Schritt 2 wieder auf Heute. */
  const afterWatch = () => (wasDone ? navigate('/heute') : go(3))

  const back = () => {
    if (wasDone && step === 2 && window.history.length > 1) navigate(-1)
    else go(step - 1)
  }

  const saveGoal = async () => {
    const res = goalFromDraft(draft)
    if ('error' in res) {
      setError(res.error)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await updateCoachSettings(profile.id, { goal: res.goal })
      rememberGoalSaved(profile.id)
      go(2)
    } catch {
      setError('Speichern hat nicht geklappt. Versuch es nochmal.')
    } finally {
      setBusy(false)
    }
  }

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await connectWearable(apiKey, consent))
      setApiKey('')
      setDays(null)
    } catch (e) {
      setError(errorText((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const allowPush = async () => {
    setBusy(true)
    setError(null)
    if (channel !== 'telegram') await subscribePush()
    try {
      await updateCoachSettings(profile.id, { channel })
    } catch {
      // Kanal lässt sich später in den Einstellungen ändern.
    }
    setBusy(false)
    finish()
  }

  const hasTelegram = !!profile.telegram_chat_id
  const permission = pushPermission()
  const showForm = enabled && status && (!status.connected || expired)

  // Unterer Bereich: Hauptknopf je Schritt
  let primary: { label: string; onClick: () => void; disabled?: boolean } | null = null
  if (step === 1) primary = { label: busy ? 'Speichere …' : 'Weiter', onClick: () => void saveGoal(), disabled: busy }
  if (step === 2) {
    if (showForm)
      primary = {
        label: busy ? 'Verbinde …' : 'Verbinden',
        onClick: () => void connect(),
        disabled: busy || !consent || apiKey.trim().length === 0,
      }
    else primary = { label: wasDone ? 'Fertig' : 'Weiter', onClick: afterWatch, disabled: enabled === null }
  }
  if (step === 3) primary = { label: 'Erledigt', onClick: () => go(4) }

  const canSkip = step === 2 || step === 3
  const pct = days === null ? 0 : Math.round((days / BACKFILL_DAYS) * 100)

  return (
    <div className="ob">
      <header className="ob-header">
        {step > 1 ? (
          <button type="button" className="ob-icon-btn" aria-label="Zurück" onClick={back}>
            <Icon name="chevronLeft" size={24} strokeWidth={2.2} />
          </button>
        ) : (
          <span className="ob-spacer" />
        )}
        <div
          className="ob-progress"
          role="progressbar"
          aria-label={`Schritt ${step} von 4`}
          aria-valuemin={1}
          aria-valuemax={4}
          aria-valuenow={step}
        >
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="ob-dot" data-on={i <= step} />
          ))}
        </div>
        {canSkip ? (
          <button type="button" className="ob-skip" onClick={step === 2 ? afterWatch : () => go(step + 1)}>
            Überspringen
          </button>
        ) : (
          <span className="ob-spacer" />
        )}
      </header>

      <main className="ob-main" key={step}>
        {step === 1 && (
          <>
            <Head title="Was willst du erreichen?" text="Du kannst mehreres wählen. Das ändert, worauf ich achte." />
            <GoalEditor
              draft={draft}
              onChange={(d) => {
                setGoalTouched(true)
                setError(null)
                setDraft(d)
              }}
            />
          </>
        )}

        {step === 2 && (
          <>
            {renew && !connected ? (
              <Head
                title="Erneuere deinen Schlüssel"
                text="Dein alter Schlüssel gilt nicht mehr. Erstell in Garmin Connect einen neuen, dann geht alles weiter wie bisher."
              />
            ) : (
              <Head
                title="Verbinde deine Uhr"
                text="Damit ich sehe, wie du schläfst und läufst. Dauert etwa 2 Minuten."
              />
            )}

            {enabled === null || (enabled && !status) ? (
              <div className="ob-loading" aria-busy="true">
                <div className="skeleton" style={{ height: 120 }} />
                <span className="sr-only">Lädt …</span>
              </div>
            ) : null}

            {enabled === false && (
              <div className="card soft">
                <p className="t-15">
                  Die Uhr-Verbindung ist für dein Konto noch nicht freigeschaltet. Überspring diesen Schritt, du kannst
                  sie später in den Einstellungen verbinden.
                </p>
              </div>
            )}

            {showForm && (
              <>
                <Steps items={KEY_STEPS} />
                <a className="ob-ext" href={GARMIN_URL} target="_blank" rel="noreferrer">
                  Garmin Connect öffnen
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5" />
                  </svg>
                  <span className="sr-only">(öffnet in neuem Fenster)</span>
                </a>
                <form
                  className="ob-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (consent && apiKey.trim()) void connect()
                  }}
                >
                  <div className="ob-field">
                    <label htmlFor="ob-key">Dein Schlüssel</label>
                    <input
                      id="ob-key"
                      className="ob-input surface"
                      type="password"
                      autoComplete="off"
                      placeholder="Hier einfügen"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                    />
                  </div>
                  <label className="ob-consent">
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                    <span>
                      Ich bin einverstanden, dass happen meine Gesundheitsdaten (Schlaf, Puls, HRV, Läufe) speichert und
                      zur Auswertung an Anthropic übermittelt. Ich kann das jederzeit widerrufen und alles löschen.
                    </span>
                  </label>
                </form>
              </>
            )}

            {connected && (
              <div className="ob-connected pop-in" aria-live="polite">
                <div className="ob-connected-head">
                  <span className="ob-check" aria-hidden="true">
                    <Icon name="check" size={18} strokeWidth={2.6} />
                  </span>
                  <span className="ob-connected-title">Verbunden</span>
                </div>
                <p className="t-15">
                  {status?.backfillPending
                    ? 'Ich lade deine letzten 4 Wochen. Du kannst schon weitermachen.'
                    : 'Deine Uhr ist verbunden. Neue Nächte und Läufe hole ich automatisch.'}
                </p>
                {days !== null && (
                  <>
                    <div
                      className="ob-bar"
                      role="progressbar"
                      aria-label="Geladene Tage"
                      aria-valuemin={0}
                      aria-valuemax={BACKFILL_DAYS}
                      aria-valuenow={days}
                    >
                      <div className="ob-bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="t-13 t-muted">
                      {days} von {BACKFILL_DAYS} Tagen geladen
                    </span>
                  </>
                )}
              </div>
            )}

            {error && (
              <p className="ob-error" role="alert">
                {error}
              </p>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <Head
              title="Leg happen auf deinen Homescreen"
              text="Nur dann kann ich dir morgens eine Mitteilung schicken. Und happen öffnet sich wie eine App."
            />
            <div className="ob-phone" aria-hidden="true">
              <div className="ob-phone-url">happen.app</div>
              <div className="ob-phone-bar">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M15 5l-7 7 7 7" /></svg>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M9 5l7 7-7 7" /></svg>
                <span className="ob-share">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M8 7l4-4 4 4M5 11v9h14v-9" /></svg>
                </span>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 4h12v16l-6-4-6 4z" /></svg>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="3" /></svg>
              </div>
            </div>
            <Steps items={HOME_STEPS} />
          </>
        )}

        {step === 4 && (
          <>
            <Head
              title="Darf ich dich morgens kurz informieren?"
              text="Einmal nach dem Aufwachen: wie erholt du bist und was heute dran ist. Nach einem Lauf sage ich dir, wie er war. Höchstens 3 Mitteilungen am Tag, nie nachts."
            />
            <div className="ob-notif" role="img" aria-label="Beispiel einer Mitteilung: Gut erholt. Heute 40 Min. locker.">
              <span className="ob-notif-icon" aria-hidden="true">
                <Icon name="sun" size={20} />
              </span>
              <span className="ob-notif-body" aria-hidden="true">
                <span className="ob-notif-meta">
                  <span>happen</span>
                  <span>06:02</span>
                </span>
                <span className="ob-notif-title">Gut erholt</span>
                <span className="ob-notif-text">Heute 40 Min. locker. Und: Was war gestern Abend los?</span>
              </span>
            </div>
            <div className="ob-channel">
              <span className="t-13 t-muted" id="ob-channel-label">
                Wo soll ich dich erreichen?
              </span>
              <div className="ob-seg" role="group" aria-labelledby="ob-channel-label">
                {CHANNELS.map(([id, label]) => {
                  const locked = id !== 'push' && !hasTelegram
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={channel === id}
                      disabled={locked}
                      onClick={() => setChannel(id)}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
              {!hasTelegram && (
                <p className="t-13 t-muted ob-note">
                  Telegram ist noch nicht verknüpft. Das geht später in den Einstellungen unter „Telegram“.
                </p>
              )}
              {channel !== 'telegram' && isIOSBrowser() && (
                <p className="t-13 t-muted ob-note">
                  Auf dem iPhone kommen Mitteilungen erst an, wenn du happen vom Homescreen aus öffnest.
                </p>
              )}
              {channel !== 'telegram' && !isIOSBrowser() && !supportsPush() && (
                <p className="t-13 t-muted ob-note">Dieser Browser kann leider keine Mitteilungen empfangen.</p>
              )}
              {channel !== 'telegram' && permission === 'denied' && (
                <p className="t-13 t-muted ob-note">Mitteilungen sind für happen gesperrt. {permissionHelp()}</p>
              )}
            </div>
          </>
        )}
      </main>

      <footer className="ob-footer">
        {step === 1 && error && (
          <p className="ob-error" role="alert">
            {error}
          </p>
        )}
        {primary && (
          <button type="button" className="ob-primary" onClick={primary.onClick} disabled={primary.disabled}>
            {primary.label}
          </button>
        )}
        {step === 4 && (
          <>
            <button type="button" className="ob-primary" onClick={() => void allowPush()} disabled={busy}>
              {busy ? 'Einen Moment …' : 'Ja, gerne'}
            </button>
            <button type="button" className="ob-secondary" onClick={finish} disabled={busy}>
              Lieber nicht
            </button>
          </>
        )}
      </footer>
    </div>
  )
}
