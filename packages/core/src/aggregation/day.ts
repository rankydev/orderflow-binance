// Tagesaggregation (KONZEPT §3.3–§3.5): aggTrades eines UTC-Tages in aggId-Reihenfolge →
// fp_1m-Basiszeilen (1 Minute × nativer Preis), bar_1m, Kandidaten für den Kline-Abgleich (§4.6)
// und die empirische Tickweite (symbol_tick_history). Speicher: nur der Tag, nie Rohzeilen.
// Ab P5 (§3.7) zusätzlich die Orders nach Order-Regel v1: Summen über ALLE Orders und die Orders
// mit Notional ≥ Untergrenze (big_order). Importer und Recorder rechnen beide hier.
import type { AggTrade } from '../parser/csv.ts';
import { DAY_MS, MINUTE_MS } from '../constants.ts';
import { MINUTES_PER_DAY } from '../time.ts';
import { BarAcc, type Bar } from './bar.ts';
import { FpBuilder, type FpTable } from './fp.ts';

/** Kandidatenregel §4.6: Mehrfach-Fill und T mod 60 000 ≥ 59 900. */
export const CANDIDATE_FROM_MS = 59_900;

export function isCandidate(t: Pick<AggTrade, 'f' | 'l' | 'T'>): boolean {
  return t.l > t.f && t.T % MINUTE_MS >= CANDIDATE_FROM_MS;
}

const INT32_MAX = 2_147_483_647;

/**
 * Order-Regel v1 (KONZEPT §3.7, entschieden): maximaler Lauf von aggTrades mit gleichem T (ms),
 * gleicher Seite (m) und lückenlos fortlaufender aggId (+1) bildet eine Order. Versioniert: ein
 * Wechsel bedeutet Neuberechnung von big_order und der Ordersummen aus dem Archiv.
 */
export const ORDER_RULE_VERSION = 1;

/** Seite einer Order wie in size_hist_* (§3.7): 1 = Käufer-Aggressor (m = false), 2 = Verkäufer. */
export const SIDE_BUY = 1;
export const SIDE_SELL = 2;

/** Eine Order (Zeile von big_order). Notional ganzzahlig Σ px·lots (price_unit·qty_unit). */
export interface BigOrder {
  /** T der Order in ms (alle aggTrades der Order haben dasselbe T). */
  ts: number;
  firstAggId: number;
  lastAggId: number;
  side: 1 | 2;
  pxFirst: number;
  pxLast: number;
  /** Σ Lots. */
  qty: number;
  /** Σ px·lots; eine Order liegt in einer Minute, deren Notional < 2^53 geprüft ist. */
  notional: number;
  /** Anzahl aggTrades. */
  aggN: number;
}

export interface DayAggregate {
  /** UTC-Tagesindex. */
  day: number;
  trades: number;
  fp1m: FpTable;
  /** bar_1m, nur Minuten mit Trades, nach ts sortiert. */
  bars: Bar[];
  /** Σ Menge der Kandidaten je Minute (Lots), für q und b (nur m = false). */
  candQ: Float64Array;
  candB: Float64Array;
  /** Anzahl Kandidaten-aggTrades des Tages. */
  candCount: number;
  /** ggT aller |px_i − px_{i−1}| des Tages (0, wenn nur ein Preis vorkam). */
  minStepUnits: number;
  /** Anzahl aller Orders des Tages (Order-Regel v1). */
  ordersN: number;
  /** Σ Notional aller Orders (= Σ bar_1m.notional, je Minute geprüft). */
  ordersNotional: bigint;
  /** Untergrenze, mit der bigOrders gebildet wurden; null = keine Untergrenze, keine big orders. */
  bigFloorN: number | null;
  /** Orders mit notional ≥ bigFloorN, sortiert nach (ts, firstAggId) wie der Primärschlüssel. */
  bigOrders: BigOrder[];
}

/** Ordersummen einer Minute (Live-Pfad, Abgleich). */
export interface MinuteOrders {
  n: number;
  notional: number;
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export class DayAggregator {
  readonly day: number;
  private readonly dayStart: number;
  private readonly dayEnd: number;
  private cur = -1;
  private trades = 0;
  private readonly fp = new FpBuilder(1 << 16);
  private readonly bars: Bar[] = [];
  private readonly bar = new BarAcc();
  private readonly candQ = new Float64Array(MINUTES_PER_DAY);
  private readonly candB = new Float64Array(MINUTES_PER_DAY);
  private candCount = 0;
  private g = 0;
  private lastPx = -1;
  // Level der laufenden Minute
  private readonly slot = new Map<number, number>();
  private lvN = 0;
  private lvPx: number[] = [];
  private lvBQ: number[] = [];
  private lvSQ: number[] = [];
  private lvBA: number[] = [];
  private lvSA: number[] = [];
  private finished = false;
  /** Für den Live-Pfad: je abgeschlossener Minute Zeilenbereich in fp und Index in bars. */
  private readonly flushed = new Map<
    number,
    { from: number; to: number; bar: number; bigFrom: number; bigTo: number }
  >();
  private onFlush: ((minute: number) => void) | null = null;
  // Orders (§3.7): die laufende Order und die Summen der laufenden Minute
  private readonly bigFloorN: number | null;
  private oOpen = false;
  private oT = 0;
  private oM = false;
  private oFirst = 0;
  private oLast = 0;
  private oPxFirst = 0;
  private oPxLast = 0;
  private oQty = 0;
  private oNtl = 0;
  private oN = 0;
  private mOrdersN = 0;
  private mOrdersQty = 0;
  private mOrdersAgg = 0;
  private mOrdersNtl = 0;
  private ordersN = 0;
  private ordersNotional = 0n;
  private readonly minOrdersN = new Float64Array(MINUTES_PER_DAY);
  private readonly minOrdersNtl = new Float64Array(MINUTES_PER_DAY);
  private readonly big: BigOrder[] = [];
  private bigMinuteFrom = 0;

  /**
   * `bigFloorN`: Untergrenze für big_order als ganzzahliges Notional (symbol.big_floor_n, Daten,
   * keine Code-Konstante); null = keine Untergrenze bekannt → es werden keine big orders gebildet.
   */
  constructor(day: number, bigFloorN: number | null) {
    if (bigFloorN !== null && !(Number.isSafeInteger(bigFloorN) && bigFloorN > 0)) {
      throw new Error(`big_floor_n muss eine positive Ganzzahl sein (ist ${bigFloorN})`);
    }
    this.day = day;
    this.dayStart = day * DAY_MS;
    this.dayEnd = this.dayStart + DAY_MS;
    this.bigFloorN = bigFloorN;
  }

  /** Laufende Order abschließen (Summen der Minute, ggf. big order). */
  private closeOrder(): void {
    if (!this.oOpen) return;
    this.oOpen = false;
    this.mOrdersN++;
    this.mOrdersQty += this.oQty;
    this.mOrdersAgg += this.oN;
    this.mOrdersNtl += this.oNtl;
    if (this.bigFloorN !== null && this.oNtl >= this.bigFloorN) {
      this.big.push({
        ts: this.oT,
        firstAggId: this.oFirst,
        lastAggId: this.oLast,
        side: this.oM ? SIDE_SELL : SIDE_BUY,
        pxFirst: this.oPxFirst,
        pxLast: this.oPxLast,
        qty: this.oQty,
        notional: this.oNtl,
        aggN: this.oN,
      });
    }
  }

  /** aggTrades müssen in aggId-Reihenfolge kommen; T darf innerhalb des Tages nicht über eine Minutengrenze zurücklaufen. */
  add(t: AggTrade): void {
    const T = t.T;
    if (T < this.dayStart || T >= this.dayEnd) {
      throw new Error(`aggTrade ${t.a}: T=${T} liegt nicht im UTC-Tag ${this.day}`);
    }
    const minute = (T - this.dayStart - (T % MINUTE_MS)) / MINUTE_MS;
    if (minute !== this.cur) {
      if (minute < this.cur) {
        throw new Error(
          `aggTrade ${t.a}: Zeit läuft über eine Minutengrenze zurück (Minute ${minute} nach ${this.cur})`,
        );
      }
      if (this.cur >= 0 && !this.flushed.has(this.cur)) this.flushMinute();
      this.cur = minute;
    } else if (this.flushed.has(minute)) {
      throw new Error(
        `aggTrade ${t.a}: Minute ${minute} ist bereits abgeschlossen (verspäteter Trade)`,
      );
    }
    // Order-Regel v1: gleiches T, gleiche Seite, aggId lückenlos +1 (T gleich ⇒ gleiche Minute).
    if (this.oOpen && t.T === this.oT && t.m === this.oM && t.a === this.oLast + 1) {
      this.oLast = t.a;
      this.oPxLast = t.px;
      this.oQty += t.q;
      this.oNtl += t.px * t.q;
      this.oN++;
    } else {
      this.closeOrder();
      this.oOpen = true;
      this.oT = t.T;
      this.oM = t.m;
      this.oFirst = t.a;
      this.oLast = t.a;
      this.oPxFirst = t.px;
      this.oPxLast = t.px;
      this.oQty = t.q;
      this.oNtl = t.px * t.q;
      this.oN = 1;
    }
    let s = this.slot.get(t.px);
    if (s === undefined) {
      s = this.lvN++;
      this.slot.set(t.px, s);
      this.lvPx[s] = t.px;
      this.lvBQ[s] = 0;
      this.lvSQ[s] = 0;
      this.lvBA[s] = 0;
      this.lvSA[s] = 0;
    }
    if (t.m) {
      this.lvSQ[s]! += t.q;
      this.lvSA[s]!++;
    } else {
      this.lvBQ[s]! += t.q;
      this.lvBA[s]!++;
    }
    this.bar.add(t.a, t.px, t.q, T, t.m);
    if (t.l > t.f && T % MINUTE_MS >= CANDIDATE_FROM_MS) {
      this.candQ[minute]! += t.q;
      if (!t.m) this.candB[minute]! += t.q;
      this.candCount++;
    }
    if (this.lastPx >= 0 && t.px !== this.lastPx) {
      this.g = gcd(this.g, Math.abs(t.px - this.lastPx));
    }
    this.lastPx = t.px;
    this.trades++;
  }

  private flushMinute(): void {
    const ts = this.dayStart + this.cur * MINUTE_MS;
    this.closeOrder();
    const from = this.fp.n;
    const idx = new Array<number>(this.lvN);
    for (let i = 0; i < this.lvN; i++) idx[i] = i;
    const px = this.lvPx;
    idx.sort((a, b) => px[a]! - px[b]!);
    for (const i of idx) {
      const bq = this.lvBQ[i]!;
      const sq = this.lvSQ[i]!;
      if (bq > INT32_MAX || sq > INT32_MAX) {
        throw new Error(`fp_1m-Überlauf: Menge > int32 bei ts=${ts}, px=${px[i]}`);
      }
      this.fp.push(ts, px[i]!, bq, sq, this.lvBA[i]!, this.lvSA[i]!);
    }
    const bar = this.bar.finish(ts);
    // Abgleich (§3.7): die Orders zerlegen die aggTrades der Minute; Menge, Anzahl und Notional
    // müssen exakt den Bar ergeben. Bricht hier, statt still falsche Orders zu speichern.
    if (
      BigInt(this.mOrdersNtl) !== bar.notional ||
      this.mOrdersQty !== bar.buyQ + bar.sellQ ||
      this.mOrdersAgg !== bar.buyA + bar.sellA
    ) {
      throw new Error(
        `Order-Zerlegung ≠ bar_1m bei ts=${ts}: notional ${this.mOrdersNtl}/${bar.notional}, ` +
          `qty ${this.mOrdersQty}/${bar.buyQ + bar.sellQ}, aggTrades ${this.mOrdersAgg}/${bar.buyA + bar.sellA}`,
      );
    }
    this.minOrdersN[this.cur] = this.mOrdersN;
    this.minOrdersNtl[this.cur] = this.mOrdersNtl;
    this.ordersN += this.mOrdersN;
    this.ordersNotional += BigInt(this.mOrdersNtl);
    this.mOrdersN = 0;
    this.mOrdersQty = 0;
    this.mOrdersAgg = 0;
    this.mOrdersNtl = 0;
    // big orders der Minute in Primärschlüssel-Reihenfolge (T darf innerhalb der Minute zurücklaufen)
    const bigFrom = this.bigMinuteFrom;
    if (this.big.length - bigFrom > 1) {
      const part = this.big
        .slice(bigFrom)
        .sort((a, b) => a.ts - b.ts || a.firstAggId - b.firstAggId);
      for (let i = 0; i < part.length; i++) this.big[bigFrom + i] = part[i]!;
    }
    this.bigMinuteFrom = this.big.length;
    this.bars.push(bar);
    this.flushed.set(this.cur, {
      from,
      to: this.fp.n,
      bar: this.bars.length - 1,
      bigFrom,
      bigTo: this.big.length,
    });
    const done = this.cur;
    this.bar.reset();
    this.slot.clear();
    this.lvN = 0;
    this.onFlush?.(done);
  }

  /**
   * Live-Pfad: Rückruf je abgeschlossener Minute (sobald der erste Trade der Folgeminute kommt
   * oder `closeOpenMinute` aufgerufen wird). Rechnet nichts anders als der Tagesimport.
   */
  setOnFlush(cb: ((minute: number) => void) | null): void {
    this.onFlush = cb;
  }

  /** Offene Minute < `beforeMinute` abschließen (Live-Pfad, ruhiger Markt ohne Folgetrade). */
  closeOpenMinute(beforeMinute: number): void {
    if (this.cur >= 0 && this.cur < beforeMinute && !this.flushed.has(this.cur)) this.flushMinute();
  }

  /**
   * Zeilen, Bar, big orders und Ordersummen einer abgeschlossenen Minute (Kopie bzw. Referenz);
   * undefined ohne Trades.
   */
  minute(m: number): { fp: FpTable; bar: Bar; big: BigOrder[]; orders: MinuteOrders } | undefined {
    const f = this.flushed.get(m);
    if (!f) return undefined;
    return {
      fp: this.fp.slice(f.from, f.to),
      bar: this.bars[f.bar]!,
      big: this.big.slice(f.bigFrom, f.bigTo),
      orders: { n: this.minOrdersN[m]!, notional: this.minOrdersNtl[m]! },
    };
  }

  /**
   * big orders aller abgeschlossenen Minuten bis einschließlich `m` (Kopie, Primärschlüssel-
   * Reihenfolge); für den Abgleich eines ganzen Live-Tages mit der Datenbank.
   */
  bigUpTo(m: number): BigOrder[] {
    const f = this.flushed.get(m);
    if (!f) throw new Error(`bigUpTo: Minute ${m} ist nicht abgeschlossen`);
    return this.big.slice(0, f.bigTo);
  }

  /** Kandidatensummen je Minute bisher (Live-Kline-Abgleich; Referenzen, nicht kopiert). */
  candidates(): { candQ: Float64Array; candB: Float64Array; count: number } {
    return { candQ: this.candQ, candB: this.candB, count: this.candCount };
  }

  /** Anzahl aggTrades bisher. */
  get tradeCount(): number {
    return this.trades;
  }

  finish(): DayAggregate {
    if (this.finished) throw new Error('DayAggregator.finish zweimal aufgerufen');
    this.finished = true;
    if (this.cur >= 0 && !this.flushed.has(this.cur)) this.flushMinute();
    return {
      day: this.day,
      trades: this.trades,
      fp1m: this.fp.build(),
      bars: this.bars,
      candQ: this.candQ,
      candB: this.candB,
      candCount: this.candCount,
      minStepUnits: this.g,
      ordersN: this.ordersN,
      ordersNotional: this.ordersNotional,
      bigFloorN: this.bigFloorN,
      bigOrders: this.big,
    };
  }
}

/** Bequemlichkeit für Tests: aggregiert eine Liste von aggTrades (in aggId-Reihenfolge) eines Tages. */
export function aggregateDay(
  day: number,
  trades: Iterable<AggTrade>,
  bigFloorN: number | null = null,
): DayAggregate {
  const agg = new DayAggregator(day, bigFloorN);
  for (const t of trades) agg.add(t);
  return agg.finish();
}
