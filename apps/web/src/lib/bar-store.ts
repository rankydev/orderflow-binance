// Bar-Abschnitte (bars-Endpunkt) je (Symbol, tf) und das Datenfenster der Serien (KONZEPT §7.3:
// setData nur bei Ankunft bzw. tf-Wechsel; Footprint-Modus ≤ 5 000 Bars, Kerzen-Modus ≤ 20 000 Bars).
import { decodeTile, type BarColumns } from '@orderflow/core/browser';
import type { UTCTimestamp } from 'lightweight-charts';
import type { BarItem } from './types.ts';

export interface ChunkExpectation {
  sym: string;
  tf: string;
  from: number;
  to: number;
}

const EMPTY_BARS: BarColumns = {
  time: new Int32Array(0),
  open: new Int32Array(0),
  high: new Int32Array(0),
  low: new Int32Array(0),
  close: new Int32Array(0),
  buyQ: new Float64Array(0),
  sellQ: new Float64Array(0),
  buyA: new Int32Array(0),
  sellA: new Int32Array(0),
};

export const FOOTPRINT_WINDOW_BARS = 5_000;
export const CANDLE_WINDOW_BARS = 20_000;
/** Höchstzahl gecachter Abschnitte je Serie (à 1 000 Bars, ≈ 44 kB). */
export const MAX_CHUNKS = 80;

export class BarStore {
  private readonly chunks = new Map<number, BarColumns>();
  /** je Abschnitt: final (aus dem Header) bzw. Lücke (markEmpty) – für die Querprüfung (W-3) */
  private readonly state = new Map<number, 'final' | 'provisional' | 'gap'>();
  readonly series: string;
  readonly priceDecimals: number;

  constructor(series: string, priceDecimals: number) {
    this.series = series;
    this.priceDecimals = priceDecimals;
  }

  has(c: number): boolean {
    return this.chunks.has(c);
  }

  /** Dekodiert und prüft gegen die Anfrage (K2): Art, Symbol, tf, Zeitraum; wirft bei Abweichung. */
  addEncoded(c: number, buf: ArrayBuffer, expect?: ChunkExpectation): void {
    const dec = decodeTile(buf);
    if (expect) {
      const h = dec.header;
      const bad: string[] = [];
      if (h.kind !== 'bars') bad.push(`kind ${h.kind}`);
      if (h.sym !== expect.sym) bad.push(`sym ${h.sym}`);
      if (h.tf !== expect.tf) bad.push(`tf ${h.tf}`);
      if (h.from !== expect.from || h.to !== expect.to) bad.push(`Zeitraum [${h.from}, ${h.to})`);
      if (bad.length > 0)
        throw new Error(`Bar-Abschnitt ${c} passt nicht zur Anfrage: ${bad.join(', ')}`);
    }
    // Der Decoder garantiert streng aufsteigende Zeiten innerhalb [from, to) → setData-sicher.
    this.chunks.delete(c);
    this.chunks.set(c, dec.bars);
    this.state.set(c, dec.header.final ? 'final' : 'provisional');
    this.loadedAt.set(c, Date.now());
  }

  private readonly loadedAt = new Map<number, number>();

  /**
   * Bars c0…c1 für den Zeitraum bis `endMs` vergleichbar? Geladen, keine Lücke und je Abschnitt final
   * oder – bei einem vorläufigen Abschnitt (enthält den laufenden Tag) – erst geladen, als `endMs`
   * schon länger als `settleMs` zurücklag (dann ändern sich diese Bars nicht mehr).
   */
  settled(c0: number, c1: number, endMs: number, settleMs: number): boolean {
    for (let c = c0; c <= c1; c++) {
      const st = this.state.get(c);
      if (st === 'final') continue;
      if (st !== 'provisional' || (this.loadedAt.get(c) ?? 0) < endMs + settleMs) return false;
    }
    return true;
  }

  /** Endgültig fehlender Abschnitt als leere Lücke (das Fenster kann darüber wachsen). */
  markEmpty(c: number): void {
    this.chunks.set(c, EMPTY_BARS);
    this.state.set(c, 'gap');
  }

  /** Abschnitt vergessen (wird beim nächsten Fensterbedarf neu angefragt). */
  drop(c: number): void {
    this.chunks.delete(c);
    this.state.delete(c);
    this.loadedAt.delete(c);
  }

  /** Alle Abschnitte c0…c1 geladen, final und keine Lücke? */
  allFinal(c0: number, c1: number): boolean {
    for (let c = c0; c <= c1; c++) if (this.state.get(c) !== 'final') return false;
    return true;
  }

  get size(): number {
    return this.chunks.size;
  }

  /** Verdrängt die ältesten Abschnitte außerhalb von [keep0, keep1]. */
  evict(keep0: number, keep1: number): void {
    if (this.chunks.size <= MAX_CHUNKS) return;
    for (const c of this.chunks.keys()) {
      if (this.chunks.size <= MAX_CHUNKS) break;
      if (c < keep0 || c > keep1) this.chunks.delete(c);
    }
  }

  /** Größter lückenlos geladener Bereich in [c0, c1], der `center` enthält; null, wenn center fehlt. */
  loadedRun(c0: number, c1: number, center: number): [number, number] | null {
    if (!this.chunks.has(center)) return null;
    let a = center;
    let b = center;
    while (a - 1 >= c0 && this.chunks.has(a - 1)) a--;
    while (b + 1 <= c1 && this.chunks.has(b + 1)) b++;
    return [a, b];
  }

  /** Datenitems der Abschnitte [c0, c1] (alle geladen), aufsteigend; einmal je Fensterwechsel erzeugt. */
  items(c0: number, c1: number): BarItem[] {
    const out: BarItem[] = [];
    const f = 10 ** this.priceDecimals;
    for (let c = c0; c <= c1; c++) {
      const b = this.chunks.get(c);
      if (!b) throw new Error(`Abschnitt ${c} fehlt`);
      for (let i = 0; i < b.time.length; i++) {
        const o = b.open[i]!;
        const h = b.high[i]!;
        const l = b.low[i]!;
        const cl = b.close[i]!;
        out.push({
          time: b.time[i]! as UTCTimestamp,
          t: b.time[i]!,
          open: o / f,
          high: h / f,
          low: l / f,
          close: cl / f,
          o,
          h,
          l,
          c: cl,
          v: b.buyQ[i]! + b.sellQ[i]!,
        });
      }
    }
    return out;
  }
}

/** Index des ersten Items mit time ≥ t (binäre Suche). */
export function indexAtOrAfter(items: readonly BarItem[], t: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (items[m]!.time < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Index des letzten Items mit time ≤ t (−1, wenn keins); W8: der Bar, der t enthält. */
export function indexAtOrBefore(items: readonly BarItem[], t: number): number {
  // erster Index mit time > t, minus 1 (kein t + ε: bei ~10^9 s verschwindet ε im Gleitkomma)
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (items[m]!.time <= t) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}

/**
 * Logische Position der Zeit t in `items` für die Ansicht (K1/W8): innerhalb der Daten der Bar, der t
 * enthält (letzter mit time ≤ t); davor/dahinter mit tf fortgesetzt; auf [0, n − 1] begrenzt, damit
 * die Ansicht nach einem Fensterwechsel nie neben den Daten landet.
 */
export function logicalIndexOfTime(items: readonly BarItem[], t: number, tfSec: number): number {
  const n = items.length;
  if (n === 0) return 0;
  if (t < items[0]!.time) return Math.max(0, Math.floor((t - items[0]!.time) / tfSec));
  return Math.min(n - 1, Math.max(0, indexAtOrBefore(items, t)));
}

/** Zeit (s) an einer logischen Position; außerhalb der Items linear mit tf fortgesetzt. */
export function timeAtLogical(
  items: readonly BarItem[],
  x: number,
  tfSec: number,
  fallback = 0,
): number {
  const n = items.length;
  if (n === 0) return fallback;
  const i = Math.round(x);
  if (i < 0) return items[0]!.time + i * tfSec;
  if (i >= n) return items[n - 1]!.time + (i - n + 1) * tfSec;
  return items[i]!.time;
}

/**
 * Sichtbarer Bereich nach einem Fensterwechsel (K1): Ankerzeit = Zeit der Bildmitte im alten Fenster
 * (auch weit außerhalb, fortgesetzt), Position im neuen Fenster per logicalIndexOfTime (begrenzt), Breite
 * und Nachkomma-Versatz der Mitte bleiben erhalten.
 */
export function rangeAfterRebuild(
  oldItems: readonly BarItem[],
  lr: { from: number; to: number },
  newItems: readonly BarItem[],
  tfSec: number,
): { from: number; to: number } {
  const mid = (lr.from + lr.to) / 2;
  const width = lr.to - lr.from;
  const t = timeAtLogical(oldItems, mid, tfSec);
  const offset = mid >= 0 && mid <= oldItems.length - 1 ? mid - Math.round(mid) : 0;
  const c = logicalIndexOfTime(newItems, t, tfSec) + offset;
  return { from: c - width / 2, to: c + width / 2 };
}

/** W8: Ankerzeit beim tf-Wechsel – auf einen feineren tf die Mitte des alten Bars. */
export function tfSwitchAnchorTime(centerSec: number, oldTfSec: number, newTfSec: number): number {
  if (newTfSec >= oldTfSec) return centerSec;
  return centerSec - (centerSec % oldTfSec) + oldTfSec / 2;
}

/**
 * Review b: Eine nach einer Abweichung zurückgestellte Kachel darf erst wieder angefordert werden, wenn
 * alle ihre neu geladenen Bar-Abschnitte da UND im aktuellen Fenster sind (die Querprüfung vergleicht
 * gegen die Fenster-Items).
 */
export function chunksReadyInWindow(
  [c0, c1]: [number, number],
  has: (c: number) => boolean,
  win: [number, number] | null,
): boolean {
  for (let c = c0; c <= c1; c++) if (!has(c)) return false;
  return !!win && win[0] <= c0 && win[1] >= c1;
}
