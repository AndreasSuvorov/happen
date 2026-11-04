import { useRef, useState } from 'react'
import { supabase, type Profile } from '../lib/supabase'

interface FoodReply {
  kind: 'food'
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
  todayLine: string
}

interface ActivityReply {
  kind: 'activity'
  transcript?: string
  title: string
  distance_km: number | null
  duration_min: number | null
  kcal_gross: number | null
  todayLine: string
}

interface WeightReply {
  kind: 'weight'
  kg: number
  trend: number
  rateText: string
}

interface OtherReply {
  kind: 'other' | 'error'
  transcript?: string
  message: string
}

type Reply = FoodReply | ActivityReply | WeightReply | OtherReply

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  kind: 'text' | 'photo' | 'voice'
  text?: string
  imageUrl?: string
  reply?: Reply
  pending?: boolean
}

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export default function Chat({ profile: _profile }: { profile: Profile }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [recording, setRecording] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const send = async (payload: { kind: 'text' | 'photo' | 'voice'; text?: string; imageBase64?: string; audioBase64?: string; mimeType?: string }, userMsg: ChatMessage) => {
    const pendingId = crypto.randomUUID()
    setMessages((m) => [...m, userMsg, { id: pendingId, role: 'assistant', kind: 'text', pending: true }])

    const { data: session } = await supabase.auth.getSession()
    const token = session.session?.access_token
    const { data, error } = await supabase.functions.invoke('web-chat', {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: payload,
    })

    setMessages((m) =>
      m.map((msg) =>
        msg.id === pendingId
          ? {
              ...msg,
              pending: false,
              reply: error ? { kind: 'error', message: 'Verbindung fehlgeschlagen.' } : (data as Reply),
            }
          : msg,
      ),
    )
  }

  const sendText = async () => {
    const value = text.trim()
    if (!value) return
    setText('')
    await send({ kind: 'text', text: value }, { id: crypto.randomUUID(), role: 'user', kind: 'text', text: value })
  }

  const sendPhoto = async (file: File) => {
    const dataUrl = await blobToBase64(file)
    const imageUrl = URL.createObjectURL(file)
    await send(
      { kind: 'photo', imageBase64: dataUrl },
      { id: crypto.randomUUID(), role: 'user', kind: 'photo', imageUrl },
    )
  }

  const toggleRecording = async () => {
    if (recording) {
      mediaRecorderRef.current?.stop()
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
        await send(
          { kind: 'voice', audioBase64: base64, mimeType: mimeType || 'audio/webm' },
          { id: crypto.randomUUID(), role: 'user', kind: 'voice' },
        )
      }
      mediaRecorderRef.current = recorder
      recorder.start()
      setRecording(true)
    } catch {
      alert('Mikrofon-Zugriff nicht möglich. Prüfe die Berechtigung.')
    }
  }

  return (
    <div className="chat-screen">
      <div className="chat-log">
        {messages.length === 0 && (
          <p className="muted small chat-hint">
            Schick ein Foto vom Teller, eine Sprachnachricht oder schreib einfach, was du gegessen hast.
          </p>
        )}
        {messages.map((m) => (
          <ChatBubble key={m.id} msg={m} />
        ))}
      </div>
      <div className="chat-inputbar">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) sendPhoto(file)
            e.target.value = ''
          }}
        />
        <button type="button" className="icon-btn" onClick={() => fileInputRef.current?.click()} aria-label="Foto">
          📷
        </button>
        <input
          type="text"
          placeholder="Was hast du gegessen?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') sendText()
          }}
        />
        {text.trim() ? (
          <button type="button" className="icon-btn send" onClick={sendText} aria-label="Senden">
            ➤
          </button>
        ) : (
          <button
            type="button"
            className={recording ? 'icon-btn mic recording' : 'icon-btn mic'}
            onClick={toggleRecording}
            aria-label="Sprachnachricht"
          >
            🎤
          </button>
        )}
      </div>
    </div>
  )
}

function ChatBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="bubble user">
        {msg.kind === 'photo' && msg.imageUrl && <img src={msg.imageUrl} alt="" className="bubble-img" />}
        {msg.kind === 'voice' && <span>🎤 Sprachnachricht</span>}
        {msg.kind === 'text' && msg.text}
      </div>
    )
  }

  if (msg.pending) {
    return (
      <div className="bubble assistant">
        <span className="muted">denkt nach …</span>
      </div>
    )
  }

  const r = msg.reply
  if (!r) return null

  if (r.kind === 'food') {
    return (
      <div className="bubble assistant">
        {r.transcript && <p className="muted small chat-transcript">„{r.transcript}“</p>}
        <strong>{r.entry.title}</strong>
        <p className="kcal-row">
          <span className="big">{r.entry.kcal_mid}</span>
          <span className="muted"> kcal · {r.entry.kcal_low}–{r.entry.kcal_high}</span>
        </p>
        <p className="muted small">
          P {r.entry.protein_g ?? 0} g · K {r.entry.carbs_g ?? 0} g · F {r.entry.fat_g ?? 0} g
        </p>
        {r.entry.note && <p className="muted small chat-note">{r.entry.note}</p>}
        <p className="muted small chat-today">{r.todayLine}</p>
      </div>
    )
  }

  if (r.kind === 'activity') {
    return (
      <div className="bubble assistant">
        {r.transcript && <p className="muted small chat-transcript">„{r.transcript}“</p>}
        <strong>
          🏃 {r.title}
          {r.distance_km ? ` · ${r.distance_km} km` : ''}
          {r.duration_min ? ` · ${r.duration_min} min` : ''}
        </strong>
        {r.kcal_gross != null && <p className="muted small">≈ {r.kcal_gross} kcal brutto</p>}
        <p className="muted small chat-today">{r.todayLine}</p>
      </div>
    )
  }

  if (r.kind === 'weight') {
    return (
      <div className="bubble assistant">
        <strong>⚖️ {r.kg} kg notiert</strong>
        <p className="muted small">
          Trend: {r.trend} kg · {r.rateText}
        </p>
      </div>
    )
  }

  return (
    <div className="bubble assistant">
      {r.transcript && <p className="muted small chat-transcript">„{r.transcript}“</p>}
      {r.message}
    </div>
  )
}
