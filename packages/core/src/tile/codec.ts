// Binärformat der Kacheln (KONZEPT §5.6; Details in docs/TILE-FORMAT.md). Rein, ohne I/O.
//
//   Byte 0..3   Magic "OFT1"
//   Byte 4..7   Länge H des JSON-Headers (uint32 LE); 8 + H ist ein Vielfaches von 8
//   Byte 8..    Header (UTF-8-JSON, mit Leerzeichen auf die Ausrichtung aufgefüllt)
//   danach      Spalten in der Reihenfolge von header.columns, Little Endian, jede 8-Byte-ausgerichtet,
//               mit Nullbytes auf ein Vielfaches von 8 aufgefüllt; keine Bytes nach der letzten Spalte.
//
// Zwei Arten: "footprint" (Bars + Level, GET /api/v1/footprint) und "bars" (nur Bars, GET /api/v1/bars).
// Alle Werte sind ganzzahlig: Preise in price_unit (Int32), Mengen in Lots (Float64, exakt < 2^53),
// Zähler Int32, Zeit Int32 in Sekunden (UTC). Die Zeile eines Levels ist der Zeilenindex
// floor(px / (R·tick_ref_units)); die untere Zeilenkante in price_unit ist row · R · tick_ref_units.

import { isTimeframe, TIMEFRAMES } from './timeframes.ts';

export const TILE_MAGIC = 0x3154464f; // "OFT1" als uint32 LE
export const TILE_FORMAT_VERSION = 1;

export type TileKind = 'footprint' | 'bars';
export type ColumnType = 'i32' | 'f64';

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  length: number;
}

/** Header-Felder, die der Erzeuger setzt (Spalten und Längen ergänzt der Encoder). */
export interface TileMeta {
  kind: TileKind;
  sym: string;
  tf: string;
  tfSec: number;
  /** Zeilengröße in Ticks; nur bei footprint (bei bars null). */
  R: number | null;
  priceDecimals: number;
  qtyDecimals: number;
  tickRefUnits: number;
  /** Abgedeckter Zeitraum [from, to) in ms UTC. */
  from: number;
  to: number;
  /** Kachelindex und -länge (footprint); bei bars null. */
  tile: { index: number; n: number } | null;
  /** Kachelversion (KONZEPT §5.4): Hash der Tagesversionen + Konfigurationsversion. Gleichzeitig ETag. */
  dataVersion: string;
  /** true, wenn alle überdeckten Tage final_* sind (Kachel unveränderlich). */
  final: boolean;
}

export interface TileHeader extends TileMeta {
  format: number;
  nBars: number;
  nLevels: number;
  columns: ColumnSpec[];
}

export interface BarColumns {
  /** Bar-Beginn in Sekunden (UTC), streng aufsteigend, Vielfaches von tfSec. */
  time: Int32Array;
  open: Int32Array;
  high: Int32Array;
  low: Int32Array;
  close: Int32Array;
  /** Lots, Aggressor Käufer ("Ask"). */
  buyQ: Float64Array;
  /** Lots, Aggressor Verkäufer ("Bid"). */
  sellQ: Float64Array;
  /** Anzahl aggTrades. */
  buyA: Int32Array;
  sellA: Int32Array;
}

export interface LevelColumns {
  /** nBars + 1 Einträge: Level von Bar i sind [levelOffset[i], levelOffset[i+1]). */
  levelOffset: Int32Array;
  /** Zeilenindex, je Bar streng aufsteigend. */
  row: Int32Array;
  buy: Float64Array;
  sell: Float64Array;
  buyA: Int32Array;
  sellA: Int32Array;
}

export interface TileData {
  meta: TileMeta;
  bars: BarColumns;
  /** Pflicht bei footprint, fehlt bei bars. */
  levels?: LevelColumns;
  /** Zusätzliche Spalten (Erweiterungspunkt, z. B. Stats-Felder in späteren Phasen); werden durchgereicht. */
  extra?: Record<string, Int32Array | Float64Array>;
}

export interface DecodedTile extends TileData {
  header: TileHeader;
}

export class TileFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TileFormatError';
  }
}

const BAR_COLUMNS: readonly [keyof BarColumns, ColumnType][] = [
  ['time', 'i32'],
  ['open', 'i32'],
  ['high', 'i32'],
  ['low', 'i32'],
  ['close', 'i32'],
  ['buyQ', 'f64'],
  ['sellQ', 'f64'],
  ['buyA', 'i32'],
  ['sellA', 'i32'],
];

// Spaltennamen der Level im Header tragen das Präfix "lv." (buyA/sellA gibt es auch bei den Bars).
const LEVEL_COLUMNS: readonly [keyof LevelColumns, ColumnType][] = [
  ['levelOffset', 'i32'],
  ['row', 'i32'],
  ['buy', 'f64'],
  ['sell', 'f64'],
  ['buyA', 'i32'],
  ['sellA', 'i32'],
];

const levelName = (k: keyof LevelColumns) => (k === 'levelOffset' ? 'levelOffset' : `lv.${k}`);

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
function assertLittleEndian(): void {
  if (!LITTLE_ENDIAN) throw new TileFormatError('Plattform ist nicht Little Endian');
}

// Nicht per Bit-Operation (32 Bit): Längen aus einem fremden Header können > 2^31 sein (Review H1).
const align8 = (n: number) => Math.ceil(n / 8) * 8;
const bytesOf = (t: ColumnType) => (t === 'i32' ? 4 : 8);

function columnList(data: TileData): { spec: ColumnSpec; arr: Int32Array | Float64Array }[] {
  const nBars = data.bars.time.length;
  const out: { spec: ColumnSpec; arr: Int32Array | Float64Array }[] = [];
  for (const [k, type] of BAR_COLUMNS) {
    const arr = data.bars[k];
    if (arr.length !== nBars)
      throw new TileFormatError(`Spalte ${k}: Länge ${arr.length} ≠ ${nBars}`);
    out.push({ spec: { name: k, type, length: arr.length }, arr });
  }
  if (data.meta.kind === 'footprint') {
    const lv = data.levels;
    if (!lv) throw new TileFormatError('footprint-Kachel ohne Level');
    for (const [k, type] of LEVEL_COLUMNS) {
      const arr = lv[k];
      out.push({ spec: { name: levelName(k), type, length: arr.length }, arr });
    }
  } else if (data.levels) {
    throw new TileFormatError('bars-Kachel mit Level');
  }
  for (const [name, arr] of Object.entries(data.extra ?? {})) {
    if (!name.startsWith('x.'))
      throw new TileFormatError(`Zusatzspalte "${name}" braucht Präfix "x."`);
    out.push({
      spec: { name, type: arr instanceof Int32Array ? 'i32' : 'f64', length: arr.length },
      arr,
    });
  }
  return out;
}

/** Kodiert eine Kachel. Prüft vorher dieselben Invarianten wie der Decoder (nie ungültige Kacheln ausliefern). */
export function encodeTile(data: TileData): Uint8Array {
  assertLittleEndian();
  const cols = columnList(data);
  const nBars = data.bars.time.length;
  const nLevels = data.levels ? data.levels.row.length : 0;
  const header: TileHeader = {
    format: TILE_FORMAT_VERSION,
    ...data.meta,
    nBars,
    nLevels,
    columns: cols.map((c) => c.spec),
  };
  validateHeader(header);
  validateContent(header, data.bars, data.levels);
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
  dv.setUint32(0, TILE_MAGIC, true);
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

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function validateHeader(h: TileHeader): void {
  const fail = (m: string): never => {
    throw new TileFormatError(`Header: ${m}`);
  };
  if (h.format !== TILE_FORMAT_VERSION) fail(`Formatversion ${String(h.format)} nicht unterstützt`);
  if (h.kind !== 'footprint' && h.kind !== 'bars') fail(`unbekannte Art ${String(h.kind)}`);
  if (typeof h.sym !== 'string' || h.sym.length === 0) fail('sym fehlt');
  if (typeof h.tf !== 'string' || h.tf.length === 0) fail('tf fehlt');
  if (!isInt(h.tfSec) || h.tfSec <= 0) fail('tfSec ungültig');
  if (isTimeframe(h.tf) && TIMEFRAMES[h.tf] !== h.tfSec)
    fail(`tf ${h.tf} passt nicht zu tfSec ${h.tfSec}`);
  if (!isInt(h.priceDecimals) || h.priceDecimals < 0 || h.priceDecimals > 8)
    fail('priceDecimals ungültig');
  if (!isInt(h.qtyDecimals) || h.qtyDecimals < 0 || h.qtyDecimals > 8) fail('qtyDecimals ungültig');
  if (!isInt(h.tickRefUnits) || h.tickRefUnits <= 0) fail('tickRefUnits ungültig');
  if (!isInt(h.from) || !isInt(h.to) || h.from > h.to) fail('Zeitraum ungültig');
  if (h.from % 1000 !== 0 || h.to % 1000 !== 0) fail('Zeitraum nicht sekundengenau');
  if (h.from < 0 || h.to / 1000 > 2 ** 31) fail('Zeitraum außerhalb Int32-Sekunden');
  if (typeof h.dataVersion !== 'string') fail('dataVersion fehlt');
  if (typeof h.final !== 'boolean') fail('final fehlt');
  if (!isInt(h.nBars) || h.nBars < 0 || !isInt(h.nLevels) || h.nLevels < 0)
    fail('Anzahlen ungültig');
  if (!Array.isArray(h.columns)) fail('columns fehlt');
  if (h.kind === 'footprint') {
    if (!isInt(h.R) || h.R <= 0) fail('R ungültig');
    const t = h.tile;
    if (t === null || typeof t !== 'object' || !isInt(t.index) || !isInt(t.n) || t.n <= 0) {
      fail('tile ungültig');
    } else {
      const span = t.n * h.tfSec * 1000;
      if (h.from !== t.index * span || h.to !== (t.index + 1) * span) {
        fail('Zeitraum passt nicht zu tile.index · n · tf');
      }
    }
  } else {
    if (h.R !== null) fail('R muss bei bars null sein');
    if (h.tile !== null) fail('tile muss bei bars null sein');
    if (h.nLevels !== 0) fail('bars-Kachel mit Leveln');
  }
  const seen = new Set<string>();
  for (const c of h.columns) {
    if (typeof c !== 'object' || c === null) fail('Spaltenangabe ungültig');
    if (typeof c.name !== 'string' || seen.has(c.name))
      fail(`Spaltenname ${String(c.name)} ungültig/doppelt`);
    seen.add(c.name);
    if (c.type !== 'i32' && c.type !== 'f64') fail(`Spalte ${c.name}: Typ ${String(c.type)}`);
    if (!isInt(c.length) || c.length < 0) fail(`Spalte ${c.name}: Länge ungültig`);
  }
  const need = (name: string, type: ColumnType, length: number) => {
    const c = h.columns.find((x) => x.name === name);
    if (!c) fail(`Pflichtspalte ${name} fehlt`);
    else if (c.type !== type || c.length !== length)
      fail(`Spalte ${name}: ${c.type}[${c.length}], erwartet ${type}[${length}]`);
  };
  for (const [k, type] of BAR_COLUMNS) need(k, type, h.nBars);
  if (h.kind === 'footprint') {
    for (const [k, type] of LEVEL_COLUMNS) {
      need(levelName(k), type, k === 'levelOffset' ? h.nBars + 1 : h.nLevels);
    }
  }
  for (const c of h.columns) {
    const known =
      BAR_COLUMNS.some(([k]) => k === c.name) ||
      (h.kind === 'footprint' && LEVEL_COLUMNS.some(([k]) => levelName(k) === c.name));
    if (!known && !c.name.startsWith('x.')) fail(`unbekannte Spalte ${c.name}`);
  }
}

/**
 * Inhaltliche Invarianten: Zeiten ausgerichtet, aufsteigend, im Zeitraum; OHLC konsistent;
 * Mengen ganzzahlig ≥ 0; Level je Bar streng aufsteigend innerhalb [Zeile(low), Zeile(high)];
 * Level-Summen = Bar-Summen (Footprint-Summen = Bars).
 */
function validateContent(h: TileHeader, b: BarColumns, lv: LevelColumns | undefined): void {
  const fail = (m: string): never => {
    throw new TileFormatError(`Inhalt: ${m}`);
  };
  const fromSec = h.from / 1000;
  const toSec = h.to / 1000;
  const width = h.kind === 'footprint' ? h.R! * h.tickRefUnits : 0;
  let prev = -Infinity;
  for (let i = 0; i < h.nBars; i++) {
    const t = b.time[i]!;
    if (t <= prev) fail(`Bar ${i}: Zeit nicht streng aufsteigend`);
    prev = t;
    if (t % h.tfSec !== 0) fail(`Bar ${i}: Zeit ${t} nicht am Zeitrahmen ausgerichtet`);
    if (t < fromSec || t >= toSec) fail(`Bar ${i}: Zeit ${t} außerhalb [from, to)`);
    const o = b.open[i]!;
    const hi = b.high[i]!;
    const lo = b.low[i]!;
    const c = b.close[i]!;
    if (!(lo > 0 && lo <= hi && o >= lo && o <= hi && c >= lo && c <= hi))
      fail(`Bar ${i}: OHLC inkonsistent`);
    const bq = b.buyQ[i]!;
    const sq = b.sellQ[i]!;
    if (!Number.isSafeInteger(bq) || !Number.isSafeInteger(sq) || bq < 0 || sq < 0)
      fail(`Bar ${i}: Mengen ungültig`);
    if (bq + sq <= 0) fail(`Bar ${i}: Bar ohne Menge`);
    if (b.buyA[i]! < 0 || b.sellA[i]! < 0) fail(`Bar ${i}: Zähler negativ`);
  }
  if (h.kind !== 'footprint' || !lv) return;
  const off = lv.levelOffset;
  if (off[0] !== 0 || off[h.nBars] !== h.nLevels) fail('levelOffset: Rand ungültig');
  for (let i = 0; i < h.nBars; i++) {
    const s = off[i]!;
    const e = off[i + 1]!;
    if (e <= s) fail(`Bar ${i}: keine Level bzw. levelOffset fallend`);
    const hi = b.high[i]!;
    const lo = b.low[i]!;
    const rLo = (lo - (lo % width)) / width;
    const rHi = (hi - (hi % width)) / width;
    let sb = 0;
    let ss = 0;
    let sba = 0;
    let ssa = 0;
    let pr = -Infinity;
    for (let j = s; j < e; j++) {
      const r = lv.row[j]!;
      if (r <= pr) fail(`Bar ${i}: Zeilen nicht streng aufsteigend`);
      pr = r;
      if (r < rLo || r > rHi) fail(`Bar ${i}: Zeile ${r} außerhalb [${rLo}, ${rHi}]`);
      const bq = lv.buy[j]!;
      const sq = lv.sell[j]!;
      if (!Number.isSafeInteger(bq) || !Number.isSafeInteger(sq) || bq < 0 || sq < 0)
        fail(`Level ${j}: Mengen ungültig`);
      if (lv.buyA[j]! < 0 || lv.sellA[j]! < 0) fail(`Level ${j}: Zähler negativ`);
      sb += bq;
      ss += sq;
      sba += lv.buyA[j]!;
      ssa += lv.sellA[j]!;
    }
    if (sb !== b.buyQ[i] || ss !== b.sellQ[i] || sba !== b.buyA[i] || ssa !== b.sellA[i]) {
      fail(`Bar ${i}: Level-Summen ≠ Bar-Summen`);
    }
  }
}

/**
 * Dekodiert eine Kachel. Die Spalten sind Sichten auf den Puffer (keine Kopie), sofern die Eingabe
 * 8-Byte-ausgerichtet ist; sonst wird einmal ausgerichtet kopiert. Wirft TileFormatError bei jeder
 * Abweichung (Länge, Magic, Header, Spalten, Padding, Inhalt).
 */
export function decodeTile(input: Uint8Array | ArrayBuffer): DecodedTile {
  assertLittleEndian();
  let u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.byteOffset % 8 !== 0) u8 = u8.slice();
  if (u8.length < 8) throw new TileFormatError('zu kurz');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== TILE_MAGIC) throw new TileFormatError('Magic fehlt');
  const hlen = dv.getUint32(4, true);
  if (8 + hlen > u8.length) throw new TileFormatError('Header länger als Daten');
  if ((8 + hlen) % 8 !== 0) throw new TileFormatError('Header nicht ausgerichtet');
  let header: TileHeader;
  try {
    header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(u8.subarray(8, 8 + hlen)),
    ) as TileHeader;
  } catch (e) {
    throw new TileFormatError(
      `Header kein gültiges JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new TileFormatError('Header ist kein Objekt');
  }
  validateHeader(header);
  let off = 8 + hlen;
  const arrays = new Map<string, Int32Array | Float64Array>();
  for (const c of header.columns) {
    const len = c.length * bytesOf(c.type);
    const padded = align8(len);
    if (off + padded > u8.length)
      throw new TileFormatError(`Spalte ${c.name} über das Ende hinaus`);
    for (let p = off + len; p < off + padded; p++) {
      if (u8[p] !== 0) throw new TileFormatError(`Spalte ${c.name}: Padding nicht null`);
    }
    const abs = u8.byteOffset + off;
    arrays.set(
      c.name,
      c.type === 'i32'
        ? new Int32Array(u8.buffer, abs, c.length)
        : new Float64Array(u8.buffer, abs, c.length),
    );
    off += padded;
  }
  if (off !== u8.length)
    throw new TileFormatError(`${u8.length - off} Bytes nach der letzten Spalte`);
  const get = <T extends Int32Array | Float64Array>(name: string) => arrays.get(name) as T;
  const bars: BarColumns = {
    time: get('time'),
    open: get('open'),
    high: get('high'),
    low: get('low'),
    close: get('close'),
    buyQ: get('buyQ'),
    sellQ: get('sellQ'),
    buyA: get('buyA'),
    sellA: get('sellA'),
  };
  let levels: LevelColumns | undefined;
  if (header.kind === 'footprint') {
    levels = {
      levelOffset: get('levelOffset'),
      row: get('lv.row'),
      buy: get('lv.buy'),
      sell: get('lv.sell'),
      buyA: get('lv.buyA'),
      sellA: get('lv.sellA'),
    };
  }
  validateContent(header, bars, levels);
  const extra: Record<string, Int32Array | Float64Array> = {};
  for (const [k, v] of arrays) if (k.startsWith('x.')) extra[k] = v;
  const meta: TileMeta = {
    kind: header.kind,
    sym: header.sym,
    tf: header.tf,
    tfSec: header.tfSec,
    R: header.R,
    priceDecimals: header.priceDecimals,
    qtyDecimals: header.qtyDecimals,
    tickRefUnits: header.tickRefUnits,
    from: header.from,
    to: header.to,
    tile: header.tile,
    dataVersion: header.dataVersion,
    final: header.final,
  };
  const out: DecodedTile = { header, meta, bars };
  if (levels) out.levels = levels;
  if (Object.keys(extra).length > 0) out.extra = extra;
  return out;
}

/** Rohgröße einer Kachel in Bytes ohne Header (für Größenabschätzungen und Tests). */
export function tileColumnBytes(nBars: number, nLevels: number, kind: TileKind): number {
  let b = align8(nBars * 4) * 7 + align8(nBars * 8) * 2;
  if (kind === 'footprint')
    b += align8((nBars + 1) * 4) + align8(nLevels * 4) * 3 + align8(nLevels * 8) * 2;
  return b;
}
