// Bar-Abschnitte (bars-Endpunkt) je (Symbol, tf) und das Datenfenster der Serien (KONZEPT §7.3:
// setData nur bei Ankunft bzw. tf-Wechsel; Footprint-Modus ≤ 5 000 Bars, Kerzen-Modus ≤ 20 000 Bars).
import { decodeTile, type BarColumns } from '@orderflow/core/browser';
import type { UTCTimestamp } from 'lightweight-charts';
import type { BarItem } from './types.ts';

export const FOOTPRINT_WINDOW_BARS = 5_000;
export const CANDLE_WINDOW_BARS = 20_000;
/** Höchstzahl gecachter Abschnitte je Serie (à 1 000 Bars, ≈ 44 kB). */
export const MAX_CHUNKS = 80;

export class BarStore {
  private readonly chunks = new Map<number, BarColumns>();
  readonly series: string;
  readonly priceDecimals: number;

  constructor(series: string, priceDecimals: number) {
    this.series = series;
    this.priceDecimals = priceDecimals;
  }

  has(c: number): boolean {
    return this.chunks.has(c);
  }

  addEncoded(c: number, buf: ArrayBuffer): void {
    this.chunks.delete(c);
    this.chunks.set(c, decodeTile(buf).bars);
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
