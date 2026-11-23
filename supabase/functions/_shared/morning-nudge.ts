import { defaultSchedule, inQuietHours, morningDue, type BriefingSchedule } from "./briefing-schedule.ts";
import { buildContext, generateBriefing, morningReadiness } from "./coach.ts";
import { db, type UserRow } from "./db.ts";
import { localDate, localTime } from "./nutrition.ts";
import { recordPushOutcome } from "./push-delivery.ts";
import { escapeHtml, sendMessage } from "./telegram.ts";
import { sendWebPush, vapidSettings, type Subscription } from "./web-push.ts";

type Settings = BriefingSchedule & {
  channel: "push" | "telegram" | "both";
  easy_hr_cap: number;
  bedtime_target: string;
  goal: unknown;
  kcal_target_low?: number | null;
};
const defaults: Settings = { ...defaultSchedule, channel: "push", easy_hr_cap: 145, bedtime_target: "22:30", goal: null };
type Generated = Awaited<ReturnType<typeof generateBriefing>>;
const KIND = "morning";
const TAG = "coach_morning";

function read<T>(record: { data: T; error: { message: string } | null }): T {
  if (record.error) throw new Error(record.error.message);
  return record.data;
}

export async function morningNudge(original: UserRow, now: Date): Promise<{ handlesWeigh: boolean; sent: boolean }> {
  const none = { handlesWeigh: false, sent: false };
  const [feature, connection, setting] = await Promise.all([
    db.from("user_features").select("user_id").eq("user_id", original.id).eq("feature", "garmin").maybeSingle(),
    db.from("wearable_connections").select("id,timezone").eq("user_id", original.id).eq("provider", "garmin_personal").maybeSingle(),
    db.from("coach_settings").select("*").eq("user_id", original.id).maybeSingle(),
  ]);
  const wearable = read(connection);
  if (!read(feature) || !wearable) return none;
  const user = { ...original, timezone: wearable.timezone };
  const settings = read(setting) as Settings | null ?? defaults;
  const date = localDate(now, user.timezone);
  const { hour, minute } = localTime(now, user.timezone);
  const localMinute = hour * 60 + minute;

  const vapid = settings.channel !== "telegram" && settings.max_pushes_per_day > 0 ? vapidSettings() : null;
  const subscriptions = vapid ? read(await db.from("push_subscriptions")
    .select("id,endpoint,p256dh,auth,failed_count").eq("user_id", user.id)) as Subscription[] : [];
  const telegram = settings.channel !== "push" && !!user.telegram_chat_id;
  const handlesWeigh = !!subscriptions.length || telegram;
  const idle = { handlesWeigh, sent: false };

  if (inQuietHours(localMinute, settings.quiet_from, settings.quiet_to)) return idle;

  const [existing, metrics] = await Promise.all([
    db.from("briefings").select("payload,model,delivered_push_at,delivered_telegram_at")
      .eq("user_id", user.id).eq("date", date).eq("kind", KIND).eq("ref", "").maybeSingle(),
    db.from("daily_metrics").select("*").eq("user_id", user.id).eq("date", date).maybeSingle(),
  ]);
  let record = read(existing);
  const day = read(metrics);
  if (!morningDue(settings, date, localMinute, day?.sleep_end_local ?? null, morningReadiness(day))) return idle;

  if (!record) {
    const ctx = await buildContext(user, date, settings);
    const { payload, model } = await generateBriefing(KIND, ctx);
    read(await db.rpc("save_morning_briefing", {
      p_user_id: user.id, p_connection_id: wearable.id, p_date: date, p_status: payload.status, p_payload: payload, p_model: model,
    }));
    record = read(await db.from("briefings").select("payload,model,delivered_push_at,delivered_telegram_at")
      .eq("user_id", user.id).eq("date", date).eq("kind", KIND).eq("ref", "").maybeSingle());
  }
  if (!record || !handlesWeigh) return idle;

  const payload = record.payload as Generated["payload"];
  let sent = false;
  const markDelivered = async (field: "delivered_push_at" | "delivered_telegram_at") => {
    read(await db.from("briefings").update({ [field]: new Date().toISOString() })
      .eq("user_id", user.id).eq("date", date).eq("kind", KIND).eq("ref", ""));
  };

  if (vapid && subscriptions.length && !record.delivered_push_at) {
    const claimed = read(await db.rpc("claim_coach_push", {
      p_user_id: user.id, p_kind: TAG, p_date: date, p_limit: settings.max_pushes_per_day,
    }));
    if (claimed) {
      const message = JSON.stringify({ ...payload.push, url: "/heute", tag: TAG });
      const stamp = new Date().toISOString();
      const deliveries = await Promise.all(subscriptions.map(async (subscription) => {
        const outcome = await sendWebPush(subscription, vapid, message);
        try {
          await recordPushOutcome(subscription, outcome, stamp, {
            remove: async (id) => {
              read(await db.from("push_subscriptions").delete().eq("id", id).eq("user_id", user.id));
            },
            update: async (id, values) => {
              read(await db.from("push_subscriptions").update(values).eq("id", id).eq("user_id", user.id));
            },
          });
        } catch {
          console.warn("Push-Abo konnte nicht aktualisiert werden");
        }
        return outcome;
      }));
      if (deliveries.includes("accepted")) {
        await markDelivered("delivered_push_at");
        sent = true;
      } else {
        console.warn("Coach-Push wurde von keinem Push-Dienst angenommen");
      }
    }
  }

  if (telegram && !record.delivered_telegram_at) {
    const claimed = read(await db.from("nudges_sent").upsert(
      { user_id: user.id, kind: TAG + "_telegram", local_date: date },
      { onConflict: "user_id,kind,local_date", ignoreDuplicates: true },
    ).select("kind"));
    if (claimed?.length) {
      const lines = [payload.headline, payload.why, payload.today.text, payload.food, payload.question?.text,
        payload.weigh ? "Ab 07:30 kannst du dich kurz wiegen." : null];
      await sendMessage(user.telegram_chat_id, lines.filter((line): line is string => !!line).map(escapeHtml).join("\n"));
      await markDelivered("delivered_telegram_at");
      sent = true;
    }
  }
  return { handlesWeigh, sent };
}
