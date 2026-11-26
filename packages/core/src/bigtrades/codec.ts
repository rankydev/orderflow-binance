// Binärformat der Big-Trades-Antwort (GET /api/v1/bigtrades; Vertrag in docs/BIGTRADES-API.md).
// Rein, ohne I/O. Gleicher Containeraufbau wie die Kacheln (docs/TILE-FORMAT.md), eigenes Magic,
// damit ein Kachel-Decoder eine solche Antwort nie als Kachel liest:
//
//   Byte 0..3   Magic "OFB1"
//   Byte 4..7   Länge H des JSON-Headers (uint32 LE); 8 + H ist ein Vielfaches von 8
//   Byte 8..    Header (UTF-8-JSON, mit Leerzeichen auf die Ausrichtung aufgefüllt)
//   danach      Spalten in der Reihenfolge von header.columns, Little Endian, jede 8-Byte-ausgerichtet,
//               mit Nullbytes auf ein Vielfaches von 8 aufgefüllt; keine Bytes nach der letzten Spalte.
//
// Eine Zeile je Order (Order-Regel v1, KONZEPT §3.7) mit notional ≥ minN, nach (ts, firstAggId)
// aufsteigend. Alle Werte ganzzahlig: Preise in price_unit (i32), Lots und Notional
// (price_unit·qty_unit) als f64 (exakt < 2^53), Zeit in ms (f64). VWAP = notional / qty (price_unit).
// `coverage` sagt je Teilbereich von [from, to), ob dort Order-Daten vorliegen: wo nicht, heißt eine
// fehlende Zeile „keine Daten", nicht „kein Big Trade".

import { isTimeframe, TIMEFRAMES } from '../tile/timeframes.ts';

export const BIGTRADES_MAGIC = 0x3142464f; // "OFB1" als uint32 LE
export const BIGTRADES_FORMAT_VERSION = 1;

/**
 * ok: Order-Daten vollständig ab minN (Tagesuntergrenze ≤ minN). partial: Order-Daten nur ab der
 * höheren Tagesuntergrenze floorN (Orders in [minN, floorN) fehlen). none: keine Order-Daten.
 */
export type CoverageStatus = 'ok' | 'partial' | 'none';
/**
 * Grund bei partial/none: floor_above (Tag mit höherer Untergrenze geschrieben), no_day (keine
 * gespeicherten Daten an dem Tag), digest_v1 (vor den Order-Daten geschrieben, Neuimport ausstehend),
 * no_floor (ohne Untergrenze geschrieben: keine big orders gebildet), unknown_totals (laufender Tag,
 * Vollständigkeit der Order-Daten nicht nachgewiesen).
 */
export type CoverageReason = 'floor_above' | 'no_day' | 'digest_v1' | 'no_floor' | 'unknown_totals';

export interface CoverageSpan {
  /** [from, to) in ms UTC, an UTC-Tagen bzw. den Rändern der Anfrage. */
  from: number;
  to: number;
  status: CoverageStatus;
  reason: CoverageReason | null;
  /** Untergrenze, mit der die Tage geschrieben wurden (price_unit·qty_unit); null bei none. */
  floorN: number | null;
  /** Alle Tage des Teilbereichs unveränderlich (final). */
  final: boolean;
}

export interface BigTradesMeta {
  kind: 'bigtrades';
  sym: string;
  /** Zeitrahmen der Bars, auf die die Orders gesetzt werden (Spalte bar, Ausdünnung je Bar). */
  tf: string;
  tfSec: number;
  priceDecimals: number;
  qtyDecimals: number;
  tickRefUnits: number;
  /** Notional in USDT = notional / 10^notionalDecimals (= priceDecimals + qtyDecimals). */
  notionalDecimals: number;
  /** Angefragter Zeitraum [from, to) in ms UTC. */
  from: number;
  to: number;
  /** Angefragte Schwelle in ganzen USDT und als Notional (minUsdt · 10^notionalDecimals). */
  minUsdt: number;
  minN: number;
  /** Zeilengrenze dieser Antwort (limits.bigtrades.maxRows). */
  maxRows: number;
  /** Orders ≥ minN in den abgedeckten Teilbereichen (vor der Ausdünnung). */
  total: number;
  /** total − n: ausgelassen durch die Ausdünnung. */
  omitted: number;
  /** Ausdünnung: je (bar, side) die k größten Orders; null = nicht ausgedünnt (omitted = 0). */
  k: number | null;
  /** Lückenlose Zerlegung von [from, to), aufsteigend. */
  coverage: CoverageSpan[];
  dataVersion: string;
  /** Alle überdeckten Tage unveränderlich und mit Order-Daten (Antwort ändert sich nicht mehr). */
  final: boolean;
}

export type BigTradesColumnType = 'i32' | 'f64';

export interface BigTradesColumnSpec {
  name: string;
  type: BigTradesColumnType;
  length: number;
}

export interface BigTradesHeader extends BigTradesMeta {
  format: number;
  n: number;
  columns: BigTradesColumnSpec[];
}

export interface BigTradeColumns {
  /** Zeit T der Order in ms UTC. */
  ts: Float64Array;
  /** Beginn der Bar des Zeitrahmens tf in Sekunden UTC (floor(ts / 1000 / tfSec) · tfSec). */
  bar: Int32Array;
  /** 1 = Käufer-Aggressor (buy), 2 = Verkäufer-Aggressor (sell). */
  side: Int32Array;
  /** Preis des ersten / letzten aggTrades der Order (price_unit). */
  pxFirst: Int32Array;
  pxLast: Int32Array;
  /** Lots. */
  qty: Float64Array;
  /** Σ px · lots (price_unit·qty_unit), exakt. */
  notional: Float64Array;
  /** Anzahl aggTrades. */
  aggN: Int32Array;
  /** aggId des ersten aggTrades (stabiler Schlüssel der Order). */
  firstAggId: Float64Array;
}

export interface BigTradesData {
  meta: BigTradesMeta;
  rows: BigTradeColumns;
}

export interface DecodedBigTrades extends BigTradesData {
  header: BigTradesHeader;
}

export class BigTradesFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BigTradesFormatError';
  }
}

const COLUMNS: readonly [keyof BigTradeColumns, BigTradesColumnType][] = [
  ['ts', 'f64'],
  ['bar', 'i32'],
  ['side', 'i32'],
  ['pxFirst', 'i32'],
  ['pxLast', 'i32'],
  ['qty', 'f64'],
  ['notional', 'f64'],
  ['aggN', 'i32'],
  ['firstAggId', 'f64'],
];

const STATUSES: readonly CoverageStatus[] = ['ok', 'partial', 'none'];
const NONE_REASONS: readonly CoverageReason[] = [
  'no_day',
  'digest_v1',
  'no_floor',
  'unknown_totals',
];

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const align8 = (n: number) => Math.ceil(n / 8) * 8;
const bytesOf = (t: BigTradesColumnType) => (t === 'i32' ? 4 : 8);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const DAY_MS = 86_400_000;

/** Kodiert eine Big-Trades-Antwort; prüft vorher dieselben Invarianten wie der Decoder. */
export function encodeBigTrades(data: BigTradesData): Uint8Array {
  if (!LITTLE_ENDIAN) throw new BigTradesFormatError('Plattform ist nicht Little Endian');
  const n = data.rows.ts.length;
  const cols = COLUMNS.map(([k, type]) => {
    const arr = data.rows[k];
    if (arr.length !== n) throw new BigTradesFormatError(`Spalte ${k}: Länge ${arr.length} ≠ ${n}`);
    return { spec: { name: k, type, length: n }, arr };
  });
  const header: BigTradesHeader = {
    format: BIGTRADES_FORMAT_VERSION,
    ...data.meta,
    n,
    columns: cols.map((c) => c.spec),
  };
  validateHeader(header);
  validateRows(header, data.rows);
  let json = JSON.stringify(header);
  let hdr = new TextEncoder().encode(json);
  const pad = align8(8 + hdr.length) - (8 + hdr.length);
  if (pad > 0) {
    json += ' '.repeat(pad);
    hdr = new TextEncoder().encode(json);
  }
  let total = 8 + hdr.length;
  for (const c of cols) total += align8(c.spec.length * bytesOf(c.spec.type));
  const buf = new ArrayBuffer(total);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  dv.setUint32(0, BIGTRADES_MAGIC, true);
  dv.setUint32(4, hdr.length, true);
  u8.set(hdr, 8);
  let off = 8 + hdr.length;
  for (const c of cols) {
    const len = c.spec.length * bytesOf(c.spec.type);
    u8.set(new Uint8Array(c.arr.buffer, c.arr.byteOffset, len), off);
    off += align8(len);
  }
  return u8;
}

function validateHeader(h: BigTradesHeader): void {
  const fail = (m: string): never => {
    throw new BigTradesFormatError(`Header: ${m}`);
  };
  if (h.format !== BIGTRADES_FORMAT_VERSION)
    fail(`Formatversion ${String(h.format)} nicht unterstützt`);
  if (h.kind !== 'bigtrades') fail(`unbekannte Art ${String(h.kind)}`);
  if (typeof h.sym !== 'string' || h.sym.length === 0) fail('sym fehlt');
  if (typeof h.tf !== 'string' || !isTimeframe(h.tf)) fail('tf ungültig');
  if (TIMEFRAMES[h.tf as keyof typeof TIMEFRAMES] !== h.tfSec)
    fail(`tf ${h.tf} passt nicht zu tfSec ${h.tfSec}`);
  for (const k of ['priceDecimals', 'qtyDecimals'] as const)
    if (!isInt(h[k]) || h[k] < 0 || h[k] > 8) fail(`${k} ungültig`);
  if (!isInt(h.tickRefUnits) || h.tickRefUnits <= 0) fail('tickRefUnits ungültig');
  if (h.notionalDecimals !== h.priceDecimals + h.qtyDecimals) fail('notionalDecimals ungültig');
  if (!isInt(h.from) || !isInt(h.to) || h.from >= h.to || h.from < 0) fail('Zeitraum ungültig');
  if (h.from % (h.tfSec * 1000) !== 0 || h.to % (h.tfSec * 1000) !== 0)
    fail('Zeitraum nicht am Zeitrahmen ausgerichtet');
  if (h.to / 1000 > 2 ** 31) fail('Zeitraum außerhalb Int32-Sekunden');
  if (!isInt(h.minUsdt) || h.minUsdt <= 0) fail('minUsdt ungültig');
  if (!isInt(h.minN) || h.minN !== h.minUsdt * 10 ** h.notionalDecimals) fail('minN ungültig');
  if (!isInt(h.maxRows) || h.maxRows <= 0) fail('maxRows ungültig');
  if (!isInt(h.n) || h.n < 0 || h.n > h.maxRows) fail('n ungültig');
  if (!isInt(h.total) || !isInt(h.omitted) || h.omitted < 0 || h.total !== h.n + h.omitted)
    fail('total/omitted ungültig');
  if (h.omitted === 0 ? h.k !== null : !isInt(h.k) || h.k < 1) fail('k ungültig');
  if (typeof h.dataVersion !== 'string') fail('dataVersion fehlt');
  if (typeof h.final !== 'boolean') fail('final fehlt');
  if (!Array.isArray(h.coverage) || h.coverage.length === 0) fail('coverage fehlt');
  let at = h.from;
  let allFinal = true;
  for (const c of h.coverage) {
    if (typeof c !== 'object' || c === null) fail('coverage-Eintrag ungültig');
    if (c.from !== at || !isInt(c.to) || c.to <= c.from || c.to > h.to)
      fail('coverage nicht lückenlos aufsteigend');
    if (c.to !== h.to && c.to % DAY_MS !== 0) fail('coverage-Grenze nicht an einem UTC-Tag');
    if (!STATUSES.includes(c.status)) fail(`coverage-Status ${String(c.status)}`);
    if (typeof c.final !== 'boolean') fail('coverage.final fehlt');
    if (c.status === 'ok') {
      if (c.reason !== null || !isInt(c.floorN) || c.floorN <= 0 || c.floorN > h.minN)
        fail('coverage ok: reason/floorN ungültig');
    } else if (c.status === 'partial') {
      if (c.reason !== 'floor_above' || !isInt(c.floorN) || c.floorN <= h.minN)
        fail('coverage partial: reason/floorN ungültig');
    } else if (!NONE_REASONS.includes(c.reason as CoverageReason) || c.floorN !== null) {
      fail('coverage none: reason/floorN ungültig');
    }
    if (!c.final || c.status === 'none') allFinal = false;
    at = c.to;
  }
  if (at !== h.to) fail('coverage deckt [from, to) nicht ab');
  if (h.final && !allFinal) fail('final trotz nicht finaler oder fehlender Order-Daten');
  if (!Array.isArray(h.columns) || h.columns.length !== COLUMNS.length) fail('columns ungültig');
  COLUMNS.forEach(([k, type], i) => {
    const c = h.columns[i];
    if (!c || c.name !== k || c.type !== type || c.length !== h.n)
      fail(`Spalte ${i}: erwartet ${k} ${type}[${h.n}]`);
  });
}

/** Inhaltliche Invarianten der Zeilen (Reihenfolge, Bar, Seite, Mengen, Schwelle, Abdeckung). */
function validateRows(h: BigTradesHeader, r: BigTradeColumns): void {
  const fail = (m: string): never => {
    throw new BigTradesFormatError(`Inhalt: ${m}`);
  };
  const tfMs = h.tfSec * 1000;
  let ci = 0;
  let pts = -Infinity;
  let pid = -Infinity;
  for (let i = 0; i < h.n; i++) {
    const ts = r.ts[i]!;
    const id = r.firstAggId[i]!;
    if (!isInt(ts) || ts < h.from || ts >= h.to) fail(`Zeile ${i}: ts außerhalb [from, to)`);
    if (!isInt(id) || id < 0) fail(`Zeile ${i}: firstAggId ungültig`);
    if (ts < pts || (ts === pts && id <= pid))
      fail(`Zeile ${i}: nicht streng aufsteigend nach (ts, firstAggId)`);
    pts = ts;
    pid = id;
    if (r.bar[i]! * 1000 !== ts - (ts % tfMs)) fail(`Zeile ${i}: bar passt nicht zu ts`);
    const side = r.side[i]!;
    if (side !== 1 && side !== 2) fail(`Zeile ${i}: side ${side}`);
    if (r.pxFirst[i]! <= 0 || r.pxLast[i]! <= 0) fail(`Zeile ${i}: Preis ≤ 0`);
    const q = r.qty[i]!;
    const nt = r.notional[i]!;
    if (!isInt(q) || q <= 0) fail(`Zeile ${i}: qty ungültig`);
    if (!isInt(nt) || nt < h.minN) fail(`Zeile ${i}: notional ungültig oder unter minN`);
    if (r.aggN[i]! < 1) fail(`Zeile ${i}: aggN < 1`);
    while (ci < h.coverage.length && h.coverage[ci]!.to <= ts) ci++;
    const c = h.coverage[ci];
    if (!c || c.status === 'none') fail(`Zeile ${i}: in einem Bereich ohne Order-Daten`);
    else if (nt < c.floorN!) fail(`Zeile ${i}: notional unter der Tagesuntergrenze`);
  }
}

/**
 * Dekodiert eine Big-Trades-Antwort. Spalten sind Sichten auf den Puffer (keine Kopie), sofern die
 * Eingabe 8-Byte-ausgerichtet ist. Wirft BigTradesFormatError bei jeder Abweichung.
 */
export function decodeBigTrades(input: Uint8Array | ArrayBuffer): DecodedBigTrades {
  if (!LITTLE_ENDIAN) throw new BigTradesFormatError('Plattform ist nicht Little Endian');
  let u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.byteOffset % 8 !== 0) u8 = u8.slice();
  if (u8.length < 8) throw new BigTradesFormatError('zu kurz');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== BIGTRADES_MAGIC) throw new BigTradesFormatError('Magic fehlt');
  const hlen = dv.getUint32(4, true);
  if (8 + hlen > u8.length) throw new BigTradesFormatError('Header länger als Daten');
  if ((8 + hlen) % 8 !== 0) throw new BigTradesFormatError('Header nicht ausgerichtet');
  let header: BigTradesHeader;
  try {
    header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(u8.subarray(8, 8 + hlen)),
    ) as BigTradesHeader;
  } catch (e) {
    throw new BigTradesFormatError(
      `Header kein gültiges JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header))
    throw new BigTradesFormatError('Header ist kein Objekt');
  validateHeader(header);
  let off = 8 + hlen;
  const arrays: Record<string, Int32Array | Float64Array> = {};
  for (const c of header.columns) {
    const len = c.length * bytesOf(c.type);
    const padded = align8(len);
    if (off + padded > u8.length)
      throw new BigTradesFormatError(`Spalte ${c.name} über das Ende hinaus`);
    for (let p = off + len; p < off + padded; p++)
      if (u8[p] !== 0) throw new BigTradesFormatError(`Spalte ${c.name}: Padding nicht null`);
    const abs = u8.byteOffset + off;
    arrays[c.name] =
      c.type === 'i32'
        ? new Int32Array(u8.buffer, abs, c.length)
        : new Float64Array(u8.buffer, abs, c.length);
    off += padded;
  }
  if (off !== u8.length)
    throw new BigTradesFormatError(`${u8.length - off} Bytes nach der letzten Spalte`);
  const rows = arrays as unknown as BigTradeColumns;
  validateRows(header, rows);
  const h = header;
  const meta: BigTradesMeta = {
    kind: h.kind,
    sym: h.sym,
    tf: h.tf,
    tfSec: h.tfSec,
    priceDecimals: h.priceDecimals,
    qtyDecimals: h.qtyDecimals,
    tickRefUnits: h.tickRefUnits,
    notionalDecimals: h.notionalDecimals,
    from: h.from,
    to: h.to,
    minUsdt: h.minUsdt,
    minN: h.minN,
    maxRows: h.maxRows,
    total: h.total,
    omitted: h.omitted,
    k: h.k,
    coverage: h.coverage,
    dataVersion: h.dataVersion,
    final: h.final,
  };
  return { header, meta, rows };
}
