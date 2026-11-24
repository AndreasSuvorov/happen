// Garmin-Sync. Zwei Auslöser:
//  * pg_cron alle 20 min (Header x-cron-secret): alle fälligen Verbindungen, nur 04:30–23:30 Ortszeit.
//  * PWA "Nochmal prüfen" (Supabase-Auth-Token): sofort, nur für diesen Nutzer.
import { authenticate } from "../_shared/auth.ts";
import { localTime } from "../_shared/nutrition.ts";
import { RAW_RETENTION_DAYS, syncConnection, type SyncDeps } from "../_shared/garmin/sync.ts";
import { runAnalysisHook } from "../_shared/run/hook.ts";
import { connectionFor, deleteOldRaw, dueConnections, hasFeature, notifyUser, supabaseStore } from "../_shared/garmin/store.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const MIN_INTERVAL_MIN = 15;
const MAX_PER_RUN = 10;
const MANUAL_MIN_INTERVAL_MS = 60_000;

const deps: SyncDeps = {
  store: supabaseStore,
  notify: (uid, text) => notifyUser(uid, text, "garmin_expired"),
  log: (m) => console.error(m),
  afterActivities: runAnalysisHook(),
};

/** 04:30 bis 23:30 Ortszeit. */
export function inSyncWindow(now: Date, tz: string): boolean {
  const { hour, minute } = localTime(now, tz);
  const m = hour * 60 + minute;
  return m >= 4 * 60 + 30 && m <= 23 * 60 + 30;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // --- Cron -----------------------------------------------------------------
  if (req.headers.get("x-cron-secret")) {
    if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return new Response("forbidden", { status: 403 });
    const now = new Date();
    const results: Record<string, string> = {};
    for (const conn of await dueConnections(now, MIN_INTERVAL_MIN, MAX_PER_RUN * 3)) {
      if (Object.keys(results).length >= MAX_PER_RUN) break;
      if (!inSyncWindow(now, conn.timezone)) continue;
      if (!(await hasFeature(conn.user_id, "garmin"))) continue;
      const r = await syncConnection(conn, deps);
      results[conn.user_id] = r.status;
    }
    try {
      await deleteOldRaw(new Date(now.getTime() - RAW_RETENTION_DAYS * 86_400_000));
    } catch (e) {
      console.error("raw cleanup failed:", (e as Error).message);
    }
    return Response.json({ synced: results });
  }

  // --- Manuell aus der PWA --------------------------------------------------
  const user = await authenticate(req);
  if (!user) return new Response("unauthorized", { status: 401 });
  if (!(await hasFeature(user.id, "garmin"))) return Response.json({ error: "feature_disabled" }, { status: 403 });
  const conn = await connectionFor(user.id);
  if (!conn) return Response.json({ error: "not_connected" }, { status: 404 });
  if (conn.status !== "active") return Response.json({ status: conn.status });
  if (conn.last_sync_at && Date.now() - Date.parse(conn.last_sync_at) < MANUAL_MIN_INTERVAL_MS) {
    return Response.json({ status: "ok", skipped: "too_soon" });
  }
  const r = await syncConnection(conn, deps);
  return Response.json({ status: r.status, newData: r.rawChanged > 0, backfillDone: r.backfillDone });
});
