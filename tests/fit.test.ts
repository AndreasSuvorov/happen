// Ausführen: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFit, unzipFirstFit } from "../supabase/functions/_shared/run/fit.ts";

// ---------------------------------------------------------------------------
// Kleiner FIT-Encoder für synthetische Testdateien
// ---------------------------------------------------------------------------

type Field = [num: number, size: number, baseType: number];

const ENUM = 0x00, UINT8 = 0x02, UINT16 = 0x84, SINT32 = 0x85, UINT32 = 0x86, UINT32Z = 0x8c;
const FIT_EPOCH_S = 631065600;
const START = Date.UTC(2026, 10, 22, 7, 30, 0) / 1000 - FIT_EPOCH_S;

class FitWriter {
  bytes: number[] = [];
  defs = new Map<number, { fields: Field[]; little: boolean }>();

  define(local: number, global: number, fields: Field[], opts: { little?: boolean; dev?: number[] } = {}) {
    const little = opts.little ?? true;
    this.bytes.push(0x40 | (opts.dev ? 0x20 : 0) | local, 0, little ? 0 : 1);
    this.push(global, 2, little);
    this.bytes.push(fields.length);
    for (const f of fields) this.bytes.push(...f);
    if (opts.dev) {
      this.bytes.push(opts.dev.length);
      for (const size of opts.dev) this.bytes.push(0, size, 0);
    }
    this.defs.set(local, { fields, little });
  }

  data(local: number, values: number[], dev: number[] = []) {
    this.bytes.push(local);
    this.values(local, values);
    this.bytes.push(...dev);
  }

  compressed(local: number, offset: number, values: number[]) {
    this.bytes.push(0x80 | (local << 5) | (offset & 0x1f));
    this.values(local, values);
  }

  values(local: number, values: number[]) {
    const d = this.defs.get(local)!;
    d.fields.forEach((f, i) => this.push(values[i], f[1], d.little, (f[2] & 0x1f) === 0x05));
  }

  push(v: number, size: number, little: boolean, signed = false) {
    const buf = new DataView(new ArrayBuffer(size));
    if (size === 1) buf.setUint8(0, v & 0xff);
    else if (size === 2) buf.setUint16(0, v, little);
    else if (signed) buf.setInt32(0, v, little);
    else buf.setUint32(0, v >>> 0, little);
    this.bytes.push(...new Uint8Array(buf.buffer));
  }

  file(headerSize: 12 | 14 = 14): Uint8Array {
    const h = new Uint8Array(headerSize);
    const dv = new DataView(h.buffer);
    h[0] = headerSize;
    h[1] = 0x20;
    dv.setUint16(2, 2132, true);
    dv.setUint32(4, this.bytes.length, true);
    h.set([0x2e, 0x46, 0x49, 0x54], 8);
    const out = new Uint8Array(headerSize + this.bytes.length + 2); // + CRC (0, wird nicht geprüft)
    out.set(h);
    out.set(this.bytes, headerSize);
    return out;
  }
}

const RECORD_FIELDS: Field[] = [
  [253, 4, UINT32], // timestamp
  [0, 4, SINT32], // position_lat
  [1, 4, SINT32], // position_long
  [3, 1, UINT8], // heart_rate
  [4, 1, UINT8], // cadence
  [5, 4, UINT32], // distance
  [73, 4, UINT32], // enhanced_speed
  [78, 4, UINT32], // enhanced_altitude
];
const deg2sc = (d: number) => Math.round((d * 2 ** 31) / 180);

/** Lauf mit 120 Records; liefert Datei + Erwartungswerte. */
function buildRun(opts: { chest: boolean; headerSize?: 12 | 14; bigEndianRecords?: boolean }) {
  const w = new FitWriter();
  // file_id
  w.define(0, 0, [[0, 1, ENUM], [1, 2, UINT16], [3, 4, UINT32Z], [4, 4, UINT32]]);
  w.data(0, [4, 1, 12345, START]);
  // device_info: Uhr selbst (index 0, local source) und optischer Sensor (local, local_device_type 10)
  w.define(1, 23, [[253, 4, UINT32], [0, 1, UINT8], [1, 1, UINT8], [25, 1, ENUM]]);
  w.data(1, [START, 0, 0xff, 5]);
  w.data(1, [START, 1, 10, 5]);
  if (opts.chest) w.data(1, [START, 2, 120, 1]); // ANT+ HRM
  // record mit einem Developer-Feld (2 Byte), das übersprungen werden muss
  w.define(2, 20, RECORD_FIELDS, { little: !opts.bigEndianRecords, dev: [2] });
  // Definition für compressed-timestamp-Records (lokaler Typ 3, ohne Feld 253)
  w.define(3, 20, [[3, 1, UINT8], [73, 4, UINT32]]);

  for (let i = 0; i < 120; i++) {
    const ts = START + i;
    const hr = i === 10 ? 0xff : 120 + Math.floor(i / 4);
    const lat = 52.5 + i * 0.00001;
    const lon = 13.4 + i * 0.00002;
    const gpsOk = i !== 20;
    w.data(2, [
      ts,
      gpsOk ? deg2sc(lat) : 0x7fffffff,
      gpsOk ? deg2sc(lon) : 0x7fffffff,
      hr,
      i === 30 ? 0xff : 82,
      i * 280, // 2,8 m pro Sekunde in cm
      i === 40 ? 0xffffffff : 2800,
      (35 + 500) * 5 + i, // 35 m + i/5
    ], [0xab, 0xcd]);
  }
  // compressed timestamp: letzte ts = START+119, Offset → +2 s
  w.compressed(3, (START + 121) & 0x1f, [170, 3000]);
  return w.file(opts.headerSize ?? 14);
}

test("parseFit: Records, Skalierung, Invalid-Werte und compressed timestamp", () => {
  const a = parseFit(buildRun({ chest: false }));
  assert.equal(a.records.length, 121);
  assert.equal(a.start_time_utc, "2026-11-22T07:30:00.000Z");
  assert.equal(a.hr_sensor, "wrist");

  const r0 = a.records[0];
  assert.equal(r0.t_s, 0);
  assert.equal(r0.hr, 120);
  assert.equal(r0.speed_mps, 2.8);
  assert.equal(r0.dist_m, 0);
  assert.equal(r0.alt_m, 35);
  assert.equal(r0.cadence_spm, 164);
  assert.ok(Math.abs(r0.lat! - 52.5) < 1e-6);
  assert.ok(Math.abs(r0.lon! - 13.4) < 1e-6);

  const r5 = a.records[5];
  assert.equal(r5.t_s, 5);
  assert.equal(r5.dist_m, 14);
  assert.equal(r5.alt_m, 36);

  assert.equal(a.records[10].hr, null);
  assert.equal(a.records[20].lat, null);
  assert.equal(a.records[20].lon, null);
  assert.equal(a.records[30].cadence_spm, null);
  assert.equal(a.records[40].speed_mps, null);
  assert.equal(a.records[119].t_s, 119);
  assert.equal(a.records[119].hr, 149);

  const c = a.records[120];
  assert.equal(c.t_s, 121);
  assert.equal(c.hr, 170);
  assert.equal(c.speed_mps, 3);
  assert.equal(c.dist_m, null);
});

test("parseFit: Brustgurt aus device_info (ANT+ heart_rate, nicht Hauptgerät)", () => {
  assert.equal(parseFit(buildRun({ chest: true })).hr_sensor, "chest");
});

test("parseFit: 12-Byte-Header und Big Endian", () => {
  const a = parseFit(buildRun({ chest: false, headerSize: 12, bigEndianRecords: true }));
  assert.equal(a.records.length, 121);
  assert.equal(a.records[3].hr, 120);
  assert.equal(a.records[3].dist_m, 8.4);
  assert.equal(a.records[3].speed_mps, 2.8);
  assert.ok(Math.abs(a.records[3].lat! - 52.50003) < 1e-6);
});

test("parseFit: BLE-Pulsgurt (ble_device_type heart_rate = 1)", () => {
  const w = new FitWriter();
  w.define(0, 23, [[0, 1, UINT8], [1, 1, UINT8], [25, 1, ENUM]]);
  w.data(0, [3, 1, 3]);
  w.define(1, 20, [[253, 4, UINT32], [3, 1, UINT8]]);
  w.data(1, [START, 140]);
  assert.equal(parseFit(w.file()).hr_sensor, "chest");
});

test("parseFit: abgeschnittene Datei liefert die Records bis zum Bruch", () => {
  const full = buildRun({ chest: false });
  const cut = full.subarray(0, Math.floor(full.length / 2));
  const a = parseFit(cut);
  assert.ok(a.records.length > 30 && a.records.length < 121, `records=${a.records.length}`);
  assert.equal(a.records[0].t_s, 0);
});

test("parseFit: Müll und leere Eingaben werfen nicht", () => {
  assert.deepEqual(parseFit(new Uint8Array(0)), { records: [], hr_sensor: null, start_time_utc: null });
  assert.deepEqual(parseFit(new Uint8Array([1, 2, 3])).records, []);
  const junk = new Uint8Array(500).map((_, i) => (i * 37 + 11) & 0xff);
  junk.set([14, 0x20, 0, 0, 0xff, 0xff, 0, 0, 0x2e, 0x46, 0x49, 0x54], 0);
  assert.doesNotThrow(() => parseFit(junk));
  // Data Message ohne Definition
  const w = new FitWriter();
  w.bytes.push(0x05, 1, 2, 3);
  assert.deepEqual(parseFit(w.file()).records, []);
  // Record ohne timestamp wird verworfen, HR fehlt → hr_sensor null
  const w2 = new FitWriter();
  w2.define(0, 20, [[3, 1, UINT8]]);
  w2.data(0, [150]);
  assert.deepEqual(parseFit(w2.file()), { records: [], hr_sensor: null, start_time_utc: null });
});

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface ZipFile {
  name: string;
  data: Uint8Array;
  deflate?: boolean;
  descriptor?: boolean;
}

/** Minimaler ZIP-Writer (CRC = 0, wird nicht geprüft). */
async function buildZip(files: ZipFile[]): Promise<Uint8Array> {
  const out: number[] = [];
  const central: number[] = [];
  const le = (v: number, n: number) => Array.from({ length: n }, (_, i) => (v >>> (8 * i)) & 0xff);
  for (const f of files) {
    const comp = f.deflate ? await deflateRaw(f.data) : f.data;
    const name = [...new TextEncoder().encode(f.name)];
    const method = f.deflate ? 8 : 0;
    const flags = f.descriptor ? 0x08 : 0;
    const offset = out.length;
    const sizes = f.descriptor ? [0, 0] : [comp.length, f.data.length];
    out.push(...le(0x04034b50, 4), ...le(20, 2), ...le(flags, 2), ...le(method, 2), ...le(0, 4), ...le(0, 4),
      ...le(sizes[0], 4), ...le(sizes[1], 4), ...le(name.length, 2), ...le(0, 2), ...name, ...comp);
    if (f.descriptor) out.push(...le(0x08074b50, 4), ...le(0, 4), ...le(comp.length, 4), ...le(f.data.length, 4));
    central.push(...le(0x02014b50, 4), ...le(20, 2), ...le(20, 2), ...le(flags, 2), ...le(method, 2), ...le(0, 4),
      ...le(0, 4), ...le(comp.length, 4), ...le(f.data.length, 4), ...le(name.length, 2), ...le(0, 2), ...le(0, 2),
      ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(offset, 4), ...name);
  }
  const cdOffset = out.length;
  out.push(...central);
  out.push(...le(0x06054b50, 4), ...le(0, 2), ...le(0, 2), ...le(files.length, 2), ...le(files.length, 2),
    ...le(central.length, 4), ...le(cdOffset, 4), ...le(0, 2));
  return new Uint8Array(out);
}

test("unzipFirstFit: stored", async () => {
  const fit = buildRun({ chest: true });
  const zip = await buildZip([{ name: "readme.txt", data: new Uint8Array([1, 2, 3]) }, { name: "123_ACTIVITY.fit", data: fit }]);
  assert.deepEqual(await unzipFirstFit(zip), fit);
});

test("unzipFirstFit: deflate, auch mit Data Descriptor (Bit 3)", async () => {
  const fit = buildRun({ chest: false });
  for (const descriptor of [false, true]) {
    const zip = await buildZip([{ name: "123_ACTIVITY.FIT", data: fit, deflate: true, descriptor }]);
    assert.ok(zip.length < fit.length);
    const out = await unzipFirstFit(zip);
    assert.deepEqual(out, fit);
    assert.equal(parseFit(out).records.length, 121);
  }
});

test("unzipFirstFit: direkt FIT wird unverändert zurückgegeben", async () => {
  const fit = buildRun({ chest: false });
  assert.equal(await unzipFirstFit(fit), fit);
});

test("unzipFirstFit: Müll, ZIP ohne FIT und kaputtes Deflate → leeres Array", async () => {
  assert.equal((await unzipFirstFit(new Uint8Array(0))).length, 0);
  assert.equal((await unzipFirstFit(new Uint8Array(100).fill(0x50))).length, 0);
  const noFit = await buildZip([{ name: "a.txt", data: new Uint8Array([1, 2, 3]) }]);
  assert.equal((await unzipFirstFit(noFit)).length, 0);
  const broken = await buildZip([{ name: "x.fit", data: new Uint8Array(400).fill(0xff), deflate: true }]);
  // Deflate-Daten verfälschen
  const start = 30 + 5;
  broken[start] = 0xff;
  broken[start + 1] = 0xff;
  broken[start + 2] = 0xff;
  assert.equal((await unzipFirstFit(broken)).length, 0);
});
