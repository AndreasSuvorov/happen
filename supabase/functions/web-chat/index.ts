// Web-Chat für Happen: gleiche Schätz-Logik wie der Telegram-Bot, aber für die PWA –
// Auth per Supabase-Session statt Telegram-Secret, Antwort als strukturiertes JSON statt Chat-Text.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { db, dayBounds, dayTotals, knownMeals, latestKg, profileOf, weightTrend, type UserRow } from "../_shared/db.ts";
import { estimate, EstimateRefused, type Estimate } from "../_shared/estimate.ts";
import { baseTdee, dailyBudget, fmtKcal, fmtSigned, localDate, localTime, parseWeight, runKcalGross } from "../_shared/nutrition.ts";
import { sttEnabled, transcribe } from "../_shared/stt.ts";
import { addDays } from "../_shared/garmin/transform.ts";
import type { SignalDay } from "../_shared/signals.ts";
import {
  type CoachAnswer, detectIntent, foodAdvice, type Intent, nightAnswer, noteReply, pickRun, runAnswer, type RunRow, weekAnswer,
} from "./coach-answers.ts";
import { CoachUnavailable, normalizeTag, runCoachAgent } from "./coach-agent.ts";
import { looksLikeQuestion } from "./question.ts";
import { aiEnabled, coachData, countTagThisMonth, createMessage, knownTags, recentTurns } from "./coach-data.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface Body {
  kind: "text" | "photo" | "voice";
  text?: string;
  imageBase64?: string;
  audioBase64?: string;
  mimeType?: string;
  /** Datum der Rückfrage, die der Nutzer gerade beantwortet (Chip oder „Andere…“). */
  noteDate?: string;
}

async function authenticate(req: Request): Promise<UserRow | null> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const asUser = createClient(SUPABASE_URL, ANON_KEY);
  const { data, error } = await asUser.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await db.from("users").select("*").eq("auth_user_id", data.user.id).maybeSingle();
  return (profile as UserRow) ?? null;
}

function eatenAt(user: UserRow, est: Estimate): string {
  const now = new Date();
  if (est.day_offset === 0 && !est.time_hint) return now.toISOString();
  const date = localDate(new Date(now.getTime() + est.day_offset * 86_400_000), user.timezone);
  const { from } = dayBounds(user.timezone, date);
  const m = est.time_hint.match(/^(\d{1,2}):(\d{2})$/);
  const minutes = m ? Number(m[1]) * 60 + Number(m[2]) : 12 * 60;
  const t = new Date(Date.parse(from) + minutes * 60_000);
  return (t > now ? now : t).toISOString();
}

async function todayLine(user: UserRow): Promise<string> {
  const t = await dayTotals(user);
  const kg = await latestKg(user);
  const tdee = kg ? baseTdee(profileOf(user), kg) : null;
  if (!tdee) return `Heute: ≈ ${fmtKcal(t.mid)} kcal (${fmtKcal(t.low)}–${fmtKcal(t.high)})`;
  const budget = dailyBudget(tdee, Number(user.goal_kg_per_week), t.runKcal);
  const left = budget - t.mid;
  return `Heute: ≈ ${fmtKcal(t.mid)} von ≈ ${fmtKcal(budget)} kcal · ${left >= 0 ? `noch ≈ ${fmtKcal(left)}` : `≈ ${fmtKcal(-left)} drüber`}`;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Antwort am Nachrichten-Datensatz speichern (Verlauf auf allen Geräten, Kontext für den KI-Coach). */
async function respond(messageId: string, payload: Record<string, unknown>): Promise<Response> {
  const { error } = await db.from("messages").update({ reply: payload }).eq("id", messageId);
  if (error) console.warn("reply not saved:", error.message);
  return Response.json(payload);
}

function rowsOf<T>(res: { data: unknown; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? []) as T;
}

/** Coach-Fragen und Notizen mit echten Daten beantworten (deterministisch, ohne KI). */
async function answerCoach(user: UserRow, intent: Intent, today: string): Promise<CoachAnswer> {
  const uid = user.id;
  switch (intent.kind) {
    case "night": {
      const [days, notes] = await Promise.all([
        db.from("daily_metrics").select("*").eq("user_id", uid).gte("date", addDays(today, -29)).lte("date", today).order("date"),
        db.from("context_notes").select("date").eq("user_id", uid).gte("date", addDays(today, -1)).lte("date", today),
      ]);
      return nightAnswer(rowsOf<SignalDay[]>(days), today, rowsOf<{ date: string }[]>(notes).map((n) => n.date));
    }
    case "run": {
      const [runs, settings] = await Promise.all([
        db.from("wearable_activities").select("external_id,started_at_local,type,name,duration_s,distance_m,avg_hr,analysis")
          .eq("user_id", uid).gte("started_at_local", addDays(today, -13)).lt("started_at_local", addDays(today, 1)),
        db.from("coach_settings").select("easy_hr_cap").eq("user_id", uid).maybeSingle(),
      ]);
      const cap = (settings.data as { easy_hr_cap: number } | null)?.easy_hr_cap ?? 145;
      return runAnswer(pickRun(rowsOf<RunRow[]>(runs), intent.day), cap, intent.day);
    }
    case "week": {
      const from = addDays(today, -6);
      const { from: fromTs } = dayBounds(user.timezone, from);
      const { to: toTs } = dayBounds(user.timezone, today);
      const [days, runs, briefings, entries, weights] = await Promise.all([
        db.from("daily_metrics").select("date,sleep_minutes,hrv_last_night,sleep_uncertain").eq("user_id", uid).gte("date", from).lte("date", today),
        db.from("wearable_activities").select("external_id,started_at_local,type,name,duration_s,distance_m,avg_hr,analysis")
          .eq("user_id", uid).gte("started_at_local", from).lt("started_at_local", addDays(today, 1)),
        db.from("briefings").select("date,status").eq("user_id", uid).eq("kind", "morning").eq("ref", "").gte("date", from).lte("date", today),
        db.from("entries").select("eaten_at,kcal_mid").eq("user_id", uid).neq("status", "deleted").gte("eaten_at", fromTs).lt("eaten_at", toTs),
        db.from("weights").select("measured_on,kg").eq("user_id", uid).gte("measured_on", from).lte("measured_on", today),
      ]);
      const perDay = new Map<string, number>();
      for (const e of rowsOf<{ eaten_at: string; kcal_mid: number }[]>(entries)) {
        const d = localDate(new Date(e.eaten_at), user.timezone);
        perDay.set(d, (perDay.get(d) ?? 0) + e.kcal_mid);
      }
      return weekAnswer({
        today,
        days: rowsOf(days),
        runs: rowsOf(runs),
        statuses: rowsOf(briefings),
        mealDays: [...perDay].map(([date, mid]) => ({ date, mid })),
        weights: rowsOf(weights),
      });
    }
    case "food_advice": {
      const t = await dayTotals(user);
      const kg = await latestKg(user);
      const tdee = kg ? baseTdee(profileOf(user), kg) : null;
      return foodAdvice(t, tdee ? dailyBudget(tdee, Number(user.goal_kg_per_week), t.runKcal) : null);
    }
    case "note": {
      let tag = intent.tag;
      // Freie Antwort ohne erkanntes Stichwort: KI ordnet sie einem festen Stichwort zu („Wasserpfeife“ → Shisha).
      if (tag === "Sonstiges" && aiEnabled()) {
        try {
          tag = (await normalizeTag(createMessage, intent.text, await knownTags(user, today))) ?? tag;
        } catch (e) {
          console.warn("normalizeTag failed:", (e as Error).message);
        }
      }
      const { error } = await db.from("context_notes").insert({
        user_id: uid, date: intent.date, tag: tag.toLocaleLowerCase("de-DE"), text: intent.text,
        source: intent.answered ? "question" : "chat",
      });
      if (error) throw new Error(error.message);
      return { message: noteReply(tag, intent.date, today, await countTagThisMonth(uid, tag, intent.date)), cards: [] };
    }
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const user = await authenticate(req);
  if (!user) return new Response("unauthorized", { status: 401 });

  const body = (await req.json()) as Body;
  const text = (body.text ?? "").trim();

  // Gewicht direkt ohne KI, wie im Bot.
  if (body.kind === "text" && text) {
    const kg = parseWeight(text);
    if (kg) {
      const today = localDate(new Date(), user.timezone);
      const { error } = await db.from("weights").upsert({ user_id: user.id, measured_on: today, kg }, { onConflict: "user_id,measured_on" });
      if (error) return Response.json({ kind: "error", message: error.message }, { status: 500 });
      const { series, rate } = await weightTrend(user);
      const trend = series.at(-1)?.trend ?? kg;
      return Response.json({
        kind: "weight",
        kg,
        trend: Number(trend.toFixed(1)),
        rateText: rate !== null ? `${fmtSigned(rate)} kg/Woche` : "Nach ein paar Tagen wird er aussagekräftig.",
      });
    }
  }

  if (body.kind === "text" && !text) return Response.json({ kind: "error", message: "leer" }, { status: 400 });

  const today = localDate(new Date(), user.timezone);
  const hour = localTime(new Date(), user.timezone).hour;
  const coachReply = async (intent: Intent, messageId: string, transcript?: string) => {
    const answer = await answerCoach(user, intent, today);
    await db.from("messages").update({ status: "processed" }).eq("id", messageId);
    return await respond(messageId, { kind: "coach", intent: intent.kind, transcript, messageId, ...answer });
  };
  const localNow = () => new Date().toLocaleString("de-DE", {
    timeZone: user.timezone, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  /** Freie Frage an den KI-Coach. null = nicht verfügbar (kein Schlüssel, Ablehnung, Fehler). */
  const agentReply = async (question: string, messageId: string, transcript?: string): Promise<Response | null> => {
    if (!aiEnabled()) return null;
    try {
      const answer = await runCoachAgent(createMessage, coachData(user), {
        question, today, localNow: localNow(), history: await recentTurns(user, messageId),
      });
      await db.from("messages").update({ status: "processed" }).eq("id", messageId);
      return await respond(messageId, { kind: "coach", intent: "ai", transcript, messageId, ...answer });
    } catch (e) {
      console.warn("coach agent unavailable:", e instanceof CoachUnavailable ? e.message : (e as Error).message);
      return null;
    }
  };
  if (body.kind === "photo" && !body.imageBase64) return Response.json({ kind: "error", message: "imageBase64 fehlt" }, { status: 400 });
  if (body.kind === "voice" && !body.audioBase64) return Response.json({ kind: "error", message: "audioBase64 fehlt" }, { status: 400 });

  const { data: row, error: msgErr } = await db
    .from("messages")
    .insert({ user_id: user.id, kind: body.kind, text: text || null })
    .select("id")
    .single();
  if (msgErr) return Response.json({ kind: "error", message: msgErr.message }, { status: 500 });
  const messageId: string = row.id;

  try {
    if (body.kind === "text") {
      const intent = detectIntent(text, today, hour, body.noteDate);
      if (intent) return await coachReply(intent, messageId);
      if (looksLikeQuestion(text)) {
        const answered = await agentReply(text, messageId);
        if (answered) return answered;
      }
    }

    let image: { base64: string; mediaType: "image/jpeg" } | undefined;
    let input = text;

    if (body.kind === "photo") {
      image = { base64: body.imageBase64!, mediaType: "image/jpeg" };
    } else if (body.kind === "voice") {
      if (!sttEnabled()) {
        await db.from("messages").update({ status: "ignored" }).eq("id", messageId);
        return Response.json({ kind: "other", message: "Sprachnachrichten sind noch nicht eingerichtet." });
      }
      const bytes = base64ToBytes(body.audioBase64!);
      input = await transcribe(bytes, "voice.webm", body.mimeType || "audio/webm");
      await db.from("messages").update({ transcript: input }).eq("id", messageId);
      const intent = detectIntent(input, today, hour, body.noteDate);
      if (intent) return await coachReply(intent, messageId, input);
      if (looksLikeQuestion(input)) {
        const answered = await agentReply(input, messageId, input);
        if (answered) return answered;
      }
    }

    const est = await estimate({
      text: input,
      image,
      localNow: localNow(),
      knownMeals: await knownMeals(user),
    });

    await db.from("messages").update({ status: "processed" }).eq("id", messageId);

    if (est.kind === "food") {
      const hasQuestion = est.question.text && est.question.options.length >= 2;
      const { data: entry, error } = await db
        .from("entries")
        .insert({
          user_id: user.id,
          message_id: messageId,
          eaten_at: eatenAt(user, est),
          meal: est.meal,
          title: est.title,
          items: est.items,
          kcal_low: est.kcal_low,
          kcal_mid: est.kcal_mid,
          kcal_high: est.kcal_high,
          protein_g: est.protein_g,
          carbs_g: est.carbs_g,
          fat_g: est.fat_g,
          confidence: est.confidence,
          note: est.note || null,
          question: hasQuestion ? est.question : null,
        })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      return await respond(messageId, {
        kind: "food",
        messageId,
        transcript: body.kind === "voice" ? input : undefined,
        entry: {
          id: entry.id,
          title: entry.title,
          kcal_low: entry.kcal_low,
          kcal_mid: entry.kcal_mid,
          kcal_high: entry.kcal_high,
          protein_g: entry.protein_g,
          carbs_g: entry.carbs_g,
          fat_g: entry.fat_g,
          note: entry.note,
          question: hasQuestion ? est.question : null,
        },
        todayLine: await todayLine(user),
      });
    }

    if (est.kind === "activity") {
      const kg = (await latestKg(user)) ?? 80;
      const km = est.activity.distance_km || 0;
      const factor = est.activity.type === "walk" ? 0.5 : est.activity.type === "run" ? 1 : 0;
      const kcal = km && factor ? Math.round(runKcalGross(kg, km) * factor) : null;
      const { error } = await db.from("activities").insert({
        user_id: user.id,
        message_id: messageId,
        started_at: eatenAt(user, est),
        type: est.activity.type || "other",
        distance_km: km || null,
        duration_min: est.activity.duration_min || null,
        kcal_gross: kcal,
      });
      if (error) throw new Error(error.message);
      return await respond(messageId, {
        kind: "activity",
        messageId,
        transcript: body.kind === "voice" ? input : undefined,
        title: est.title || "Training",
        distance_km: km || null,
        duration_min: est.activity.duration_min || null,
        kcal_gross: kcal,
        todayLine: await todayLine(user),
      });
    }

    // Weder Mahlzeit noch Training: Text an den KI-Coach geben, sonst die kurze Antwort der Schätzung.
    if (body.kind !== "photo" && input.trim()) {
      const answered = await agentReply(input, messageId, body.kind === "voice" ? input : undefined);
      if (answered) return answered;
    }
    return await respond(messageId, {
      kind: "other",
      messageId,
      transcript: body.kind === "voice" ? input : undefined,
      message: est.reply_text || "Schick mir einfach ein Foto oder schreib, was du gegessen hast.",
    });
  } catch (e) {
    console.error(e);
    await db.from("messages").update({ status: "failed", error: String(e) }).eq("id", messageId);
    const message = e instanceof EstimateRefused ? "Das konnte ich leider nicht einschätzen." : "Da ist etwas schiefgelaufen.";
    return Response.json({ kind: "error", message }, { status: 200 });
  }
});
