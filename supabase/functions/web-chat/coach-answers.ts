// Coach-Antworten im Web-Chat: Absicht erkennen und Antworten aus echten Daten bauen.
// Reine Funktionen ohne Datenbank, deterministisch und getestet (tests/web-chat-coach.test.ts).
// Die Mahlzeiten-Erfassung bleibt beim bestehenden Ablauf in index.ts.
import { addDays } from "../_shared/garmin/transform.ts";
import { daysUntilBaseline, normalRanges, recovery, type SignalDay } from "../_shared/signals.ts";

/* ---------------------------------------------------------------------------
 * Bausteine, die die PWA als Karten darstellt (Plan 7.3 / 9.5)
 * ------------------------------------------------------------------------- */
export interface MetricItem { metric: string; label: string; value: number; unit: string; low: number; high: number }
export type Card =
  | { type: "metric_compare"; items: MetricItem[] }
  | {
    type: "run_card"; activity_id: string; date: string; title: string; tone: "good" | "warn" | "neutral";
    detail: string; hr_cap: number | null; hr?: number[];
  }
  | { type: "table"; title?: string; rows: { label: string; value: string; note?: string }[] }
  | { type: "chips"; options: string[]; note_date?: string };

export interface CoachAnswer { message: string; cards: Card[] }

export type Intent =
  | { kind: "night" }
  | { kind: "run"; day: string | null }
  | { kind: "week" }
  | { kind: "food_advice" }
  | { kind: "note"; tag: string; date: string; text: string; answered: boolean };

/* ---------------------------------------------------------------------------
 * Absicht
 * ------------------------------------------------------------------------- */
const tags: [string, RegExp][] = [
  ["Shisha", /shisha/],
  ["Alkohol", /\balkohol|\bbetrunken|\bkater\b/],
  ["Party", /\bparty\b|gefeiert|\bfeier\b/],
  ["Kind wach", /\b(kind|baby|kleine[nr]?|tochter|sohn)\b.*\bwach\b/],
  ["Stress", /stress/],
  ["Spät gegessen", /spät gegessen|spät essen/],
  ["Hitze", /\bhitze\b|zu warm|\bheiß/],
  ["Krank", /\bkrank|erkältet|erkältung|fieber/],
  ["Nichts Besonderes", /^nichts( besonderes)?\.?$/],
];

const weekdays = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"];

function isQuestion(t: string): boolean {
  return t.includes("?") || /^(wie|was|und|war|wann|zeig|hab|habe|bin)\b/.test(t);
}

/** Datum, auf das sich „gestern“, „Sonntag“ usw. bezieht, oder null. */
export function dayMentioned(t: string, today: string): string | null {
  if (/vorgestern/.test(t)) return addDays(today, -2);
  if (/gestern/.test(t)) return addDays(today, -1);
  if (/\bheute\b/.test(t)) return today;
  const dow = new Date(today + "T12:00:00Z").getUTCDay();
  const i = weekdays.findIndex((w) => t.includes(w));
  if (i < 0) return null;
  return addDays(today, -((dow - i + 7) % 7));
}

/**
 * Erkennt Coach-Fragen und Notizen. null = bestehender Ablauf (Mahlzeit, Aktivität, freie Antwort).
 * `noteDate` kommt mit, wenn der Nutzer eine Rückfrage beantwortet (Chip oder „Andere…“).
 */
export function detectIntent(text: string, today: string, hour: number, noteDate?: string): Intent | null {
  const t = text.trim().toLocaleLowerCase("de-DE");
  if (!t) return null;
  const tag = tags.find(([, re]) => re.test(t))?.[0];

  if (noteDate && /^\d{4}-\d{2}-\d{2}$/.test(noteDate) && t.length <= 300) {
    return { kind: "note", tag: tag ?? "Sonstiges", date: noteDate, text: text.trim(), answered: true };
  }

  if (isQuestion(t)) {
    const logsDistance = /\d+([.,]\d+)?\s*(km|kilometer)\b/.test(t);
    if (/\bnacht\b|geschlafen|\bschlaf/.test(t)) return { kind: "night" };
    if (!logsDistance && /\blauf\b|\bläufe|gelaufen|joggen/.test(t)) {
      return { kind: "run", day: dayMentioned(t, today) };
    }
    if (/\bwoche\b/.test(t)) return { kind: "week" };
    if (/^(was|wie ?viel)\b/.test(t) && /\b(ich|mir|noch)\b/.test(t) && /\bessen\b|gegessen|kalorien|kcal|\bbudget/.test(t)) return { kind: "food_advice" };
    return null;
  }

  // „gestern war Shisha“: kurze Aussage mit bekanntem Stichwort, nichts, was nach Mahlzeit klingt.
  const words = t.split(/\s+/).length;
  const soundsLikeMeal = /\d+\s*(g|kg|ml|l|stück|scheiben?)\b/.test(t) ||
    (/gegessen|getrunken|\bessen\b/.test(t) && tag !== "Spät gegessen");
  if (tag && words <= 8 && !soundsLikeMeal) {
    const date = dayMentioned(t, today) ?? (hour < 12 ? addDays(today, -1) : today);
    return { kind: "note", tag, date, text: text.trim(), answered: false };
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Zahlen
 * ------------------------------------------------------------------------- */
const de = (n: number, digits = 0) =>
  n.toLocaleString("de-DE", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const hours = (min: number) => de(Math.round(min / 6) / 10, 1);
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const shortDay = (date: string) => {
  const d = new Date(date + "T12:00:00Z");
  const wd = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][d.getUTCDay()];
  return `${wd}, ${d.getUTCDate()}.${d.getUTCMonth() + 1}.`;
};

/* ---------------------------------------------------------------------------
 * „Wie war meine Nacht?“
 * ------------------------------------------------------------------------- */
export function nightAnswer(days: SignalDay[], today: string, notedDates: string[]): CoachAnswer {
  const day = days.find((d) => d.date === today);
  if (!day || !isNum(day.sleep_minutes)) {
    return { message: "Von letzter Nacht habe ich noch keine Daten. Sobald deine Uhr synchronisiert hat, sage ich dir mehr.", cards: [] };
  }
  if (day.sleep_uncertain) {
    return { message: `Die Uhr hat ${hours(day.sleep_minutes)} Stunden erkannt, ist sich bei dieser Nacht aber unsicher. Ich bewerte sie deshalb nicht.`, cards: [] };
  }
  const ranges = normalRanges(days, today);
  const rec = recovery(day, ranges);
  const parts: string[] = [];
  const opener = { green: "Gut.", yellow: "Etwas unruhig.", red: "Deine Werte weichen deutlich ab.", unknown: "" }[rec.status];
  if (opener) parts.push(opener);

  const sleepRange = ranges.sleep_minutes;
  let sleep = `${hours(day.sleep_minutes)} Stunden`;
  if (sleepRange) {
    const diff = day.sleep_minutes - sleepRange.median;
    sleep += diff >= 20 ? ", länger als dein Schnitt" : diff <= -20 ? ", kürzer als dein Schnitt" : ", etwa wie dein Schnitt";
  }
  parts.push(sleep + ".");

  const garmin = isNum(day.hrv_baseline_low) && isNum(day.hrv_baseline_high) && day.hrv_baseline_low <= day.hrv_baseline_high;
  const hrvLow = garmin ? day.hrv_baseline_low! : ranges.hrv_last_night?.low;
  const hrvHigh = garmin ? day.hrv_baseline_high! : ranges.hrv_last_night?.high;
  const items: MetricItem[] = [];
  if (isNum(day.hrv_last_night) && isNum(hrvLow) && isNum(hrvHigh)) {
    const where = day.hrv_last_night > hrvHigh ? "über" : day.hrv_last_night < hrvLow ? "unter" : "in";
    parts.push(`Deine HRV liegt ${where} deinem Normalbereich.`);
    items.push({ metric: "hrv_last_night", label: "HRV", value: day.hrv_last_night, unit: "ms", low: hrvLow, high: hrvHigh });
  }
  const pulse = ranges.sleep_hr_avg;
  if (isNum(day.sleep_hr_avg) && pulse) {
    items.push({ metric: "sleep_hr_avg", label: "Schlafpuls", value: Math.round(day.sleep_hr_avg), unit: "bpm", low: pulse.low, high: pulse.high });
  }
  if (sleepRange) {
    items.push({
      metric: "sleep_minutes", label: "Schlaf", value: Math.round(day.sleep_minutes / 6) / 10, unit: "h",
      low: Math.round(sleepRange.low / 6) / 10, high: Math.round(sleepRange.high / 6) / 10,
    });
  }
  if (rec.status === "red") parts.push("Achte auf Symptome und lass das Training heute aus.");
  if (!items.length) {
    const left = daysUntilBaseline(days, today);
    parts.push(left > 0
      ? `Einen Normalbereich habe ich in ${left} ${left === 1 ? "Tag" : "Tagen"}, dann kann ich vergleichen.`
      : "Für einen Vergleich fehlen mir noch Werte.");
  }

  const cards: Card[] = items.length ? [{ type: "metric_compare", items }] : [];
  const yesterday = addDays(today, -1);
  if ((rec.status === "yellow" || rec.status === "red") && !notedDates.includes(yesterday)) {
    parts.push("War gestern Abend etwas?");
    cards.push({
      type: "chips", note_date: yesterday,
      options: ["Shisha", "Alkohol", "Party", "Kind wach", "Stress", "Spät gegessen", "Krank", "Nichts Besonderes"],
    });
  }
  return { message: parts.join(" "), cards };
}

/* ---------------------------------------------------------------------------
 * „Wie war mein Lauf?“
 * ------------------------------------------------------------------------- */
export interface RunRow {
  external_id: string; started_at_local: string; type: string; name: string | null;
  duration_s: number | null; distance_m: number | null; avg_hr: number | null;
  analysis: Record<string, unknown> | null;
}

export const isRunType = (type: string) => /run/i.test(type);

const verdicts: Record<string, { title: string; tone: "good" | "warn" | "neutral" }> = {
  easy_ok: { title: "Locker geblieben", tone: "good" },
  easy: { title: "Locker geblieben", tone: "good" },
  easy_too_hard: { title: "Zu hart für locker", tone: "warn" },
  drifted: { title: "Puls ist weggelaufen", tone: "warn" },
  late_surge: { title: "Zu schnell geworden", tone: "warn" },
  hard_session: { title: "Harte Einheit", tone: "neutral" },
  hard: { title: "Harte Einheit", tone: "neutral" },
  race_like: { title: "Wie ein Wettkampf", tone: "neutral" },
};

export function pickRun(runs: RunRow[], day: string | null): RunRow | null {
  const sorted = runs.filter((r) => isRunType(r.type)).sort((a, b) => b.started_at_local.localeCompare(a.started_at_local));
  if (day) return sorted.find((r) => r.started_at_local.startsWith(day)) ?? null;
  return sorted[0] ?? null;
}

export function runAnswer(run: RunRow | null, cap: number, day: string | null): CoachAnswer {
  if (!run) {
    return {
      message: day
        ? `Am ${shortDay(day)} habe ich keinen Lauf von deiner Uhr gefunden.`
        : "In den letzten 14 Tagen habe ich keinen Lauf von deiner Uhr gefunden.",
      cards: [],
    };
  }
  const a = run.analysis ?? {};
  const date = run.started_at_local.slice(0, 10);
  const min = isNum(run.duration_s) ? Math.round(run.duration_s / 60) : null;
  const km = isNum(run.distance_m) && run.distance_m > 0 ? run.distance_m / 1000 : null;
  const hr = run.avg_hr;

  let verdict = typeof a.verdict === "string" ? verdicts[a.verdict] : undefined;
  if (!verdict) {
    verdict = !isNum(hr) ? { title: "Lauf ohne Puls", tone: "neutral" }
      : hr <= cap ? { title: "Locker geblieben", tone: "good" }
      : hr <= cap + 5 ? { title: "Knapp über locker", tone: "warn" }
      : { title: "Über deiner Obergrenze", tone: "warn" };
  }
  const detail = [shortDay(date), min !== null ? `${min} Min.` : null, km !== null ? `${de(km, 1)} km` : null,
    isNum(hr) ? `Ø Puls ${hr}` : null].filter(Boolean).join(" · ");

  let message: string;
  if (typeof a.explanation === "string" && a.explanation.trim()) message = a.explanation.trim();
  else if (!isNum(hr)) message = "Zu diesem Lauf habe ich keinen Puls, deshalb kann ich die Intensität nicht bewerten.";
  else if (hr <= cap) message = `Im Schnitt Puls ${hr}, deine Obergrenze für lockere Läufe ist ${cap}. Genau so baut sich Grundlage auf.`;
  else {
    message = `Im Schnitt Puls ${hr}, deine Obergrenze für lockere Läufe ist ${cap}. ` +
      `Wenn es ein lockerer Lauf sein sollte: Stell den Pulsalarm auf ${cap}, dann merkst du es früher.`;
  }
  const series = Array.isArray(a.hr_series) ? (a.hr_series as unknown[]).filter(isNum) : [];
  const card: Card = {
    type: "run_card", activity_id: run.external_id, date, title: verdict.title, tone: verdict.tone, detail, hr_cap: cap,
    ...(series.length >= 5 ? { hr: series.slice(0, 120) } : {}),
  };
  return { message, cards: [card] };
}

/* ---------------------------------------------------------------------------
 * „Wie war meine Woche?“
 * ------------------------------------------------------------------------- */
export interface WeekInput {
  today: string;
  days: Pick<SignalDay, "date" | "sleep_minutes" | "hrv_last_night" | "sleep_uncertain">[];
  runs: RunRow[];
  statuses: { date: string; status: string | null }[];
  mealDays: { date: string; mid: number }[];
  weights: { measured_on: string; kg: number }[];
}

export function weekAnswer(w: WeekInput): CoachAnswer {
  const from = addDays(w.today, -6);
  const inWeek = (d: string) => d >= from && d <= w.today;
  const rows: { label: string; value: string; note?: string }[] = [];
  const parts: string[] = [];

  const runs = w.runs.filter((r) => isRunType(r.type) && inWeek(r.started_at_local.slice(0, 10)));
  const km = runs.reduce((s, r) => s + (r.distance_m ?? 0), 0) / 1000;
  const runMin = runs.reduce((s, r) => s + (r.duration_s ?? 0), 0) / 60;
  if (runs.length) {
    rows.push({ label: "Läufe", value: `${runs.length} · ${de(km, 1)} km`, note: `${Math.round(runMin)} Min.` });
    parts.push(`${runs.length} ${runs.length === 1 ? "Lauf" : "Läufe"} mit ${de(km, 1)} km.`);
  } else {
    rows.push({ label: "Läufe", value: "keine" });
  }

  const nights = w.days.filter((d) => inWeek(d.date) && !d.sleep_uncertain && isNum(d.sleep_minutes));
  if (nights.length) {
    const avg = nights.reduce((s, d) => s + d.sleep_minutes!, 0) / nights.length;
    rows.push({ label: "Schlaf Ø", value: `${hours(avg)} h`, note: `${nights.length} Nächte` });
    parts.push(`Du hast im Schnitt ${hours(avg)} Stunden geschlafen.`);
  }

  const statuses = w.statuses.filter((s) => inWeek(s.date) && s.status && s.status !== "unknown");
  if (statuses.length) {
    const count = (st: string) => statuses.filter((s) => s.status === st).length;
    const g = count("green"), y = count("yellow"), r = count("red");
    rows.push({ label: "Erholung", value: [g && `${g}× gut`, y && `${y}× müde`, r && `${r}× schonen`].filter(Boolean).join(", ") });
    parts.push(`An ${g} von ${statuses.length} Morgen warst du gut erholt.`);
  } else {
    const hrv = w.days.filter((d) => inWeek(d.date) && isNum(d.hrv_last_night));
    if (hrv.length) rows.push({ label: "HRV Ø", value: `${Math.round(hrv.reduce((s, d) => s + d.hrv_last_night!, 0) / hrv.length)} ms` });
  }

  const meals = w.mealDays.filter((m) => inWeek(m.date) && m.mid > 0);
  if (meals.length) {
    const avg = meals.reduce((s, m) => s + m.mid, 0) / meals.length;
    rows.push({ label: "Essen Ø", value: `≈ ${de(Math.round(avg / 10) * 10)} kcal`, note: `${meals.length} Tage erfasst` });
  }

  const weights = w.weights.filter((x) => inWeek(x.measured_on)).sort((a, b) => a.measured_on.localeCompare(b.measured_on));
  if (weights.length >= 2) {
    const diff = Number(weights.at(-1)!.kg) - Number(weights[0].kg);
    const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
    rows.push({ label: "Gewicht", value: `${sign}${de(Math.abs(diff), 1)} kg`, note: `${weights.length} Messungen` });
  }

  if (rows.length === 1 && !runs.length) {
    return { message: "Für die letzten 7 Tage habe ich noch kaum Daten. Verbinde deine Uhr oder erfasse dein Essen, dann wird das hier interessant.", cards: [] };
  }
  return {
    message: (parts.length ? parts.join(" ") : "Hier ist deine Woche.") + " Das sind die letzten 7 Tage.",
    cards: [{ type: "table", title: `${shortDay(from)} bis ${shortDay(w.today)}`, rows: rows.slice(0, 5) }],
  };
}

/* ---------------------------------------------------------------------------
 * „Was soll ich heute noch essen?“
 * ------------------------------------------------------------------------- */
export function foodAdvice(t: { count: number; low: number; mid: number; high: number; protein: number }, budget: number | null): CoachAnswer {
  const kcal = (n: number) => `≈ ${de(Math.round(n / 10) * 10)} kcal`;
  const rows: { label: string; value: string; note?: string }[] = [
    { label: "Gegessen", value: kcal(t.mid), note: t.count ? `${de(t.low)}–${de(t.high)}` : "noch nichts erfasst" },
  ];
  if (budget === null) {
    return {
      message: `Heute hast du ${kcal(t.mid)} erfasst. Für ein Tagesbudget brauche ich Größe, Geburtsjahr, Geschlecht und ein Gewicht. Das kannst du in den Einstellungen eintragen.`,
      cards: [{ type: "table", rows }],
    };
  }
  const left = budget - t.mid;
  rows.push({ label: "Tagesbudget", value: kcal(budget) });
  rows.push({ label: left >= 0 ? "Noch übrig" : "Drüber", value: kcal(Math.abs(left)) });
  rows.push({ label: "Eiweiß", value: `${Math.round(t.protein)} g` });
  let message: string;
  if (left > 700) message = `Du hast noch ${kcal(left)}. Iss eine richtige Mahlzeit mit viel Eiweiß, zum Beispiel Fisch oder Hähnchen mit Gemüse und einer Beilage.`;
  else if (left > 250) message = `Noch ${kcal(left)}. Etwas Leichtes mit Eiweiß passt gut, zum Beispiel Quark, Joghurt oder ein Omelett.`;
  else if (left >= 0) message = "Dein Budget ist für heute fast aufgebraucht. Wenn du Hunger hast: Gemüse, Suppe oder ein Joghurt.";
  else message = `Du bist heute ${kcal(-left)} drüber. Kein Problem, morgen geht es normal weiter.`;
  return { message, cards: [{ type: "table", rows }] };
}

/* ---------------------------------------------------------------------------
 * Notiz („gestern war Shisha“)
 * ------------------------------------------------------------------------- */
const ordinals = ["", "erste", "zweite", "dritte", "vierte", "fünfte", "sechste", "siebte", "achte", "neunte", "zehnte"];

export function noteReply(tag: string, date: string, today: string, sameTagThisMonth: number): string {
  const when = date === today ? "für heute" : date === addDays(today, -1) ? "für gestern" : `für ${shortDay(date)}`;
  if (tag === "Nichts Besonderes") return `Notiert ${when}. Danke!`;
  if (tag === "Sonstiges") return `Notiert ${when}. Ich schaue mir an, ob es mit deinen Werten zusammenhängt.`;
  let msg = `Notiert ${when}: ${tag}.`;
  if (sameTagThisMonth >= 2) {
    msg += ` Das war das ${ordinals[sameTagThisMonth] ?? `${sameTagThisMonth}.`} Mal in diesem Monat.`;
  }
  msg += sameTagThisMonth >= 3
    ? " Ab jetzt kann ich dir zeigen, was das mit deiner Nacht macht."
    : " Ab drei Notizen zeige ich dir, was das mit deiner Nacht macht.";
  return msg;
}
