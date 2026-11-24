// Ausführen: node --test tests/*.test.ts
// KI-Coach mit gefälschter Messages API: prüft Werkzeuge, Karten aus echten Daten und Grenzen. Kein Netz.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type CoachData, CoachUnavailable, executeTool, MAX_ROUNDS, normalizeTag, runCoachAgent, TOOLS, type ToolContext,
} from "../supabase/functions/web-chat/coach-agent.ts";
import { looksLikeQuestion } from "../supabase/functions/web-chat/question.ts";

const TODAY = "2026-11-24";

function day(date: string, hrv: number, extra: Record<string, unknown> = {}) {
  return {
    date, hrv_last_night: hrv, sleep_hr_avg: 52, sleep_resp_avg: 15.5, bb_wake: 80, sleep_minutes: 450,
    evening_hr_avg: 70, sleep_score: 80, stress_high_min: 30, sleep_end_local: `${date}T06:30:00`, sleep_uncertain: false,
    hrv_baseline_low: null, hrv_baseline_high: null, wear_hours: 23, resting_hr: 48, ...extra,
  };
}

function fakeData(): CoachData & { saved: unknown[] } {
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.parse(TODAY + "T12:00:00Z") - (29 - i) * 86_400_000).toISOString().slice(0, 10);
    return day(d, d === TODAY ? 84 : 55 + (i % 7) * 3);
  });
  const saved: unknown[] = [];
  return {
    saved,
    async days(from, to) {
      return days.filter((d) => d.date >= from && d.date <= to) as never;
    },
    async activities() {
      return [{
        external_id: "r1", started_at_local: "2026-11-22T09:30:00", type: "running", name: "Lauf", duration_s: 5160,
        distance_m: 11600, avg_hr: 155, analysis: { verdict: "late_surge", headline: "Ab Minute 43 zu schnell geworden", share_below_cap: 0.41, surge: { detected: true, from_min: 43, peak_hr: 171 } },
      }];
    },
    async meals() {
      return [{ eaten_at_local: "2026-11-24T07:30", title: "Shake", kcal_low: 410, kcal_mid: 490, kcal_high: 565, protein_g: 28 }];
    },
    async weights() {
      return [{ measured_on: TODAY, kg: 83.4 }];
    },
    async notes() {
      return [{ date: "2026-11-23", tag: "shisha", text: "Shisha", source: "question" }];
    },
    async briefing() {
      return null;
    },
    async easyHrCap() {
      return 145;
    },
    async saveNote(date, tag, text) {
      saved.push({ date, tag, text });
      return 3;
    },
  };
}

function ctx(data: CoachData): ToolContext {
  return { data, today: TODAY, cards: [] };
}

test("Werkzeuge: strikte Schemas ohne Zusatzfelder", () => {
  for (const t of TOOLS) {
    assert.equal(t.strict, true, t.name);
    assert.equal((t.input_schema as { additionalProperties?: boolean }).additionalProperties, false, t.name);
  }
});

test("tage: Werte und Normalbereich aus echten Daten, Zeitraum begrenzt", async () => {
  const out = await executeTool("tage", { von: "2025-01-01", bis: "2027-01-01" }, ctx(fakeData())) as {
    tage: { datum: string; hrv: number }[]; normalbereich: Record<string, { low: number; high: number }>;
  };
  assert.ok(out.tage.length <= 92);
  assert.equal(out.tage.at(-1)!.datum, TODAY); // nicht in die Zukunft
  assert.equal(out.tage.at(-1)!.hrv, 84);
  assert.ok(out.normalbereich.hrv_last_night);
  const bad = await executeTool("tage", { von: "gestern", bis: TODAY }, ctx(fakeData()));
  assert.ok((bad as { fehler?: string }).fehler);
});

test("karte_kennzahl: Karte mit echtem Wert und Band, keine erfundenen Zahlen", async () => {
  const c = ctx(fakeData());
  const out = await executeTool("karte_kennzahl", { kennzahl: "hrv_last_night", datum: TODAY }, c) as { wert: number };
  assert.equal(out.wert, 84);
  assert.equal(c.cards.length, 1);
  const card = c.cards[0] as { type: string; items: { value: number; low: number; high: number }[] };
  assert.equal(card.type, "metric_compare");
  assert.equal(card.items[0].value, 84);
  assert.ok(card.items[0].low < card.items[0].high);
  // unbekannte Kennzahl
  assert.ok((await executeTool("karte_kennzahl", { kennzahl: "vo2max", datum: TODAY }, c) as { fehler?: string }).fehler);
});

test("karte_lauf, karte_tabelle, antwort_chips: Grenzen", async () => {
  const c = ctx(fakeData());
  await executeTool("karte_lauf", { activity_id: "r1" }, c);
  assert.equal(c.cards.filter((x) => x.type === "run_card").length, 1);
  assert.ok((await executeTool("karte_lauf", { activity_id: "nope" }, c) as { fehler?: string }).fehler);
  const rows = Array.from({ length: 8 }, (_, i) => ({ label: `Z${i}`, wert: String(i), hinweis: "" }));
  await executeTool("karte_tabelle", { titel: "Woche", zeilen: rows }, c);
  const table = c.cards.find((x) => x.type === "table") as { rows: unknown[] };
  assert.equal(table.rows.length, 5);
  assert.equal((await executeTool("antwort_chips", { optionen: ["nur eine"] }, c) as { angezeigt: boolean }).angezeigt, false);
  await executeTool("antwort_chips", { optionen: ["a", "b", "c", "d", "e"] }, c);
  assert.equal((c.cards.find((x) => x.type === "chips") as { options: string[] }).options.length, 4);
});

test("notiz_speichern: nur letzte 14 Tage, nicht in der Zukunft", async () => {
  const data = fakeData();
  const ok = await executeTool("notiz_speichern", { datum: "2026-11-23", stichwort: "Shisha", text: "gestern Shisha" }, ctx(data));
  assert.equal((ok as { anzahl_diesen_monat: number }).anzahl_diesen_monat, 3);
  assert.equal(data.saved.length, 1);
  assert.ok((await executeTool("notiz_speichern", { datum: "2026-12-01", stichwort: "x", text: "" }, ctx(data)) as { fehler?: string }).fehler);
  assert.ok((await executeTool("notiz_speichern", { datum: "2026-10-01", stichwort: "x", text: "" }, ctx(data)) as { fehler?: string }).fehler);
  assert.equal(data.saved.length, 1);
});

// --- Schleife mit gefälschter API --------------------------------------------
type Fake = { calls: Record<string, unknown>[]; create: (p: unknown) => Promise<never> };
function fakeApi(responses: unknown[]): Fake {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    create: async (p: unknown) => {
      calls.push(JSON.parse(JSON.stringify(p)));
      const next = responses.shift();
      if (!next) throw new Error("keine Antwort mehr");
      return next as never;
    },
  };
}
const toolUse = (id: string, name: string, input: unknown) => ({
  stop_reason: "tool_use",
  content: [{ type: "text", text: "Ich schaue nach." }, { type: "tool_use", id, name, input }],
});
const final = (text: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });

test("Schleife: Werkzeug, Karte, Antwort; Datum steht in der Nachricht, nicht im System-Prompt", async () => {
  const api = fakeApi([
    toolUse("t1", "karte_kennzahl", { kennzahl: "hrv_last_night", datum: TODAY }),
    final("Gut geschlafen: HRV 84 (normal 55–69)."),
  ]);
  const answer = await runCoachAgent(api.create, fakeData(), {
    question: "Wie war meine Nacht im Vergleich?", today: TODAY, localNow: "Dienstag, 24.11.2026, 07:40",
    history: [{ role: "user", text: "Hallo" }, { role: "assistant", text: "Hi!" }],
  });
  assert.match(answer.message, /HRV 84/);
  assert.equal(answer.cards[0].type, "metric_compare");
  const first = api.calls[0] as { system: string; messages: { role: string; content: unknown }[]; model: string; fallbacks: string };
  assert.equal(first.model, "claude-opus-5-5");
  assert.equal(first.fallbacks, "default");
  assert.ok(!first.system.includes("2026"));
  assert.equal(first.messages[0].role, "user");
  assert.match(String(first.messages.at(-1)!.content), /heute = 2026-11-24/);
  // Zweiter Aufruf enthält das Werkzeug-Ergebnis
  const second = api.calls[1] as { messages: { role: string; content: { type: string; tool_use_id?: string }[] }[] };
  assert.equal(second.messages.at(-1)!.content[0].tool_use_id, "t1");
});

test("Schleife: Ablehnung und Endlosschleife werden zu CoachUnavailable", async () => {
  const refused = fakeApi([{ stop_reason: "refusal", content: [] }]);
  await assert.rejects(runCoachAgent(refused.create, fakeData(), { question: "?", today: TODAY, localNow: "", history: [] }), CoachUnavailable);
  const loop = fakeApi(Array.from({ length: MAX_ROUNDS + 1 }, (_, i) => toolUse(`t${i}`, "gewicht", { von: TODAY, bis: TODAY })));
  await assert.rejects(runCoachAgent(loop.create, fakeData(), { question: "?", today: TODAY, localNow: "", history: [] }), CoachUnavailable);
  assert.equal(loop.calls.length, MAX_ROUNDS);
});

test("Schleife: kaputtes Werkzeug liefert is_error statt Abbruch", async () => {
  const data = fakeData();
  data.weights = async () => {
    throw new Error("db down");
  };
  const api = fakeApi([toolUse("t1", "gewicht", { von: TODAY, bis: TODAY }), final("Dazu habe ich gerade keine Daten.")]);
  const answer = await runCoachAgent(api.create, data, { question: "Mein Gewicht?", today: TODAY, localNow: "", history: [] });
  assert.match(answer.message, /keine Daten/);
  const result = (api.calls[1] as { messages: { content: { is_error?: boolean }[] }[] }).messages.at(-1)!.content[0];
  assert.equal(result.is_error, true);
});

test("normalizeTag: bekanntes Stichwort in der Schreibweise der Liste, Fehler → null", async () => {
  const api = fakeApi([final(JSON.stringify({ stichwort: "shisha", bekannt: true }))]);
  assert.equal(await normalizeTag(api.create, "Wasserpfeife geraucht", []), "Shisha");
  const fresh = fakeApi([final(JSON.stringify({ stichwort: "Sauna", bekannt: false }))]);
  assert.equal(await normalizeTag(fresh.create, "war in der Sauna", []), "Sauna");
  const broken = fakeApi([final("kein json")]);
  assert.equal(await normalizeTag(broken.create, "x", []), null);
});

test("looksLikeQuestion", () => {
  assert.equal(looksLikeQuestion("Warum schlafe ich nach Lauftagen schlechter?"), true);
  assert.equal(looksLikeQuestion("lohnt sich der lange lauf morgen"), true);
  assert.equal(looksLikeQuestion("2 Brezen mit Butter"), false);
  assert.equal(looksLikeQuestion("Spaghetti Bolognese"), false);
});
