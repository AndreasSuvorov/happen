import webPush from "npm:web-push@3.6.7";
import { pushFailure, type PushOutcome } from "./push-delivery.ts";

export interface Subscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failed_count: number;
}

const supportedPushHosts = new Set([
  "fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com",
  "web.push.apple.com", "wns.windows.com", "notify.windows.com",
]);

export function isPushEndpoint(input: unknown): input is string {
  if (typeof input !== "string" || input.length > 2048) return false;
  try {
    const url = new URL(input);
    const host = url.hostname;
    const supported = supportedPushHosts.has(host) ||
      host.endsWith(".push.apple.com") || host.endsWith(".notify.windows.com") || host.endsWith(".wns.windows.com");
    return supported && url.protocol === "https:" && !url.port && !url.username && !url.password &&
      !url.hash && url.pathname !== "/";
  } catch {
    return false;
  }
}

export function vapidSettings() {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT");
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

export async function sendWebPush(
  subscription: Subscription, vapid: NonNullable<ReturnType<typeof vapidSettings>>, payload: string,
): Promise<PushOutcome> {
  if (!isPushEndpoint(subscription.endpoint)) return "failed";
  try {
    const { endpoint, p256dh, auth } = subscription;
    await webPush.sendNotification({ endpoint, keys: { p256dh, auth } }, payload, {
      vapidDetails: vapid, TTL: 3600, urgency: "normal", timeout: 8000,
    });
    return "accepted";
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    return pushFailure(status);
  }
}
