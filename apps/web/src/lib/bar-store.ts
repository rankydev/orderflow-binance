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

  /**
   * Dekodiert und prüft gegen die Anfrage (K2): Art, Symbol, tf, Zeitraum; wirft bei Abweichung.
   * `dataToMs`: Datenende laut Server (/symbols) beim Laden – Datenzeit statt Uhr des Besuchers (W-3).
   */
  addEncoded(
    c: number,
    buf: ArrayBuffer,
    expect?: ChunkExpectation,
    dataToMs = 0,
    /** nur übernehmen, wenn committedTo nicht älter ist als das gehaltene (Live-Neuladen) */
    onlyNewer = false,
  ): boolean {
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
    const held = this.committed.get(c);
    const got = dec.header.committedTo;
    if (onlyNewer && held !== undefined && (got === undefined || got < held)) return false;
    // W-1: Stats-Spalten sind Zusätze – eine unbrauchbare Spalte wird verworfen (mit Hinweis), der
    // Abschnitt (Zeit, OHLC, Mengen) bleibt
    for (const [name, why] of statsColumnProblems(dec.extra, dec.bars.time.length)) {
      delete dec.extra![name];
      this.badColumns.set(name, why);
      console.warn(`Bar-Abschnitt ${c}: ${name} unbrauchbar (${why}) – Spalte verworfen`);
    }
    // Der Decoder garantiert streng aufsteigende Zeiten innerhalb [from, to) → setData-sicher.
    this.chunks.delete(c);
    this.chunks.set(c, dec.bars);
    if (dec.extra) this.extra.set(c, dec.extra);
    else this.extra.delete(c);
    this.state.set(c, dec.header.final ? 'final' : 'provisional');
    this.dataToAt.set(c, dataToMs);
    if (got !== undefined) this.committed.set(c, got);
    else this.committed.delete(c);
    return true;
  }

  /** committedTo je Abschnitt (Live-Naht, TILE-FORMAT.md); fehlt bei älteren Servern */
  private readonly committed = new Map<number, number>();

  /** committedTo des geladenen Abschnitts c (ms) oder undefined. */
  committedTo(c: number): number | undefined {
    return this.chunks.has(c) ? this.committed.get(c) : undefined;
  }

  /** Spalten des Abschnitts c (Referenz; ein Neuladen ersetzt das Objekt, das alte bleibt gültig). */
  columns(c: number): BarColumns | undefined {
    return this.chunks.get(c);
  }

  /** DB-Item des Abschnitts c zur Bar-Zeit tSec (ohne Zusatzspalten) oder null. */
  itemAt(c: number, tSec: number, cols = this.chunks.get(c)): BarItem | null {
    if (!cols) return null;
    let lo = 0;
    let hi = cols.time.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (cols.time[m]! < tSec) lo = m + 1;
      else hi = m;
    }
    if (lo >= cols.time.length || cols.time[lo] !== tSec) return null;
    return this.itemFrom(cols, lo, cols === this.chunks.get(c) ? this.extra.get(c) : undefined);
  }

  /** DB-Items des Abschnitts c mit Zeit ≥ fromSec (aufsteigend, ohne Zusatzspalten). */
  itemsFrom(c: number, fromSec: number): BarItem[] {
    const cols = this.chunks.get(c);
    if (!cols) return [];
    const out: BarItem[] = [];
    const ex = this.extra.get(c);
    for (let i = 0; i < cols.time.length; i++)
      if (cols.time[i]! >= fromSec) out.push(this.itemFrom(cols, i, ex));
    return out;
  }

  private itemFrom(
    b: BarColumns,
    i: number,
    ex?: Record<string, Int32Array | Float64Array>,
  ): BarItem {
    const exKeys = ex ? Object.keys(ex).filter((k) => ex[k]!.length === b.time.length) : [];
    const f = 10 ** this.priceDecimals;
    const o = b.open[i]!;
    const h = b.high[i]!;
    const l = b.low[i]!;
    const cl = b.close[i]!;
    return {
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
      b: b.buyQ[i]!,
      s: b.sellQ[i]!,
      ba: b.buyA[i]!,
      sa: b.sellA[i]!,
      ...(exKeys.length > 0 ? { x: Object.fromEntries(exKeys.map((k) => [k, ex![k]![i]!])) } : {}),
    };
  }

  private readonly dataToAt = new Map<number, number>();
  /** Verworfene Stats-Spalten (Name → Grund), für die Hinweise im Grid */
  readonly badColumns = new Map<string, string>();
  /** Zusatzspalten `x.*` je Abschnitt (z. B. künftige Stats-Felder), durchgereicht */
  private readonly extra = new Map<number, Record<string, Int32Array | Float64Array>>();

  /**
   * Bars c0…c1 für den Zeitraum bis `endMs` vergleichbar? Geladen, keine Lücke und je Abschnitt final
   * oder – bei einem vorläufigen Abschnitt (enthält den laufenden Tag) – geladen, als das Datenende des
   * Servers schon mehr als `settleMs` hinter `endMs` lag (dann ändern sich diese Bars nicht mehr). Die
   * Uhr des Besuchers spielt keine Rolle (W-3).
   */
  settled(c0: number, c1: number, endMs: number, settleMs: number): boolean {
    for (let c = c0; c <= c1; c++) {
      const st = this.state.get(c);
      if (st === 'final') continue;
      if (st !== 'provisional' || (this.dataToAt.get(c) ?? 0) < endMs + settleMs) return false;
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
    this.dataToAt.delete(c);
    this.committed.delete(c);
  }

  /** Abschnitte in c0…c1, die als Lücke (ohne Daten) geführt werden. */
  gapChunks(c0: number, c1: number): number[] {
    const out: number[] = [];
    for (let c = c0; c <= c1; c++) if (this.state.get(c) === 'gap') out.push(c);
    return out;
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
      const ex = this.extra.get(c);
      const exKeys = ex ? Object.keys(ex).filter((k) => ex[k]!.length === b.time.length) : [];
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
          b: b.buyQ[i]!,
          s: b.sellQ[i]!,
          ba: b.buyA[i]!,
          sa: b.sellA[i]!,
          ...(exKeys.length > 0
            ? { x: Object.fromEntries(exKeys.map((k) => [k, ex![k]![i]!])) }
            : {}),
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

/** Stats-Spalten der API (TILE-FORMAT.md, `stats=1`); andere `x.`-Spalten werden nicht geprüft. */
export const STATS_X_COLUMNS = ['x.maxDelta', 'x.minDelta', 'x.cotHigh', 'x.cotLow', 'x.trades'];

/**
 * Form der Stats-Spalten prüfen, wenn vorhanden (fehlende Spalten sind erlaubt = nicht geliefert): Länge =
 * Anzahl Bars, endliche Zahlen, x.trades ganzzahlig ≥ 0, minDelta ≤ maxDelta je Bar (sonst beide
 * unbrauchbar). Liefert [Spalte, Grund] je unbrauchbarer Spalte; wirft nie (W-1).
 */
export function statsColumnProblems(
  extra: Record<string, Int32Array | Float64Array> | undefined,
  nBars: number,
): [string, string][] {
  const out: [string, string][] = [];
  if (!extra) return out;
  for (const name of STATS_X_COLUMNS) {
    const c = extra[name];
    if (!c) continue;
    if (c.length !== nBars) {
      out.push([name, `Länge ${c.length} ≠ ${nBars} Bars`]);
      continue;
    }
    for (let i = 0; i < c.length; i++) {
      const v = c[i]!;
      if (!Number.isFinite(v)) {
        out.push([name, `Bar ${i} nicht endlich`]);
        break;
      }
      if (name === 'x.trades' && (v < 0 || !Number.isInteger(v))) {
        out.push([name, `Bar ${i}: ${v} keine Anzahl`]);
        break;
      }
    }
  }
  const bad = new Set(out.map(([n]) => n));
  const mx = extra['x.maxDelta'];
  const mn = extra['x.minDelta'];
  if (mx && mn && !bad.has('x.maxDelta') && !bad.has('x.minDelta'))
    for (let i = 0; i < nBars; i++)
      if (mn[i]! > mx[i]!) {
        out.push(
          ['x.maxDelta', `Bar ${i}: minDelta > maxDelta`],
          ['x.minDelta', `Bar ${i}: minDelta > maxDelta`],
        );
        break;
      }
  return out;
}
