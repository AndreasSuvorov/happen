// Chat mit dem Coach (Design „Chat“, Plan 9.5): Fragen an den Coach mit Karten,
// dazu wie bisher Mahlzeiten per Text, Foto oder Sprache an die Edge Function `web-chat`.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { supabase, type Profile } from '../../lib/supabase'
import { Icon } from '../../components/ui'
import { fmt } from '../../lib/format'
import { localDate, useCached } from '../../lib/coach'
import { CardView } from './cards'
import {
  blobToBase64,
  loadBriefing,
  loadHistory,
  loadMeta,
  pickMimeType,
  rememberReply,
  separatorLabel,
  subtitle,
  suggestions,
  type BriefingMessage,
} from './chatData'
import type { ChatItem, Reply, SendPayload } from './types'
import './chat.css'

const GAP_FOR_SEPARATOR_MS = 3 * 60 * 60 * 1000

export default function ChatCoach({ profile }: { profile: Profile }) {
  const [openedAt] = useState(() => new Date())
  const today = localDate(openedAt)
  const [history, setHistory] = useState<ChatItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [briefing, setBriefing] = useState<BriefingMessage | null>(null)
  const [live, setLive] = useState<ChatItem[]>([])
  const [text, setText] = useState('')
  const [recording, setRecording] = useState(false)
  const [noteDate, setNoteDate] = useState<string | null>(null)
  const [answered, setAnswered] = useState<Record<string, string>>({})
  const meta = useCached(`chat-meta:${today}`, () => loadMeta(today), [today])

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  useEffect(() => {
    let active = true
    Promise.all([loadHistory().catch(() => [] as ChatItem[]), loadBriefing(today).catch(() => null)]).then(([h, b]) => {
      if (!active) return
      setHistory(h)
      setBriefing(b)
      setLoaded(true)
    })
    return () => {
      active = false
    }
  }, [today])

  const items = useMemo(() => {
    const all: ChatItem[] = [...history]
    if (briefing) {
      all.push({
        id: 'briefing',
        at: briefing.at,
        role: 'coach',
        reply: {
          kind: 'coach',
          message: briefing.text,
          cards: briefing.question ? [{ type: 'chips', options: briefing.question.options, note_date: briefing.question.date }] : [],
        },
      })
    }
    all.sort((a, b) => a.at.localeCompare(b.at))
    return [...all, ...live]
  }, [history, briefing, live])

  const rows = useMemo(
    () =>
      items.map((item, i) => {
        const prev = items[i - 1]
        const newBlock =
          !prev ||
          localDate(new Date(prev.at)) !== localDate(new Date(item.at)) ||
          Date.parse(item.at) - Date.parse(prev.at) > GAP_FOR_SEPARATOR_MS
        return { item, sep: newBlock ? separatorLabel(item.at, today) : null }
      }),
    [items, today],
  )

  const last = items.at(-1)
  const lastKey = `${items.length}:${last?.role === 'coach' && last.pending ? 'p' : 'r'}`
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastKey, loaded])

  const scrollToEnd = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  const send = async (payload: SendPayload, user: ChatItem) => {
    const pendingId = crypto.randomUUID()
    const now = new Date().toISOString()
    setLive((l) => [...l, user, { id: pendingId, at: now, role: 'coach', pending: true }])

    const { data: session } = await supabase.auth.getSession()
    const token = session.session?.access_token
    const { data, error } = await supabase.functions.invoke('web-chat', {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: payload,
    })
    const reply: Reply =
      error || !data ? { kind: 'error', message: 'Verbindung fehlgeschlagen. Versuch es gleich nochmal.' } : (data as Reply)
    const at = new Date().toISOString()
    if ('messageId' in reply && reply.messageId) rememberReply(reply.messageId, at, reply)
    const transcript = 'transcript' in reply ? reply.transcript : undefined

    setLive((l) =>
      l.map((m) => {
        if (m.id === pendingId) return { id: pendingId, at, role: 'coach', reply }
        if (m.id === user.id && m.role === 'user' && transcript) return { ...m, text: transcript }
        return m
      }),
    )
  }

  const sendText = (value: string, forDate?: string | null) => {
    const v = value.trim()
    if (!v) return
    const date = forDate ?? undefined
    void send(
      { kind: 'text', text: v, ...(date ? { noteDate: date } : {}) },
      { id: crypto.randomUUID(), at: new Date().toISOString(), role: 'user', kind: 'text', text: v },
    )
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    sendText(text, noteDate)
    setText('')
    setNoteDate(null)
  }

  const pickChip = (key: string, option: string, forDate?: string) => {
    if (option.startsWith('Andere')) {
      setNoteDate(forDate ?? null)
      setAnswered((a) => ({ ...a, [key]: option }))
      inputRef.current?.focus()
      return
    }
    setAnswered((a) => ({ ...a, [key]: option }))
    sendText(option, forDate)
  }

  const sendPhoto = async (file: File) => {
    const base64 = await blobToBase64(file)
    const imageUrl = URL.createObjectURL(file)
    void send(
      { kind: 'photo', imageBase64: base64 },
      { id: crypto.randomUUID(), at: new Date().toISOString(), role: 'user', kind: 'photo', imageUrl },
    )
  }

  const toggleRecording = async () => {
    if (recording) {
      recorderRef.current?.stop()
      setRecording(false)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' })
        const base64 = await blobToBase64(blob)
        void send(
          { kind: 'voice', audioBase64: base64, mimeType: mimeType || 'audio/webm', ...(noteDate ? { noteDate } : {}) },
          { id: crypto.randomUUID(), at: new Date().toISOString(), role: 'user', kind: 'voice' },
        )
        setNoteDate(null)
      }
      recorderRef.current = recorder
      recorder.start()
      setRecording(true)
    } catch {
      alert('Mikrofon-Zugriff nicht möglich. Prüfe die Berechtigung.')
    }
  }

  const hour = openedAt.getHours()
  const chips = suggestions(hour, meta.data)
  const hasText = text.trim().length > 0
  const placeholder = recording
    ? 'Ich höre zu … tipp zum Senden'
    : noteDate
      ? 'Was war los?'
      : 'Frag mich oder erzähl, was du isst'

  return (
    <div className="chat-coach">
      <header className="chat-header">
        <div className="chat-inner chat-header-inner">
          <div className="chat-avatar" aria-hidden="true">
            <Icon name="sun" size={20} />
          </div>
          <div className="chat-header-text">
            <h1>Dein Coach</h1>
            <span className="t-13 t-muted">{subtitle(meta.data)}</span>
          </div>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-inner chat-log" aria-live="polite" aria-relevant="additions">
          {loaded && items.length === 0 && (
            <>
              <p className="chat-sep">{separatorLabel(openedAt.toISOString(), today)}</p>
              <div className="chat-bubble coach">
                Hallo{profile.first_name ? ` ${profile.first_name}` : ''}. Frag mich, wie deine Nacht oder dein Lauf war, oder
                schick mir ein Foto von deinem Essen.
              </div>
            </>
          )}
          {!loaded && (
            <div className="chat-bubble coach">
              <span className="t-13 t-muted">Lädt den Verlauf…</span>
            </div>
          )}
          {rows.map(({ item, sep }) => (
            <Fragment key={item.id}>
              {sep && <p className="chat-sep">{sep}</p>}
              <ChatEntry item={item} answered={answered} onPick={pickChip} onImageLoad={scrollToEnd} />
            </Fragment>
          ))}
        </div>
      </div>

      <div className="chat-panel">
        <div className="chat-inner chat-panel-inner">
          <div className="chat-suggest" role="group" aria-label="Vorschläge">
            {chips.map((s) => (
              <button key={s} type="button" className="chat-suggest-chip" onClick={() => sendText(s)}>
                {s}
              </button>
            ))}
          </div>
          <form className="chat-input-row" onSubmit={onSubmit}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void sendPhoto(file)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              className="chat-icon-btn"
              aria-label="Foto von einer Mahlzeit"
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="camera" size={24} />
            </button>
            <label htmlFor="chat-msg" className="sr-only">
              Nachricht an den Coach
            </label>
            <input
              ref={inputRef}
              id="chat-msg"
              type="text"
              className="chat-input"
              placeholder={placeholder}
              value={text}
              autoComplete="off"
              enterKeyHint="send"
              onChange={(e) => setText(e.target.value)}
            />
            {hasText ? (
              <button type="submit" className="chat-icon-btn primary" aria-label="Senden">
                <Icon name="arrowRight" size={22} strokeWidth={2} />
              </button>
            ) : (
              <button
                type="button"
                className={recording ? 'chat-icon-btn primary recording' : 'chat-icon-btn primary'}
                aria-label={recording ? 'Aufnahme beenden und senden' : 'Sprachnachricht'}
                aria-pressed={recording}
                onClick={() => void toggleRecording()}
              >
                {recording ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
                  </svg>
                ) : (
                  <Icon name="mic" size={22} />
                )}
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  )
}

function ChatEntry({
  item,
  answered,
  onPick,
  onImageLoad,
}: {
  item: ChatItem
  answered: Record<string, string>
  onPick: (key: string, option: string, noteDate?: string) => void
  onImageLoad: () => void
}) {
  if (item.role === 'user') {
    if (item.kind === 'photo') {
      return item.imageUrl ? (
        <div className="chat-bubble user photo">
          <img src={item.imageUrl} alt="Dein Foto" onLoad={onImageLoad} />
        </div>
      ) : (
        <div className="chat-bubble user with-icon">
          <Icon name="camera" size={18} />
          Foto
        </div>
      )
    }
    if (item.kind === 'voice') {
      return (
        <div className="chat-bubble user with-icon">
          <Icon name="mic" size={18} />
          {item.text ? `„${item.text}“` : 'Sprachnachricht'}
        </div>
      )
    }
    return <div className="chat-bubble user">{item.text}</div>
  }

  if (item.pending) {
    return (
      <div className="chat-bubble coach pending">
        <span className="t-13 t-muted">Schaut in deine Daten…</span>
      </div>
    )
  }

  const r = item.reply
  switch (r.kind) {
    case 'food':
      return (
        <div className="chat-bubble coach chat-food">
          <strong>{r.entry.title}</strong>
          <span className="chat-food-kcal">
            <span className="chat-food-mid">≈ {fmt(r.entry.kcal_mid)}</span> kcal{' '}
            <span className="t-muted">
              · {fmt(r.entry.kcal_low)}–{fmt(r.entry.kcal_high)}
            </span>
          </span>
          <span className="t-13 t-muted">
            Eiweiß {fmt(r.entry.protein_g ?? 0)} g · Kohlenhydrate {fmt(r.entry.carbs_g ?? 0)} g · Fett {fmt(r.entry.fat_g ?? 0)} g
          </span>
          {r.entry.note && <span className="t-13 t-muted">{r.entry.note}</span>}
          {r.todayLine && <span className="t-13 chat-today">{r.todayLine}</span>}
        </div>
      )
    case 'activity':
      return (
        <div className="chat-bubble coach chat-food">
          <strong>
            {r.title}
            {r.distance_km ? ` · ${fmt(r.distance_km, 1)} km` : ''}
            {r.duration_min ? ` · ${r.duration_min} Min.` : ''}
          </strong>
          {r.kcal_gross != null && <span className="t-13 t-muted">≈ {fmt(r.kcal_gross)} kcal verbraucht (brutto)</span>}
          {r.todayLine && <span className="t-13 chat-today">{r.todayLine}</span>}
        </div>
      )
    case 'weight':
      return (
        <div className="chat-bubble coach chat-food">
          <strong>{fmt(r.kg, 1)} kg notiert</strong>
          <span className="t-13 t-muted">
            Trend {fmt(r.trend, 1)} kg · {r.rateText}
          </span>
        </div>
      )
    case 'error':
      return (
        <div className="chat-bubble coach">
          <span className="t-muted">{r.message}</span>
        </div>
      )
    default: {
      const cards = r.cards ?? []
      const cardFirst = cards[0]?.type === 'run_card'
      const bubble = r.message ? <div className="chat-bubble coach">{r.message}</div> : null
      const cardNodes = cards.map((c, i) => {
        const key = `${item.id}:${i}`
        return (
          <CardView
            key={key}
            card={c}
            answered={answered[key] ?? null}
            onPick={(o, d) => onPick(key, o, d)}
          />
        )
      })
      if (!cards.length) return bubble
      return (
        <div className="chat-group">
          {cardFirst ? cardNodes : bubble}
          {cardFirst ? bubble : cardNodes}
        </div>
      )
    }
  }
}
