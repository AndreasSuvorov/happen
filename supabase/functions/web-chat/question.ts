// Erkennt, ob ein Text eine Frage an den Coach ist (statt Mahlzeit oder Aktivität). Ohne Deno-Importe.

/** Frage an den Coach (statt Mahlzeit/Aktivität)? Nur für Texte ohne erkannte feste Absicht. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim().toLocaleLowerCase("de-DE");
  return t.endsWith("?") ||
    /^(wie|was|warum|wieso|weshalb|wann|wo|welche[rsmn]?|wieviel|wie viel|soll|sollte|kann|darf|lohnt|zeig|erklär|vergleich|hab ich|habe ich|bin ich|war ich|ist mein|sind meine)\b/.test(t);
}
