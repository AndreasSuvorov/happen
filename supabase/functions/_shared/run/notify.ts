// Push nach einem neuen, analysierten Lauf (Coach-Plan 8.2). Gleiche Regeln wie das Morgenbriefing:
// Kanal aus coach_settings, nie in der Ruhezeit, höchstens max_pushes_per_day, Protokoll in nudges_sent.
import { defaultSchedule, inQuietHours } from "../briefing-schedule.ts";
import { db } from "../db.ts";
import { localDate, localTime } from "../nutrition.ts";
import { recordPushOutcome } from "../push-delivery.ts";
import { escapeHtml, sendMessage } from "../telegram.ts";
import { sendWebPush, vapidSettings, type Subscription } from "../web-push.ts";
import type { RunAnalysis, RunInput } from "./types.ts";

function read<T>(record: { data: T; error: { message: string } | null }): T {
  if (record.error) throw new Error(record.error.message);
  return record.data;
}

/** Kurzer Push-Text: Urteil + eine Zahl. Keine sensiblen Details (erscheint auf dem Sperrbildschirm). */
export function runPushText(analysis: RunAnalysis): { title: string; body: string } {
  const share = analysis.share_below_cap;
  const number = share !== null && analysis.verdict === "easy_ok"
    ? ` · ${Math.round(share * 100)} % unter ${analysis.hr_cap}`
    : "";
  const body = analysis.verdict === "easy_ok" ? `${analysis.headline}${number}` : `${analysis.headline}. Schau mal rein.`;
  return { title: "Happen · Dein Lauf", body };
}

/**
 * Schickt den Lauf-Push, wenn der Lauf heute oder gestern (Ortszeit) war. Wirft nicht; Fehler werden geloggt.
 */
export async function notifyRun(userId: string, timezone: string, run: RunInput, analysis: RunAnalysis, now = new Date()) {
  try {
    const date = localDate(now, timezone);
    const runDate = run.started_at_local.slice(0, 10);
    const yesterday = new Date(Date.parse(date + "T12:00:00Z") - 86_400_000).toISOString().slice(0, 10);
    if (runDate !== date && runDate !== yesterday) return; // kein Push für nachgeladene alte Läufe

    const [userRes, settingRes] = await Promise.all([
      db.from("users").select("id,telegram_chat_id").eq("id", userId).maybeSingle(),
      db.from("coach_settings").select("*").eq("user_id", userId).maybeSingle(),
    ]);
    const user = read(userRes) as { id: string; telegram_chat_id: number | null } | null;
    if (!user) return;
    const settings = { ...defaultSchedule, channel: "push", ...(read(settingRes) ?? {}) } as typeof defaultSchedule & {
      channel: "push" | "telegram" | "both";
    };
    const { hour, minute } = localTime(now, timezone);
    if (inQuietHours(hour * 60 + minute, settings.quiet_from, settings.quiet_to)) return;

    const kind = `coach_run:${run.external_id}`;
    const text = runPushText(analysis);
    const vapid = settings.channel !== "telegram" && settings.max_pushes_per_day > 0 ? vapidSettings() : null;
    if (vapid) {
      const subscriptions = read(await db.from("push_subscriptions")
        .select("id,endpoint,p256dh,auth,failed_count").eq("user_id", userId)) as Subscription[];
      const claimed = subscriptions.length && read(await db.rpc("claim_coach_push", {
        p_user_id: userId, p_kind: kind, p_date: date, p_limit: settings.max_pushes_per_day,
      }));
      if (claimed) {
        const message = JSON.stringify({ ...text, url: `/lauf/${encodeURIComponent(run.external_id)}`, tag: "coach_run" });
        const stamp = new Date().toISOString();
        await Promise.all(subscriptions.map(async (subscription) => {
          const outcome = await sendWebPush(subscription, vapid, message);
          try {
            await recordPushOutcome(subscription, outcome, stamp, {
              remove: async (id) => void read(await db.from("push_subscriptions").delete().eq("id", id).eq("user_id", userId)),
              update: async (id, values) => void read(await db.from("push_subscriptions").update(values).eq("id", id).eq("user_id", userId)),
            });
          } catch {
            console.warn("Push-Abo konnte nicht aktualisiert werden");
          }
        }));
      }
    }
    if (settings.channel !== "push" && user.telegram_chat_id) {
      const claimed = read(await db.from("nudges_sent").upsert(
        { user_id: userId, kind: kind + "_telegram", local_date: date },
        { onConflict: "user_id,kind,local_date", ignoreDuplicates: true },
      ).select("kind"));
      if (claimed?.length) {
        const lines = [analysis.headline, analysis.explanation, analysis.tip].filter((l): l is string => !!l);
        await sendMessage(user.telegram_chat_id, lines.map(escapeHtml).join("\n"));
      }
    }
  } catch (e) {
    console.error("run push failed:", (e as Error).message);
  }
}
