// FIT-Parser für Meilenstein 4 (Laufanalyse, Coach-Plan 6.3 / Anhang A „Original-Datei“).
// Garmin liefert unter /download-service/files/activity/{id} ein ZIP mit einer FIT-Datei
// (manchmal auch direkt die FIT-Datei). Wir dekodieren nur, was die Analyse braucht:
// `record` (Global 20) und `device_info` (Global 23).
// Reines TypeScript ohne Deno-/npm-Importe, kein `enum`, keine Parameter-Properties,
// damit Node 22 (Type-Stripping) und Deno die Datei gleichermaßen laden können.

import type { FitActivity, FitRecord } from "./types.ts";

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** true, wenn an Byte 8–11 die FIT-Signatur „.FIT“ steht. */
function isFit(b: Uint8Array): boolean {
  return b.length >= 12 && b[8] === 0x2e && b[9] === 0x46 && b[10] === 0x49 && b[11] === 0x54;
}

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function asciiName(b: Uint8Array, o: number, n: number): string {
  let s = "";
  for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

interface ZipEntry {
  method: number;
  compSize: number;
  localOffset: number;
}

/** Erster `.fit`-Eintrag laut Central Directory, sonst null. */
function findViaCentralDirectory(zip: Uint8Array): ZipEntry | null {
  // EOCD liegt in den letzten 22 + max. 65535 (Kommentar) Bytes.
  const minPos = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let p = zip.length - 22; p >= minPos; p--) {
    if (u32(zip, p) === SIG_EOCD) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = u16(zip, eocd + 10);
  let p = u32(zip, eocd + 16);
  for (let i = 0; i < count && p + 46 <= zip.length; i++) {
    if (u32(zip, p) !== SIG_CENTRAL) return null;
    const method = u16(zip, p + 10);
    const compSize = u32(zip, p + 20);
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    const localOffset = u32(zip, p + 42);
    const name = asciiName(zip, p + 46, nameLen);
    if (name.toLowerCase().endsWith(".fit")) return { method, compSize, localOffset };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Fallback ohne Central Directory: Local File Headers der Reihe nach (nur ohne Data Descriptor). */
function findViaLocalHeaders(zip: Uint8Array): ZipEntry | null {
  let p = 0;
  while (p + 30 <= zip.length && u32(zip, p) === SIG_LOCAL) {
    const flags = u16(zip, p + 6);
    const method = u16(zip, p + 8);
    const compSize = u32(zip, p + 18);
    const nameLen = u16(zip, p + 26);
    const extraLen = u16(zip, p + 28);
    const name = asciiName(zip, p + 30, nameLen);
    if (flags & 0x08) return null; // Größe steht erst im Data Descriptor – ohne Central Directory nicht lösbar
    if (name.toLowerCase().endsWith(".fit")) return { method, compSize, localOffset: p };
    p += 30 + nameLen + extraLen + compSize;
  }
  return null;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  const readAll = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();
  // Fehler beim Schreiben landen auch im Reader; hier nur nicht unbehandelt lassen.
  writer.write(data.slice()).catch(() => {});
  writer.close().catch(() => {});
  await readAll;
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Liefert die erste `.fit`-Datei aus einem ZIP (Methode 0 = stored, 8 = deflate).
 * Ist die Eingabe schon eine FIT-Datei, kommt sie unverändert zurück.
 * Wirft nie: bei Müll, fehlender FIT-Datei oder kaputtem Deflate kommt ein leeres Array zurück.
 */
export async function unzipFirstFit(zip: Uint8Array): Promise<Uint8Array> {
  try {
    if (isFit(zip)) return zip;
    const entry = findViaCentralDirectory(zip) ?? findViaLocalHeaders(zip);
    if (!entry) return new Uint8Array(0);
    const lh = entry.localOffset;
    if (lh + 30 > zip.length || u32(zip, lh) !== SIG_LOCAL) return new Uint8Array(0);
    // Größe immer aus dem Central Directory (bzw. Local Header ohne Bit 3) – deckt den Data-Descriptor-Fall ab.
    const start = lh + 30 + u16(zip, lh + 26) + u16(zip, lh + 28);
    const end = start + entry.compSize;
    if (end > zip.length) return new Uint8Array(0);
    const data = zip.subarray(start, end);
    if (entry.method === 0) return data.slice();
    if (entry.method === 8) return await inflateRaw(data);
    return new Uint8Array(0);
  } catch {
    return new Uint8Array(0);
  }
}

// ---------------------------------------------------------------------------
// FIT
// ---------------------------------------------------------------------------

/** Sekunden zwischen 1970-01-01 und dem FIT-Epoch 1989-12-31T00:00:00Z. */
const FIT_EPOCH_S = 631065600;
const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;

const MSG_RECORD = 20;
const MSG_DEVICE_INFO = 23;

interface FieldDef {
  num: number;
  size: number;
  baseType: number;
}

interface MessageDef {
  global: number;
  little: boolean;
  fields: FieldDef[];
  devBytes: number;
}

/**
 * Liest einen Basistyp-Wert (erstes Element bei Arrays). Invalid-Werte → null.
 * Strings/Bytes/64-Bit-Typen brauchen wir nicht → null.
 */
function readValue(dv: DataView, o: number, f: FieldDef, little: boolean): number | null {
  const t = f.baseType & 0x1f;
  switch (t) {
    case 0x00: // enum
    case 0x02: // uint8
    case 0x0d: { // byte
      if (f.size < 1) return null;
      const v = dv.getUint8(o);
      return v === 0xff ? null : v;
    }
    case 0x0a: { // uint8z
      if (f.size < 1) return null;
      const v = dv.getUint8(o);
      return v === 0 ? null : v;
    }
    case 0x01: { // sint8
      if (f.size < 1) return null;
      const v = dv.getInt8(o);
      return v === 0x7f ? null : v;
    }
    case 0x03: { // sint16
      if (f.size < 2) return null;
      const v = dv.getInt16(o, little);
      return v === 0x7fff ? null : v;
    }
    case 0x04: { // uint16
      if (f.size < 2) return null;
      const v = dv.getUint16(o, little);
      return v === 0xffff ? null : v;
    }
    case 0x0b: { // uint16z
      if (f.size < 2) return null;
      const v = dv.getUint16(o, little);
      return v === 0 ? null : v;
    }
    case 0x05: { // sint32
      if (f.size < 4) return null;
      const v = dv.getInt32(o, little);
      return v === 0x7fffffff ? null : v;
    }
    case 0x06: { // uint32
      if (f.size < 4) return null;
      const v = dv.getUint32(o, little);
      return v === 0xffffffff ? null : v;
    }
    case 0x0c: { // uint32z
      if (f.size < 4) return null;
      const v = dv.getUint32(o, little);
      return v === 0 ? null : v;
    }
    case 0x08: { // float32
      if (f.size < 4) return null;
      const v = dv.getFloat32(o, little);
      return Number.isFinite(v) ? v : null;
    }
    case 0x09: { // float64
      if (f.size < 8) return null;
      const v = dv.getFloat64(o, little);
      return Number.isFinite(v) ? v : null;
    }
    default:
      return null;
  }
}

/** Externer Pulssensor in einer device_info-Nachricht? */
function isExternalHrSensor(fields: Map<number, number | null>): boolean {
  // Heuristik: device_type (Feld 1) ist je nach source_type (Feld 25) ein anderes Enum:
  //   ant(0)/antplus(1) → antplus_device_type, heart_rate = 120
  //   bluetooth_low_energy(3) → ble_device_type, heart_rate = 1
  //   local(5) → local_device_type (z. B. 10 = optischer Handgelenkssensor) – nie ein Brustgurt.
  // device_index 0 ist das aufzeichnende Gerät (die Uhr) selbst und zählt nie als Sensor.
  // Ein über ANT+/BLE gekoppelter HR-Sensor ist praktisch immer ein Gurt (HRM-Pro, Polar H10 …);
  // optische Armbänder per Broadcast sind selten und werden bewusst ebenfalls als „chest“ gezählt,
  // weil sie für die Analyse genauso „nicht der Uhr-Sensor“ sind.
  const index = fields.get(0) ?? null;
  const type = fields.get(1) ?? null;
  const source = fields.get(25) ?? null;
  if (index === 0) return false;
  if (source === 3) return type === 1;
  if (source === null || source === 0 || source === 1) return type === 120;
  return false;
}

function emptyActivity(): FitActivity {
  return { records: [], hr_sensor: null, start_time_utc: null };
}

interface RawRecord {
  ts: number;
  hr: number | null;
  speed: number | null;
  dist: number | null;
  alt: number | null;
  cadence: number | null;
  lat: number | null;
  lon: number | null;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * Dekodiert eine FIT-Datei. Wirft nie: bei kaputten Daten kommen die bis dahin
 * gelesenen Datensätze zurück. CRC wird nicht geprüft.
 */
export function parseFit(bytes: Uint8Array): FitActivity {
  if (!(bytes instanceof Uint8Array) || !isFit(bytes)) return emptyActivity();
  const headerSize = bytes[0];
  if (headerSize !== 12 && headerSize !== 14) return emptyActivity();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataSize = dv.getUint32(4, true);
  const end = Math.min(bytes.length, headerSize + dataSize);

  const defs: (MessageDef | undefined)[] = new Array(16);
  const raw: RawRecord[] = [];
  let lastTs: number | null = null;
  let chest = false;

  let p = headerSize;
  try {
    while (p < end) {
      const h = bytes[p++];
      if (h & 0x80) {
        // Compressed Timestamp Header: Bits 5–6 = lokaler Typ, Bits 0–4 = Zeit-Offset
        const local = (h >> 5) & 0x03;
        const offset = h & 0x1f;
        const def = defs[local];
        if (!def) break;
        let ts: number | null = null;
        if (lastTs !== null) {
          ts = lastTs + ((offset - (lastTs & 0x1f)) & 0x1f);
          lastTs = ts;
        }
        const fields = readData(dv, p, def, end);
        if (!fields) break;
        p += messageSize(def);
        handle(def.global, fields, ts);
        continue;
      }
      const local = h & 0x0f;
      if (h & 0x40) {
        // Definition Message
        if (p + 5 > end) break;
        const little = bytes[p + 1] === 0;
        const global = dv.getUint16(p + 2, little);
        const n = bytes[p + 4];
        p += 5;
        if (p + n * 3 > end) break;
        const fields: FieldDef[] = [];
        for (let i = 0; i < n; i++) {
          fields.push({ num: bytes[p], size: bytes[p + 1], baseType: bytes[p + 2] });
          p += 3;
        }
        let devBytes = 0;
        if (h & 0x20) {
          if (p + 1 > end) break;
          const nd = bytes[p++];
          if (p + nd * 3 > end) break;
          for (let i = 0; i < nd; i++) {
            devBytes += bytes[p + 1];
            p += 3;
          }
        }
        defs[local] = { global, little, fields, devBytes };
        continue;
      }
      // Data Message
      const def = defs[local];
      if (!def) break;
      const fields = readData(dv, p, def, end);
      if (!fields) break;
      p += messageSize(def);
      const tsField = fields.get(253) ?? null;
      if (tsField !== null) lastTs = tsField;
      handle(def.global, fields, tsField);
    }
  } catch {
    // Kaputte Daten: mit dem weitermachen, was bis hierhin gelesen wurde.
  }

  function handle(global: number, f: Map<number, number | null>, ts: number | null): void {
    if (global === MSG_DEVICE_INFO) {
      if (isExternalHrSensor(f)) chest = true;
      return;
    }
    if (global !== MSG_RECORD || ts === null) return;
    const g = (n: number) => f.get(n) ?? null;
    const enhSpeed = g(73);
    const speed = g(6);
    const enhAlt = g(78);
    const alt = g(2);
    const cad = g(4);
    const fracCad = g(53);
    const lat = g(0);
    const lon = g(1);
    const dist = g(5);
    raw.push({
      ts,
      hr: g(3),
      speed: enhSpeed !== null ? enhSpeed / 1000 : speed !== null ? speed / 1000 : null,
      dist: dist !== null ? dist / 100 : null,
      alt: enhAlt !== null ? enhAlt / 5 - 500 : alt !== null ? alt / 5 - 500 : null,
      // cadence ist pro Bein (rpm); fractional_cadence (Feld 53, scale 128) ergänzt die Nachkommastellen.
      cadence: cad !== null ? (cad + (fracCad ?? 0) / 128) * 2 : null,
      lat: lat !== null && lon !== null ? round(lat * SEMICIRCLE_TO_DEG, 7) : null,
      lon: lat !== null && lon !== null ? round(lon * SEMICIRCLE_TO_DEG, 7) : null,
    });
  }

  if (raw.length === 0) return { records: [], hr_sensor: chest ? "chest" : null, start_time_utc: null };

  const t0 = raw[0].ts;
  const records: FitRecord[] = raw.map((r) => ({
    t_s: r.ts - t0,
    hr: r.hr,
    speed_mps: r.speed,
    dist_m: r.dist,
    alt_m: r.alt !== null ? round(r.alt, 2) : null,
    cadence_spm: r.cadence !== null ? round(r.cadence, 2) : null,
    lat: r.lat,
    lon: r.lon,
  }));
  const hasHr = records.some((r) => r.hr !== null);
  return {
    records,
    hr_sensor: chest ? "chest" : hasHr ? "wrist" : null,
    start_time_utc: new Date((t0 + FIT_EPOCH_S) * 1000).toISOString(),
  };
}

function messageSize(def: MessageDef): number {
  let s = def.devBytes;
  for (const f of def.fields) s += f.size;
  return s;
}

/** Liest die Felder einer Data Message; null, wenn sie über das Datenende hinausreicht. */
function readData(dv: DataView, p: number, def: MessageDef, end: number): Map<number, number | null> | null {
  if (p + messageSize(def) > end) return null;
  const out = new Map<number, number | null>();
  let o = p;
  for (const f of def.fields) {
    out.set(f.num, readValue(dv, o, f, def.little));
    o += f.size;
  }
  return out;
}
