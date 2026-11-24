// Kachel-Cache der Footprint-Daten (KONZEPT §5.4, §7.3): dekodierte Typed Arrays plus einmal beim Laden
// berechnete Ableitungen (POC je Bar, Slot-Tabelle Zeit → Bar, Farbreferenz je Bar). Zelltexte
// formatiert ein begrenzter Cache beim Zeichnen (TextCache; Review W5: die frühere Tabelle je Wert wuchs
// unbegrenzt). Nicht reaktiv; LRU nach Zellzahl (≤ 2 Mio. Zellen), sichtbare Kacheln bleiben.
import { decodeTile, type DecodedTile } from '@orderflow/core/browser';
import { COLOR_REF_PERCENTILE, quantileInPlace } from './color.ts';
import { TextCache } from './format.ts';

export const CACHE_MAX_CELLS = 2_000_000;

export interface PreparedTile {
  /** sym|tf|R */
  series: string;
  k: number;
  n: number;
  tfSec: number;
  fromSec: number;
  nBars: number;
  cells: number;
  time: Int32Array;
  high: Int32Array;
  low: Int32Array;
  levelOffset: Int32Array;
  row: Int32Array;
  buy: Float64Array;
  sell: Float64Array;
  /** Zeilenindex des POC je Bar. */
  poc: Int32Array;
  /** slot[(t − fromSec)/tfSec] = Bar-Index oder −1. */
  slot: Int32Array;
  /** Farbreferenz je Bar (P95 von |Delta| bzw. von buy/sell) für den Bereich „je Bar". */
  refDelta: Float64Array;
  refVol: Float64Array;
  /** buyQ + sellQ je Bar (Querprüfung gegen /bars, H-1). */
  vol: Float64Array;
  /** Bytes der Typed Arrays (für die Speicheranzeige). */
  bytes: number;
  /** Alle überdeckten Tage final (unveränderlich); sonst läuft die Kachel nach NONFINAL_TTL_MS ab (W3). */
  final: boolean;
  dataVersion: string;
  loadedAt: number;
}

/** Nicht finale Kacheln (provisorische Tage) gelten nur so lange (W3; Live-Patches folgen in P2). */
export const NONFINAL_TTL_MS = 60_000;
/** Abgelehnte Kacheln werden nach dieser Zeit erneut angefragt (W-3). */
export const REJECT_TTL_MS = 5 * 60_000;

/** Erwartung aus der Anfrage; jede Abweichung im Header ist ein Fehler (Review K2). */
export interface TileExpectation {
  sym: string;
  tf: string;
  R: number;
  k: number;
  n: number;
}

export class TileMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TileMismatchError';
  }
}

export function checkTileHeader(dec: DecodedTile, x: TileExpectation): void {
  const h = dec.header;
  const bad: string[] = [];
  if (h.kind !== 'footprint') bad.push(`kind ${h.kind}`);
  if (h.sym !== x.sym) bad.push(`sym ${h.sym} ≠ ${x.sym}`);
  if (h.tf !== x.tf) bad.push(`tf ${h.tf} ≠ ${x.tf}`);
  if (h.R !== x.R) bad.push(`R ${h.R} ≠ ${x.R}`);
  if (h.tile?.index !== x.k) bad.push(`tile ${h.tile?.index} ≠ ${x.k}`);
  if (h.tile?.n !== x.n) bad.push(`n ${h.tile?.n} ≠ ${x.n}`);
  if (bad.length > 0)
    throw new TileMismatchError(`Kachel passt nicht zur Anfrage: ${bad.join(', ')}`);
}

/**
 * POC (KONZEPT §6.1): Zeile mit maximalem Volumen; Gleichstand → näher an der Mitte des Bar-Ranges,
 * dann die tiefere. Mitte in Zeilen = (Zeile(low) + Zeile(high)) / 2.
 */
export function pocRow(
  row: ArrayLike<number>,
  buy: ArrayLike<number>,
  sell: ArrayLike<number>,
  s: number,
  e: number,
  rowLow: number,
  rowHigh: number,
): number {
  const mid2 = rowLow + rowHigh; // doppelte Mitte, ganzzahlig
  let best = -1;
  let bestV = -1;
  let bestD = Infinity;
  for (let j = s; j < e; j++) {
    const v = buy[j]! + sell[j]!;
    const r = row[j]!;
    const d = Math.abs(2 * r - mid2);
    if (v > bestV || (v === bestV && (d < bestD || (d === bestD && r < best)))) {
      best = r;
      bestV = v;
      bestD = d;
    }
  }
  return best;
}

export function prepareTile(series: string, dec: DecodedTile, now = 0): PreparedTile {
  const h = dec.header;
  if (h.kind !== 'footprint' || !h.tile || h.R === null) throw new Error('keine Footprint-Kachel');
  const lv = dec.levels!;
  const n = h.tile.n;
  const tfSec = h.tfSec;
  const fromSec = h.from / 1000;
  const width = h.R * h.tickRefUnits;
  const nb = h.nBars;
  const nl = h.nLevels;
  const slot = new Int32Array(n).fill(-1);
  const poc = new Int32Array(nb);
  const refDelta = new Float64Array(nb);
  const refVol = new Float64Array(nb);
  const vol = new Float64Array(nb);
  for (let i = 0; i < nb; i++) vol[i] = dec.bars.buyQ[i]! + dec.bars.sellQ[i]!;
  let scratch = new Float64Array(64);
  for (let i = 0; i < nb; i++) {
    slot[(dec.bars.time[i]! - fromSec) / tfSec] = i;
    const s = lv.levelOffset[i]!;
    const e = lv.levelOffset[i + 1]!;
    const lo = dec.bars.low[i]!;
    const hi = dec.bars.high[i]!;
    poc[i] = pocRow(lv.row, lv.buy, lv.sell, s, e, Math.floor(lo / width), Math.floor(hi / width));
    const m = e - s;
    if (scratch.length < 2 * m) scratch = new Float64Array(2 * m);
    for (let j = s; j < e; j++) {
      scratch[j - s] = Math.abs(lv.buy[j]! - lv.sell[j]!);
    }
    refDelta[i] = quantileInPlace(scratch, m, COLOR_REF_PERCENTILE);
    for (let j = s; j < e; j++) {
      scratch[2 * (j - s)] = lv.buy[j]!;
      scratch[2 * (j - s) + 1] = lv.sell[j]!;
    }
    refVol[i] = quantileInPlace(scratch, 2 * m, COLOR_REF_PERCENTILE);
  }
  const bytes = dec.levels!.row.buffer.byteLength + (n + nb * 3) * 4 + nb * 16;
  return {
    series,
    k: h.tile.index,
    n,
    tfSec,
    fromSec,
    nBars: nb,
    cells: nl,
    time: dec.bars.time,
    high: dec.bars.high,
    low: dec.bars.low,
    levelOffset: lv.levelOffset,
    row: lv.row,
    buy: lv.buy,
    sell: lv.sell,
    poc,
    slot,
    refDelta,
    refVol,
    vol,
    bytes,
    final: h.final,
    dataVersion: h.dataVersion,
    loadedAt: now,
  };
}

export type TileState = PreparedTile | 'rejected';

export class FootprintStore {
  /** Begrenzter Cache Wert → Text (Kurz-/Langform), beim Zeichnen benutzt. */
  readonly text: TextCache;
  private readonly bySeries = new Map<string, Map<number, TileState>>();
  /** LRU-Reihenfolge: älteste zuerst. */
  private readonly lru = new Map<string, PreparedTile>();
  cells = 0;
  bytes = 0;
  private readonly rejectedAt = new Map<string, number>();

  readonly maxCells: number;

  private readonly now: () => number;

  constructor(
    qtyDecimals: number,
    maxCells = CACHE_MAX_CELLS,
    now: () => number = () => performance.now(),
  ) {
    this.text = new TextCache(qtyDecimals);
    this.maxCells = maxCells;
    this.now = now;
  }

  static key(series: string, k: number): string {
    return `${series}#${k}`;
  }

  tiles(series: string): Map<number, TileState> | undefined {
    return this.bySeries.get(series);
  }

  /** Geladen (oder endgültig abgelehnt) und nicht abgelaufen. Abgelaufene nicht finale Kacheln
   * bleiben zum Zeichnen erhalten, bis die neue Antwort sie ersetzt. */
  has(series: string, k: number): boolean {
    const t = this.bySeries.get(series)?.get(k);
    if (t === undefined) return false;
    // W-3: Ablehnungen sind nicht endgültig – nach REJECT_TTL_MS wird erneut angefragt
    if (t === 'rejected') {
      const at = this.rejectedAt.get(FootprintStore.key(series, k)) ?? 0;
      return this.now() - at < REJECT_TTL_MS;
    }
    return t.final || this.now() - t.loadedAt < NONFINAL_TTL_MS;
  }

  get(series: string, k: number): TileState | undefined {
    return this.bySeries.get(series)?.get(k);
  }

  /** Markiert Zugriff (LRU). */
  touch(t: PreparedTile): void {
    const key = FootprintStore.key(t.series, t.k);
    this.lru.delete(key);
    this.lru.set(key, t);
  }

  /** Dekodiert, prüft gegen die Anfrage (wirft bei Abweichung) und legt ab. */
  addEncoded(series: string, buf: ArrayBuffer, expect?: TileExpectation): PreparedTile {
    const dec = decodeTile(buf);
    if (expect) checkTileHeader(dec, expect);
    const t = prepareTile(series, dec, this.now());
    this.add(t);
    return t;
  }

  add(t: PreparedTile): void {
    let m = this.bySeries.get(t.series);
    if (!m) {
      m = new Map();
      this.bySeries.set(t.series, m);
    }
    const old = m.get(t.k);
    if (old && old !== 'rejected') this.remove(old);
    m.set(t.k, t);
    this.lru.set(FootprintStore.key(t.series, t.k), t);
    this.cells += t.cells;
    this.bytes += t.bytes;
  }

  markRejected(series: string, k: number): void {
    let m = this.bySeries.get(series);
    if (!m) {
      m = new Map();
      this.bySeries.set(series, m);
    }
    m.set(k, 'rejected');
    this.rejectedAt.set(FootprintStore.key(series, k), this.now());
  }

  /** Kachel vergessen (wird beim nächsten Bedarf neu angefragt). */
  forget(series: string, k: number): void {
    const t = this.bySeries.get(series)?.get(k);
    if (t && t !== 'rejected') this.remove(t);
    else this.bySeries.get(series)?.delete(k);
    this.rejectedAt.delete(FootprintStore.key(series, k));
  }

  private remove(t: PreparedTile): void {
    this.lru.delete(FootprintStore.key(t.series, t.k));
    this.bySeries.get(t.series)?.delete(t.k);
    this.cells -= t.cells;
    this.bytes -= t.bytes;
  }

  /** Verdrängt die ältesten Kacheln bis ≤ maxCells; `pinned` (Schlüssel) bleiben. Liefert die Anzahl. */
  evict(pinned: Set<string>): number {
    let n = 0;
    if (this.cells <= this.maxCells) return 0;
    for (const [key, t] of this.lru) {
      if (this.cells <= this.maxCells) break;
      if (pinned.has(key)) continue;
      this.remove(t);
      n++;
    }
    return n;
  }

  get tileCount(): number {
    return this.lru.size;
  }
}
