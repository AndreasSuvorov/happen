import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Schedule = {
  briefing_mode: 'after_wake' | 'fixed'
  briefing_time: string
  quiet_from: string
  quiet_to: string
  max_pushes_per_day: number
  channel: 'push' | 'telegram' | 'both'
}

const initialSchedule: Schedule = {
  briefing_mode: 'after_wake',
  briefing_time: '07:00',
  quiet_from: '22:00',
  quiet_to: '06:00',
  max_pushes_per_day: 3,
  channel: 'push',
}

const supportsPush = () => 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator
const isIOSBrowser = () =>
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) &&
  !window.matchMedia('(display-mode: standalone)').matches &&
  !(navigator as Navigator & { standalone?: boolean }).standalone

const subscriptionRequest = (body: Record<string, unknown>) => supabase.functions.invoke('push-subscription', { body })

function decodeKey(key: string) {
  const base64 = key.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

export default function CoachSettingsCard({ userId, hasTelegram }: { userId: string; hasTelegram: boolean }) {
  const [enabled, setEnabled] = useState(false)
  const [schedule, setSchedule] = useState(initialSchedule)
  const [key, setKey] = useState<string | null>(null)
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [settingsMessage, setSettingsMessage] = useState('')

  useEffect(() => {
    let disposed = false
    async function load() {
      const { data: feature } = await supabase.from('user_features').select('feature')
        .eq('user_id', userId).eq('feature', 'garmin').maybeSingle()
      if (disposed || !feature) return
      const { data, error } = await supabase.from('coach_settings')
        .select('channel,briefing_mode,briefing_time,quiet_from,quiet_to,max_pushes_per_day')
        .eq('user_id', userId).maybeSingle()
      if (disposed) return
      if (data) setSchedule(data as Schedule)
      if (error) setSettingsMessage('Coach-Einstellungen konnten nicht geladen werden.')
      setEnabled(true)
      if (!supportsPush() || isIOSBrowser()) return
      const config = await subscriptionRequest({ action: 'config' })
      if (disposed) return
      if (config.data?.publicKey) setKey(config.data.publicKey)
      else setStatus('Web Push ist zurzeit nicht verfügbar.')
      const registration = await navigator.serviceWorker.getRegistration()
      const subscription = await registration?.pushManager.getSubscription()
      if (!subscription) return
      const { data: saved } = await supabase.from('push_subscriptions').select('id')
        .eq('user_id', userId).eq('endpoint', subscription.endpoint).maybeSingle()
      if (!disposed) setSubscribed(!!saved)
    }
    void load().catch(() => {
      if (!disposed) setStatus('Push-Einstellungen konnten nicht geladen werden.')
    })
    return () => { disposed = true }
  }, [userId])

  if (!enabled) return null

  async function togglePush() {
    setBusy(true)
    setStatus('')
    try {
      if (!subscribed && await Notification.requestPermission() !== 'granted') {
        setStatus('Erlaube Mitteilungen in den Einstellungen deines Browsers.')
        return
      }
      const registration = await navigator.serviceWorker.ready
      const existing = await registration.pushManager.getSubscription()
      if (subscribed && existing) {
        const { error } = await subscriptionRequest({ action: 'remove', endpoint: existing.endpoint })
        if (error) throw error
        await existing.unsubscribe()
        setSubscribed(false)
        return
      }
      if (!key) return
      const options = { userVisibleOnly: true, applicationServerKey: decodeKey(key) }
      let subscription = existing ?? await registration.pushManager.subscribe(options)
      let result = await subscriptionRequest({ action: 'save', ...subscription.toJSON() })
      if ((result.error?.context as Response | undefined)?.status === 409 && existing) {
        await existing.unsubscribe()
        subscription = await registration.pushManager.subscribe(options)
        result = await subscriptionRequest({ action: 'save', ...subscription.toJSON() })
      }
      if (result.error) throw result.error
      setSubscribed(true)
    } catch {
      setStatus('Push konnte auf diesem Gerät gerade nicht geändert werden.')
    } finally {
      setBusy(false)
    }
  }

  async function saveSchedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const { error } = await supabase.from('coach_settings').upsert({ user_id: userId, ...schedule })
    setSettingsMessage(error ? 'Speichern fehlgeschlagen.' : 'Gespeichert.')
  }

  return (
    <section className="card">
      <h2>Morgenbriefing</h2>
      <p>Dein Coach fasst morgens deine Erholung zusammen und schlägt Training für den Tag vor.</p>
      <a href="/heute">Briefing öffnen</a>
      {isIOSBrowser() ? (
        <p className="muted">Öffne in Safari das Teilen-Menü und wähle „Zum Home-Bildschirm“. Starte Happen über das neue Symbol und aktiviere dort Mitteilungen.</p>
      ) : supportsPush() ? (
        <p><button type="button" disabled={busy || (!subscribed && !key)} onClick={togglePush}>
          {subscribed ? 'Push auf diesem Gerät ausschalten' : 'Push auf diesem Gerät aktivieren'}
        </button></p>
      ) : (
        <p className="muted">Dieser Browser unterstützt keine Push-Mitteilungen.</p>
      )}
      {status && <p role="status">{status}</p>}
      <form className="stack" onSubmit={saveSchedule}>
        <label>
          Kanal
          <select value={schedule.channel} onChange={(e) => setSchedule({ ...schedule, channel: e.target.value as Schedule['channel'] })}>
            <option value="push">Web Push</option>
            <option value="telegram" disabled={!hasTelegram}>Telegram</option>
            <option value="both" disabled={!hasTelegram}>Web Push und Telegram</option>
          </select>
        </label>
        <label>
          Zeitpunkt
          <select value={schedule.briefing_mode} onChange={(e) => setSchedule({ ...schedule, briefing_mode: e.target.value as Schedule['briefing_mode'] })}>
            <option value="after_wake">Nach dem Aufwachen</option>
            <option value="fixed">Feste Uhrzeit</option>
          </select>
        </label>
        {schedule.briefing_mode === 'fixed' && (
          <label>Uhrzeit<input required type="time" value={schedule.briefing_time.slice(0, 5)}
            onChange={(e) => setSchedule({ ...schedule, briefing_time: e.target.value })} /></label>
        )}
        <label>Ruhezeit von<input required type="time" value={schedule.quiet_from.slice(0, 5)}
          onChange={(e) => setSchedule({ ...schedule, quiet_from: e.target.value })} /></label>
        <label>Ruhezeit bis<input required type="time" value={schedule.quiet_to.slice(0, 5)}
          onChange={(e) => setSchedule({ ...schedule, quiet_to: e.target.value })} /></label>
        <label>Maximale Push-Mitteilungen pro Tag<input required min="0" max="10" type="number" value={schedule.max_pushes_per_day}
          onChange={(e) => setSchedule({ ...schedule, max_pushes_per_day: Number(e.target.value) })} /></label>
        <button type="submit">Speichern</button>
        {settingsMessage && <p role="status">{settingsMessage}</p>}
      </form>
    </section>
  )
}
