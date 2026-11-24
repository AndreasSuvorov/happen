// Senden an die Edge Function `web-chat`, wie in pages/Chat.tsx (Text, Foto, Sprache).
import { supabase } from '../../lib/supabase'

export type SendPayload =
  | { kind: 'text'; text: string }
  | { kind: 'photo'; imageBase64: string }
  | { kind: 'voice'; audioBase64: string; mimeType: string }

export type Reply =
  | {
      kind: 'food'
      transcript?: string
      entry: {
        title: string
        kcal_low: number
        kcal_mid: number
        kcal_high: number
        protein_g: number | null
        note: string | null
      }
      todayLine: string
    }
  | {
      kind: 'activity'
      transcript?: string
      title: string
      distance_km: number | null
      duration_min: number | null
      kcal_gross: number | null
    }
  | { kind: 'weight'; kg: number; trend: number; rateText: string }
  | { kind: 'other' | 'error'; transcript?: string; message: string }

export async function sendMeal(payload: SendPayload): Promise<Reply> {
  const { data: session } = await supabase.auth.getSession()
  const token = session.session?.access_token
  const { data, error } = await supabase.functions.invoke('web-chat', {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: payload,
  })
  if (error) {
    // Die Function antwortet bei Fehlern meist mit { kind: 'error', message }.
    let message = 'Verbindung fehlgeschlagen. Prüf dein Netz und versuch es nochmal.'
    try {
      const ctx = (error as { context?: Response }).context
      const body = ctx && typeof ctx.json === 'function' ? await ctx.json() : null
      if (body?.message) message = body.message
    } catch {
      // Kein lesbarer Fehlertext, dann bleibt die allgemeine Meldung.
    }
    return { kind: 'error', message }
  }
  if (!data || typeof data !== 'object' || !('kind' in data))
    return { kind: 'error', message: 'Unerwartete Antwort vom Server.' }
  return data as Reply
}

export function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/**
 * Foto als JPEG, längste Seite höchstens 1600 px. Die Function gibt das Bild als image/jpeg weiter,
 * deshalb hier umwandeln (iPhone liefert sonst HEIC oder sehr große Dateien). Klappt das nicht, geht das Original raus.
 */
export async function photoToBase64(file: File): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85))
    if (blob) return blobToBase64(blob)
  } catch {
    // Fallback unten.
  }
  return blobToBase64(file)
}
