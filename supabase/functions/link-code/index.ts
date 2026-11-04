// Von der eingeloggten PWA aufgerufen: erzeugt einen Einmal-Code, mit dem der Nutzer
// in Telegram per `/start <code>` seinen Chat mit seinem Happen-Konto verknüpft.
// FUNCTIONS_VERIFY_JWT ist global aus (wegen des Telegram-Webhooks), darum prüfen wir
// das Supabase-Auth-Token hier selbst gegen GoTrue.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { db } from "../_shared/db.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const BOT_USERNAME = Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "";

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return new Response("unauthorized", { status: 401 });

  const asUser = createClient(SUPABASE_URL, ANON_KEY);
  const { data: userData, error: authError } = await asUser.auth.getUser(token);
  if (authError || !userData?.user) return new Response("unauthorized", { status: 401 });

  const { data: profile, error: profileError } = await db
    .from("users")
    .select("id")
    .eq("auth_user_id", userData.user.id)
    .maybeSingle();
  if (profileError || !profile) return new Response("profile not found", { status: 404 });

  // Alte, noch offene Codes für dieses Profil aufräumen.
  await db.from("telegram_link_codes").delete().eq("user_id", profile.id);

  const code = randomCode();
  const { error: insertError } = await db.from("telegram_link_codes").insert({ code, user_id: profile.id });
  if (insertError) return new Response(insertError.message, { status: 500 });

  const deepLink = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=${code}` : null;
  return Response.json({ code, deepLink, expiresInSeconds: 600 });
});
