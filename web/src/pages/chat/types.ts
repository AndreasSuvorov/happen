// Antworten der Edge Function `web-chat` und Karten im Chat (Plan 7.3 / 9.5).
// Spiegelt supabase/functions/web-chat/coach-answers.ts.

export interface MetricItem {
  metric: string
  label: string
  value: number
  unit: string
  low: number
  high: number
}

export interface MetricCompareCard {
  type: 'metric_compare'
  items: MetricItem[]
}

export interface RunCard {
  type: 'run_card'
  activity_id: string
  date: string
  title: string
  tone: 'good' | 'warn' | 'neutral'
  detail: string
  hr_cap: number | null
  /** Pulsverlauf in gleichen Zeitabständen, optional. */
  hr?: number[]
}

export interface TableCard {
  type: 'table'
  title?: string
  rows: { label: string; value: string; note?: string }[]
}

export interface ChipsCard {
  type: 'chips'
  options: string[]
  /** Gesetzt, wenn die Chips eine Rückfrage zu diesem Tag beantworten (legt eine Notiz an). */
  note_date?: string
}

export type Card = MetricCompareCard | RunCard | TableCard | ChipsCard

export interface FoodReply {
  kind: 'food'
  messageId?: string
  transcript?: string
  entry: {
    title: string
    kcal_low: number
    kcal_mid: number
    kcal_high: number
    protein_g: number | null
    carbs_g: number | null
    fat_g: number | null
    note: string | null
  }
  todayLine?: string
}

export interface ActivityReply {
  kind: 'activity'
  messageId?: string
  transcript?: string
  title: string
  distance_km: number | null
  duration_min: number | null
  kcal_gross: number | null
  todayLine?: string
}

export interface WeightReply {
  kind: 'weight'
  kg: number
  trend: number
  rateText: string
}

export interface CoachReply {
  kind: 'coach'
  messageId?: string
  intent?: string
  transcript?: string
  message: string
  cards?: Card[]
}

export interface OtherReply {
  kind: 'other' | 'error'
  messageId?: string
  transcript?: string
  message: string
  cards?: Card[]
}

export type Reply = FoodReply | ActivityReply | WeightReply | CoachReply | OtherReply

/** Ein Eintrag im Verlauf: eine Nachricht von dir oder vom Coach. */
export type ChatItem =
  | { id: string; at: string; role: 'user'; kind: 'text' | 'photo' | 'voice'; text?: string; imageUrl?: string }
  | { id: string; at: string; role: 'coach'; pending: true }
  | { id: string; at: string; role: 'coach'; pending?: false; reply: Reply }

export interface SendPayload {
  kind: 'text' | 'photo' | 'voice'
  text?: string
  imageBase64?: string
  audioBase64?: string
  mimeType?: string
  noteDate?: string
}
