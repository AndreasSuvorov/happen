import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { localDate, trendSeries, weeklyRate, type Profile, type TrendPoint } from "./nutrition.ts";

// SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY stellt die Edge Runtime automatisch bereit.
export const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

export interface UserRow {
  id: string;
  telegram_chat_id: number;
  first_name: string | null;
  height_cm: number | null;
  birth_year: number | null;
  sex: "m" | "f" | null;
  timezone: string;
  goal_kg_per_week: number;
}

export const profileOf = (u: UserRow): Profile => ({
  heightCm: u.height_cm ? Number(u.height_cm) : null,
  birthYear: u.birth_year,
  sex: u.sex,
  goalKgPerWeek: Number(u.goal_kg_per_week),
});

function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

/** Telegram ist nur noch ein verknüpfter Kanal: kein Auto-Anlegen mehr, nur Nachschlagen. */
export async function findUserByChatId(chatId: number): Promise<UserRow | null> {
  return must(await db.from("users").select("*").eq("telegram_chat_id", chatId).maybeSingle()) as UserRow | null;
}

/** Löst einen in der PWA erzeugten Einmal-Code ein und verknüpft den Telegram-Chat mit dem Profil. */
export async function redeemLinkCode(code: string, chatId: number): Promise<UserRow | null> {
  const row = must(
    await db.from("telegram_link_codes").select("user_id, expires_at").eq("code", code).maybeSingle(),
  ) as { user_id: string; expires_at: string } | null;
  if (!row || new Date(row.expires_at) < new Date()) return null;
  await db.from("telegram_link_codes").delete().eq("code", code);
  return must(
    await db.from("users").update({ telegram_chat_id: chatId }).eq("id", row.user_id).select().single(),
  ) as UserRow;
}

export async function listUsers(): Promise<UserRow[]> {
  return must(await db.from("users").select("*")) as UserRow[];
}

/** Gewichtsverlauf der letzten `days` Tage inkl. Trend. */
export async function weightTrend(user: UserRow, days = 60): Promise<{ series: TrendPoint[]; rate: number | null }> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = must(
    await db.from("weights").select("measured_on, kg").eq("user_id", user.id).gte("measured_on", since).order("measured_on"),
  ) as { measured_on: string; kg: number }[];
  const series = trendSeries(rows.map((r) => ({ date: r.measured_on, kg: Number(r.kg) })));
  return { series, rate: weeklyRate(series) };
}

export async function latestKg(user: UserRow): Promise<number | null> {
  const row = must(
    await db.from("weights").select("kg").eq("user_id", user.id).order("measured_on", { ascending: false }).limit(1).maybeSingle(),
  ) as { kg: number } | null;
  return row ? Number(row.kg) : null;
}

/** Start und Ende des lokalen Tages als ISO-Zeitstempel (Näherung über den aktuellen UTC-Versatz). */
export function dayBounds(tz: string, date: string): { from: string; to: string } {
  const probe = new Date(date + "T12:00:00Z");
  const localNoon = new Date(probe.toLocaleString("en-US", { timeZone: tz }));
  const offsetMs = localNoon.getTime() - probe.getTime();
  const from = new Date(Date.parse(date + "T00:00:00Z") - offsetMs);
  return { from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString() };
}

export async function dayTotals(user: UserRow, date = localDate(new Date(), user.timezone)) {
  const { from, to } = dayBounds(user.timezone, date);
  const entries = must(
    await db
      .from("entries")
      .select("kcal_low, kcal_mid, kcal_high, protein_g")
      .eq("user_id", user.id)
      .neq("status", "deleted")
      .gte("eaten_at", from)
      .lt("eaten_at", to),
  ) as { kcal_low: number; kcal_mid: number; kcal_high: number; protein_g: number | null }[];
  const runs = must(
    await db.from("activities").select("kcal_gross").eq("user_id", user.id).eq("status", "active").gte("started_at", from).lt("started_at", to),
  ) as { kcal_gross: number | null }[];
  return {
    count: entries.length,
    low: entries.reduce((s, e) => s + e.kcal_low, 0),
    mid: entries.reduce((s, e) => s + e.kcal_mid, 0),
    high: entries.reduce((s, e) => s + e.kcal_high, 0),
    protein: entries.reduce((s, e) => s + (e.protein_g ?? 0), 0),
    runKcal: runs.reduce((s, r) => s + (r.kcal_gross ?? 0), 0),
  };
}

/** Häufigste bisherige Mahlzeiten als einfaches Gedächtnis für gleiche Schätzungen. */
export async function knownMeals(user: UserRow, limit = 40): Promise<string[]> {
  const rows = must(
    await db
      .from("entries")
      .select("title, kcal_mid, answer")
      .eq("user_id", user.id)
      .neq("status", "deleted")
      .order("eaten_at", { ascending: false })
      .limit(200),
  ) as { title: string; kcal_mid: number; answer: string | null }[];
  const seen = new Map<string, { kcal: number; n: number }>();
  for (const r of rows) {
    const key = r.title.toLowerCase();
    const cur = seen.get(key);
    if (cur) cur.n++;
    else seen.set(key, { kcal: r.kcal_mid, n: 1 });
  }
  return [...seen.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, limit)
    .map(([title, v]) => `${title} – ${v.kcal} kcal (${v.n}×)`);
}
