// Minimaler Client für die Garmin Personal API (nur lesend). Siehe docs/wiki/Coach-Plan.md, Anhang A.
// Ohne Deno-Abhängigkeit, damit er in Node-Tests mit einem Fake-fetch laufen kann.
// WICHTIG: Schlüssel und Token tauchen nie in Fehlermeldungen oder Logs auf.

export const GARMIN_BASE_URL = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";

/** Schlüssel abgelaufen/ungültig (401/403 auf dem Token-Endpunkt). */
export class GarminKeyError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`garmin: api key rejected (${status})`);
    this.status = status;
  }
}

export class GarminHttpError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`garmin: ${status} on ${path.split("?")[0]}`);
    this.status = status;
  }
}

export interface ClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Wartezeiten zwischen den Versuchen; Anzahl + 1 = maximale Versuche. */
  retryDelaysMs?: number[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DEFAULT_DELAYS = [2_000, 4_000, 8_000]; // höchstens 4 Versuche

/** Führt `fn` aus und wiederholt bei 429, 5xx und Netzwerkfehlern mit exponentiellem Backoff. */
async function withRetry(fn: () => Promise<Response>, opts: ClientOptions, path: string): Promise<Response> {
  const delays = opts.retryDelaysMs ?? DEFAULT_DELAYS;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fn();
    } catch (e) {
      if (attempt >= delays.length) throw new Error(`garmin: network error on ${path.split("?")[0]}: ${(e as Error).message}`);
    }
    if (res) {
      if (res.status !== 429 && res.status < 500) return res;
      if (attempt >= delays.length) throw new GarminHttpError(res.status, path);
      await res.body?.cancel();
    }
    await sleep(delays[attempt]);
  }
}

/** Liest `exp` aus einem JWT (ohne Signaturprüfung, nur für den Cache). */
export function jwtExpiry(token: string): Date | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = JSON.parse(atob(b64));
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

/** Tauscht den Personal API Key gegen einen JWT (gilt 24 h). Die Antwort ist der JWT als Text. */
export async function fetchToken(apiKey: string, opts: ClientOptions = {}): Promise<{ token: string; expiresAt: Date }> {
  const f = opts.fetchFn ?? fetch;
  const res = await withRetry(
    () => f((opts.baseUrl ?? GARMIN_BASE_URL) + TOKEN_PATH, { method: "POST", headers: { Authorization: `ApiKey ${apiKey}` } }),
    opts,
    TOKEN_PATH,
  );
  // 404 kommt, wenn Garmin den Schlüssel nicht (mehr) kennt (abgelaufen/gelöscht); ein falscher Schlüssel
  // liefert 401. Beides heißt: Nutzer muss einen neuen Schlüssel anlegen.
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    await res.body?.cancel();
    throw new GarminKeyError(res.status);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new GarminHttpError(res.status, TOKEN_PATH);
  }
  const token = (await res.text()).trim().replace(/^"|"$/g, "");
  if (!token.includes(".")) throw new Error("garmin: unexpected token response");
  return { token, expiresAt: jwtExpiry(token) ?? new Date(Date.now() + 23 * 3_600_000) };
}

export interface GarminClient {
  /** GET mit JSON-Antwort. 204/404/leer → null (Daten noch nicht synchronisiert). */
  get(path: string): Promise<unknown | null>;
  /** GET mit Binärantwort (z. B. FIT-ZIP). 204/404/leer → null. */
  getBytes(path: string): Promise<Uint8Array | null>;
}

/**
 * `getToken` liefert den aktuellen Token; `refreshToken` wird bei einer 401 auf einem
 * Datenendpunkt genau einmal aufgerufen (z. B. wenn der Cache-Token widerrufen wurde).
 */
export function createGarminClient(
  getToken: () => Promise<string>,
  refreshToken: () => Promise<string>,
  opts: ClientOptions = {},
): GarminClient {
  const f = opts.fetchFn ?? fetch;
  const base = opts.baseUrl ?? GARMIN_BASE_URL;
  let refreshed = false;

  async function request(path: string, token: string, accept = "application/json"): Promise<Response> {
    return await withRetry(
      () => f(base + path, { headers: { Authorization: `Bearer ${token}`, Accept: accept } }),
      opts,
      path,
    );
  }

  /** Anfrage mit einmaligem Token-Refresh bei 401; null bei 204/404, Fehler bei anderen Status. */
  async function send(path: string, accept?: string): Promise<Response | null> {
    let res = await request(path, await getToken(), accept);
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await res.body?.cancel();
      res = await request(path, await refreshToken(), accept);
    }
    if (res.status === 204 || res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new GarminHttpError(res.status, path);
    }
    return res;
  }

  return {
    async getBytes(path: string) {
      const res = await send(path, "application/octet-stream, application/zip, */*");
      if (!res) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      return bytes.length ? bytes : null;
    },
    async get(path: string) {
      let res = await request(path, await getToken());
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await res.body?.cancel();
        res = await request(path, await refreshToken());
      }
      if (res.status === 204 || res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel();
        throw new GarminHttpError(res.status, path);
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new GarminHttpError(res.status, path);
      }
      const text = await res.text();
      if (!text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`garmin: invalid JSON on ${path.split("?")[0]}`);
      }
    },
  };
}

// Endpunkte (Anhang A.2)
export const endpoints = {
  profile: () => "/userprofile-service/userprofile/settings",
  dailySummaries: (from: string, to: string) => `/usersummary-service/v2/dailysummaries?startDate=${from}&endDate=${to}`,
  dailySleep: (date: string) => `/sleep-service/sleep/dailySleep?date=${date}`,
  hrv: (date: string) => `/hrv-service/hrv/${date}`,
  dailyHeartRate: (date: string) => `/wellness-service/wellness/dailyHeartRate?date=${date}`,
  bodyBattery: (from: string, to: string) => `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${from}&endDate=${to}`,
  activities: (start: number, limit: number) => `/activitylist-service/activities/search/activities?start=${start}&limit=${limit}`,
  activity: (id: string) => `/activity-service/activity/${encodeURIComponent(id)}`,
  /** ZIP mit der Original-FIT-Datei */
  activityFile: (id: string) => `/download-service/files/activity/${encodeURIComponent(id)}`,
};
