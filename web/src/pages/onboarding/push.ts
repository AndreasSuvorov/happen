import { supabase } from '../../lib/supabase'

// Web Push wie in components/CoachSettingsCard.tsx (VAPID-Key und Edge Function push-subscription).

export const supportsPush = () =>
  typeof window !== 'undefined' && 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export const isAndroid = () => /Android/i.test(navigator.userAgent)

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone

/** iPhone/iPad im Browser (nicht vom Homescreen gestartet): dort gibt es kein Web Push. */
export const isIOSBrowser = () => isIOS() && !isStandalone()

export const pushPermission = (): NotificationPermission | 'unsupported' =>
  supportsPush() ? Notification.permission : 'unsupported'

const subscriptionRequest = (body: Record<string, unknown>) => supabase.functions.invoke('push-subscription', { body })

function decodeKey(key: string) {
  const base64 = key.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

export async function fetchVapidKey(): Promise<string | null> {
  const config = await subscriptionRequest({ action: 'config' })
  return (config.data as { publicKey?: string } | null)?.publicKey ?? null
}

/** Ist dieses Gerät abonniert und in push_subscriptions gespeichert? */
export async function isSubscribed(userId: string): Promise<boolean> {
  if (!supportsPush()) return false
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return false
  const { data } = await supabase
    .from('push_subscriptions')
    .select('id')
    .eq('user_id', userId)
    .eq('endpoint', subscription.endpoint)
    .maybeSingle()
  return !!data
}

export type SubscribeResult = 'ok' | 'denied' | 'unavailable' | 'failed'

/** Fragt (falls nötig) die Berechtigung an und speichert das Abo. */
export async function subscribePush(key?: string | null): Promise<SubscribeResult> {
  if (!supportsPush() || isIOSBrowser()) return 'unavailable'
  try {
    if ((await Notification.requestPermission()) !== 'granted') return 'denied'
    const vapid = key ?? (await fetchVapidKey())
    if (!vapid) return 'unavailable'
    const registration = await navigator.serviceWorker.ready
    const existing = await registration.pushManager.getSubscription()
    const options = { userVisibleOnly: true, applicationServerKey: decodeKey(vapid) }
    let subscription = existing ?? (await registration.pushManager.subscribe(options))
    let result = await subscriptionRequest({ action: 'save', ...subscription.toJSON() })
    if ((result.error?.context as Response | undefined)?.status === 409 && existing) {
      await existing.unsubscribe()
      subscription = await registration.pushManager.subscribe(options)
      result = await subscriptionRequest({ action: 'save', ...subscription.toJSON() })
    }
    return result.error ? 'failed' : 'ok'
  } catch {
    return 'failed'
  }
}

export async function unsubscribePush(): Promise<boolean> {
  try {
    const registration = await navigator.serviceWorker.ready
    const existing = await registration.pushManager.getSubscription()
    if (!existing) return true
    const { error } = await subscriptionRequest({ action: 'remove', endpoint: existing.endpoint })
    if (error) return false
    await existing.unsubscribe()
    return true
  } catch {
    return false
  }
}

/** Wie man Mitteilungen nachträglich erlaubt, je nach Gerät. */
export function permissionHelp(): string {
  if (isIOS()) return 'Öffne auf dem iPhone Einstellungen › Mitteilungen › happen und erlaube sie.'
  if (isAndroid())
    return 'Tippe lange auf das happen-Symbol › App-Info › Benachrichtigungen und erlaube sie. Im Browser: Schloss-Symbol neben der Adresse › Berechtigungen › Benachrichtigungen.'
  return 'Klicke links neben der Adresse auf das Schloss-Symbol, setze Benachrichtigungen auf „Erlauben“ und lade die Seite neu.'
}
