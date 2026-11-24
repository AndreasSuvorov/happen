import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { supabase, type Profile } from '../../lib/supabase'
import { cacheBriefing } from '../../lib/briefingCache'
import {
  fetchCoachSettings,
  triggerSync,
  updateCoachSettings,
  type CoachSettings,
  type WearableStatus,
} from '../../lib/coach'
import { Icon, Sheet } from '../../components/ui'
import GoalEditor from '../onboarding/GoalEditor'
import { draftFromGoal, goalFromDraft, goalSummary, parseGoal, type GoalDraft } from '../onboarding/goal'
import { rememberGoalSaved } from '../onboarding/state'
import {
  fetchVapidKey,
  isIOSBrowser,
  isSubscribed,
  permissionHelp,
  pushPermission,
  subscribePush,
  supportsPush,
  unsubscribePush,
} from '../onboarding/push'
import { ago, disconnectWearable, errorText, garminEnabled, isStale, wearableStatus } from '../onboarding/wearable'
import './einstellungen.css'

type Settings = Omit<CoachSettings, 'user_id'>

// Werte, die die Datenbank ohne eigene Zeile verwendet (Defaults aus der Migration).
const DEFAULTS: Settings = {
  channel: 'push',
  briefing_mode: 'after_wake',
  briefing_time: '07:00:00',
  quiet_from: '22:00:00',
  quiet_to: '06:00:00',
  easy_hr_cap: 145,
  lthr: null,
  goal: null,
  kcal_target_low: null,
  kcal_target_high: null,
  bedtime_target: '22:30:00',
  max_pushes_per_day: 3,
}

const hm = (t: string | null | undefined) => (t ? t.slice(0, 5) : '–')
const num = (n: number) => n.toLocaleString('de-DE')
const NOT_SET = 'Nicht festgelegt'
const MAX_BIRTH_YEAR = new Date().getFullYear() - 10

/* ---------------------------------------------------------------------------
 * Bausteine: Gruppe, Zeile, Segment, Schalter
 * ------------------------------------------------------------------------- */
function Group({ title, children, warn, note }: { title: string; children: ReactNode; warn?: ReactNode; note?: ReactNode }) {
  return (
    <section className="st-group" aria-label={title}>
      <h2 className="st-group-title">{title}</h2>
      {warn}
      <div className="st-card">{children}</div>
      {note && <p className="st-note">{note}</p>}
    </section>
  )
}

function Row({
  label,
  value,
  sub,
  onClick,
  to,
  chevron = true,
  tone,
  busy,
}: {
  label: string
  value?: ReactNode
  sub?: ReactNode
  onClick?: () => void
  to?: string
  chevron?: boolean
  tone?: 'danger' | 'warn' | 'strong'
  busy?: boolean
}) {
  const inner = (
    <>
      <span className="st-row-main">
        <span className="st-row-label">{label}</span>
        {sub && <span className="st-row-sub">{sub}</span>}
      </span>
      <span className="st-row-value">
        {value}
        {chevron && <Icon name="chevronRight" size={16} strokeWidth={2} />}
      </span>
    </>
  )
  const cls = `st-row${tone ? ` ${tone}` : ''}`
  if (to)
    return (
      <Link className={cls} to={to}>
        {inner}
      </Link>
    )
  if (!onClick) return <div className={`${cls} static`}>{inner}</div>
  return (
    <button type="button" className={cls} onClick={onClick} disabled={busy} aria-busy={busy || undefined}>
      {inner}
    </button>
  )
}

function Seg<T extends string>({
  label,
  value,
  options,
  onPick,
  disabledIds = [],
  children,
}: {
  label: string
  value: T
  options: [T, string][]
  onPick: (v: T) => void
  disabledIds?: T[]
  children?: ReactNode
}) {
  return (
    <div className="st-seg-row">
      <span className="st-row-label">{label}</span>
      <div className="st-seg" role="group" aria-label={label}>
        {options.map(([id, l]) => (
          <button
            key={id}
            type="button"
            aria-pressed={value === id}
            disabled={disabledIds.includes(id)}
            onClick={() => value !== id && onPick(id)}
          >
            {l}
          </button>
        ))}
      </div>
      {children}
    </div>
  )
}

function Switch({
  label,
  sub,
  on,
  onToggle,
  disabled,
}: {
  label: string
  sub?: ReactNode
  on: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  return (
    <button type="button" className="st-switch-row" aria-pressed={on} onClick={onToggle} disabled={disabled}>
      <span className="st-row-main">
        <span className="st-row-label">{label}</span>
        {sub && <span className="st-row-sub">{sub}</span>}
      </span>
      <span className="st-switch" aria-hidden="true">
        <span className="st-knob" />
      </span>
    </button>
  )
}

/* ---------------------------------------------------------------------------
 * Bearbeiten im Sheet: einfache Felder
 * ------------------------------------------------------------------------- */
interface Field {
  key: string
  label: string
  type: 'number' | 'time' | 'text'
  value: string
  min?: number
  max?: number
  step?: number
  suffix?: string
  placeholder?: string
}

function FieldsSheet({
  title,
  hint,
  fields,
  onSave,
  onClose,
}: {
  title: string
  hint?: string
  fields: Field[]
  onSave: (v: Record<string, string>) => Promise<string | null>
  onClose: () => void
}) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.key, f.value])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    for (const f of fields) {
      const v = values[f.key].trim()
      if (f.type === 'number' && v !== '') {
        const n = Number(v.replace(',', '.'))
        if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          setError(`${f.label}: bitte zwischen ${num(f.min ?? 0)} und ${num(f.max ?? 0)}.`)
          return
        }
      }
    }
    setBusy(true)
    setError(null)
    const err = await onSave(values)
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }

  return (
    <Sheet label={title} onClose={onClose}>
      <form className="st-sheet" onSubmit={submit}>
        <h2 className="st-sheet-title">{title}</h2>
        {hint && <p className="st-sheet-hint">{hint}</p>}
        <div className={fields.length === 2 ? 'st-sheet-grid' : 'st-sheet-fields'}>
          {fields.map((f, i) => (
            <label key={f.key} className="st-field">
              <span>{f.label}</span>
              <span className="st-input-wrap">
                <input
                  className="input"
                  type={f.type === 'number' ? 'text' : f.type}
                  inputMode={f.type === 'number' ? (f.step && f.step < 1 ? 'decimal' : 'numeric') : undefined}
                  value={values[f.key]}
                  placeholder={f.placeholder}
                  autoFocus={i === 0}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
                {f.suffix && <span className="st-suffix">{f.suffix}</span>}
              </span>
            </label>
          ))}
        </div>
        {error && (
          <p className="st-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary block st-save" disabled={busy}>
          {busy ? 'Speichere …' : 'Speichern'}
        </button>
      </form>
    </Sheet>
  )
}

function GoalSheet({ goal, onSave, onClose }: { goal: unknown; onSave: (g: unknown) => Promise<string | null>; onClose: () => void }) {
  const [draft, setDraft] = useState<GoalDraft>(() => draftFromGoal(parseGoal(goal)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    const res = goalFromDraft(draft)
    if ('error' in res) return setError(res.error)
    setBusy(true)
    const err = await onSave(res.goal)
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }
  return (
    <Sheet label="Ziel" onClose={onClose}>
      <div className="st-sheet">
        <h2 className="st-sheet-title">Was willst du erreichen?</h2>
        <p className="st-sheet-hint">Du kannst mehreres wählen. Das ändert, worauf ich achte.</p>
        <GoalEditor
          draft={draft}
          onChange={(d) => {
            setError(null)
            setDraft(d)
          }}
        />
        {error && (
          <p className="st-error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="btn primary block st-save" disabled={busy} onClick={() => void save()}>
          {busy ? 'Speichere …' : 'Speichern'}
        </button>
      </div>
    </Sheet>
  )
}

type Editing =
  | 'goal'
  | 'easy'
  | 'lthr'
  | 'kcal'
  | 'bedtime'
  | 'briefingTime'
  | 'quiet'
  | 'max'
  | 'name'
  | 'height'
  | 'birth'
  | 'pace'
  | 'telegram'
  | 'disconnect'
  | null

/* ---------------------------------------------------------------------------
 * Screen
 * ------------------------------------------------------------------------- */
export default function Einstellungen({ profile, onProfileSaved }: { profile: Profile; onProfileSaved: () => void }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS)
  const [settingsState, setSettingsState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  // Gespeicherte Profiländerungen sofort zeigen, bis das neu geladene Profil da ist.
  const [overrides, setOverrides] = useState<Partial<Profile>>({})
  const me: Profile = { ...profile, ...overrides }

  // Uhr
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [status, setStatus] = useState<WearableStatus | null>(null)
  const [watchBusy, setWatchBusy] = useState(false)
  const [watchError, setWatchError] = useState<string | null>(null)

  // Push auf diesem Gerät
  const [permission, setPermission] = useState(pushPermission)
  const [vapid, setVapid] = useState<string | null>(null)
  const [subscribed, setSubscribed] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const iosBrowser = isIOSBrowser()

  // Telegram
  const [linkCode, setLinkCode] = useState<{ code: string; deepLink: string | null } | null>(null)
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetchCoachSettings()
      .then((s) => {
        if (!active) return
        if (s) {
          const { user_id: _id, ...rest } = s
          setSettings({ ...DEFAULTS, ...rest })
          if (parseGoal(s.goal)?.goals.length) rememberGoalSaved(profile.id)
        }
        setSettingsState('ready')
      })
      .catch(() => active && setSettingsState('error'))

    garminEnabled(profile.id)
      .then(async (on) => {
        if (!active) return
        setEnabled(on)
        if (!on) return
        const s = await wearableStatus().catch(() => null)
        if (active) setStatus(s)
        if (!supportsPush() || isIOSBrowser()) return
        const [key, sub] = await Promise.all([fetchVapidKey().catch(() => null), isSubscribed(profile.id).catch(() => false)])
        if (!active) return
        setVapid(key)
        setSubscribed(sub)
      })
      .catch(() => active && setEnabled(false))
    return () => {
      active = false
    }
  }, [profile.id])

  /** Coach-Einstellung sofort speichern (optimistisch, bei Fehler zurück). */
  const saveSettings = async (patch: Partial<Settings>): Promise<string | null> => {
    const before = settings
    setSettings({ ...settings, ...patch })
    setMessage(null)
    try {
      const saved = await updateCoachSettings(profile.id, patch)
      if (saved) {
        const { user_id: _id, ...rest } = saved as CoachSettings
        setSettings({ ...DEFAULTS, ...rest })
      }
      return null
    } catch {
      setSettings(before)
      setMessage('Speichern hat nicht geklappt. Versuch es nochmal.')
      return 'Speichern hat nicht geklappt.'
    }
  }

  const saveProfile = async (patch: Partial<Profile>): Promise<string | null> => {
    const { error } = await supabase.from('users').update(patch).eq('id', profile.id)
    if (error) return 'Speichern hat nicht geklappt.'
    setOverrides((o) => ({ ...o, ...patch }))
    onProfileSaved()
    return null
  }

  const togglePush = async () => {
    setPushBusy(true)
    setMessage(null)
    if (subscribed) {
      if (await unsubscribePush()) setSubscribed(false)
      else setMessage('Push konnte auf diesem Gerät gerade nicht geändert werden.')
    } else {
      const res = await subscribePush(vapid)
      setPermission(pushPermission())
      if (res === 'ok') setSubscribed(true)
      else if (res !== 'denied') setMessage('Push konnte auf diesem Gerät gerade nicht geändert werden.')
    }
    setPushBusy(false)
  }

  const syncNow = async () => {
    setWatchBusy(true)
    setWatchError(null)
    await triggerSync()
    setStatus(await wearableStatus().catch(() => status))
    setWatchBusy(false)
  }

  const disconnect = async (deleteData: boolean) => {
    setWatchBusy(true)
    setWatchError(null)
    try {
      setStatus(await disconnectWearable(deleteData))
      if (deleteData) cacheBriefing(profile.auth_user_id, null)
      setEditing(null)
    } catch (e) {
      setWatchError(errorText((e as Error).message))
      setEditing(null)
    } finally {
      setWatchBusy(false)
    }
  }

  const requestLinkCode = async () => {
    setLinking(true)
    setLinkError(null)
    const { data: session } = await supabase.auth.getSession()
    const token = session.session?.access_token
    const { data, error } = await supabase.functions.invoke('link-code', {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    setLinking(false)
    if (error) setLinkError('Konnte keinen Code erzeugen.')
    else setLinkCode(data as { code: string; deepLink: string | null })
  }

  const signOut = () => {
    cacheBriefing(profile.auth_user_id, null)
    void supabase.auth.signOut()
  }

  const s = settings
  const goal = goalSummary(parseGoal(s.goal))
  const hasTelegram = !!me.telegram_chat_id
  const usesPush = s.channel !== 'telegram'
  const connected = !!status?.connected
  const expired = connected && status?.status !== 'active'
  const stale = connected && !expired && isStale(status?.lastDataAt)

  const pushWarn =
    usesPush && permission === 'denied' ? (
      <div className="st-warn" role="status">
        <span className="st-warn-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0M3 3l18 18" />
          </svg>
          Mitteilungen sind ausgeschaltet
        </span>
        <span className="st-warn-text">Dein Morgenbriefing kommt so nicht an. {permissionHelp()} Ich frage nicht nochmal nach.</span>
      </div>
    ) : null

  // Zeile „Mitteilungen auf diesem Gerät“
  let pushRow: ReactNode = null
  if (usesPush && enabled) {
    if (iosBrowser)
      pushRow = (
        <Row
          label="Mitteilungen auf diesem Gerät"
          sub="Erst möglich, wenn happen auf dem Homescreen liegt"
          value="Anleitung"
          to="/onboarding/3"
        />
      )
    else if (!supportsPush())
      pushRow = <Row label="Mitteilungen auf diesem Gerät" sub="Dieser Browser kann keine Mitteilungen empfangen" chevron={false} />
    else
      pushRow = (
        <Switch
          label="Mitteilungen auf diesem Gerät"
          sub={
            permission === 'denied'
              ? 'Im System gesperrt, siehe oben'
              : !vapid && !subscribed
                ? 'Gerade nicht verfügbar'
                : subscribed
                  ? 'An: hier kommt dein Briefing an'
                  : 'Aus'
          }
          on={subscribed}
          onToggle={() => void togglePush()}
          disabled={pushBusy || permission === 'denied' || (!subscribed && !vapid)}
        />
      )
  }

  return (
    <div className="st">
      <header className="st-header">
        <Link to="/heute" className="st-back" aria-label="Zurück zu Heute">
          <Icon name="chevronLeft" size={24} strokeWidth={2.2} />
        </Link>
        <h1 className="st-title">Einstellungen</h1>
      </header>

      {settingsState === 'error' && (
        <p className="st-error" role="alert">
          Einstellungen konnten nicht geladen werden. Angezeigt sind die Standardwerte.
        </p>
      )}
      {message && (
        <p className="st-error" role="alert">
          {message}
        </p>
      )}

      <Group title="Ziel und Training">
        <Row label="Ziel" value={goal.value} sub={goal.sub || undefined} onClick={() => setEditing('goal')} />
        <Row label="Lockere Läufe" value={`Puls unter ${s.easy_hr_cap}`} onClick={() => setEditing('easy')} />
        <Row label="Laktatschwelle" value={s.lthr ?? NOT_SET} onClick={() => setEditing('lthr')} />
      </Group>

      <Group title="Essen und Schlaf">
        <Row
          label="Essen pro Tag"
          value={
            s.kcal_target_low && s.kcal_target_high
              ? `${num(s.kcal_target_low)}–${num(s.kcal_target_high)} kcal`
              : s.kcal_target_low
                ? `ab ${num(s.kcal_target_low)} kcal`
                : NOT_SET
          }
          onClick={() => setEditing('kcal')}
        />
        <Row
          label="Abnehmen pro Woche"
          value={`${num(Number(me.goal_kg_per_week))} kg`}
          sub="Bestimmt dein Tagesbudget"
          onClick={() => setEditing('pace')}
        />
        <Row label="Schlafenszeit" value={hm(s.bedtime_target)} onClick={() => setEditing('bedtime')} />
      </Group>

      <Group
        title="Morgenbriefing"
        warn={pushWarn}
        note="Nach dem Aufwachen heißt: etwa 15 Minuten nachdem deine Uhr dein Aufwachen erkannt hat, frühestens um 6 Uhr."
      >
        <Seg
          label="Wo soll ich dich erreichen?"
          value={s.channel}
          options={[
            ['push', 'Mitteilung'],
            ['telegram', 'Telegram'],
            ['both', 'Beides'],
          ]}
          disabledIds={hasTelegram ? [] : ['telegram', 'both']}
          onPick={(channel) => void saveSettings({ channel })}
        >
          {!hasTelegram && <span className="st-row-sub">Für Telegram verknüpfe es unten unter „Telegram“.</span>}
        </Seg>
        {pushRow}
        <Seg
          label="Wann?"
          value={s.briefing_mode}
          options={[
            ['after_wake', 'Nach dem Aufwachen'],
            ['fixed', `Um ${hm(s.briefing_time)}`],
          ]}
          onPick={(briefing_mode) => void saveSettings({ briefing_mode })}
        />
        {s.briefing_mode === 'fixed' && (
          <Row label="Uhrzeit" value={hm(s.briefing_time)} onClick={() => setEditing('briefingTime')} />
        )}
        <Row label="Ruhezeit" value={`${hm(s.quiet_from)}–${hm(s.quiet_to)}`} onClick={() => setEditing('quiet')} />
        <Row
          label="Höchstens pro Tag"
          value={s.max_pushes_per_day === 1 ? '1 Mitteilung' : `${s.max_pushes_per_day} Mitteilungen`}
          onClick={() => setEditing('max')}
        />
      </Group>

      <Group
        title="Uhr"
        note={
          enabled
            ? watchError ??
              (connected
                ? 'Beim Trennen lösche ich auf Wunsch Schlaf, Puls, Läufe und Briefings. Deine Mahlzeiten und dein Gewicht bleiben.'
                : undefined)
            : enabled === false
              ? 'Die Uhr-Verbindung ist für dein Konto noch nicht freigeschaltet.'
              : undefined
        }
      >
        {enabled === null || (enabled && !status) ? (
          <Row label="Garmin" value="Lädt …" chevron={false} />
        ) : enabled === false ? (
          <Row label="Garmin" value="Nicht freigeschaltet" chevron={false} />
        ) : !connected ? (
          <Row label="Garmin" value="Verbinden" sub="Dann sehe ich, wie du schläfst und läufst" to="/onboarding/2" />
        ) : (
          <>
            <Row
              label="Garmin"
              value={watchBusy ? 'Prüfe …' : expired ? 'Abgelaufen' : 'Verbunden'}
              tone={expired ? 'warn' : undefined}
              sub={
                <>
                  Letzter Abgleich {ago(status?.lastSyncAt)}
                  {status?.backfillPending && ' · lade die letzten 4 Wochen'}
                  {stale && ` · seit ${ago(status?.lastDataAt).replace('vor ', '')} keine neuen Daten. Öffne kurz Garmin Connect auf dem Handy.`}
                </>
              }
              chevron={false}
              onClick={expired ? undefined : () => void syncNow()}
              busy={watchBusy}
            />
            <Row
              label="Schlüssel"
              value={expired ? 'Erneuern' : 'Ersetzen'}
              sub={expired ? 'Abgelaufen. So erneuerst du ihn' : 'Neuen Schlüssel einfügen, bevor er abläuft'}
              tone={expired ? 'warn' : undefined}
              to="/onboarding/2?erneuern"
            />
            <Row label="Verbindung trennen" chevron={false} tone="danger" onClick={() => setEditing('disconnect')} />
          </>
        )}
      </Group>

      <Group title="Profil" note="Größe, Alter und Geschlecht brauche ich für dein Tagesbudget.">
        <Row label="Name" value={me.first_name || NOT_SET} onClick={() => setEditing('name')} />
        <Row label="Größe" value={me.height_cm ? `${me.height_cm} cm` : NOT_SET} onClick={() => setEditing('height')} />
        <Row label="Geburtsjahr" value={me.birth_year ?? NOT_SET} onClick={() => setEditing('birth')} />
        <Seg
          label="Geschlecht"
          value={me.sex ?? ''}
          options={[
            ['f', 'weiblich'],
            ['m', 'männlich'],
          ]}
          onPick={(sex) => void saveProfile({ sex: sex as 'm' | 'f' }).then((e) => e && setMessage(e))}
        />
      </Group>

      <Group title="Telegram">
        {hasTelegram ? (
          <Row label="Telegram" value="Verbunden" chevron={false} />
        ) : (
          <Row
            label="Mit Telegram verknüpfen"
            sub="Dann kann ich dir auch dort schreiben"
            onClick={() => {
              setEditing('telegram')
              if (!linkCode) void requestLinkCode()
            }}
          />
        )}
      </Group>

      <Group title="Datenschutz">
        <Row
          label="Einwilligung Gesundheitsdaten"
          value={connected ? 'Erteilt' : 'Nicht erteilt'}
          sub={connected ? 'Widerrufen: Verbindung trennen und Daten löschen' : undefined}
          chevron={false}
        />
      </Group>

      <div className="st-card">
        <Row label="Abmelden" chevron={false} tone="strong" onClick={signOut} />
      </div>

      {/* --- Sheets --- */}
      {editing === 'goal' && (
        <GoalSheet
          goal={s.goal}
          onClose={() => setEditing(null)}
          onSave={async (g) => {
            const err = await saveSettings({ goal: g })
            if (!err) rememberGoalSaved(profile.id)
            return err
          }}
        />
      )}
      {editing === 'easy' && (
        <FieldsSheet
          title="Lockere Läufe"
          hint="Unter diesem Puls zählt ein Lauf als locker. Danach beurteile ich deine Läufe."
          fields={[{ key: 'v', label: 'Pulsgrenze', type: 'number', value: String(s.easy_hr_cap), min: 80, max: 220, suffix: 'bpm' }]}
          onSave={(v) => saveSettings({ easy_hr_cap: Math.round(Number(v.v)) })}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'lthr' && (
        <FieldsSheet
          title="Laktatschwelle"
          hint="Puls an deiner Laktatschwelle, falls du ihn kennst. Leer lassen, wenn nicht."
          fields={[{ key: 'v', label: 'Puls', type: 'number', value: s.lthr ? String(s.lthr) : '', min: 80, max: 230, suffix: 'bpm' }]}
          onSave={(v) => saveSettings({ lthr: v.v.trim() ? Math.round(Number(v.v)) : null })}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'kcal' && (
        <FieldsSheet
          title="Essen pro Tag"
          hint="Dein Zielbereich. Liegst du darunter, sage ich es dir im Briefing. Leer lassen, wenn du keinen festen Bereich willst."
          fields={[
            { key: 'low', label: 'Von', type: 'number', value: s.kcal_target_low ? String(s.kcal_target_low) : '', min: 800, max: 6000, suffix: 'kcal' },
            { key: 'high', label: 'Bis', type: 'number', value: s.kcal_target_high ? String(s.kcal_target_high) : '', min: 800, max: 6000, suffix: 'kcal' },
          ]}
          onSave={async (v) => {
            const low = v.low.trim() ? Math.round(Number(v.low)) : null
            const high = v.high.trim() ? Math.round(Number(v.high)) : null
            if (low && high && high < low) return '„Bis“ muss größer sein als „Von“.'
            return saveSettings({ kcal_target_low: low, kcal_target_high: high })
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'bedtime' && (
        <FieldsSheet
          title="Schlafenszeit"
          fields={[{ key: 'v', label: 'Ins Bett um', type: 'time', value: hm(s.bedtime_target) }]}
          onSave={(v) => (v.v ? saveSettings({ bedtime_target: v.v }) : Promise.resolve('Bitte eine Uhrzeit wählen.'))}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'briefingTime' && (
        <FieldsSheet
          title="Briefing um"
          fields={[{ key: 'v', label: 'Uhrzeit', type: 'time', value: hm(s.briefing_time) }]}
          onSave={(v) => (v.v ? saveSettings({ briefing_time: v.v }) : Promise.resolve('Bitte eine Uhrzeit wählen.'))}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'quiet' && (
        <FieldsSheet
          title="Ruhezeit"
          hint="In dieser Zeit schicke ich dir nichts."
          fields={[
            { key: 'from', label: 'Von', type: 'time', value: hm(s.quiet_from) },
            { key: 'to', label: 'Bis', type: 'time', value: hm(s.quiet_to) },
          ]}
          onSave={(v) =>
            v.from && v.to ? saveSettings({ quiet_from: v.from, quiet_to: v.to }) : Promise.resolve('Bitte beide Uhrzeiten wählen.')
          }
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'max' && (
        <FieldsSheet
          title="Höchstens pro Tag"
          hint="So viele Mitteilungen schicke ich dir höchstens an einem Tag. 0 heißt: keine."
          fields={[{ key: 'v', label: 'Mitteilungen', type: 'number', value: String(s.max_pushes_per_day), min: 0, max: 10 }]}
          onSave={(v) => saveSettings({ max_pushes_per_day: Math.round(Number(v.v)) })}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'name' && (
        <FieldsSheet
          title="Name"
          fields={[{ key: 'v', label: 'Vorname', type: 'text', value: me.first_name ?? '' }]}
          onSave={(v) => saveProfile({ first_name: v.v.trim() || null })}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'height' && (
        <FieldsSheet
          title="Größe"
          fields={[{ key: 'v', label: 'Größe', type: 'number', value: me.height_cm ? String(me.height_cm) : '', min: 100, max: 250, suffix: 'cm' }]}
          onSave={(v) => saveProfile({ height_cm: v.v.trim() ? Math.round(Number(v.v)) : null })}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'birth' && (
        <FieldsSheet
          title="Geburtsjahr"
          fields={[
            { key: 'v', label: 'Geburtsjahr', type: 'number', value: me.birth_year ? String(me.birth_year) : '', min: 1900, max: MAX_BIRTH_YEAR },
          ]}
          onSave={(v) => saveProfile({ birth_year: v.v.trim() ? Math.round(Number(v.v)) : null })}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'pace' && (
        <FieldsSheet
          title="Abnehmen pro Woche"
          hint="0 heißt: Gewicht halten. Mehr als 0,7 kg pro Woche empfehle ich nicht."
          fields={[{ key: 'v', label: 'Zieltempo', type: 'number', value: String(me.goal_kg_per_week).replace('.', ','), min: 0, max: 1.5, step: 0.1, suffix: 'kg' }]}
          onSave={(v) => saveProfile({ goal_kg_per_week: Number(v.v.replace(',', '.')) })}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'telegram' && (
        <Sheet label="Telegram" onClose={() => setEditing(null)}>
          <div className="st-sheet">
            <h2 className="st-sheet-title">Mit Telegram verknüpfen</h2>
            {linking && <p className="st-sheet-hint">Erzeuge Code …</p>}
            {linkError && (
              <>
                <p className="st-error" role="alert">
                  {linkError}
                </p>
                <button type="button" className="btn block" onClick={() => void requestLinkCode()}>
                  Nochmal versuchen
                </button>
              </>
            )}
            {linkCode && (
              <>
                <p className="st-sheet-hint">Schick dem happen-Bot diese Nachricht:</p>
                <code className="st-code">/start {linkCode.code}</code>
                {linkCode.deepLink && (
                  <a className="btn primary block" href={linkCode.deepLink} target="_blank" rel="noreferrer">
                    In Telegram öffnen
                  </a>
                )}
                <p className="st-sheet-hint">Der Code läuft in 10 Minuten ab. Danach diese Seite neu laden.</p>
              </>
            )}
          </div>
        </Sheet>
      )}
      {editing === 'disconnect' && (
        <Sheet label="Verbindung trennen" onClose={() => setEditing(null)}>
          <div className="st-sheet">
            <h2 className="st-sheet-title">Verbindung zur Uhr trennen?</h2>
            <p className="st-sheet-hint">
              Du kannst die bisher geladenen Daten behalten oder alles löschen: Schlaf, Puls, Läufe und Briefings. Deine
              Mahlzeiten und dein Gewicht bleiben in beiden Fällen.
            </p>
            <button type="button" className="btn block" disabled={watchBusy} onClick={() => void disconnect(false)}>
              Trennen, Daten behalten
            </button>
            <button type="button" className="btn block st-danger-btn" disabled={watchBusy} onClick={() => void disconnect(true)}>
              Trennen und Daten löschen
            </button>
            <button type="button" className="btn ghost block" style={{ border: 0, color: 'var(--c-muted)' }} onClick={() => setEditing(null)}>
              Abbrechen
            </button>
          </div>
        </Sheet>
      )}
    </div>
  )
}
