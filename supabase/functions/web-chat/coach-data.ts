// Supabase-Umsetzung von CoachData. Läuft mit Service Role, deshalb filtert JEDE Abfrage auf user.id.
import Anthropic from "npm:@anthropic-ai/sdk@1.4.0";
import { db, dayBounds, type UserRow } from "../_shared/db.ts";
import { addDays } from "../_shared/garmin/transform.ts";
import type { ChatTurn, CoachData, CreateMessage, DayRow, MealRow, NoteRow } from "./coach-agent.ts";
import type { RunRow } from "./coach-answers.ts";

function rows<T>(res: { data: unknown; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? []) as T;
}

const anthropic = new Anthropic({ timeout: 45_000, maxRetries: 1 });
export const createMessage: CreateMessage = (params) => anthropic.beta.messages.create(params);
export const aiEnabled = () => !!Deno.env.get("ANTHROPIC_API_KEY");

/** Lokale Zeit „YYYY-MM-DDTHH:MM“ in der Zeitzone des Nutzers. */
function localStamp(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export function coachData(user: UserRow): CoachData {
  const uid = user.id;
  return {
    async days(from, to) {
      return rows<DayRow[]>(await db.from("daily_metrics").select("*").eq("user_id", uid).gte("date", from).lte("date", to).order("date"));
    },
    async activities(from, to) {
      return rows<RunRow[]>(
        await db.from("wearable_activities").select("external_id,started_at_local,type,name,duration_s,distance_m,avg_hr,analysis")
          .eq("user_id", uid).gte("started_at_local", from).lt("started_at_local", addDays(to, 1)).order("started_at_local"),
      );
    },
    async meals(from, to) {
      const { from: fromTs } = dayBounds(user.timezone, from);
      const { to: toTs } = dayBounds(user.timezone, to);
      const list = rows<{ eaten_at: string; title: string; kcal_low: number; kcal_mid: number; kcal_high: number; protein_g: number | null }[]>(
        await db.from("entries").select("eaten_at,title,kcal_low,kcal_mid,kcal_high,protein_g").eq("user_id", uid)
          .neq("status", "deleted").gte("eaten_at", fromTs).lt("eaten_at", toTs).order("eaten_at"),
      );
      return list.map((e): MealRow => ({ ...e, eaten_at_local: localStamp(e.eaten_at, user.timezone) }));
    },
    async weights(from, to) {
      return rows(await db.from("weights").select("measured_on,kg").eq("user_id", uid).gte("measured_on", from).lte("measured_on", to).order("measured_on"));
    },
    async notes(from, to) {
      return rows<NoteRow[]>(
        await db.from("context_notes").select("date,tag,text,source").eq("user_id", uid).gte("date", from).lte("date", to).order("date"),
      );
    },
    async briefing(date) {
      const res = await db.from("briefings").select("date,status,payload").eq("user_id", uid).eq("kind", "morning").eq("ref", "")
        .eq("date", date).maybeSingle();
      if (res.error) throw new Error(res.error.message);
      return res.data as { date: string; status: string | null; payload: Record<string, unknown> } | null;
    },
    async easyHrCap() {
      const res = await db.from("coach_settings").select("easy_hr_cap").eq("user_id", uid).maybeSingle();
      return (res.data as { easy_hr_cap: number | null } | null)?.easy_hr_cap ?? 145;
    },
    async saveNote(date, tag, text) {
      const { error } = await db.from("context_notes").insert({
        user_id: uid, date, tag: tag.toLocaleLowerCase("de-DE"), text: text || null, source: "chat",
      });
      if (error) throw new Error(error.message);
      return await countTagThisMonth(uid, tag, date);
    },
  };
}

export async function countTagThisMonth(uid: string, tag: string, date: string): Promise<number> {
  const monthStart = date.slice(0, 8) + "01";
  const next = new Date(monthStart + "T12:00:00Z");
  next.setUTCMonth(next.getUTCMonth() + 1);
  const { count } = await db.from("context_notes").select("id", { count: "exact", head: true }).eq("user_id", uid)
    .ilike("tag", tag).gte("date", monthStart).lt("date", next.toISOString().slice(0, 10));
  return count ?? 1;
}

/** Stichwörter, die der Nutzer schon benutzt hat (letzte 90 Tage), für die Normalisierung neuer Notizen. */
export async function knownTags(user: UserRow, today: string): Promise<string[]> {
  const list = rows<{ tag: string | null }[]>(
    await db.from("context_notes").select("tag").eq("user_id", user.id).gte("date", addDays(today, -90)).not("tag", "is", null).limit(500),
  );
  const seen = new Map<string, string>();
  for (const { tag } of list) {
    if (!tag) continue;
    const key = tag.toLocaleLowerCase("de-DE");
    if (!seen.has(key)) seen.set(key, tag.charAt(0).toLocaleUpperCase("de-DE") + tag.slice(1));
  }
  return [...seen.values()];
}

/** Letzte Wechsel aus dem Web-Chat (Nachricht + gespeicherte Antwort) als Kontext für den KI-Coach. */
export async function recentTurns(user: UserRow, excludeId: string): Promise<ChatTurn[]> {
  const list = rows<{ id: string; text: string | null; transcript: string | null; reply: Record<string, unknown> | null }[]>(
    await db.from("messages").select("id,text,transcript,reply").eq("user_id", user.id).neq("id", excludeId)
      .gte("received_at", new Date(Date.now() - 2 * 86_400_000).toISOString())
      .order("received_at", { ascending: false }).limit(4),
  );
  const turns: ChatTurn[] = [];
  for (const m of list.reverse()) {
    const q = (m.text ?? m.transcript ?? "").trim();
    const r = m.reply;
    const a = typeof r?.message === "string" ? r.message
      : r?.kind === "food" ? `Mahlzeit erfasst: ${(r.entry as { title?: string } | undefined)?.title ?? ""}` : "";
    if (!q || !a) continue;
    turns.push({ role: "user", text: q }, { role: "assistant", text: a });
  }
  return turns;
}
