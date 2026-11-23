// Garmin verbinden, Status abfragen, trennen. Aufruf aus der eingeloggten PWA (POST, JSON):
//   { action: "status" }
//   { action: "connect", apiKey: "...", consent: true }
//   { action: "disconnect", deleteData: boolean }
// Der Schlüssel wird nie geloggt, nie in messages gespeichert und nie an ein LLM gegeben.
import { db } from "../_shared/db.ts";
import { authenticate, runInBackground } from "../_shared/auth.ts";
import { createGarminClient, endpoints, fetchToken, GarminKeyError } from "../_shared/garmin/client.ts";
import { BACKFILL_DAYS, PROVIDER, syncConnection, type Connection } from "../_shared/garmin/sync.ts";
import { connectionFor, disconnect, hasFeature, notifyUser, supabaseStore } from "../_shared/garmin/store.ts";
import { addDays } from "../_shared/garmin/transform.ts";
import { localDate } from "../_shared/nutrition.ts";

interface Body {
  action?: "status" | "connect" | "disconnect";
  apiKey?: string;
  consent?: boolean;
  deleteData?: boolean;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function publicStatus(c: Connection | null) {
  if (!c) return { connected: false };
  return {
    connected: true,
    status: c.status,
    lastSyncAt: c.last_sync_at,
    lastDataAt: c.last_data_at,
    backfillPending: !!c.backfill_from,
    lastError: c.status === "active" ? null : c.last_error,
    timezone: c.timezone,
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const user = await authenticate(req);
  if (!user) return new Response("unauthorized", { status: 401 });
  if (!(await hasFeature(user.id, "garmin"))) return json({ error: "feature_disabled" }, 403);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  if (!body.action || body.action === "status") {
    return json(publicStatus(await connectionFor(user.id)));
  }

  if (body.action === "disconnect") {
    await disconnect(user.id, !!body.deleteData);
    return json({ connected: false, deleted: !!body.deleteData });
  }

  if (body.action === "connect") {
    if (body.consent !== true) return json({ error: "consent_required" }, 400);
    const apiKey = (body.apiKey ?? "").trim();
    if (apiKey.length < 10 || apiKey.length > 4096) return json({ error: "invalid_key" }, 400);

    // Schlüssel testen: Token holen und Profil abrufen.
    let token: { token: string; expiresAt: Date };
    let profile: { timeZone?: string } | null;
    try {
      token = await fetchToken(apiKey);
      const t = token.token;
      const client = createGarminClient(async () => t, async () => t);
      profile = (await client.get(endpoints.profile())) as { timeZone?: string } | null;
    } catch (e) {
      if (e instanceof GarminKeyError) return json({ error: "key_rejected" }, 400);
      console.error("garmin connect failed:", (e as Error).message);
      return json({ error: "garmin_unreachable" }, 502);
    }

    // Alte Verbindung (und deren Secrets) ersetzen, Daten bleiben.
    await disconnect(user.id, false);

    const keyId = await supabaseStore.createSecret(apiKey, `garmin_key_${user.id}_${Date.now()}`);
    const tokenId = await supabaseStore.createSecret(token.token, `garmin_token_${user.id}_${Date.now()}`);
    const timezone = validTimeZone(profile?.timeZone) ? profile!.timeZone! : user.timezone;
    const today = localDate(new Date(), timezone);

    const { data: conn, error } = await db
      .from("wearable_connections")
      .insert({
        user_id: user.id,
        provider: PROVIDER,
        vault_secret_id: keyId,
        token_secret_id: tokenId,
        token_expires_at: token.expiresAt.toISOString(),
        status: "active",
        timezone,
        consent_at: new Date().toISOString(),
        backfill_from: addDays(today, -BACKFILL_DAYS),
        backfill_cursor: null,
      })
      .select()
      .single();
    if (error || !conn) {
      for (const id of [keyId, tokenId]) await db.rpc("wearable_secret_delete", { p_id: id });
      return json({ error: "save_failed" }, 500);
    }

    // Erster Sync (heute, gestern und der erste Block des Backfills) im Hintergrund.
    await runInBackground(
      syncConnection(conn as Connection, {
        store: supabaseStore,
        notify: (uid, text) => notifyUser(uid, text, "garmin_expired"),
        log: (m) => console.error(m),
      }),
    );
    return json(publicStatus(conn as Connection));
  }

  return json({ error: "unknown_action" }, 400);
});
