// Supabase-Umsetzung von SyncStore (Service Role) plus Hilfen für Verbindungen.
import { db } from "../db.ts";
import { sendMessage } from "../telegram.ts";
import { localDate } from "../nutrition.ts";
import { PROVIDER, type ActivityRow, type Connection, type DailyRow, type RawKind, type RawRow, type SyncStore } from "./sync.ts";

function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

const CHUNK = 100;
function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export const supabaseStore: SyncStore = {
  async readSecret(id) {
    return must(await db.rpc("wearable_secret_read", { p_id: id })) as string | null;
  },
  async createSecret(value, name) {
    return must(await db.rpc("wearable_secret_create", { p_secret: value, p_name: name })) as string;
  },
  async updateSecret(id, value) {
    must(await db.rpc("wearable_secret_update", { p_id: id, p_secret: value }));
  },
  async updateConnection(id, patch) {
    must(await db.from("wearable_connections").update(patch).eq("id", id));
  },
  async rawHashes(userId, kinds, refs) {
    const out = new Map<string, string>();
    for (const part of chunks(refs)) {
      const rows = must(
        await db.from("wearable_raw").select("kind, ref, hash").eq("user_id", userId).eq("provider", PROVIDER).in("kind", kinds).in("ref", part),
      ) as { kind: string; ref: string; hash: string }[];
      for (const r of rows) out.set(`${r.kind}:${r.ref}`, r.hash);
    }
    return out;
  },
  async upsertRaw(rows) {
    for (const part of chunks(rows, 20)) {
      must(await db.from("wearable_raw").upsert(part, { onConflict: "user_id,provider,kind,ref" }));
    }
  },
  async rawForDates(userId, dates) {
    const kinds: RawKind[] = ["sleep", "hrv", "daily_summary", "heart_rate", "body_battery"];
    const out: RawRow[] = [];
    for (const part of chunks(dates, 10)) {
      out.push(...(must(
        await db.from("wearable_raw").select("*").eq("user_id", userId).eq("provider", PROVIDER).in("kind", kinds).in("ref", part),
      ) as RawRow[]));
    }
    return out;
  },
  async rawForActivities(userId, ids) {
    const out: RawRow[] = [];
    for (const part of chunks(ids)) {
      out.push(...(must(
        await db.from("wearable_raw").select("*").eq("user_id", userId).eq("provider", PROVIDER)
          .in("kind", ["activity_list", "activity_detail"]).in("ref", part),
      ) as RawRow[]));
    }
    return out;
  },
  async activities(userId, ids) {
    const out: ActivityRow[] = [];
    for (const part of chunks(ids)) {
      out.push(...(must(
        await db.from("wearable_activities").select("*").eq("user_id", userId).eq("provider", PROVIDER).in("external_id", part),
      ) as ActivityRow[]));
    }
    return out;
  },
  async activitiesBetween(userId, fromLocal, toLocal) {
    return must(
      await db.from("wearable_activities").select("*").eq("user_id", userId).eq("provider", PROVIDER)
        .gte("started_at_local", fromLocal).lt("started_at_local", toLocal),
    ) as ActivityRow[];
  },
  async activitiesWithoutDetail(userId, limit) {
    const rows = must(
      await db.from("wearable_activities").select("external_id").eq("user_id", userId).eq("provider", PROVIDER)
        .is("detail_fetched_at", null).order("started_at_local", { ascending: false }).limit(limit),
    ) as { external_id: string }[];
    return rows.map((r) => r.external_id);
  },
  async upsertActivities(rows) {
    const stamp = new Date().toISOString();
    for (const part of chunks(rows, 50)) {
      must(await db.from("wearable_activities").upsert(part.map((r) => ({ ...r, updated_at: stamp })), { onConflict: "user_id,provider,external_id" }));
    }
  },
  async dailyMetrics(userId, dates) {
    return must(await db.from("daily_metrics").select("*").eq("user_id", userId).in("date", dates)) as DailyRow[];
  },
  async upsertDailyMetrics(rows) {
    for (const part of chunks(rows, 50)) {
      must(await db.from("daily_metrics").upsert(part, { onConflict: "user_id,date" }));
    }
  },
};

/** Hinweis an den Nutzer. Bis Web Push da ist (M2): Telegram, falls verknüpft. Protokoll in nudges_sent. */
export async function notifyUser(userId: string, text: string, kind = "garmin_notice"): Promise<void> {
  const { data: user } = await db.from("users").select("telegram_chat_id, timezone").eq("id", userId).maybeSingle();
  if (!user) return;
  await db.from("nudges_sent").upsert(
    { user_id: userId, kind, local_date: localDate(new Date(), user.timezone ?? "Europe/Berlin") },
    { onConflict: "user_id,kind,local_date", ignoreDuplicates: true },
  );
  if (user.telegram_chat_id) await sendMessage(user.telegram_chat_id, text);
}

export async function hasFeature(userId: string, feature: string): Promise<boolean> {
  const { data } = await db.from("user_features").select("feature").eq("user_id", userId).eq("feature", feature).maybeSingle();
  return !!data;
}

export async function connectionFor(userId: string): Promise<Connection | null> {
  return must(
    await db.from("wearable_connections").select("*").eq("user_id", userId).eq("provider", PROVIDER).maybeSingle(),
  ) as Connection | null;
}

/** Verbindungen, die ein Cron-Lauf jetzt synchronisieren soll (älteste zuerst, begrenzt). */
export async function dueConnections(now: Date, minIntervalMin: number, limit: number): Promise<Connection[]> {
  const before = new Date(now.getTime() - minIntervalMin * 60_000).toISOString();
  const rows = must(
    await db.from("wearable_connections").select("*").eq("provider", PROVIDER).eq("status", "active")
      .or(`last_sync_at.is.null,last_sync_at.lt.${before}`)
      .order("last_sync_at", { ascending: true, nullsFirst: true }).limit(limit),
  ) as Connection[];
  return rows;
}

export async function deleteOldRaw(before: Date): Promise<void> {
  must(await db.from("wearable_raw").delete().lt("fetched_at", before.toISOString()));
}

/** Trennt die Verbindung; optional alle Wearable-Daten löschen. happen-Daten bleiben. */
export async function disconnect(userId: string, deleteData: boolean): Promise<void> {
  const conn = await connectionFor(userId);
  if (conn) {
    for (const id of [conn.vault_secret_id, conn.token_secret_id]) {
      if (id) must(await db.rpc("wearable_secret_delete", { p_id: id }));
    }
    must(await db.from("wearable_connections").delete().eq("id", conn.id));
  }
  if (deleteData) {
    for (const table of ["wearable_raw", "daily_metrics", "wearable_activities", "briefings"]) {
      must(await db.from(table).delete().eq("user_id", userId));
    }
  }
}
