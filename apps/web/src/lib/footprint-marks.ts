// Marken im Footprint (KONZEPT §6.1, Phase P4): Imbalance und Stacked Imbalance, Delta-POC und Value
// Area je Bar. Rein und ganzzahlig (Mengen in Lots, < 2^53; 100 · Menge bleibt exakt). Eingabe sind die
// dünn besetzten Level eines Bars aus der Kachel (Zeilen streng aufsteigend, nur Zeilen mit Trades) und
// der Zeilenbereich des Bars [rowLow, rowHigh] = [floor(low/w), floor(high/w)]: innere Zeilen ohne Trades
// zählen als 0, Zeilen außerhalb existieren nicht. Alles gilt für die Zeilengröße der Kachel, also die
// tatsächlich gezeichnete (auch für die vorige Größe während eines R-Wechsels).
import { maxNearMiddle, valueArea } from '@orderflow/core/browser';

export interface ImbalanceOptions {
  /** Schwelle in Prozent (300 = Faktor 3), ganzzahlig */
  ratio: number;
  /** Mindestdifferenz in Lots (ganzzahlig, ≥ 0) */
  minDiff: number;
  /** Gegenseite 0 bzw. fehlende Vergleichszeile zählt (dann nur die minDiff-Bedingung, Menge > 0) */
  includeZero: boolean;
  /** b_i gegen s_i statt diagonal */
  horizontal: boolean;
  /** Mindestlänge einer Stacked-Folge (Zeilen) */
  stack: number;
}

export const IMBALANCE_DEFAULTS: ImbalanceOptions = {
  ratio: 300,
  minDiff: 0,
  includeZero: false,
  horizontal: false,
  stack: 3,
};

/** Bits der Imbalance-Markierung je Level. */
export const IMB_BUY = 1;
export const IMB_SELL = 2;
export const IMB_BUY_STACK = 4;
export const IMB_SELL_STACK = 8;

/** Schlüssel der Optionen (Neuberechnung nur bei Änderung). */
export function imbalanceKey(o: ImbalanceOptions): string {
  return `${o.ratio}|${o.minDiff}|${o.includeZero ? 1 : 0}|${o.horizontal ? 1 : 0}|${o.stack}`;
}

/**
 * Seite x gegen Gegenseite c (c = null: Vergleichszeile fehlt am Rand).
 * c > 0: 100·x ≥ ratio·c und x − c ≥ minDiff; c = 0 oder fehlend: nur mit includeZero, dann x > 0 und
 * x ≥ minDiff.
 */
export function dominates(x: number, c: number | null, o: ImbalanceOptions): boolean {
  if (c === null || c === 0) return o.includeZero && x > 0 && x >= o.minDiff;
  return 100 * x >= o.ratio * c && x - c >= o.minDiff;
}

/**
 * Imbalance-Bits für die Level [s, e) eines Bars nach `out[s…e)`.
 *  - diagonal: Buy in Zeile i gegen s_{i−1}; Sell in Zeile i gegen b_{i+1}. Die unterste Zeile hat keine
 *    Zeile i−1, die oberste keine Zeile i+1 (→ nur mit includeZero). Fehlt eine innere Zeile in den Leveln
 *    (keine Trades), ist ihre Menge 0.
 *  - horizontal: b_i gegen s_i (und umgekehrt).
 *  - Stacked: ≥ stack lückenlos benachbarte Zeilen mit Imbalance derselben Seite; eine Zeile ohne
 *    Imbalance oder ohne Trades bricht die Folge.
 */
export function imbalanceFlags(
  row: ArrayLike<number>,
  buy: ArrayLike<number>,
  sell: ArrayLike<number>,
  s: number,
  e: number,
  rowLow: number,
  rowHigh: number,
  o: ImbalanceOptions,
  out: Uint8Array,
): void {
  for (let j = s; j < e; j++) {
    const r = row[j]!;
    const b = buy[j]!;
    const sl = sell[j]!;
    let f = 0;
    if (o.horizontal) {
      if (dominates(b, sl, o)) f |= IMB_BUY;
      if (dominates(sl, b, o)) f |= IMB_SELL;
    } else {
      // Zeile darunter: vorhanden (Level j−1 mit Zeile r−1), leer (innere Zeile) oder fehlend (Rand)
      const below = r - 1 < rowLow ? null : j > s && row[j - 1] === r - 1 ? sell[j - 1]! : 0;
      const above = r + 1 > rowHigh ? null : j + 1 < e && row[j + 1] === r + 1 ? buy[j + 1]! : 0;
      if (dominates(b, below, o)) f |= IMB_BUY;
      if (dominates(sl, above, o)) f |= IMB_SELL;
    }
    out[j] = f;
  }
  // Stacked: Folgen benachbarter Zeilen je Seite
  for (const [bit, stackBit] of [
    [IMB_BUY, IMB_BUY_STACK],
    [IMB_SELL, IMB_SELL_STACK],
  ] as const) {
    let start = -1;
    for (let j = s; j <= e; j++) {
      const on = j < e && (out[j]! & bit) !== 0;
      const adjacent = j > s && j < e && row[j] === row[j - 1]! + 1;
      if (on && start >= 0 && adjacent) continue;
      // Folge [start, j) abschließen
      if (start >= 0 && j - start >= o.stack) for (let q = start; q < j; q++) out[q]! |= stackBit;
      start = on ? j : -1;
    }
  }
}

/** Dichte Werte eines Bars (Zeilen rowLow…rowHigh, Lücken 0) für die Kern-Helfer. */
function dense(
  row: ArrayLike<number>,
  buy: ArrayLike<number>,
  sell: ArrayLike<number>,
  s: number,
  e: number,
  rowLow: number,
  rowHigh: number,
  f: (b: number, s: number) => number,
): Float64Array {
  const v = new Float64Array(Math.max(0, rowHigh - rowLow + 1));
  for (let j = s; j < e; j++) v[row[j]! - rowLow] = f(buy[j]!, sell[j]!);
  return v;
}

/**
 * Delta-POC je Bar: Zeile mit größtem |b − s|; Gleichstand → näher an der Mitte des Bar-Ranges, dann die
 * tiefere (core `maxNearMiddle`, wie POC und PROFILE-API). −1, wenn jedes Delta 0 ist.
 */
export function deltaPocRow(
  row: ArrayLike<number>,
  buy: ArrayLike<number>,
  sell: ArrayLike<number>,
  s: number,
  e: number,
  rowLow: number,
  rowHigh: number,
): number {
  const i = maxNearMiddle(dense(row, buy, sell, s, e, rowLow, rowHigh, (b, x) => Math.abs(b - x)));
  return i < 0 ? -1 : rowLow + i;
}

/** Value Area je Bar (core `valueArea`, Paarverfahren wie beim Profil) als [VAL, VAH] Zeilen, null ohne Volumen. */
export function barValueArea(
  row: ArrayLike<number>,
  buy: ArrayLike<number>,
  sell: ArrayLike<number>,
  s: number,
  e: number,
  rowLow: number,
  rowHigh: number,
  pocRow: number,
  vaPct: number,
): [number, number] | null {
  const vol = dense(row, buy, sell, s, e, rowLow, rowHigh, (b, x) => b + x);
  const va = valueArea(vol, pocRow - rowLow, vaPct);
  return va ? [rowLow + va[0], rowLow + va[1]] : null;
}

/** Stacked-Zonen eines Bars aus den Bits: [unterste Zeile, oberste Zeile, Seite (0 = Buy, 1 = Sell)]. */
export function stackZones(
  row: ArrayLike<number>,
  flags: ArrayLike<number>,
  s: number,
  e: number,
): [number, number, 0 | 1][] {
  const out: [number, number, 0 | 1][] = [];
  for (const [bit, side] of [
    [IMB_BUY_STACK, 0],
    [IMB_SELL_STACK, 1],
  ] as const) {
    let lo = -1;
    for (let j = s; j <= e; j++) {
      const on = j < e && (flags[j]! & bit) !== 0;
      const cont = on && lo >= 0 && row[j] === row[j - 1]! + 1;
      if (cont) continue;
      if (lo >= 0) out.push([row[lo]!, row[j - 1]!, side]);
      lo = on ? j : -1;
    }
  }
  return out;
}

/**
 * Projektion einer Stacked-Zone [lo, hi) (price_unit) nach rechts (§6.1): Index des ersten späteren Bars
 * ab `from`, dessen [low, high] in die Zone handelt; −1 = bis `end` (exklusiv) unberührt.
 */
export function zoneTouch(
  bars: ArrayLike<{ h: number; l: number }>,
  from: number,
  end: number,
  lo: number,
  hi: number,
): number {
  for (let i = Math.max(0, from); i < Math.min(end, bars.length); i++) {
    const b = bars[i]!;
    if (b.l < hi && b.h >= lo) return i;
  }
  return -1;
}
