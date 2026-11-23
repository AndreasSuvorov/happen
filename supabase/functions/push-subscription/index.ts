import { authenticate } from "../_shared/auth.ts";
import { db } from "../_shared/db.ts";
import { hasFeature } from "../_shared/garmin/store.ts";
import { isPushEndpoint, vapidSettings } from "../_shared/web-push.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body?: unknown): Response {
  return body === undefined ? new Response(null, { status, headers: cors }) :
    Response.json(body, { status, headers: cors });
}

function keyOfLength(value: unknown, length: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{20,90}$/.test(value)) return false;
  try {
    return atob(value.replace(/-/g, "+").replace(/_/g, "/")).length === length;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return reply(204);
  if (req.method !== "POST") return reply(405);
  const user = await authenticate(req);
  if (!user) return reply(401);

  let body;
  try {
    body = await req.json();
  } catch {
    return reply(400);
  }

  if (body?.action === "remove" && isPushEndpoint(body.endpoint)) {
    const { error } = await db.from("push_subscriptions").delete().eq("user_id", user.id).eq("endpoint", body.endpoint);
    return reply(error ? 500 : 200, { ok: !error });
  }

  if (!(await hasFeature(user.id, "garmin"))) return reply(403);
  const vapid = vapidSettings();
  if (!vapid) return reply(503);

  if (body?.action === "config") return reply(200, { publicKey: vapid.publicKey });
  if (body?.action !== "save" || !isPushEndpoint(body.endpoint) ||
    !keyOfLength(body.keys?.p256dh, 65) || !keyOfLength(body.keys?.auth, 16)) {
    return reply(400);
  }

  const record = {
    user_id: user.id, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth,
    user_agent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
  };
  const { error: insertError } = await db.from("push_subscriptions").upsert(record, {
    onConflict: "endpoint", ignoreDuplicates: true,
  });
  if (insertError) return reply(500);
  const { data, error } = await db.from("push_subscriptions").update({
    p256dh: record.p256dh, auth: record.auth, user_agent: record.user_agent,
  }).eq("user_id", user.id).eq("endpoint", body.endpoint).select("id").maybeSingle();
  if (error) return reply(500);
  if (!data) return reply(409, { error: "endpoint_in_use" });
  return reply(200, { ok: true });
});
