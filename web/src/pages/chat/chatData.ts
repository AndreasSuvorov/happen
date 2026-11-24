// Daten für den Chat: Verlauf aus `messages`, Morgenbriefing, Vorschläge, Untertitel.
import { supabase } from '../../lib/supabase'
import { addDays, fetchActivities, fetchDailyMetrics, fetchNotes, isRun, localDate, type MorningBriefing } from '../../lib/coach'
import type { ChatItem, Reply } from './types'

/* ---------------------------------------------------------------------------
 * Antworten des Coaches werden in `messages` nicht gespeichert. Damit der Verlauf
 * sie trotzdem zeigt, merkt sich das Gerät die Antwort pro Nachricht.
 * ------------------------------------------------------------------------- */
const REPLY_KEY = 'happen-chat:replies'
const REPLY_LIMIT = 80

function readReplies(): Record<string, { at: string; reply: Reply }> {
  try {
    return JSON.parse(localStorage.getItem(REPLY_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function rememberReply(messageId: string, at: string, reply: Reply) {
  try {
    const all = readReplies()
    all[messageId] = { at, reply }
    const keep = Object.entries(all)
      .sort((a, b) => b[1].at.localeCompare(a[1].at))
      .slice(0, REPLY_LIMIT)
    localStorage.setItem(REPLY_KEY, JSON.stringify(Object.fromEntries(keep)))
  } catch {
    // Ohne Speicher fehlt die Antwort nur im Verlauf.
  }
}

interface MessageRow {
  id: string
  kind: 'text' | 'photo' | 'voice'
  text: string | null
  transcript: string | null
  received_at: string
  status: string
  entries: {
    title: string
    kcal_low: number
    kcal_mid: number
    kcal_high: number
    protein_g: number | null
    carbs_g: number | null
    fat_g: number | null
    note: string | null
    status: string
  }[] | null
  activities: { type: string; distance_km: number | null; duration_min: number | null; kcal_gross: number | null; status: string }[] | null
}

const activityTitle: Record<string, string> = { run: 'Lauf', walk: 'Spaziergang', bike: 'Radfahren', strength: 'Krafttraining' }

/** Letzte Nachrichten (Web und Telegram) mit erfassten Mahlzeiten und Aktivitäten. */
export async function loadHistory(limit = 40): Promise<ChatItem[]> {
  const res = await supabase
    .from('messages')
    .select(
      'id,kind,text,transcript,received_at,status,' +
        'entries(title,kcal_low,kcal_mid,kcal_high,protein_g,carbs_g,fat_g,note,status),' +
        'activities(type,distance_km,duration_min,kcal_gross,status)',
    )
    .order('received_at', { ascending: false })
    .limit(limit)
  if (res.error) throw new Error(res.error.message)
  const replies = readReplies()
  const items: ChatItem[] = []
  for (const m of [...((res.data ?? []) as unknown as MessageRow[])].reverse()) {
    items.push({ id: m.id, at: m.received_at, role: 'user', kind: m.kind, text: m.text ?? m.transcript ?? undefined })
    const cached = replies[m.id]
    const entry = m.entries?.find((e) => e.status !== 'deleted')
    const activity = m.activities?.find((a) => a.status !== 'deleted')
    let reply: Reply | null = cached?.reply ?? null
    if (!reply && entry) reply = { kind: 'food', entry }
    if (!reply && activity) {
      reply = {
        kind: 'activity',
        title: activityTitle[activity.type] ?? 'Training',
        distance_km: activity.distance_km,
        duration_min: activity.duration_min,
        kcal_gross: activity.kcal_gross,
      }
    }
    if (reply) items.push({ id: `${m.id}:reply`, at: cached?.at ?? m.received_at, role: 'coach', reply })
  }
  // Antwort-Chips nur an der letzten Nachricht anbieten, ältere Rückfragen sind erledigt.
  return items.map((item, i) => {
    if (i === items.length - 1 || item.role !== 'coach' || item.pending) return item
    const r = item.reply
    if ((r.kind === 'coach' || r.kind === 'other') && r.cards?.some((c) => c.type === 'chips')) {
      return { ...item, reply: { ...r, cards: r.cards.filter((c) => c.type !== 'chips') } }
    }
    return item
  })
}

/* ---------------------------------------------------------------------------
 * Morgenbriefing als erste Coach-Nachricht des Tages, mit offener Rückfrage
 * ------------------------------------------------------------------------- */
export interface BriefingMessage {
  at: string
  text: string
  question: { date: string; options: string[] } | null
}

export async function loadBriefing(today = localDate()): Promise<BriefingMessage | null> {
  const res = await supabase
    .from('briefings')
    .select('date,payload,created_at')
    .eq('kind', 'morning')
    .eq('ref', '')
    .eq('date', today)
    .maybeSingle()
  if (res.error || !res.data) return null
  const row = res.data as { date: string; payload: MorningBriefing; created_at: string }
  const p = row.payload
  if (!p?.headline) return null
  let question: BriefingMessage['question'] = null
  if (p.question?.text) {
    const notes = await fetchNotes(p.question.date, p.question.date).catch(() => [])
    if (!notes.length) question = { date: p.question.date, options: p.question.options }
  }
  const text = ['Guten Morgen.', p.headline, p.today?.text, p.question?.text].filter(Boolean).join(' ')
  return { at: row.created_at, text, question }
}

/* ---------------------------------------------------------------------------
 * Kopf und Vorschläge
 * ------------------------------------------------------------------------- */
export interface ChatMeta {
  /** Tage mit Messwerten in den letzten 28 Tagen. */
  daysWithData: number
  ranToday: boolean
  ranRecently: boolean
}

export async function loadMeta(today = localDate()): Promise<ChatMeta> {
  const [days, acts] = await Promise.all([
    fetchDailyMetrics(addDays(today, -28), addDays(today, -1)).catch(() => []),
    fetchActivities(addDays(today, -2), today).catch(() => []),
  ])
  const runs = acts.filter((a) => isRun(a.type))
  return {
    daysWithData: days.filter((d) => d.sleep_minutes !== null || d.resting_hr !== null || d.steps !== null).length,
    ranToday: runs.some((a) => a.started_at_local.startsWith(today)),
    ranRecently: runs.length > 0,
  }
}

/** Untertitel: nur „letzte 4 Wochen“, wenn es die Daten wirklich gibt. */
export function subtitle(meta: ChatMeta | null): string {
  if (meta && meta.daysWithData >= 26) return 'Kennt deine letzten 4 Wochen'
  return 'Lernt dich gerade kennen'
}

/** Vorschläge nach Tageszeit (Plan 9.5): morgens Nacht, nach einem Lauf der Lauf, abends Essen, dazu die Woche. */
export function suggestions(hour: number, meta: ChatMeta | null): string[] {
  const list: string[] = []
  if (hour < 11) list.push('Wie war meine Nacht?')
  if (meta?.ranToday) list.push('Wie war mein Lauf?')
  if (hour >= 16) list.push('Was soll ich heute noch essen?')
  if (list.length < 2 && hour >= 11) {
    list.push(meta?.ranRecently && !meta.ranToday ? 'Wie war mein Lauf?' : 'Was soll ich heute noch essen?')
  }
  list.push('Wie war meine Woche?')
  return [...new Set(list)]
}

/* ---------------------------------------------------------------------------
 * Aufnahme und Dateien
 * ------------------------------------------------------------------------- */
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

/* ---------------------------------------------------------------------------
 * Datumstrenner: „Heute, 07:12“, „Gestern, 21:40“, „Mo, 23.11., 18:02“
 * ------------------------------------------------------------------------- */
export function separatorLabel(at: string, today = localDate()): string {
  const d = new Date(at)
  const day = localDate(d)
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  if (day === today) return `Heute, ${time}`
  if (day === addDays(today, -1)) return `Gestern, ${time}`
  const wd = d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')
  return `${wd}, ${d.getDate()}.${d.getMonth() + 1}., ${time}`
}
