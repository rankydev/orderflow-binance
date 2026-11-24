// Bar-Statistik (KONZEPT §3.5) für bar_1m und höhere Zeitrahmen, inkl. Komposition von
// Max/Min-Delta und COT aus Minutenwerten.

export interface Bar {
  /** Bucketbeginn in ms. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  buyQ: number;
  sellQ: number;
  buyA: number;
  sellA: number;
  /** Σ px·lots in price_unit·qty_unit (bigint, Tagessummen können 2^53 überschreiten). */
  notional: bigint;
  firstAggId: number;
  lastAggId: number;
  firstTradeMs: number;
  lastTradeMs: number;
  /** Maximum des laufenden Deltas nach jedem aggTrade (Startwert 0 zählt nicht). */
  runMax: number;
  runMin: number;
  /** Delta ab (inkl.) dem ERSTEN aggTrade auf low bis Barende (COT High). */
  dFromLow: number;
  /** Delta ab (inkl.) dem ERSTEN aggTrade auf high bis Barende (COT Low). */
  dFromHigh: number;
}

export function barDelta(b: Bar): number {
  return b.buyQ - b.sellQ;
}

/**
 * Akkumulator für einen Bar aus aggTrades in aggId-Reihenfolge. Wird für bar_1m verwendet;
 * höhere Zeitrahmen entstehen per `composeBars` aus Minuten.
 */
export class BarAcc {
  count = 0;
  private open = 0;
  private high = 0;
  private low = 0;
  private close = 0;
  private buyQ = 0;
  private sellQ = 0;
  private buyA = 0;
  private sellA = 0;
  private notional = 0;
  private firstAggId = 0;
  private lastAggId = 0;
  private firstTradeMs = 0;
  private lastTradeMs = 0;
  private cum = 0;
  private runMax = 0;
  private runMin = 0;
  private cumBeforeLow = 0;
  private cumBeforeHigh = 0;

  reset(): void {
    this.count = 0;
    this.buyQ = 0;
    this.sellQ = 0;
    this.buyA = 0;
    this.sellA = 0;
    this.notional = 0;
    this.cum = 0;
  }

  add(a: number, px: number, q: number, T: number, sellerAggressor: boolean): void {
    const before = this.cum;
    if (sellerAggressor) {
      this.sellQ += q;
      this.sellA++;
      this.cum -= q;
    } else {
      this.buyQ += q;
      this.buyA++;
      this.cum += q;
    }
    this.notional += px * q;
    if (this.notional > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Notional einer Minute überschreitet 2^53 (aggId ${a})`);
    }
    if (this.count === 0) {
      this.open = px;
      this.high = px;
      this.low = px;
      this.firstAggId = a;
      this.firstTradeMs = T;
      this.runMax = this.cum;
      this.runMin = this.cum;
      this.cumBeforeLow = before;
      this.cumBeforeHigh = before;
    } else {
      if (this.cum > this.runMax) this.runMax = this.cum;
      if (this.cum < this.runMin) this.runMin = this.cum;
      // Bildung des Extrems = erster Print auf dem endgültigen Extrempreis; erneutes Antesten
      // desselben Preises verschiebt den Startpunkt nicht (KONZEPT §3.5).
      if (px < this.low) {
        this.low = px;
        this.cumBeforeLow = before;
      }
      if (px > this.high) {
        this.high = px;
        this.cumBeforeHigh = before;
      }
    }
    this.close = px;
    this.lastAggId = a;
    this.lastTradeMs = T;
    this.count++;
  }

  finish(ts: number): Bar {
    if (this.count === 0) throw new Error('BarAcc.finish ohne Trades');
    return {
      ts,
      open: this.open,
      high: this.high,
      low: this.low,
      close: this.close,
      buyQ: this.buyQ,
      sellQ: this.sellQ,
      buyA: this.buyA,
      sellA: this.sellA,
      notional: BigInt(this.notional),
      firstAggId: this.firstAggId,
      lastAggId: this.lastAggId,
      firstTradeMs: this.firstTradeMs,
      lastTradeMs: this.lastTradeMs,
      runMax: this.runMax,
      runMin: this.runMin,
      dFromLow: this.cum - this.cumBeforeLow,
      dFromHigh: this.cum - this.cumBeforeHigh,
    };
  }
}

/**
 * Komposition eines höheren Bars aus zeitlich sortierten Teilbars (KONZEPT §3.5):
 * Max Delta = max_i (P_{i−1} + run_max_i), Min Delta analog;
 * COT High: j = erste Minute mit low_j = Bar-Low → d_from_low_j + Σ_{i>j} d_i; COT Low analog.
 * Gilt auch für Teilbars, die selbst komponiert sind (Assoziativität), z. B. 1d aus 1h.
 */
export function composeBars(ts: number, parts: readonly Bar[]): Bar {
  if (parts.length === 0) throw new Error('composeBars: keine Teilbars');
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  let high = first.high;
  let low = first.low;
  let buyQ = 0;
  let sellQ = 0;
  let buyA = 0;
  let sellA = 0;
  let notional = 0n;
  let p = 0; // exklusive Präfixsumme P_{i−1}
  let runMax = -Infinity;
  let runMin = Infinity;
  for (let i = 0; i < parts.length; i++) {
    const b = parts[i]!;
    if (i > 0 && b.ts <= parts[i - 1]!.ts) throw new Error('composeBars: Teilbars nicht sortiert');
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    buyQ += b.buyQ;
    sellQ += b.sellQ;
    buyA += b.buyA;
    sellA += b.sellA;
    notional += b.notional;
    if (p + b.runMax > runMax) runMax = p + b.runMax;
    if (p + b.runMin < runMin) runMin = p + b.runMin;
    p += b.buyQ - b.sellQ;
  }
  const total = p;
  // COT: Delta ab der ersten Teilbar mit dem Extrem, inkl. deren d_from_*, plus alle späteren Deltas.
  let dFromLow = 0;
  let dFromHigh = 0;
  let pre = 0;
  let lowDone = false;
  let highDone = false;
  for (const b of parts) {
    const d = b.buyQ - b.sellQ;
    if (!lowDone && b.low === low) {
      dFromLow = b.dFromLow + (total - pre - d);
      lowDone = true;
    }
    if (!highDone && b.high === high) {
      dFromHigh = b.dFromHigh + (total - pre - d);
      highDone = true;
    }
    pre += d;
  }
  return {
    ts,
    open: first.open,
    high,
    low,
    close: last.close,
    buyQ,
    sellQ,
    buyA,
    sellA,
    notional,
    firstAggId: first.firstAggId,
    lastAggId: last.lastAggId,
    firstTradeMs: first.firstTradeMs,
    lastTradeMs: last.lastTradeMs,
    runMax,
    runMin,
    dFromLow,
    dFromHigh,
  };
}
