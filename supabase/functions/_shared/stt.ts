// Sprache → Text. Claude verarbeitet kein Audio, deshalb ein eigener Transkriptionsdienst.
// Standard: OpenAI-Transkription (OPENAI_API_KEY). Ohne Schlüssel ist Sprache deaktiviert.

const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
const STT_MODEL = Deno.env.get("STT_MODEL") ?? "gpt-4o-mini-transcribe";

export const sttEnabled = () => Boolean(OPENAI_KEY);

export async function transcribe(audio: Uint8Array, filename = "voice.ogg", mimeType = "audio/ogg"): Promise<string> {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY fehlt");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
  form.append("model", STT_MODEL);
  form.append("language", "de");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`transcription ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return String(json.text ?? "").trim();
}
