import Anthropic from "npm:@anthropic-ai/sdk@1.4.0";

export const MODEL = "claude-opus-5-5";

export interface EstimateItem {
  name: string;
  grams_low: number;
  grams_high: number;
  kcal_low: number;
  kcal_high: number;
}

export interface QuestionOption {
  label: string;
  kcal_low: number;
  kcal_mid: number;
  kcal_high: number;
}

export interface Estimate {
  kind: "food" | "activity" | "other";
  reply_text: string;
  title: string;
  meal: "breakfast" | "lunch" | "dinner" | "snack" | "drink";
  items: EstimateItem[];
  kcal_low: number;
  kcal_mid: number;
  kcal_high: number;
  protein_g: number;
  confidence: "hoch" | "mittel" | "niedrig";
  day_offset: number;
  time_hint: string;
  note: string;
  question: { text: string; options: QuestionOption[] };
  activity: { type: string; distance_km: number; duration_min: number };
}

const int = { type: "integer" };
const str = { type: "string" };
const num = { type: "number" };

function obj(properties: Record<string, unknown>) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

const SCHEMA = obj({
  kind: { type: "string", enum: ["food", "activity", "other"] },
  reply_text: str,
  title: str,
  meal: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack", "drink"] },
  items: {
    type: "array",
    items: obj({ name: str, grams_low: int, grams_high: int, kcal_low: int, kcal_high: int }),
  },
  kcal_low: int,
  kcal_mid: int,
  kcal_high: int,
  protein_g: int,
  confidence: { type: "string", enum: ["hoch", "mittel", "niedrig"] },
  day_offset: int,
  time_hint: str,
  note: str,
  question: obj({
    text: str,
    options: { type: "array", items: obj({ label: str, kcal_low: int, kcal_mid: int, kcal_high: int }) },
  }),
  activity: obj({ type: str, distance_km: num, duration_min: int }),
});

// Bewusst stabil gehalten (kein Datum o. Ä.), damit der Prompt-Cache greift.
const SYSTEM = `Du bist der Ernährungs-Assistent von "Happen", einem Ernährungstagebuch per Chat.
Der Nutzer schickt Fotos, Sprachnachrichten (als Transkript) oder Text zu dem, was er gegessen oder getrunken hat.
Deine Aufgabe: Bestandteile erkennen, Mengen schätzen und den Energiegehalt als ehrliche Spanne angeben.

Grundsätze
- Schätze realistisch, nicht optimistisch. Menschen unterschätzen ihr Essen typischerweise; versteckte Kalorien
  (Öl, Butter, Soßen, Dressing, Käse, Zucker im Getränk, Alkohol) gehören in die Schätzung.
- Gewichte beziehen sich auf den verzehrfertigen Zustand. Nutze typische deutsche Portionsgrößen.
- Orientierung: 1 EL Öl ≈ 10 g ≈ 90 kcal; 1 TL Butter ≈ 5 g ≈ 37 kcal; 0,5 l Bier ≈ 210 kcal; 0,2 l Wein ≈ 150 kcal.
- kcal_mid ist dein bester Schätzwert, kcal_low/kcal_high die plausible Spanne. Bei einem Foto ohne Zusatzinfo
  ist die Spanne breiter (oft ±25 %), bei genauen Angaben (Packung, Gramm) enger.
- Wenn der Nutzer eine frühere Mahlzeit nennt, die in "Bekannte Mahlzeiten" vorkommt, übernimm deren Werte,
  damit gleiche Mahlzeiten gleich geschätzt werden.
- Stelle höchstens EINE Rückfrage und nur, wenn die Antwort den Mittelwert um mehr als ca. 150 kcal verändert
  (z. B. "Mit Sahne oder ohne?", "Großer oder normaler Teller?"). Gib dann 2–3 Antwortoptionen mit jeweils eigener
  Spanne. Sonst question.text = "" und question.options = [].
- Werte nie moralisch. Keine Ratschläge, außer der Nutzer fragt danach.

Felder
- kind = "food" für Essen und Getränke, "activity" für Sport (z. B. "bin 12 km gelaufen"), sonst "other".
- reply_text: nur bei kind="other" eine kurze, freundliche Antwort auf Deutsch, sonst "".
- title: kurzer deutscher Name der Mahlzeit (max. 40 Zeichen), bei activity z. B. "Lauf".
- day_offset: 0 = heute, -1 = gestern usw., falls der Nutzer einen anderen Tag nennt.
- time_hint: "HH:MM", wenn der Nutzer eine Uhrzeit nennt oder klar impliziert ("heute Mittag" = "12:30"), sonst "".
- note: ein kurzer Satz, was die Schätzung am stärksten beeinflusst (z. B. "Annahme: 1 EL Öl zum Braten"), oder "".
- activity: nur bei kind="activity" befüllen (type "run", "bike", "walk", "strength" …), sonst type "" und 0-Werte.
- Bei kind != "food": items = [], alle kcal-Werte 0, protein_g 0.`;

export interface EstimateInput {
  text?: string; // Bildunterschrift, Transkript oder Nachricht
  image?: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" };
  localNow: string; // z. B. "Mittwoch, 04.11.2026, 13:05"
  knownMeals: string[]; // "Müsli mit Milch – 520 kcal"
}

export class EstimateRefused extends Error {}

const client = new Anthropic(); // liest ANTHROPIC_API_KEY

export async function estimate(input: EstimateInput): Promise<Estimate> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (input.image) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: input.image.mediaType, data: input.image.base64 },
    });
  }
  const context = [
    `Jetzt: ${input.localNow}`,
    input.knownMeals.length
      ? `Bekannte Mahlzeiten dieses Nutzers (für gleiche Schätzungen):\n${input.knownMeals.map((m) => `- ${m}`).join("\n")}`
      : "Bekannte Mahlzeiten: noch keine",
    `Nachricht des Nutzers: ${input.text?.trim() ? input.text.trim() : input.image ? "(nur Foto)" : "(leer)"}`,
  ].join("\n\n");
  content.push({ type: "text", text: context });

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
    system: SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new EstimateRefused(response.stop_details?.explanation ?? "refused");
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error(`no text block (stop_reason=${response.stop_reason})`);
  return sanitize(JSON.parse(text.text) as Estimate);
}

/** Erzwingt low ≤ mid ≤ high und nicht-negative Werte. */
export function sanitize(e: Estimate): Estimate {
  const fix = (o: { kcal_low: number; kcal_mid: number; kcal_high: number }) => {
    const [lo, mid, hi] = [o.kcal_low, o.kcal_mid, o.kcal_high].map((n) => Math.max(0, Math.round(n || 0)));
    o.kcal_mid = mid;
    o.kcal_low = Math.min(lo, mid);
    o.kcal_high = Math.max(hi, mid);
  };
  fix(e);
  e.question.options.forEach(fix);
  e.protein_g = Math.max(0, Math.round(e.protein_g || 0));
  e.day_offset = Math.max(-7, Math.min(0, Math.round(e.day_offset || 0)));
  return e;
}
