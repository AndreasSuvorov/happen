import type { Profile } from '../../lib/supabase'
import { supabase } from '../../lib/supabase'

// Onboarding-Abschluss pro Nutzer im localStorage. Synchron, damit App.tsx ohne Ladezustand entscheiden kann.
const doneKey = (profileId: string) => `happen-onboarding-done:${profileId}`

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function isOnboardingDone(profileId: string): boolean {
  return read(doneKey(profileId)) !== null
}

export function markOnboardingDone(profileId: string) {
  try {
    localStorage.setItem(doneKey(profileId), new Date().toISOString())
  } catch {
    // Ohne Speicher fragt das Onboarding beim nächsten Start nochmal. Kein Drama.
  }
}

/** Schneller Hinweis: Dieser Nutzer hat schon ein Ziel in coach_settings (siehe rememberGoalSaved). */
const goalKey = (profileId: string) => `happen-onboarding-goal:${profileId}`

export function rememberGoalSaved(profileId: string) {
  try {
    localStorage.setItem(goalKey(profileId), '1')
  } catch {
    // egal
  }
}

/**
 * true, wenn das Onboarding gezeigt werden soll: weder das Abschluss-Flag noch ein gespeichertes Ziel
 * (coach_settings.goal) ist bekannt. Synchron über localStorage; mit checkOnboardingRemote() lässt sich
 * der Stand einmalig mit der Datenbank abgleichen (z. B. neues Gerät, Ziel schon gesetzt).
 */
export function needsOnboarding(profile: Pick<Profile, 'id'>): boolean {
  return !isOnboardingDone(profile.id) && read(goalKey(profile.id)) === null
}

/** Abgleich mit coach_settings: Gibt es dort ein Ziel, gilt das Onboarding als erledigt. */
export async function checkOnboardingRemote(profile: Pick<Profile, 'id'>): Promise<boolean> {
  if (!needsOnboarding(profile)) return false
  const { data, error } = await supabase.from('coach_settings').select('goal').eq('user_id', profile.id).maybeSingle()
  if (error) return true
  if (data?.goal) {
    rememberGoalSaved(profile.id)
    return false
  }
  return true
}
