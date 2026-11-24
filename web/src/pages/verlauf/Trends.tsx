import {
  addDays,
  baseline,
  fetchActivities,
  fetchCoachSettings,
  fetchDailyMetrics,
  fetchWeights,
  localDate,
  shortDate,
  shortWeekday,
  useCached,
  weekStart,
  type CoachSettings,
  type DailyMetrics,
  type WearableActivity,
} from '../../lib/coach'
import type { Weight } from '../../lib/supabase'
import { fmt, fmtRange } from '../../lib/format'
import { BarChart, LineChart, type Pt, type Tip, type WeekBar } from './Chart'
import { activityDay, hardMinutes, isEasyRun, mean, signed } from './werte'
import { isRun } from '../../lib/coach'

const DAYS = 28

interface TrendData {
  metrics: DailyMetrics[]
  weights: Weight[]
  runs: WearableActivity[]
  settings: CoachSettings | null
}

async function loadTrends(today: string): Promise<TrendData> {
  const from = addDays(today, -DAYS * 2) // 28 Tage Anzeige + 28 Tage für den Normalbereich am Anfang
  const runFrom = addDays(weekStart(today), -28)
  const [metrics, weights, acts, settings] = await Promise.all([
    fetchDailyMetrics(from, today),
    fetchWeights(addDays(today, -DAYS)),
    fetchActivities(runFrom, today),
    fetchCoachSettings(),
  ])
  return { metrics, weights, runs: acts.filter((a) => isRun(a.type)), settings }
}

const dayLabel = (date: string) => `${shortWeekday(date)} ${shortDate(date)}`

function ChartCard({
  title,
  range,
  value,
  sub,
  note,
  children,
}: {
  title: string
  range: string
  value?: string
  sub?: string
  note: string
  children?: React.ReactNode
}) {
  return (
    <section aria-label={title} className="vl-chart-card">
      <div className="vl-chart-head">
        <h2>{title}</h2>
        <span className="t-13 t-muted">{range}</span>
      </div>
      {value && (
        <span className="vl-big">
          {value} {sub && <span className="t-13 t-muted vl-big-sub">{sub}</span>}
        </span>
      )}
      {children}
      <p className="t-13 t-muted vl-note">{note}</p>
    </section>
  )
}

function tooFew(n: number) {
  return n === 0 ? 'Noch keine Werte von der Uhr.' : `Mit ${n} ${n === 1 ? 'Wert' : 'Werten'} kann ich noch nichts sagen.`
}

/** HRV oder Ruhepuls: Linie über 28 Tage, Normalband, auffälligster Tag markiert. */
function MetricChart({
  data,
  today,
  metric,
  title,
  unit,
}: {
  data: TrendData
  today: string
  metric: 'hrv_last_night' | 'resting_hr'
  title: string
  unit: string
}) {
  const from = addDays(today, -DAYS)
  const xOf = (d: string) => (DAYS - (Date.parse(today) - Date.parse(d)) / 86400000) / DAYS
  const rows = data.metrics.filter((d) => d.date >= from && typeof d[metric] === 'number')
  if (rows.length < 3) return <ChartCard title={title} range="4 Wochen" note={tooFew(rows.length)} />

  // HRV: Garmins eigenen Normalbereich nehmen, wenn er da ist (Plan 6.1), sonst den eigenen.
  const latest = rows[rows.length - 1]
  let band: { low: number; high: number } | null = null
  if (metric === 'hrv_last_night' && latest.hrv_baseline_low != null && latest.hrv_baseline_high != null) {
    band = { low: latest.hrv_baseline_low, high: latest.hrv_baseline_high }
  } else {
    const b = baseline(data.metrics, metric, latest.date)
    if (b) band = { low: b.low, high: b.high }
  }

  const pts: Pt[] = rows.map((d) => ({ x: xOf(d.date), value: d[metric] as number }))
  const values = pts.map((p) => p.value)
  const lo = Math.min(...values, band?.low ?? Infinity)
  const hi = Math.max(...values, band?.high ?? -Infinity)
  const pad = Math.max((hi - lo) * 0.15, 2)
  const domain: [number, number] = [lo - pad, hi + pad]

  // Auffälligster Tag: mehr als eine halbe Bandbreite außerhalb des Normalbereichs.
  let mark: { x: number; value: number; text: string; date: string; above: boolean } | null = null
  if (band) {
    const width = Math.max(band.high - band.low, 1)
    let worst = 0
    for (const d of rows) {
      const v = d[metric] as number
      const out = v > band.high ? v - band.high : v < band.low ? band.low - v : 0
      if (out > width * 0.5 && out > worst && d.date !== latest.date) {
        worst = out
        mark = { x: xOf(d.date), value: v, text: `${shortDate(d.date)} deutlich abweichend`, date: d.date, above: v > band.high }
      }
    }
  }
  const tips: Tip[] = rows.map((d) => ({ x: xOf(d.date), value: d[metric] as number, text: `${dayLabel(d.date)} · ${fmt(d[metric] as number)} ${unit}`.trim() }))

  const when = latest.date === today ? 'heute' : latest.date === addDays(today, -1) ? 'gestern' : dayLabel(latest.date)
  const sub = band ? `${when} · normal ${fmtRange(band.low, band.high)}` : `${when} · Normalbereich ab 10 Werten`
  const inBand = band ? rows.filter((d) => (d[metric] as number) >= band.low && (d[metric] as number) <= band.high).length / rows.length : 0

  let note: string
  if (!band) note = 'Den Normalbereich zeige ich ab 10 Werten.'
  else if (metric === 'hrv_last_night') note = 'Das blasse Band ist dein Normalbereich.'
  else if (inBand >= 0.6)
    note = mark ? `Ruhig. Nur rund um den ${shortDate(mark.date)} war er ${mark.above ? 'höher' : 'niedriger'}.` : 'Ruhig, meist im Normalbereich.'
  else note = 'Öfter außerhalb deines Normalbereichs. Das blasse Band ist dein Normalbereich.'

  const aria =
    `${title} der letzten 4 Wochen, zuletzt ${fmt(latest[metric] as number)} ${unit}` +
    (band ? `, Normalbereich ${fmtRange(band.low, band.high)}, ${Math.round(inBand * 100)} Prozent der Tage darin` : '') +
    (mark ? `, am ${shortDate(mark.date)} deutlich ${mark.above ? 'darüber' : 'darunter'}` : '')

  return (
    <ChartCard title={title} range="4 Wochen" value={`${fmt(latest[metric] as number)}${unit === 'ms' ? ' ms' : ''}`} sub={sub} note={note}>
      <LineChart
        line={pts}
        band={band}
        domain={domain}
        mark={metric === 'hrv_last_night' ? mark : null}
        tips={tips}
        label={aria}
      />
    </ChartCard>
  )
}

function WeightChart({ data, today }: { data: TrendData; today: string }) {
  const xOf = (d: string) => (DAYS - (Date.parse(today) - Date.parse(d)) / 86400000) / DAYS
  const ws = data.weights.map((w) => ({ date: w.measured_on, kg: Number(w.kg) })).filter((w) => Number.isFinite(w.kg))
  if (ws.length < 3) return <ChartCard title="Gewicht" range="4 Wochen" note={tooFew(ws.length)} />
  const meanAt = (date: string) => mean(ws.filter((w) => w.date <= date && w.date >= addDays(date, -6)).map((w) => w.kg))!
  const line: Pt[] = ws.map((w) => ({ x: xOf(w.date), value: meanAt(w.date) }))
  const dots: Pt[] = ws.map((w) => ({ x: xOf(w.date), value: w.kg }))
  const all = [...line, ...dots].map((p) => p.value)
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const pad = Math.max((hi - lo) * 0.15, 0.3)
  const last = line[line.length - 1].value
  const diff = last - line[0].value
  const tips: Tip[] = ws.map((w, i) => ({
    x: xOf(w.date),
    value: w.kg,
    text: `${dayLabel(w.date)} · ${fmt(w.kg, 1)} kg (Mittel ${fmt(line[i].value, 1)})`,
  }))
  const trend = Math.abs(diff) < 0.2 ? 'stabil' : diff < 0 ? 'leicht fallend' : 'leicht steigend'
  return (
    <ChartCard
      title="Gewicht"
      range="4 Wochen"
      value={`${fmt(last, 1)} kg`}
      sub={`7-Tage-Mittel · ${signed(diff, 1)} kg in 4 Wochen`}
      note="Punkte sind einzelne Tage, die Linie ist das 7-Tage-Mittel. Tagesschwankungen sind normal."
    >
      <LineChart
        line={line}
        dots={dots}
        domain={[lo - pad, hi + pad]}
        tips={tips}
        label={`Gewicht der letzten 4 Wochen, Punkte für jeden gewogenen Tag und eine Linie für das 7-Tage-Mittel, ${trend}, zuletzt ${fmt(last, 1)} kg`}
      />
    </ChartCard>
  )
}

function RunChart({ data, today }: { data: TrendData; today: string }) {
  const cap = data.settings?.easy_hr_cap ?? 145
  const monday = weekStart(today)
  const weeks = [4, 3, 2, 1].map((n) => addDays(monday, -7 * n))
  const bars: WeekBar[] = weeks.map((from) => {
    const runs = data.runs.filter((a) => activityDay(a) >= from && activityDay(a) <= addDays(from, 6))
    const total = runs.reduce((s, a) => s + (a.duration_s ?? 0) / 60, 0)
    const hard = runs.reduce((s, a) => s + hardMinutes(a, cap), 0)
    const easy = Math.round(total - hard)
    const h = Math.round(hard)
    return { label: shortDate(from), easy, hard: h, tip: `Woche ab ${shortDate(from)}: ${easy} locker, ${h} zu hart` }
  })
  const any = data.runs.some((a) => activityDay(a) >= weeks[0] && activityDay(a) < monday)
  if (!any) return <ChartCard title="Laufminuten pro Woche" range="locker / zu hart" note="In den letzten 4 Wochen ist kein Lauf von deiner Uhr angekommen." />
  const last = bars[bars.length - 1]
  const lastRuns = data.runs.filter((a) => activityDay(a) >= weeks[3] && activityDay(a) < monday)
  const easyRuns = lastRuns.filter((a) => isEasyRun(a, cap)).length
  return (
    <ChartCard
      title="Laufminuten pro Woche"
      range="locker / zu hart"
      value={`${last.easy + last.hard} Min.`}
      sub={`letzte Woche · ${last.hard} davon zu hart`}
      note={`Grün ist locker unter ${cap}, orange ist darüber. Für die Grundlage sollten es mindestens 80 % locker sein.`}
    >
      <BarChart
        bars={bars}
        label={
          'Laufminuten pro Woche, aufgeteilt in locker und zu hart: ' +
          bars.map((b) => `Woche ab ${b.label} ${b.easy} locker, ${b.hard} zu hart`).join('; ') +
          `. Letzte Woche ${easyRuns} von ${lastRuns.length} Läufen locker.`
        }
      />
    </ChartCard>
  )
}

export default function Trends() {
  const today = localDate()
  const { data, error } = useCached(`verlauf-trends-${today}`, () => loadTrends(today), [today])
  if (!data) {
    return error ? (
      <p className="card warn">Die Trends lassen sich gerade nicht laden. {error}</p>
    ) : (
      <div className="vl-stack-12" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="vl-chart-card skeleton" style={{ height: 190 }} />
        ))}
      </div>
    )
  }
  return (
    <div className="vl-stack-12">
      <MetricChart data={data} today={today} metric="hrv_last_night" title="HRV" unit="ms" />
      <MetricChart data={data} today={today} metric="resting_hr" title="Ruhepuls" unit="bpm" />
      <WeightChart data={data} today={today} />
      <RunChart data={data} today={today} />
    </div>
  )
}
