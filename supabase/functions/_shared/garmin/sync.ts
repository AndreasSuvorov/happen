// Sync eines Garmin-Kontos: Rohdaten holen, in wearable_raw ablegen, daily_metrics und
// wearable_activities neu berechnen. Alle Zugriffe gehen über `SyncStore`, damit die Logik
// ohne Datenbank testbar ist (tests/garmin-sync.test.ts). Die Supabase-Umsetzung steht in store.ts.

import { localDate } from "../nutrition.ts";
import {
  createGarminClient,
  endpoints,
  fetchToken,
  GarminKeyError,
  type ClientOptions,
  type GarminClient,
} from "./client.ts";
import {
  activitiesOnDate,
  addDays,
  buildDailyMetrics,
  dateRange,
  differs,
  sha256,
  splitBodyBattery,
  splitDailySummaries,
  stableStringify,
  transformActivityDetail,
  transformActivityListItem,
  type ActivityDetailFields,
  type ActivityListFields,
  type DailyMetrics,
} from "./transform.ts";

export const PROVIDER = "garmin_personal";
export const BACKFILL_DAYS = 28;
/** Tage pro Sync-Lauf beim Nachladen (hält jeden Lauf kurz). */
export const BACKFILL_CHUNK_DAYS = 14;
/** Aktivitätsdetails pro Lauf. */
export const DETAIL_LIMIT = 15;
export const RAW_RETENTION_DAYS = 30;
const TOKEN_MIN_REMAINING_MS = 30 * 60_000;

export type RawKind = "sleep" | "hrv" | "daily_summary" | "heart_rate" | "body_battery" | "activity_list" | "activity_detail";

export interface Connection {
  id: string;
  user_id: string;
  vault_secret_id: string;
  token_secret_id: string | null;
  token_expires_at: string | null;
  status: "active" | "expired" | "error" | "disconnected";
  last_sync_at: string | null;
  last_data_at: string | null;
  last_error: string | null;
  backfill_from: string | null;
  backfill_cursor: string | null;
  timezone: string;
  expired_notified_at: string | null;
}

export interface RawRow {
  user_id: string;
  provider: string;
  kind: RawKind;
  ref: string;
  payload: unknown;
  hash: string;
  fetched_at: string;
}

export type ActivityRow = ActivityListFields & Partial<ActivityDetailFields> & {
  user_id: string;
  provider: string;
  detail_fetched_at?: string | null;
};

export type DailyRow = DailyMetrics & { user_id: string; updated_at?: string };

export interface SyncStore {
  readSecret(id: string): Promise<string | null>;
  createSecret(value: string, name: string): Promise<string>;
  updateSecret(id: string, value: string): Promise<void>;
  updateConnection(id: string, patch: Partial<Connection>): Promise<void>;
  /** Hashes vorhandener Rohdaten: Schlüssel `${kind}:${ref}`. */
  rawHashes(userId: string, kinds: RawKind[], refs: string[]): Promise<Map<string, string>>;
  upsertRaw(rows: RawRow[]): Promise<void>;
  /** Rohdaten mit Datums-Ref für die angegebenen Tage. */
  rawForDates(userId: string, dates: string[]): Promise<RawRow[]>;
  /** Rohdaten von Aktivitäten (activity_list/activity_detail) für die IDs. */
  rawForActivities(userId: string, ids: string[]): Promise<RawRow[]>;
  activities(userId: string, ids: string[]): Promise<ActivityRow[]>;
  /** Aktivitäten mit lokaler Startzeit im Bereich [fromLocal, toLocal). */
  activitiesBetween(userId: string, fromLocal: string, toLocal: string): Promise<ActivityRow[]>;
  /** Aktivitäten ohne geladene Details, neueste zuerst. */
  activitiesWithoutDetail(userId: string, limit: number): Promise<string[]>;
  upsertActivities(rows: ActivityRow[]): Promise<void>;
  dailyMetrics(userId: string, dates: string[]): Promise<DailyRow[]>;
  upsertDailyMetrics(rows: DailyRow[]): Promise<void>;
}

export interface SyncDeps {
  store: SyncStore;
  /** Hinweis an den Nutzer (Telegram/Push). Darf werfen; wird dann geloggt. */
  notify: (userId: string, text: string) => Promise<void>;
  now?: () => Date;
  client?: ClientOptions;
  log?: (msg: string) => void;
}

export interface SyncResult {
  status: "ok" | "expired" | "error";
  rawChanged: number;
  metricsChanged: number;
  activitiesChanged: number;
  backfillDone: boolean;
  error?: string;
}

export const EXPIRED_TEXT =
  "Dein Garmin-Schlüssel ist abgelaufen. So erneuerst du ihn: Garmin Connect (Web) → Personal API Key → neuen Schlüssel erstellen, dann in happen unter Einstellungen → Garmin einfügen.";

const ACTIVITY_LIST_KEYS: (keyof ActivityListFields)[] = [
  "started_at_local", "type", "name", "duration_s", "distance_m", "elevation_gain_m", "avg_hr", "max_hr",
  "hr_zone_s", "training_load", "aerobic_te", "anaerobic_te", "te_label", "avg_cadence",
];
const ACTIVITY_DETAIL_KEYS: (keyof ActivityDetailFields)[] = ["feel", "rpe", "run_s", "walk_s", "hr_sensor"];

/** Ein Sync-Lauf für eine Verbindung. Wirft nicht; Fehler landen in `last_error`. */
export async function syncConnection(conn: Connection, deps: SyncDeps): Promise<SyncResult> {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const result: SyncResult = { status: "ok", rawChanged: 0, metricsChanged: 0, activitiesChanged: 0, backfillDone: !conn.backfill_from };

  // --- Token ---------------------------------------------------------------
  let token: string | null = null;
  const refresh = async (): Promise<string> => {
    const key = await store.readSecret(conn.vault_secret_id);
    if (!key) throw new GarminKeyError(0);
    const t = await fetchToken(key, deps.client);
    if (conn.token_secret_id) await store.updateSecret(conn.token_secret_id, t.token);
    else conn.token_secret_id = await store.createSecret(t.token, `garmin_token_${conn.id}`);
    conn.token_expires_at = t.expiresAt.toISOString();
    await store.updateConnection(conn.id, { token_secret_id: conn.token_secret_id, token_expires_at: conn.token_expires_at });
    token = t.token;
    return t.token;
  };
  const getToken = async (): Promise<string> => {
    if (token) return token;
    const fresh = conn.token_secret_id && conn.token_expires_at &&
      Date.parse(conn.token_expires_at) - now.getTime() > TOKEN_MIN_REMAINING_MS;
    if (fresh) token = await store.readSecret(conn.token_secret_id!);
    return token ?? (await refresh());
  };

  try {
    await getToken();
  } catch (e) {
    if (e instanceof GarminKeyError) return await markExpired(conn, deps, now, result);
    return await markError(conn, deps, now, result, e);
  }

  const client = createGarminClient(getToken, refresh, deps.client);

  try {
    const today = localDate(now, conn.timezone);
    const yesterday = addDays(today, -1);
    const rawRows: RawRow[] = [];
    const stamp = now.toISOString();
    const push = async (kind: RawKind, ref: string, payload: unknown) => {
      if (payload === null || payload === undefined) return;
      rawRows.push({
        user_id: conn.user_id, provider: PROVIDER, kind, ref, payload,
        hash: await sha256(stableStringify(payload)), fetched_at: stamp,
      });
    };

    // --- Heute und gestern -------------------------------------------------
    await fetchDays(client, push, yesterday, today, { sleepAndHrvFor: [today] });

    // --- Nachladen (Backfill) in Blöcken -----------------------------------
    let backfilling = false;
    if (conn.backfill_from) {
      backfilling = true;
      const end = conn.backfill_cursor ? addDays(conn.backfill_cursor, -1) : yesterday;
      if (end >= conn.backfill_from) {
        const startCandidate = addDays(end, -(BACKFILL_CHUNK_DAYS - 1));
        const start = startCandidate < conn.backfill_from ? conn.backfill_from : startCandidate;
        await fetchDays(client, push, start, end, { sleepAndHrvFor: dateRange(start, end) });
        conn.backfill_cursor = start;
      }
      if (!conn.backfill_cursor || conn.backfill_cursor <= conn.backfill_from) {
        conn.backfill_from = null;
        result.backfillDone = true;
      }
    }

    // --- Aktivitäten -------------------------------------------------------
    const oldest = backfilling ? addDays(today, -BACKFILL_DAYS) : null;
    const listItems = await fetchActivityList(client, oldest);
    for (const item of listItems) await push("activity_list", String((item as { activityId: unknown }).activityId), item);

    // --- Rohdaten schreiben (nur Geändertes) -------------------------------
    const changed = await writeChangedRaw(store, conn.user_id, rawRows);
    result.rawChanged = changed.length;

    // --- Aktivitäten aufbereiten ------------------------------------------
    const listIds = listItems.map((i) => String((i as { activityId: unknown }).activityId));
    const touchedActivities = await upsertActivityList(store, conn.user_id, listIds);

    const needDetail = await store.activitiesWithoutDetail(conn.user_id, DETAIL_LIMIT);
    const detailRows: RawRow[] = [];
    for (const id of needDetail) {
      const detail = await client.get(endpoints.activity(id));
      if (detail === null) continue;
      detailRows.push({
        user_id: conn.user_id, provider: PROVIDER, kind: "activity_detail", ref: id, payload: detail,
        hash: await sha256(stableStringify(detail)), fetched_at: stamp,
      });
    }
    const changedDetails = await writeChangedRaw(store, conn.user_id, detailRows);
    result.rawChanged += changedDetails.length;
    const detailTouched = await applyActivityDetails(store, conn.user_id, detailRows, stamp);
    result.activitiesChanged = new Set([...touchedActivities, ...detailTouched].map((a) => a.external_id)).size;

    // --- Tageswerte neu berechnen ------------------------------------------
    const dates = new Set<string>([yesterday, today]);
    for (const r of changed) if (/^\d{4}-\d{2}-\d{2}$/.test(r.ref)) dates.add(r.ref);
    for (const a of touchedActivities) {
      const d = a.started_at_local.slice(0, 10);
      dates.add(d);
      // Läufe über Mitternacht berühren auch den Folgetag.
      if (addDays(d, 1) <= today) dates.add(addDays(d, 1));
    }
    result.metricsChanged = await recomputeDailyMetrics(store, conn, [...dates].sort(), today, stamp);

    const patch: Partial<Connection> = {
      status: "active",
      last_sync_at: stamp,
      last_error: null,
      backfill_from: conn.backfill_from,
      backfill_cursor: conn.backfill_cursor,
    };
    if (result.rawChanged > 0) patch.last_data_at = stamp;
    await store.updateConnection(conn.id, patch);
    return result;
  } catch (e) {
    if (e instanceof GarminKeyError) return await markExpired(conn, deps, now, result);
    return await markError(conn, deps, now, result, e);
  }
}

type Push = (kind: RawKind, ref: string, payload: unknown) => Promise<void>;

async function fetchDays(client: GarminClient, push: Push, from: string, to: string, opts: { sleepAndHrvFor: string[] }) {
  const summaries = splitDailySummaries(await client.get(endpoints.dailySummaries(from, to)));
  for (const [d, s] of summaries) if (d >= from && d <= to) await push("daily_summary", d, s);

  const bb = splitBodyBattery(await client.get(endpoints.bodyBattery(from, to)));
  for (const [d, s] of bb) if (d >= from && d <= to) await push("body_battery", d, s);

  for (const d of dateRange(from, to)) {
    await push("heart_rate", d, await client.get(endpoints.dailyHeartRate(d)));
  }
  for (const d of opts.sleepAndHrvFor) {
    await push("sleep", d, await client.get(endpoints.dailySleep(d)));
    await push("hrv", d, await client.get(endpoints.hrv(d)));
  }
}

/** Neueste Aktivitäten; beim Nachladen seitenweise bis `oldestDate`. */
async function fetchActivityList(client: GarminClient, oldestDate: string | null): Promise<unknown[]> {
  const pageSize = oldestDate ? 100 : 10;
  const out: unknown[] = [];
  for (let start = 0; start < 1000; start += pageSize) {
    const page = await client.get(endpoints.activities(start, pageSize));
    const items = Array.isArray(page) ? page : [];
    out.push(...items.filter((i) => i && (i as { activityId?: unknown }).activityId !== undefined));
    if (!oldestDate || items.length < pageSize) break;
    const last = items.at(-1) as { startTimeLocal?: string } | undefined;
    if (!last?.startTimeLocal || last.startTimeLocal.slice(0, 10) < oldestDate) break;
  }
  if (!oldestDate) return out;
  return out.filter((i) => ((i as { startTimeLocal?: string }).startTimeLocal ?? "").slice(0, 10) >= oldestDate);
}

async function writeChangedRaw(store: SyncStore, userId: string, rows: RawRow[]): Promise<RawRow[]> {
  if (rows.length === 0) return [];
  const kinds = [...new Set(rows.map((r) => r.kind))];
  const refs = [...new Set(rows.map((r) => r.ref))];
  const existing = await store.rawHashes(userId, kinds, refs);
  const changed = rows.filter((r) => existing.get(`${r.kind}:${r.ref}`) !== r.hash);
  if (changed.length) await store.upsertRaw(changed);
  return changed;
}

/** Listenfelder aus den Rohdaten neu aufbauen und nur Geändertes schreiben. */
async function upsertActivityList(store: SyncStore, userId: string, ids: string[]): Promise<ActivityRow[]> {
  if (ids.length === 0) return [];
  const raw = await store.rawForActivities(userId, ids);
  const existing = new Map((await store.activities(userId, ids)).map((a) => [a.external_id, a]));
  const rows: ActivityRow[] = [];
  for (const r of raw) {
    if (r.kind !== "activity_list") continue;
    const fields = transformActivityListItem(r.payload);
    if (!fields) continue;
    const row: ActivityRow = { user_id: userId, provider: PROVIDER, ...fields };
    if (differs(row as unknown as Record<string, unknown>, existing.get(fields.external_id) as Record<string, unknown> | undefined, ACTIVITY_LIST_KEYS)) {
      rows.push(row);
    }
  }
  if (rows.length) await store.upsertActivities(rows);
  return rows;
}

async function applyActivityDetails(store: SyncStore, userId: string, details: RawRow[], stamp: string): Promise<ActivityRow[]> {
  if (details.length === 0) return [];
  const existing = new Map((await store.activities(userId, details.map((d) => d.ref))).map((a) => [a.external_id, a]));
  const rows: ActivityRow[] = [];
  for (const d of details) {
    const base = existing.get(d.ref);
    if (!base) continue; // Detail ohne Listeneintrag: beim nächsten Lauf
    const fields = transformActivityDetail(d.payload);
    rows.push({ ...base, ...fields, detail_fetched_at: stamp });
  }
  if (rows.length) await store.upsertActivities(rows);
  return rows;
}

const METRIC_KEYS: (keyof DailyMetrics)[] = [
  "sleep_start_local", "sleep_end_local", "sleep_minutes", "sleep_score", "deep_min", "rem_min", "light_min",
  "awake_min", "awake_count", "sleep_hr_avg", "sleep_resp_avg", "sleep_stress_avg", "sleep_need_min",
  "sleep_uncertain", "hrv_last_night", "hrv_status", "hrv_baseline_low", "hrv_baseline_high", "resting_hr",
  "bb_wake", "bb_max", "bb_min", "bb_charged", "bb_drained", "steps", "kcal_total", "kcal_active", "stress_avg",
  "stress_high_min", "stress_med_min", "intensity_min_moderate", "intensity_min_vigorous", "evening_hr_avg",
  "wear_hours", "is_complete",
];

/** Baut daily_metrics für die Tage aus den Rohdaten neu und schreibt nur geänderte Zeilen. */
export async function recomputeDailyMetrics(
  store: SyncStore,
  conn: Pick<Connection, "user_id" | "timezone">,
  dates: string[],
  today: string,
  stamp: string,
): Promise<number> {
  if (dates.length === 0) return 0;
  const raw = await store.rawForDates(conn.user_id, dates);
  const byDate = new Map<string, Partial<Record<RawKind, unknown>>>();
  for (const r of raw) {
    const e = byDate.get(r.ref) ?? {};
    e[r.kind] = r.payload;
    byDate.set(r.ref, e);
  }
  const acts = await store.activitiesBetween(conn.user_id, addDays(dates[0], -1) + "T00:00:00", addDays(dates.at(-1)!, 1) + "T00:00:00");
  const existing = new Map((await store.dailyMetrics(conn.user_id, dates)).map((m) => [String(m.date).slice(0, 10), m]));

  const rows: DailyRow[] = [];
  for (const date of dates) {
    const r = byDate.get(date);
    if (!r) continue; // keine Daten für diesen Tag (noch nicht synchronisiert)
    const metrics = buildDailyMetrics({
      date,
      today,
      timeZone: conn.timezone,
      summary: r.daily_summary,
      sleep: r.sleep,
      hrv: r.hrv,
      heartRate: r.heart_rate,
      bodyBattery: r.body_battery,
      activities: activitiesOnDate(acts, date),
    });
    if (differs(metrics as unknown as Record<string, unknown>, existing.get(date) as unknown as Record<string, unknown> | undefined, METRIC_KEYS)) {
      rows.push({ ...metrics, user_id: conn.user_id, updated_at: stamp });
    }
  }
  if (rows.length) await store.upsertDailyMetrics(rows);
  return rows.length;
}

async function markExpired(conn: Connection, deps: SyncDeps, now: Date, result: SyncResult): Promise<SyncResult> {
  const patch: Partial<Connection> = { status: "expired", last_error: "api key rejected", last_sync_at: now.toISOString() };
  if (!conn.expired_notified_at) {
    try {
      await deps.notify(conn.user_id, EXPIRED_TEXT);
    } catch (e) {
      deps.log?.(`notify failed: ${(e as Error).message}`);
    }
    patch.expired_notified_at = now.toISOString();
  }
  await deps.store.updateConnection(conn.id, patch);
  return { ...result, status: "expired" };
}

async function markError(conn: Connection, deps: SyncDeps, now: Date, result: SyncResult, e: unknown): Promise<SyncResult> {
  const message = sanitizeError(e);
  deps.log?.(`garmin sync failed for ${conn.user_id}: ${message}`);
  await deps.store.updateConnection(conn.id, { last_error: message, last_sync_at: now.toISOString() });
  return { ...result, status: "error", error: message };
}

/** Fehlermeldungen kommen aus unserem eigenen Code; Bearer/ApiKey-Werte zur Sicherheit trotzdem entfernen. */
export function sanitizeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/(ApiKey|Bearer)\s+\S+/gi, "$1 ***").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "***").slice(0, 500);
}
