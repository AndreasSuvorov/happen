// Sync-Logik gegen einen Fake-Garmin-Server und einen In-Memory-Store.
// Prüft die Abnahmekriterien von M1 (docs/wiki/Coach-Plan.md, Abschnitt 11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGarminClient, fetchToken, GarminKeyError, jwtExpiry } from "../supabase/functions/_shared/garmin/client.ts";
import {
  EXPIRED_TEXT,
  sanitizeError,
  syncConnection,
  type ActivityRow,
  type Connection,
  type DailyRow,
  type RawRow,
  type SyncStore,
} from "../supabase/functions/_shared/garmin/sync.ts";
import { addDays, dateRange } from "../supabase/functions/_shared/garmin/transform.ts";

const NOW = new Date("2026-11-23T08:00:00Z"); // 09:00 in Berlin
const TODAY = "2026-11-23";

function makeJwt(expSec: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: expSec, iat: expSec - 86400 })}.sig`;
}
const TOKEN = makeJwt(Math.floor(NOW.getTime() / 1000) + 86400);

// ---------------------------------------------------------------------------
// Fake-Garmin: deterministische Daten für jeden Tag
// ---------------------------------------------------------------------------
function fakeGarmin(opts: { keyValid?: boolean } = {}) {
  const calls: string[] = [];
  const L = (d: string, h: number, m: number) => Date.parse(`${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const activities = [5, 12, 20, 26].map((ago, i) => ({
    activityId: 30000000000 + i,
    startTimeLocal: `${addDays(TODAY, -ago)} 07:00:00`,
    activityType: { typeKey: i % 2 ? "running" : "treadmill_running" },
    duration: 2400, distance: 6000, averageHR: 140, maxHR: 155,
    hrTimeInZone_1: 100, hrTimeInZone_2: 2000, hrTimeInZone_3: 300, hrTimeInZone_4: 0, hrTimeInZone_5: 0,
  }));
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    calls.push(path + url.search);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path.endsWith("/personal-api-key/token")) {
      assert.equal(init?.method, "POST");
      return opts.keyValid === false ? new Response("", { status: 401 }) : new Response(TOKEN, { status: 200 });
    }
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
    const range = (from: string, to: string) => dateRange(from, to).filter((d) => d <= TODAY);
    if (path.includes("/v2/dailysummaries")) {
      return ok({ data: range(url.searchParams.get("startDate")!, url.searchParams.get("endDate")!).map((d) => ({
        calendarDate: d, movement: { steps: { value: 8000 } }, heartRate: { restingValue: 48 },
        calories: { burnedTotal: 2600, burnedActive: 500 },
        stress: { avgLevel: 25, highStressDurationInMillis: 600000, mediumStressDurationInMillis: 1200000,
                  totalDurationInMillis: d === TODAY ? 30000000 : 82800000 },
        bodyBattery: { minValue: 20, maxValue: 90, chargedValue: 60, drainedValue: 65 },
        intensityMinutes: { moderate: 10, vigorous: 20 },
      })) });
    }
    if (path.includes("/bodyBattery/reports/daily")) {
      return ok(range(url.searchParams.get("startDate")!, url.searchParams.get("endDate")!).map((d) => ({
        date: d, charged: 60, drained: 65, bodyBatteryValuesArray: [[Date.parse(`${d}T06:00:00Z`), 85]],
      })));
    }
    if (path.includes("/dailySleep")) {
      const d = url.searchParams.get("date")!;
      return ok({ dailySleepDTO: { calendarDate: d, sleepTimeSeconds: 27000,
        sleepStartTimestampLocal: L(addDays(d, -1), 22, 30), sleepEndTimestampLocal: L(d, 6, 0),
        avgHeartRate: 52, averageRespirationValue: 16, sleepScores: { overall: { value: 80 } } } });
    }
    if (path.startsWith("/hrv-service/hrv/")) {
      return ok({ hrvSummary: { lastNightAvg: 66, status: "BALANCED", baseline: { balancedLow: 50, balancedUpper: 73 } } });
    }
    if (path.includes("/dailyHeartRate")) {
      const d = url.searchParams.get("date")!;
      const start = Date.parse(`${d}T00:00:00Z`) - 3600000; // Berlin UTC+1
      return ok({ restingHeartRate: 48, heartRateValues: Array.from({ length: 720 }, (_, i) => [start + i * 120000, 65]) });
    }
    if (path.includes("/activities/search/activities")) {
      const start = Number(url.searchParams.get("start"));
      const limit = Number(url.searchParams.get("limit"));
      return ok(activities.slice(start, start + limit));
    }
    if (path.startsWith("/activity-service/activity/")) {
      return ok({ summaryDTO: { directWorkoutFeel: 75, directWorkoutRpe: 30 }, splitSummaries: [], metadataDTO: { sensors: [] } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

// ---------------------------------------------------------------------------
// In-Memory-Store
// ---------------------------------------------------------------------------
function memoryStore(conn: Connection) {
  const secrets = new Map<string, string>([[conn.vault_secret_id, "personal-api-key-xyz"]]);
  const raw = new Map<string, RawRow>();
  const acts = new Map<string, ActivityRow>();
  const metrics = new Map<string, DailyRow>();
  let writes = 0;
  let n = 0;
  const store: SyncStore = {
    async readSecret(id) { return secrets.get(id) ?? null; },
    async createSecret(v) { const id = `secret-${++n}`; secrets.set(id, v); return id; },
    async updateSecret(id, v) { secrets.set(id, v); },
    async updateConnection(_id, patch) { Object.assign(conn, patch); },
    async rawHashes(_u, kinds, refs) {
      const m = new Map<string, string>();
      for (const r of raw.values()) if (kinds.includes(r.kind) && refs.includes(r.ref)) m.set(`${r.kind}:${r.ref}`, r.hash);
      return m;
    },
    async upsertRaw(rows) { writes += rows.length; for (const r of rows) raw.set(`${r.kind}:${r.ref}`, structuredClone(r)); },
    async rawForDates(_u, dates) { return [...raw.values()].filter((r) => dates.includes(r.ref)); },
    async rawForActivities(_u, ids) {
      return [...raw.values()].filter((r) => (r.kind === "activity_list" || r.kind === "activity_detail") && ids.includes(r.ref));
    },
    async activities(_u, ids) { return ids.map((id) => acts.get(id)).filter(Boolean).map((a) => structuredClone(a!)); },
    async activitiesBetween(_u, from, to) {
      return [...acts.values()].filter((a) => a.started_at_local >= from && a.started_at_local < to);
    },
    async activitiesWithoutDetail(_u, limit) {
      return [...acts.values()].filter((a) => !a.detail_fetched_at)
        .sort((a, b) => b.started_at_local.localeCompare(a.started_at_local)).slice(0, limit).map((a) => a.external_id);
    },
    async upsertActivities(rows) {
      writes += rows.length;
      for (const r of rows) acts.set(r.external_id, { ...(acts.get(r.external_id) ?? {}), ...structuredClone(r) });
    },
    async dailyMetrics(_u, dates) { return dates.map((d) => metrics.get(d)).filter(Boolean).map((m) => structuredClone(m!)); },
    async upsertDailyMetrics(rows) { writes += rows.length; for (const r of rows) metrics.set(r.date, structuredClone(r)); },
  };
  return { store, secrets, raw, acts, metrics, writes: () => writes };
}

function newConnection(): Connection {
  return {
    id: "conn-1", user_id: "user-1", vault_secret_id: "key-secret", token_secret_id: null, token_expires_at: null,
    status: "active", last_sync_at: null, last_data_at: null, last_error: null,
    backfill_from: addDays(TODAY, -28), backfill_cursor: null, timezone: "Europe/Berlin", expired_notified_at: null,
  };
}

const noSleep = async () => {};

test("Verbinden: nach dem Backfill stehen 28 Tage daily_metrics und alle Aktivitäten in der Datenbank", async () => {
  const conn = newConnection();
  const mem = memoryStore(conn);
  const garmin = fakeGarmin();
  const notes: string[] = [];
  const deps = { store: mem.store, notify: async (_u: string, t: string) => { notes.push(t); }, now: () => NOW,
    client: { fetchFn: garmin.fetchFn, sleep: noSleep } };

  const r1 = await syncConnection(conn, deps);
  assert.equal(r1.status, "ok");
  assert.equal(r1.backfillDone, false);
  assert.equal(conn.backfill_cursor, addDays(TODAY, -14));

  const r2 = await syncConnection(conn, deps);
  assert.equal(r2.status, "ok");
  assert.equal(r2.backfillDone, true);
  assert.equal(conn.backfill_from, null);

  // 28 Tage zurück plus heute
  const dates = [...mem.metrics.keys()].sort();
  assert.equal(dates[0], addDays(TODAY, -28));
  assert.equal(dates.at(-1), TODAY);
  assert.equal(dates.length, 29);
  for (const d of dates.slice(0, -1)) {
    const m = mem.metrics.get(d)!;
    assert.equal(m.sleep_minutes, 450, `Schlaf fehlt am ${d}`);
    assert.equal(m.hrv_last_night, 66);
    assert.equal(m.is_complete, true);
    assert.equal(m.evening_hr_avg, 65);
  }
  assert.equal(mem.metrics.get(TODAY)!.is_complete, false);

  // alle Aktivitäten inkl. Details
  assert.equal(mem.acts.size, 4);
  for (const a of mem.acts.values()) {
    assert.ok(a.detail_fetched_at);
    assert.equal(a.feel, 75);
    assert.equal(a.hr_sensor, "wrist");
  }

  // Token liegt im (Fake-)Vault, nicht in der Verbindung
  assert.ok(conn.token_secret_id);
  assert.equal(mem.secrets.get(conn.token_secret_id!), TOKEN);
  assert.equal(notes.length, 0);
});

test("Ein weiterer Sync-Lauf ändert nichts", async () => {
  const conn = newConnection();
  const mem = memoryStore(conn);
  const garmin = fakeGarmin();
  const deps = { store: mem.store, notify: async () => {}, now: () => NOW, client: { fetchFn: garmin.fetchFn, sleep: noSleep } };
  await syncConnection(conn, deps);
  await syncConnection(conn, deps);

  const before = { writes: mem.writes(), metrics: structuredClone([...mem.metrics.entries()]), acts: structuredClone([...mem.acts.entries()]) };
  const tokenCalls = garmin.calls.filter((c) => c.includes("/token")).length;
  const r = await syncConnection(conn, deps);
  assert.equal(r.status, "ok");
  assert.equal(r.rawChanged, 0);
  assert.equal(r.metricsChanged, 0);
  assert.equal(r.activitiesChanged, 0);
  assert.equal(mem.writes(), before.writes);
  assert.deepEqual([...mem.metrics.entries()], before.metrics);
  assert.deepEqual([...mem.acts.entries()], before.acts);
  // zwischengespeicherter Token wird wiederverwendet
  assert.equal(garmin.calls.filter((c) => c.includes("/token")).length, tokenCalls);
});

test("Ungültiger Schlüssel: status = expired und genau ein Hinweis", async () => {
  const conn = newConnection();
  const mem = memoryStore(conn);
  const garmin = fakeGarmin({ keyValid: false });
  const notes: string[] = [];
  const deps = { store: mem.store, notify: async (_u: string, t: string) => { notes.push(t); }, now: () => NOW,
    client: { fetchFn: garmin.fetchFn, sleep: noSleep } };

  const r1 = await syncConnection(conn, deps);
  assert.equal(r1.status, "expired");
  assert.equal(conn.status, "expired");
  const r2 = await syncConnection(conn, deps);
  assert.equal(r2.status, "expired");
  assert.deepEqual(notes, [EXPIRED_TEXT]);
  assert.equal(mem.metrics.size, 0);
  assert.ok(!(conn.last_error ?? "").includes("personal-api-key"));
});

test("Client: Backoff bei 429/5xx mit 2, 4, 8 s und höchstens 4 Versuchen", async () => {
  const waits: number[] = [];
  let n = 0;
  const fetchFn = (async () => (++n < 3 ? new Response("", { status: n === 1 ? 429 : 503 }) : new Response("[]"))) as typeof fetch;
  const client = createGarminClient(async () => "t", async () => "t", { fetchFn, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await client.get("/x"), []);
  assert.deepEqual(waits, [2000, 4000]);

  n = 0;
  waits.length = 0;
  const always = (async () => { n++; return new Response("", { status: 500 }); }) as typeof fetch;
  const c2 = createGarminClient(async () => "t", async () => "t", { fetchFn: always, sleep: async (ms) => { waits.push(ms); } });
  await assert.rejects(c2.get("/x"), /500/);
  assert.equal(n, 4);
  assert.deepEqual(waits, [2000, 4000, 8000]);
});

test("Client: 404 = noch keine Daten, 401 erneuert den Token einmal", async () => {
  const seen: string[] = [];
  const fetchFn = (async (_u: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).Authorization;
    seen.push(auth);
    if (auth === "Bearer old") return new Response("", { status: 401 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const client = createGarminClient(async () => "old", async () => "new", { fetchFn, sleep: noSleep });
  assert.equal(await client.get("/sleep"), null);
  assert.deepEqual(seen, ["Bearer old", "Bearer new"]);
});

test("Token: 404 (Schlüssel bei Garmin unbekannt) → GarminKeyError", async () => {
  const gone = async () => new Response('{"error":"NOT_FOUND","status":404}', { status: 404 });
  await assert.rejects(fetchToken("k", { fetchFn: gone as typeof fetch, sleep: async () => {} }), GarminKeyError);
});

test("Token: Antwort ist der JWT als Text, 401 → GarminKeyError", async () => {
  const ok = (async () => new Response(TOKEN)) as typeof fetch;
  const t = await fetchToken("k", { fetchFn: ok, sleep: noSleep });
  assert.equal(t.token, TOKEN);
  assert.equal(t.expiresAt.getTime(), jwtExpiry(TOKEN)!.getTime());
  const bad = (async () => new Response("", { status: 403 })) as typeof fetch;
  await assert.rejects(fetchToken("k", { fetchFn: bad, sleep: noSleep }), GarminKeyError);
});

test("Fehlermeldungen enthalten keine Schlüssel oder Token", () => {
  assert.equal(sanitizeError(new Error(`bad Authorization: Bearer ${TOKEN}`)), "bad Authorization: Bearer ***");
  assert.equal(sanitizeError(new Error("ApiKey abc123 rejected")), "ApiKey *** rejected");
});
