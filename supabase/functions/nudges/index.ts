// Erinnerungen, ausgelöst alle 15 Minuten per pg_cron (siehe supabase/cron.sql).
import { db, dayBounds, dayTotals, listUsers, weightTrend, type UserRow } from "../_shared/db.ts";
import { fmtKcal, fmtKg, fmtSigned, localDate, localTime } from "../_shared/nutrition.ts";
import { sendMessage } from "../_shared/telegram.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const sent: string[] = [];
  for (const user of await listUsers()) {
    try {
      sent.push(...(await nudgeUser(user)));
    } catch (e) {
      console.error("nudge failed", user.id, e);
    }
  }
  return Response.json({ sent });
});

/** true, wenn die Erinnerung heute noch nicht verschickt wurde (und markiert sie). */
async function claim(user: UserRow, kind: string, date: string): Promise<boolean> {
  const { data, error } = await db
    .from("nudges_sent")
    .upsert({ user_id: user.id, kind, local_date: date }, { onConflict: "user_id,kind,local_date", ignoreDuplicates: true })
    .select();
  if (error) throw new Error(error.message);
  return (data?.length ?? 0) > 0;
}

const inWindow = (h: number, m: number, startH: number, startM: number, minutes = 15) => {
  const now = h * 60 + m;
  const start = startH * 60 + startM;
  return now >= start && now < start + minutes;
};

async function nudgeUser(user: UserRow): Promise<string[]> {
  const now = new Date();
  const { hour, minute, weekday } = localTime(now, user.timezone);
  const today = localDate(now, user.timezone);
  const chat = user.telegram_chat_id;
  const out: string[] = [];

  // 07:30 – Wiegen, falls noch kein Wert
  if (inWindow(hour, minute, 7, 30)) {
    const { data } = await db.from("weights").select("id").eq("user_id", user.id).eq("measured_on", today).maybeSingle();
    if (!data && (await claim(user, "weigh", today))) {
      await sendMessage(chat, "Guten Morgen ☀️ Kurz auf die Waage? Einfach die Zahl schicken.");
      out.push("weigh");
    }
  }

  // 13:30 – Mittag fehlt
  if (inWindow(hour, minute, 13, 30)) {
    const { from } = dayBounds(user.timezone, today);
    const since = new Date(Date.parse(from) + 10.5 * 3_600_000).toISOString();
    const { count } = await db
      .from("entries")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .neq("status", "deleted")
      .gte("eaten_at", since);
    if (!count && (await claim(user, "lunch", today))) {
      await sendMessage(chat, "Mittag fehlt noch – kurzes Foto oder ein Satz?");
      out.push("lunch");
    }
  }

  // 21:00 – Abend-Rückblick
  if (inWindow(hour, minute, 21, 0) && (await claim(user, "recap", today))) {
    const t = await dayTotals(user, today);
    const summary = t.count ? `Bisher ≈ ${fmtKcal(t.mid)} kcal aus ${t.count} Einträgen.` : "Heute ist noch nichts erfasst.";
    await sendMessage(
      chat,
      `${summary}\nWas gab’s heute noch? Snacks, Getränke, ein Bier? Einfach reinsprechen – oder „nichts mehr“.`,
    );
    out.push("recap");
  }

  // Sonntag 19:00 – Wochenbericht
  if (weekday === 0 && inWindow(hour, minute, 19, 0) && (await claim(user, "weekly", today))) {
    const since = localDate(new Date(now.getTime() - 7 * 86_400_000), user.timezone);
    const { data: days } = await db.from("daily_intake").select("kcal_mid").eq("user_id", user.id).gt("local_date", since);
    const n = days?.length ?? 0;
    const avg = n ? days!.reduce((s, d) => s + Number(d.kcal_mid), 0) / n : 0;
    const { series, rate } = await weightTrend(user);
    const last = series.at(-1);
    const lines = [
      "<b>Deine Woche</b>",
      `Erfasst an ${n} von 7 Tagen · Ø ≈ ${fmtKcal(avg)} kcal`,
      last ? `Trend: ${fmtKg(last.trend)} kg${rate !== null ? ` (${fmtSigned(rate, 2)} kg/Woche)` : ""}` : "Noch keine Gewichtsdaten.",
    ];
    await sendMessage(chat, lines.join("\n"));
    out.push("weekly");
  }
  return out;
}
