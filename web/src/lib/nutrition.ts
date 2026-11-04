// Gleiche Formeln wie supabase/functions/_shared/nutrition.ts (Deno-Modul, hier dupliziert
// statt geteilt, weil Edge Function und Web-App unterschiedliche Build-Toolchains haben).

export type Sex = 'm' | 'f'

export interface NutritionProfile {
  heightCm: number | null
  birthYear: number | null
  sex: Sex | null
  goalKgPerWeek: number
}

export const KCAL_PER_KG_LONG_TERM = 7700
export const MIN_DAILY_KCAL = 1500
export const RUN_CREDIT_SHARE = 0.5
export const BASE_ACTIVITY_FACTOR = 1.35

export function mifflinBmr(kg: number, heightCm: number, age: number, sex: Sex): number {
  return 10 * kg + 6.25 * heightCm - 5 * age + (sex === 'm' ? 5 : -161)
}

export function ageFromBirthYear(birthYear: number, now: Date = new Date()): number {
  return now.getUTCFullYear() - birthYear
}

export function baseTdee(profile: NutritionProfile, kg: number, now: Date = new Date()): number | null {
  if (!profile.heightCm || !profile.birthYear || !profile.sex) return null
  const bmr = mifflinBmr(kg, profile.heightCm, ageFromBirthYear(profile.birthYear, now), profile.sex)
  return Math.round(bmr * BASE_ACTIVITY_FACTOR)
}

export function dailyBudget(tdee: number, goalKgPerWeek: number, runKcalToday: number): number {
  const deficit = (goalKgPerWeek * KCAL_PER_KG_LONG_TERM) / 7
  const budget = tdee - deficit + RUN_CREDIT_SHARE * runKcalToday
  return Math.max(MIN_DAILY_KCAL, Math.round(budget))
}
