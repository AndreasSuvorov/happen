// Supabase-Umsetzung von RunStore (Service Role).
import { db } from "../db.ts";
import type { RunCandidate, RunStore, StoredAnalysis } from "./pipeline.ts";

const PROVIDER = "garmin_personal";
const DEFAULT_CAP = 145;

function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export const supabaseRunStore: RunStore = {
  async recentRuns(userId, sinceLocal) {
    const rows = must(
      await db.from("wearable_activities")
        .select("external_id,type,started_at_local,duration_s,distance_m,avg_hr,max_hr,hr_sensor,analysis")
        .eq("user_id", userId).eq("provider", PROVIDER)
        .like("type", "%running%")
        .not("detail_fetched_at", "is", null)
        .gte("started_at_local", sinceLocal)
        .order("started_at_local", { ascending: false })
        .limit(200),
    ) as RunCandidate[];
    return rows;
  },
  async easyHrCap(userId) {
    const row = must(await db.from("coach_settings").select("easy_hr_cap").eq("user_id", userId).maybeSingle()) as
      | { easy_hr_cap: number | null }
      | null;
    return row?.easy_hr_cap ?? DEFAULT_CAP;
  },
  async treadmillSpeeds(userId, sinceDate) {
    const rows = must(
      await db.from("context_notes").select("date,text,created_at").eq("user_id", userId).eq("tag", "laufband_kmh")
        .gte("date", sinceDate).order("created_at"),
    ) as { date: string; text: string | null }[];
    const out = new Map<string, number>();
    for (const r of rows) {
      const kmh = Number(String(r.text ?? "").replace(",", ".").replace(/[^0-9.]/g, ""));
      if (Number.isFinite(kmh) && kmh >= 3 && kmh <= 25) out.set(r.date, kmh);
    }
    return out;
  },
  async saveAnalysis(userId, externalId, analysis: StoredAnalysis) {
    must(
      await db.from("wearable_activities").update({ analysis, updated_at: new Date().toISOString() })
        .eq("user_id", userId).eq("provider", PROVIDER).eq("external_id", externalId),
    );
  },
};
