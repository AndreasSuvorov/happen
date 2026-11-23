// Prüft das Supabase-Auth-Token aus der PWA selbst (FUNCTIONS_VERIFY_JWT ist wegen Telegram global aus).
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { db, type UserRow } from "./db.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export async function authenticate(req: Request): Promise<UserRow | null> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const asUser = createClient(SUPABASE_URL, ANON_KEY);
  const { data, error } = await asUser.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await db.from("users").select("*").eq("auth_user_id", data.user.id).maybeSingle();
  return (profile as UserRow) ?? null;
}

/** Führt Arbeit nach der Antwort weiter aus (Supabase Edge Runtime), sonst wird gewartet. */
export async function runInBackground(p: Promise<unknown>): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
  else await p;
}
