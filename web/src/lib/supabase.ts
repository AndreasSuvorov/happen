import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!url || !anonKey) {
  throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY fehlen (.env prüfen)')
}

export const supabase = createClient(url, anonKey)

export interface Profile {
  id: string
  auth_user_id: string
  telegram_chat_id: number | null
  first_name: string | null
  height_cm: number | null
  birth_year: number | null
  sex: 'm' | 'f' | null
  timezone: string
  goal_kg_per_week: number
}

export interface Entry {
  id: string
  eaten_at: string
  meal: string | null
  title: string
  kcal_low: number
  kcal_mid: number
  kcal_high: number
  protein_g: number | null
  confidence: 'hoch' | 'mittel' | 'niedrig' | null
  status: string
}

export interface Weight {
  measured_on: string
  kg: number
}
