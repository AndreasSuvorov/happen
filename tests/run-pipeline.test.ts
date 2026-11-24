// Ausführen: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePendingRuns, needsAnalysis, type RunCandidate, type RunStore, type StoredAnalysis } from "../supabase/functions/_shared/run/pipeline.ts";
import { ANALYSIS_VERSION } from "../supabase/functions/_shared/run/types.ts";

function run(id: string, start: string, extra: Partial<RunCandidate> = {}): RunCandidate {
  return {
    external_id: id, type: "running", started_at_local: start, duration_s: 2400, distance_m: 6000,
    avg_hr: 139, max_hr: 150, hr_sensor: "wrist", analysis: null, ...extra,
  };
}

function fakeStore(runs: RunCandidate[], opts: { cap?: number; speeds?: [string, number][] } = {}) {
  const saved = new Map<string, StoredAnalysis>();
  const store: RunStore = {
    async recentRuns() {
      return runs;
    },
    async easyHrCap() {
      return opts.cap ?? 145;
    },
    async treadmillSpeeds() {
      return new Map(opts.speeds ?? []);
    },
    async saveAnalysis(_u, id, a) {
      saved.set(id, a);
    },
  };
  return { store, saved };
}

test("pipeline: neue Läufe ohne FIT werden vorsichtig geurteilt und gespeichert", async () => {
  const { store, saved } = fakeStore([run("b", "2026-11-24T07:00:00"), run("a", "2026-11-20T07:00:00")]);
  const fetched: string[] = [];
  const result = await analyzePendingRuns("u1", "2026-11-24", store, async (id) => {
    fetched.push(id);
    return null;
  });
  assert.deepEqual(result.analyzed, ["b", "a"]);
  assert.equal(result.fresh.length, 2);
  assert.deepEqual(fetched, ["b", "a"]);
  const b = saved.get("b")!;
  assert.equal(b.version, ANALYSIS_VERSION);
  assert.equal(b.input_cap, 145);
  assert.ok(b.notes.includes("no_fit"));
  assert.equal(b.hr_series.length, 0);
});

test("pipeline: kaputte FIT-Datei bricht nicht ab", async () => {
  const { store, saved } = fakeStore([run("x", "2026-11-24T07:00:00")]);
  const logs: string[] = [];
  await analyzePendingRuns("u1", "2026-11-24", store, async () => new Uint8Array([1, 2, 3, 4, 5]), { log: (m) => logs.push(m) });
  assert.ok(saved.has("x"));
});

test("pipeline: höchstens `limit` Läufe pro Durchgang, Nicht-Läufe werden übersprungen", async () => {
  const runs = [
    run("k", "2026-11-24T18:00:00", { type: "strength_training" }),
    run("r1", "2026-11-24T07:00:00"),
    run("r2", "2026-11-23T07:00:00"),
    run("r3", "2026-11-22T07:00:00"),
  ];
  const { store } = fakeStore(runs);
  const result = await analyzePendingRuns("u1", "2026-11-24", store, async () => null, { limit: 2 });
  assert.deepEqual(result.analyzed, ["r1", "r2"]);
});

test("needsAnalysis: Version, Pulsgrenze und nachgetragene Laufband-Geschwindigkeit", () => {
  const base = { version: ANALYSIS_VERSION, input_cap: 145, input_kmh: null } as unknown as StoredAnalysis;
  assert.equal(needsAnalysis(run("a", "2026-11-24T07:00:00"), 145, null), true);
  assert.equal(needsAnalysis(run("a", "2026-11-24T07:00:00", { analysis: base }), 145, null), false);
  assert.equal(needsAnalysis(run("a", "2026-11-24T07:00:00", { analysis: base }), 140, null), true);
  assert.equal(needsAnalysis(run("a", "2026-11-24T07:00:00", { analysis: { ...base, version: 0 } }), 145, null), true);
  const tm = run("t", "2026-11-24T07:00:00", { type: "treadmill_running", analysis: base });
  assert.equal(needsAnalysis(tm, 145, null), false);
  assert.equal(needsAnalysis(tm, 145, 7.5), true);
});

test("pipeline: bestehende Analyse wird nicht neu gerechnet und nicht als neu gemeldet", async () => {
  const done = { version: ANALYSIS_VERSION, input_cap: 145, input_kmh: null } as unknown as StoredAnalysis;
  const { store } = fakeStore([run("a", "2026-11-24T07:00:00", { analysis: done })]);
  const result = await analyzePendingRuns("u1", "2026-11-24", store, async () => {
    throw new Error("darf nicht laden");
  });
  assert.deepEqual(result.analyzed, []);
});

test("pipeline: Laufband mit nachgetragener Geschwindigkeit wird neu gerechnet, aber nicht als neu gemeldet", async () => {
  const done = { version: ANALYSIS_VERSION, input_cap: 145, input_kmh: null } as unknown as StoredAnalysis;
  const { store, saved } = fakeStore(
    [run("t", "2026-11-24T07:00:00", { type: "treadmill_running", analysis: done })],
    { speeds: [["2026-11-24", 7.5]] },
  );
  const result = await analyzePendingRuns("u1", "2026-11-24", store, async () => null);
  assert.deepEqual(result.analyzed, ["t"]);
  assert.equal(result.fresh.length, 0);
  assert.equal(saved.get("t")!.input_kmh, 7.5);
});
