// Verbindet die Laufanalyse mit dem Garmin-Sync (SyncDeps.afterActivities).
import { endpoints, type GarminClient } from "../garmin/client.ts";
import type { Connection } from "../garmin/sync.ts";
import { notifyRun } from "./notify.ts";
import { analyzePendingRuns } from "./pipeline.ts";
import { supabaseRunStore } from "./store.ts";

export function runAnalysisHook(log: (msg: string) => void = (m) => console.error(m)) {
  return async (conn: Connection, client: GarminClient, today: string): Promise<number> => {
    const result = await analyzePendingRuns(
      conn.user_id,
      today,
      supabaseRunStore,
      (id) => client.getBytes(endpoints.activityFile(id)),
      { log },
    );
    for (const { run, analysis } of result.fresh) await notifyRun(conn.user_id, conn.timezone, run, analysis);
    return result.analyzed.length;
  };
}
