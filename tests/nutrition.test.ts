// Ausführen: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseTdee,
  dailyBudget,
  localDate,
  localTime,
  mifflinBmr,
  MIN_DAILY_KCAL,
  parseProfile,
  parseWeight,
  runKcalGross,
  trendSeries,
  weeklyRate,
} from "../supabase/functions/_shared/nutrition.ts";

test("parseWeight erkennt typische Eingaben", () => {
  assert.equal(parseWeight("102"), 102);
  assert.equal(parseWeight("101,4"), 101.4);
  assert.equal(parseWeight("101.4 kg"), 101.4);
  assert.equal(parseWeight("/gewicht 99,8"), 99.8);
  assert.equal(parseWeight("w 100"), 100);
  assert.equal(parseWeight("2 Brötchen"), null);
  assert.equal(parseWeight("12 km gelaufen"), null);
  assert.equal(parseWeight("15"), null); // außerhalb des plausiblen Bereichs
  assert.equal(parseWeight("1000"), null);
});

test("parseProfile", () => {
  assert.deepEqual(parseProfile("/profil 176 1985 m"), { heightCm: 176, birthYear: 1985, sex: "m" });
  assert.equal(parseProfile("/profil 176 m"), null);
  assert.equal(parseProfile("/profil 999 1985 m"), null);
});

test("Mifflin-St-Jeor: 102 kg, 176 cm, 40 Jahre, m", () => {
  // 10·102 + 6,25·176 − 5·40 + 5 = 1925
  assert.equal(mifflinBmr(102, 176, 40, "m"), 1925);
});

test("Tagesbudget respektiert Untergrenze und Laufgutschrift", () => {
  const tdee = baseTdee({ heightCm: 176, birthYear: 1986, sex: "m", goalKgPerWeek: 0.4 }, 102, new Date("2026-11-04"))!;
  assert.equal(tdee, Math.round(1925 * 1.35));
  const rest = dailyBudget(tdee, 0.4, 0);
  assert.equal(rest, Math.round(tdee - 440));
  const runDay = dailyBudget(tdee, 0.4, runKcalGross(102, 10));
  assert.equal(runDay - rest, 510); // Hälfte von 1020 kcal
  assert.equal(dailyBudget(1600, 1, 0), MIN_DAILY_KCAL);
});

test("Trend dämpft einen Wochenend-Ausreißer (100 → 105 → 102)", () => {
  const s = trendSeries([
    { date: "2026-10-26", kg: 100.0 },
    { date: "2026-11-02", kg: 105.0 },
    { date: "2026-11-04", kg: 102.0 },
  ]);
  const last = s.at(-1)!;
  // Der Trend bewegt sich nur wenig, obwohl die Waage +5 kg zeigte.
  assert.ok(last.trend > 100 && last.trend < 102, `trend=${last.trend}`);
});

test("weeklyRate erkennt 0,5 kg/Woche Abnahme trotz Rauschen", () => {
  const pts = Array.from({ length: 28 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
    const noise = [0.6, -0.4, 0.2, -0.7, 0.5, -0.1, 0.3][i % 7];
    return { date, kg: 102 - (0.5 / 7) * i + noise };
  });
  const rate = weeklyRate(trendSeries(pts))!;
  assert.ok(rate < -0.3 && rate > -0.7, `rate=${rate}`);
});

test("weeklyRate braucht genug Daten", () => {
  assert.equal(weeklyRate(trendSeries([{ date: "2026-11-01", kg: 100 }, { date: "2026-11-02", kg: 100 }])), null);
});

test("lokales Datum und Uhrzeit in Europe/Berlin", () => {
  const d = new Date("2026-11-04T23:30:00Z"); // 00:30 am 5.11. in Berlin (MEZ)
  assert.equal(localDate(d, "Europe/Berlin"), "2026-11-05");
  assert.deepEqual(localTime(d, "Europe/Berlin"), { hour: 0, minute: 30, weekday: 4 });
});
