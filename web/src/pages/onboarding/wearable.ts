import { supabase } from '../../lib/supabase'
import { addDays, localDate, type WearableStatus } from '../../lib/coach'

// Uhr verbinden über die Edge Function wearable-connect (wie components/GarminCard.tsx).

export const WEARABLE_ERRORS: Record<string, string> = {
  key_rejected: 'Garmin hat den Schlüssel abgelehnt. Ist er abgelaufen oder unvollständig kopiert?',
  consent_required: 'Bitte bestätige zuerst die Einwilligung.',
  invalid_key: 'Das sieht nicht nach einem Garmin-Schlüssel aus.',
  garmin_unreachable: 'Garmin ist gerade nicht erreichbar. Versuch es in ein paar Minuten nochmal.',
  feature_disabled: 'Die Uhr-Verbindung ist für dein Konto noch nicht freigeschaltet.',
}

export const errorText = (code: string) => WEARABLE_ERRORS[code] ?? 'Das hat nicht geklappt.'

export async function callFn<T>(fn: string, body: Record<string, unknown>): Promise<T> {
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

export const wearableStatus = () => callFn<WearableStatus>('wearable-connect', { action: 'status' })

export const connectWearable = (apiKey: string, consent: boolean) =>
  callFn<WearableStatus>('wearable-connect', { action: 'connect', apiKey: apiKey.trim(), consent })

export const disconnectWearable = (deleteData: boolean) =>
  callFn<WearableStatus>('wearable-connect', { action: 'disconnect', deleteData })

/** Ist die Uhr-Verbindung für diesen Nutzer freigeschaltet (user_features.garmin)? */
export async function garminEnabled(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('user_features')
    .select('feature')
    .eq('user_id', userId)
    .eq('feature', 'garmin')
    .maybeSingle()
  return !!data
}

export const BACKFILL_DAYS = 28

/** Wie viele der letzten 28 Tage schon in daily_metrics stehen (Fortschritt des Backfills). */
export async function loadedDays(): Promise<number> {
  const today = localDate()
  const { count } = await supabase
    .from('daily_metrics')
    .select('date', { count: 'exact', head: true })
    .gte('date', addDays(today, -BACKFILL_DAYS))
    .lte('date', today)
  return Math.min(BACKFILL_DAYS, count ?? 0)
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'noch nie'
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (min < 1) return 'gerade eben'
  if (min < 60) return `vor ${min} Min.`
  const h = Math.round(min / 60)
  return h < 48 ? `vor ${h} Std.` : `vor ${Math.round(h / 24)} Tagen`
}

/** Kamen seit mehr als 12 Stunden keine neuen Tageswerte? (Handy-App synchronisiert nicht) */
export function isStale(lastDataAt: string | null | undefined): boolean {
  return !!lastDataAt && Date.now() - Date.parse(lastDataAt) > 12 * 3_600_000
}
