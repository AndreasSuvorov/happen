import { useEffect, useState } from 'react'
import { cacheBriefing, readCachedBriefing, type BriefingRow } from '../lib/briefingCache'
import { supabase } from '../lib/supabase'

const offlineMessage = (cached: BriefingRow | null) => cached
  ? 'Gespeichertes Briefing · offline'
  : 'Für dieses Gerät ist kein Briefing offline gespeichert.'

export default function MorningBriefing({ authUserId }: { authUserId: string }) {
  const [briefing, setBriefing] = useState<BriefingRow | null>(() => navigator.onLine ? null : readCachedBriefing(authUserId))
  const [message, setMessage] = useState(() => navigator.onLine ? 'Lädt …' : offlineMessage(briefing))

  useEffect(() => {
    if (!navigator.onLine) return
    let active = true
    // RLS scopes this query to the authenticated profile, even before that profile is loaded.
    supabase.from('briefings').select('date,payload').eq('kind', 'morning').eq('ref', '')
      .order('date', { ascending: false }).limit(1).maybeSingle().retry(false).then(({ data, error, status }) => {
        if (!active) return
        if (error && status === 0) {
          const cached = readCachedBriefing(authUserId)
          setBriefing(cached)
          setMessage(offlineMessage(cached))
          return
        }
        const row = data?.payload?.headline ? data as BriefingRow : null
        setBriefing(row)
        if (!error) {
          cacheBriefing(authUserId, row)
        }
        setMessage(error ? 'Das Briefing konnte nicht geladen werden.' : row ? '' : 'Dein erstes Briefing ist noch nicht da.')
      })
    return () => { active = false }
  }, [authUserId])

  return (
    <div className="screen">
      <a href="/">Zur Übersicht</a>
      <section className="card">
        <h1>Morgenbriefing</h1>
        {briefing ? (
          <>
            <time dateTime={briefing.date}>{new Date(briefing.date + 'T12:00:00Z').toLocaleDateString('de-DE', { timeZone: 'UTC' })}</time>
            {message && <p className="muted">{message}</p>}
            <h2>{briefing.payload.headline}</h2>
            <p>{briefing.payload.why}</p>
            <p>{briefing.payload.today.text}</p>
            {briefing.payload.food && <p>{briefing.payload.food}</p>}
            {briefing.payload.question && <p>{briefing.payload.question.text}</p>}
            {briefing.payload.weigh && <p>Ab halb acht kannst du dich kurz wiegen.</p>}
          </>
        ) : (
          <p role="status">{message}</p>
        )}
      </section>
    </div>
  )
}
