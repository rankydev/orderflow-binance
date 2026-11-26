// Live-Aggregation eines UTC-Tages (KONZEPT §4.2): dieselbe Rechnung wie der Tagesimport, aber
// minutenweise. Je abgeschlossener Minute werden genau die betroffenen Buckets aller Tabellen neu
// berechnet – mit denselben Funktionen und derselben Hierarchie wie computeFpRollups /
// computeBarRollups (FP_ROLLUPS), daher ist der Tag nach der letzten Minute zeilengleich mit dem
// Import (bewiesen per Replay-Test, Digest-Gleichheit). Rein, ohne I/O.
import type { Bar } from '../aggregation/bar.ts';
import { composeBars } from '../aggregation/bar.ts';
import { DayAggregator, type BigOrder } from '../aggregation/day.ts';
import { concatFp, emptyFp, type FpTable } from '../aggregation/fp.ts';
import { FP_ROLLUPS, rollupFp, type FpTableName } from '../aggregation/rollup.ts';
import { DAY_MS, MINUTE_MS } from '../constants.ts';
import type { AggTrade } from '../parser/csv.ts';
import type { SymbolSpec } from '../symbols.ts';

/** Ein zu ersetzender Bucket einer Tabelle: [from, to) in ms und die neuen Zeilen. */
export interface FpBucket {
  table: FpTableName;
  from: number;
  to: number;
  rows: FpTable;
}

export interface BarBucket {
  table: 'bar_1m' | 'bar_1h' | 'bar_1d';
  from: number;
  to: number;
  bars: Bar[];
}

/** Alles, was eine abgeschlossene Minute in der Datenbank ändert (eine Transaktion). */
export interface MinuteDelta {
  day: number;
  minute: number;
  fp: FpBucket[];
  bars: BarBucket[];
  /** Mindestens ein Trade der Minute kam per REST (bar_1m.source = 2 statt 1). */
  viaRest: boolean;
  trades: number;
  /** big_order der Minute (Replace des Minutenbereichs [from, to)). */
  big: { from: number; to: number; rows: BigOrder[] };
  /**
   * Ordersummen des Tages über alle bis jetzt abgeschlossenen Minuten (data_day.orders_n,
   * orders_notional; absolut, nicht inkrementell) und die verwendete Untergrenze.
   */
  orders: { n: number; notional: bigint; bigFloorN: number | null };
}

const TF_OF: Record<FpTableName, number> = { fp_1m: 1 } as Record<FpTableName, number>;
for (const r of FP_ROLLUPS) TF_OF[r.table] = r.tfMin;

export class LiveDay {
  readonly day: number;
  readonly spec: SymbolSpec;
  readonly agg: DayAggregator;
  private readonly dayStart: number;
  /** je Tabelle: Bucketbeginn (ms) → Zeilen */
  private readonly fp = new Map<FpTableName, Map<number, FpTable>>();
  private readonly bars1m = new Map<number, Bar>();
  private readonly bars1h = new Map<number, Bar>();
  private bar1d: Bar | null = null;
  private readonly restMinutes = new Set<number>();
  private readonly pending: number[] = [];
  /** Minuten, die bereits vollständig verarbeitet sind (für Kontrolle und Neustart). */
  readonly completed = new Set<number>();

  private readonly bigFloorN: number | null;
  private ordersN = 0;
  private ordersNotional = 0n;

  /** `bigFloorN`: symbol.big_floor_n (wie im Import; null = keine big orders). */
  constructor(spec: SymbolSpec, day: number, bigFloorN: number | null) {
    this.spec = spec;
    this.day = day;
    this.dayStart = day * DAY_MS;
    this.bigFloorN = bigFloorN;
    this.agg = new DayAggregator(day, bigFloorN);
    this.fp.set('fp_1m', new Map());
    for (const r of FP_ROLLUPS) this.fp.set(r.table, new Map());
    this.agg.setOnFlush((m) => this.pending.push(m));
  }

  /** aggTrade in aggId-Reihenfolge; `viaRest` markiert die Minute als live+rest. */
  add(t: AggTrade, viaRest = false): void {
    this.agg.add(t);
    if (viaRest) this.restMinutes.add((t.T - this.dayStart - (t.T % MINUTE_MS)) / MINUTE_MS);
  }

  /**
   * Minuten < `beforeMinute` abschließen und je Minute (aufsteigend) die Deltas liefern. Minuten
   * ohne Trades erzeugen kein Delta (keine Zeilen, die Buckets ändern sich nicht).
   */
  complete(beforeMinute: number): MinuteDelta[] {
    this.agg.closeOpenMinute(beforeMinute);
    const out: MinuteDelta[] = [];
    while (this.pending.length > 0 && this.pending[0]! < beforeMinute) {
      out.push(this.recompute(this.pending.shift()!));
    }
    return out;
  }

  private bucket(table: FpTableName, ts: number): [number, number] {
    const tf = TF_OF[table] * MINUTE_MS;
    const from = ts - (ts % tf);
    return [from, from + tf];
  }

  /** Zeilen einer Tabelle in [from, to), nach Bucket sortiert aneinandergehängt. */
  private rowsIn(table: FpTableName, from: number, to: number): FpTable {
    const m = this.fp.get(table)!;
    const keys = [...m.keys()].filter((k) => k >= from && k < to).sort((a, b) => a - b);
    if (keys.length === 0) return emptyFp();
    if (keys.length === 1) return m.get(keys[0]!)!;
    return concatFp(keys.map((k) => m.get(k)!));
  }

  private recompute(minute: number): MinuteDelta {
    const tick = this.spec.tickRefUnits;
    const ts = this.dayStart + minute * MINUTE_MS;
    const got = this.agg.minute(minute)!;
    const fpOut: FpBucket[] = [];
    this.fp.get('fp_1m')!.set(ts, got.fp);
    fpOut.push({ table: 'fp_1m', from: ts, to: ts + MINUTE_MS, rows: got.fp });
    for (const r of FP_ROLLUPS) {
      const [from, to] = this.bucket(r.table, ts);
      const src = this.rowsIn(r.from, from, to);
      const rows = rollupFp(src, r.tfMin, r.bin * tick);
      this.fp.get(r.table)!.set(from, rows);
      fpOut.push({ table: r.table, from, to, rows });
    }
    this.bars1m.set(ts, got.bar);
    const hFrom = ts - (ts % (60 * MINUTE_MS));
    const hourBars = [...this.bars1m.entries()]
      .filter(([k]) => k >= hFrom && k < hFrom + 60 * MINUTE_MS)
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => b);
    const h = composeBars(hFrom, hourBars);
    this.bars1h.set(hFrom, h);
    const dayBars = [...this.bars1h.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    this.bar1d = composeBars(this.dayStart, dayBars);
    if (this.completed.has(minute)) throw new Error(`LiveDay: Minute ${minute} doppelt berechnet`);
    this.completed.add(minute);
    this.ordersN += got.orders.n;
    this.ordersNotional += BigInt(got.orders.notional);
    return {
      day: this.day,
      minute,
      fp: fpOut,
      bars: [
        { table: 'bar_1m', from: ts, to: ts + MINUTE_MS, bars: [got.bar] },
        { table: 'bar_1h', from: hFrom, to: hFrom + 60 * MINUTE_MS, bars: [h] },
        { table: 'bar_1d', from: this.dayStart, to: this.dayStart + DAY_MS, bars: [this.bar1d] },
      ],
      viaRest: this.restMinutes.has(minute),
      trades: got.bar.buyA + got.bar.sellA,
      big: { from: ts, to: ts + MINUTE_MS, rows: got.big },
      orders: { n: this.ordersN, notional: this.ordersNotional, bigFloorN: this.bigFloorN },
    };
  }

  /** Aktueller Stand aller Tabellen (für Replay-Beweis und Abgleich). */
  snapshot(): {
    fp: Record<FpTableName, FpTable>;
    bar_1m: Bar[];
    bar_1h: Bar[];
    bar_1d: Bar[];
    bigOrders: BigOrder[];
    orders: { n: number; notional: bigint };
  } {
    const fp = {} as Record<FpTableName, FpTable>;
    for (const [t] of this.fp) fp[t] = this.rowsIn(t, this.dayStart, this.dayStart + DAY_MS);
    const sorted = (m: Map<number, Bar>) =>
      [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    return {
      fp,
      bar_1m: sorted(this.bars1m),
      bar_1h: sorted(this.bars1h),
      bar_1d: this.bar1d ? [this.bar1d] : [],
      bigOrders: [...this.completed].sort((a, b) => a - b).flatMap((m) => this.agg.minute(m)!.big),
      orders: { n: this.ordersN, notional: this.ordersNotional },
    };
  }

  /** bar_1m der abgeschlossenen Minuten (für den Kline-Abgleich des Tages bis jetzt). */
  completedBars(): Bar[] {
    return [...this.bars1m.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  }
}
