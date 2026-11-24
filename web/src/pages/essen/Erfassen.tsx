import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Profile } from '../../lib/supabase'
import { Icon, Sheet } from '../../components/ui'
import TabBar from '../../components/TabBar'
import { useCached } from '../../lib/coach'
import { fmtRange } from '../../lib/format'
import Essen from './Essen'
import { loadRecent, protein } from './data'
import { blobToBase64, photoToBase64, pickMimeType, sendMeal, type Reply, type SendPayload } from './send'
import './essen.css'

type Phase =
  | { kind: 'idle' }
  | { kind: 'recording' }
  | { kind: 'sending'; what: string }
  | { kind: 'done'; reply: Reply }
  | { kind: 'error'; message: string }

export default function Erfassen({ profile }: { profile: Profile }) {
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const cancelledRef = useRef(false)
  const recent = useCached(`essen-recent:${profile.id}`, loadRecent, [profile.id])

  const close = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate('/essen', { replace: true })
  }, [navigate])

  // Escape schließt, Aufnahme beim Verlassen beenden.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])
  useEffect(() => {
    // StrictMode baut Effekte doppelt auf, deshalb hier zurücksetzen.
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
      const r = recorderRef.current
      if (r && r.state !== 'inactive') r.stop()
    }
  }, [])

  // Nach einer erkannten Mahlzeit kurz bestätigen, dann zurück zu Essen (lädt dort neu).
  useEffect(() => {
    if (phase.kind !== 'done' || phase.reply.kind === 'other' || phase.reply.kind === 'error') return
    const t = window.setTimeout(close, 2600)
    return () => window.clearTimeout(t)
  }, [phase, close])

  const send = async (payload: SendPayload, what: string) => {
    setPhase({ kind: 'sending', what })
    const reply = await sendMeal(payload)
    if (cancelledRef.current) return
    setPhase(reply.kind === 'error' ? { kind: 'error', message: reply.message } : { kind: 'done', reply })
  }

  const sendText = (value: string) => {
    const v = value.trim()
    if (!v) {
      inputRef.current?.focus()
      return
    }
    setText('')
    void send({ kind: 'text', text: v }, `„${v}“`)
  }

  const onPhoto = async (file: File) => {
    setPhase({ kind: 'sending', what: 'Dein Foto' })
    try {
      const imageBase64 = await photoToBase64(file)
      await send({ kind: 'photo', imageBase64 }, 'Dein Foto')
    } catch {
      setPhase({ kind: 'error', message: 'Das Foto konnte ich nicht lesen. Versuch es mit einem anderen.' })
    }
  }

  const toggleRecording = async () => {
    const active = recorderRef.current
    if (phase.kind === 'recording' && active) {
      active.stop()
      return
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setPhase({ kind: 'error', message: 'Dieser Browser kann keine Sprachaufnahme. Schreib es einfach kurz auf.' })
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
        recorderRef.current = null
        if (cancelledRef.current) return
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' })
        if (blob.size === 0) {
          setPhase({ kind: 'error', message: 'Die Aufnahme war leer. Versuch es nochmal.' })
          return
        }
        const audioBase64 = await blobToBase64(blob)
        await send({ kind: 'voice', audioBase64, mimeType: mimeType || 'audio/webm' }, 'Deine Sprachnachricht')
      }
      recorderRef.current = recorder
      recorder.start()
      setPhase({ kind: 'recording' })
    } catch {
      setPhase({
        kind: 'error',
        message: 'Kein Zugriff aufs Mikrofon. Prüf die Berechtigung in den Einstellungen des Browsers.',
      })
    }
  }

  const recording = phase.kind === 'recording'

  return (
    <>
      <div aria-hidden="true" inert>
        <main className="shell-main">
          <Essen profile={profile} />
        </main>
        <TabBar />
      </div>

      <Sheet label="Mahlzeit erfassen" onClose={close}>
        <div className="erfassen-head">
          <h1 className="page-title small erfassen-title">Was hast du gegessen?</h1>
          <button type="button" className="erfassen-close" aria-label="Schließen" onClick={close}>
            <Icon name="close" size={18} strokeWidth={2.2} />
          </button>
        </div>

        {phase.kind === 'sending' && <Progress what={phase.what} />}
        {phase.kind === 'done' && (
          <Done reply={phase.reply} onAgain={() => setPhase({ kind: 'idle' })} onClose={close} />
        )}

        {phase.kind !== 'sending' && phase.kind !== 'done' && (
          <>
            {phase.kind === 'error' && (
              <div className="card warn" role="alert">
                <p>{phase.message}</p>
              </div>
            )}

            <div className="erfassen-modes">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) void onPhoto(file)
                }}
              />
              <button
                type="button"
                className="erfassen-mode primary"
                onClick={() => fileRef.current?.click()}
                disabled={recording}
              >
                <Icon name="camera" size={28} />
                Foto
              </button>
              <button
                type="button"
                className="erfassen-mode"
                aria-pressed={recording}
                onClick={() => void toggleRecording()}
              >
                {recording ? (
                  <span className="erfassen-rec" aria-hidden="true" />
                ) : (
                  <Icon name="mic" size={28} className="erfassen-mode-icon" />
                )}
                {recording ? 'Stopp' : 'Sprechen'}
              </button>
              <button
                type="button"
                className="erfassen-mode"
                onClick={() => inputRef.current?.focus()}
                disabled={recording}
              >
                <Icon name="text" size={28} className="erfassen-mode-icon" />
                Schreiben
              </button>
            </div>

            {recording && (
              <p className="t-13 t-muted" role="status" style={{ margin: 0 }}>
                Ich höre zu. Sag, was und wie viel du gegessen hast, dann tippe auf Stopp.
              </p>
            )}

            <form
              className="erfassen-field"
              onSubmit={(e) => {
                e.preventDefault()
                sendText(text)
              }}
            >
              <label htmlFor="meal" className="t-13 t-muted">
                Oder kurz beschreiben
              </label>
              <div className="erfassen-row">
                <input
                  id="meal"
                  ref={inputRef}
                  className="input erfassen-input"
                  type="text"
                  enterKeyHint="send"
                  autoComplete="off"
                  placeholder="z. B. 2 Brezen mit Butter"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  disabled={recording}
                />
                <button type="submit" className="erfassen-send" aria-label="Senden" disabled={recording}>
                  <Icon name="arrowRight" size={20} strokeWidth={2.2} />
                </button>
              </div>
            </form>

            {recent.data && recent.data.length > 0 && (
              <div className="erfassen-recent">
                <span className="t-13 t-muted" id="recent-label">
                  Nochmal das Gleiche?
                </span>
                <div className="chips bleed" role="group" aria-labelledby="recent-label">
                  {recent.data.map((r) => (
                    <button
                      key={r.title}
                      type="button"
                      className="chip"
                      onClick={() => sendText(r.title)}
                      disabled={recording}
                    >
                      {r.title} <span className="t-13 t-muted">{r.kcal}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <p className="t-13 t-muted erfassen-hint">
          Ich schätze kcal immer als Spanne. Das ist ehrlicher als eine genaue Zahl, die es nicht gibt.
        </p>
      </Sheet>
    </>
  )
}

function Progress({ what }: { what: string }) {
  return (
    <div className="erfassen-progress" role="status" aria-live="polite">
      <div className="erfassen-progress-bar" aria-hidden="true">
        <div />
      </div>
      <p className="t-15" style={{ margin: 0 }}>
        Ich schätze … <span className="t-muted">{what} ist angekommen. Das dauert ein paar Sekunden.</span>
      </p>
    </div>
  )
}

function Done({ reply, onAgain, onClose }: { reply: Reply; onAgain: () => void; onClose: () => void }) {
  let title: string
  let detail: string | null = null
  let ok = true
  switch (reply.kind) {
    case 'food':
      title = reply.entry.title
      detail = `${fmtRange(reply.entry.kcal_low, reply.entry.kcal_high)} kcal${
        reply.entry.protein_g != null ? ` · ${protein(reply.entry.protein_g)}` : ''
      }`
      break
    case 'activity':
      title = `${reply.title} notiert`
      detail = reply.kcal_gross != null ? `etwa ${reply.kcal_gross} kcal Verbrauch` : null
      break
    case 'weight':
      title = `${reply.kg.toLocaleString('de-DE')} kg notiert`
      detail = `Trend ${reply.trend.toLocaleString('de-DE')} kg · ${reply.rateText}`
      break
    default:
      ok = false
      title = reply.message
  }
  const transcript = 'transcript' in reply ? reply.transcript : undefined

  return (
    <div className="erfassen-done pop-in" role="status" aria-live="polite">
      {transcript && (
        <p className="t-13 t-muted" style={{ margin: 0 }}>
          „{transcript}“
        </p>
      )}
      <div className="erfassen-done-row">
        {ok && (
          <span className="icon-tile">
            <Icon name="check" size={22} strokeWidth={2.2} />
          </span>
        )}
        <span className="essen-row-text">
          <span className={ok ? 'essen-row-title' : 't-15'}>{title}</span>
          {detail && <span className="t-13 t-muted">{detail}</span>}
          {ok && reply.kind === 'food' && <span className="t-13 t-muted">Gespeichert</span>}
        </span>
      </div>
      <div className="erfassen-done-actions">
        {ok ? (
          <button type="button" className="btn primary pill block" onClick={onClose}>
            Fertig
          </button>
        ) : (
          <button type="button" className="btn primary pill block" onClick={onAgain}>
            Nochmal versuchen
          </button>
        )}
      </div>
    </div>
  )
}
