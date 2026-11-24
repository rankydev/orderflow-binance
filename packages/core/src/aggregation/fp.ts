// Footprint-Zeilen (fp_1m und Rollups, KONZEPT §3.4/§3.6) als spaltenweise Typed Arrays,
// sortiert nach (ts, px). Mengen in Lots, Zähler = Anzahl aggTrades.

export interface FpTable {
  n: number;
  /** Bucketbeginn in ms (UTC). */
  ts: Float64Array;
  /** Preis bzw. untere Zeilenkante (row_px) in price_unit. */
  px: Int32Array;
  buyQ: Float64Array;
  sellQ: Float64Array;
  buyA: Float64Array;
  sellA: Float64Array;
}

export class FpBuilder {
  n = 0;
  private cap: number;
  private ts: Float64Array;
  private px: Int32Array;
  private buyQ: Float64Array;
  private sellQ: Float64Array;
  private buyA: Float64Array;
  private sellA: Float64Array;

  constructor(initial = 1024) {
    this.cap = Math.max(16, initial);
    this.ts = new Float64Array(this.cap);
    this.px = new Int32Array(this.cap);
    this.buyQ = new Float64Array(this.cap);
    this.sellQ = new Float64Array(this.cap);
    this.buyA = new Float64Array(this.cap);
    this.sellA = new Float64Array(this.cap);
  }

  private grow(): void {
    const cap = this.cap * 2;
    const g = <T extends Float64Array | Int32Array>(a: T, mk: (n: number) => T): T => {
      const b = mk(cap);
      b.set(a);
      return b;
    };
    this.ts = g(this.ts, (n) => new Float64Array(n));
    this.px = g(this.px, (n) => new Int32Array(n));
    this.buyQ = g(this.buyQ, (n) => new Float64Array(n));
    this.sellQ = g(this.sellQ, (n) => new Float64Array(n));
    this.buyA = g(this.buyA, (n) => new Float64Array(n));
    this.sellA = g(this.sellA, (n) => new Float64Array(n));
    this.cap = cap;
  }

  push(ts: number, px: number, buyQ: number, sellQ: number, buyA: number, sellA: number): void {
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    this.ts[i] = ts;
    this.px[i] = px;
    this.buyQ[i] = buyQ;
    this.sellQ[i] = sellQ;
    this.buyA[i] = buyA;
    this.sellA[i] = sellA;
  }

  build(): FpTable {
    const n = this.n;
    return {
      n,
      ts: this.ts.slice(0, n),
      px: this.px.slice(0, n),
      buyQ: this.buyQ.slice(0, n),
      sellQ: this.sellQ.slice(0, n),
      buyA: this.buyA.slice(0, n),
      sellA: this.sellA.slice(0, n),
    };
  }
}

export function emptyFp(): FpTable {
  return new FpBuilder(16).build();
}

/** Zeilen als Objekte (für Tests und kleine Ausgaben). */
export function fpRows(t: FpTable): {
  ts: number;
  px: number;
  buyQ: number;
  sellQ: number;
  buyA: number;
  sellA: number;
}[] {
  const out = [];
  for (let i = 0; i < t.n; i++) {
    out.push({
      ts: t.ts[i]!,
      px: t.px[i]!,
      buyQ: t.buyQ[i]!,
      sellQ: t.sellQ[i]!,
      buyA: t.buyA[i]!,
      sellA: t.sellA[i]!,
    });
  }
  return out;
}

/** Summen über alle Zeilen (für Konsistenzprüfungen zwischen Tabellen). */
export function fpTotals(t: FpTable): { buyQ: number; sellQ: number; buyA: number; sellA: number } {
  let buyQ = 0;
  let sellQ = 0;
  let buyA = 0;
  let sellA = 0;
  for (let i = 0; i < t.n; i++) {
    buyQ += t.buyQ[i]!;
    sellQ += t.sellQ[i]!;
    buyA += t.buyA[i]!;
    sellA += t.sellA[i]!;
  }
  return { buyQ, sellQ, buyA, sellA };
}
