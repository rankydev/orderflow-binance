// Rollups (KONZEPT §3.6) als reine Funktionen aus Basiszeilen. Alle Footprint-Rollups eines Tages
// entstehen hierarchisch (jede Stufe aus der nächstfeineren), die Bars per Komposition aus bar_1m.
// Die Property-Tests beweisen: hierarchisch = direkt aus fp_1m.
import { MINUTE_MS } from '../constants.ts';
import { composeBars, type Bar } from './bar.ts';
import { rowPx } from './bucket.ts';
import { FpBuilder, type FpTable } from './fp.ts';

export type FpTableName =
  | 'fp_1m'
  | 'fp_1m_b10'
  | 'fp_5m_b10'
  | 'fp_15m_b100'
  | 'fp_1h_b10'
  | 'fp_1h_b100'
  | 'fp_1d_b100'
  | 'fp_1d_b1000';

export interface FpRollupSpec {
  table: Exclude<FpTableName, 'fp_1m'>;
  tfMin: number;
  /** Bin in Ticks (Breite in price_unit = bin · tick_ref_units). */
  bin: number;
  /** Quelle der hierarchischen Berechnung. */
  from: FpTableName;
}

/** Tabellen nach §3.6 in Berechnungsreihenfolge. */
export const FP_ROLLUPS: readonly FpRollupSpec[] = [
  { table: 'fp_1m_b10', tfMin: 1, bin: 10, from: 'fp_1m' },
  { table: 'fp_5m_b10', tfMin: 5, bin: 10, from: 'fp_1m_b10' },
  { table: 'fp_15m_b100', tfMin: 15, bin: 100, from: 'fp_5m_b10' },
  { table: 'fp_1h_b10', tfMin: 60, bin: 10, from: 'fp_5m_b10' },
  { table: 'fp_1h_b100', tfMin: 60, bin: 100, from: 'fp_15m_b100' },
  { table: 'fp_1d_b100', tfMin: 1440, bin: 100, from: 'fp_1h_b100' },
  { table: 'fp_1d_b1000', tfMin: 1440, bin: 1000, from: 'fp_1d_b100' },
];

export const FP_TABLES: readonly FpTableName[] = ['fp_1m', ...FP_ROLLUPS.map((r) => r.table)];

/**
 * Re-Bucketing einer nach (ts, px) sortierten Tabelle auf Zeitraster tfMin und Zeilenbreite
 * `width` (price_unit). Korrekt, sobald das Quellraster das Zielraster teilt (Aufrufer prüft).
 */
export function rollupFp(src: FpTable, tfMin: number, width: number): FpTable {
  const tfMs = tfMin * MINUTE_MS;
  const out = new FpBuilder(Math.max(16, src.n >> 2));
  const acc = new Map<number, number>();
  let rpx: number[] = [];
  let bq: number[] = [];
  let sq: number[] = [];
  let ba: number[] = [];
  let sa: number[] = [];
  let bucket = -1;
  const flush = () => {
    const idx = rpx.map((_, i) => i).sort((a, b) => rpx[a]! - rpx[b]!);
    for (const i of idx) out.push(bucket, rpx[i]!, bq[i]!, sq[i]!, ba[i]!, sa[i]!);
    acc.clear();
    rpx = [];
    bq = [];
    sq = [];
    ba = [];
    sa = [];
  };
  for (let i = 0; i < src.n; i++) {
    const ts = src.ts[i]!;
    const b = ts - (ts % tfMs);
    if (b !== bucket) {
      if (b < bucket) throw new Error('rollupFp: Quelle nicht nach ts sortiert');
      if (bucket >= 0) flush();
      bucket = b;
    }
    const r = rowPx(src.px[i]!, width);
    let k = acc.get(r);
    if (k === undefined) {
      k = rpx.length;
      acc.set(r, k);
      rpx.push(r);
      bq.push(0);
      sq.push(0);
      ba.push(0);
      sa.push(0);
    }
    bq[k]! += src.buyQ[i]!;
    sq[k]! += src.sellQ[i]!;
    ba[k]! += src.buyA[i]!;
    sa[k]! += src.sellA[i]!;
  }
  if (bucket >= 0) flush();
  return out.build();
}

/** Alle Footprint-Rollups eines Tages, hierarchisch aus fp_1m. */
export function computeFpRollups(
  fp1m: FpTable,
  tickRefUnits: number,
): Record<FpTableName, FpTable> {
  const res: Partial<Record<FpTableName, FpTable>> = { fp_1m: fp1m };
  const specOf = (t: FpTableName) =>
    t === 'fp_1m' ? { tfMin: 1, bin: 1 } : FP_ROLLUPS.find((r) => r.table === t)!;
  for (const r of FP_ROLLUPS) {
    const src = specOf(r.from);
    if (r.tfMin % src.tfMin !== 0 || r.bin % src.bin !== 0) {
      throw new Error(`Rollup ${r.table} ist nicht aus ${r.from} komponierbar`);
    }
    res[r.table] = rollupFp(res[r.from]!, r.tfMin, r.bin * tickRefUnits);
  }
  return res as Record<FpTableName, FpTable>;
}

/** Bars höherer Zeitrahmen aus nach ts sortierten Teilbars (bar_1m oder bereits komponiert). */
export function rollupBars(bars: readonly Bar[], tfMin: number): Bar[] {
  const tfMs = tfMin * MINUTE_MS;
  const out: Bar[] = [];
  let group: Bar[] = [];
  let bucket = -1;
  for (const b of bars) {
    const k = b.ts - (b.ts % tfMs);
    if (k !== bucket) {
      if (k < bucket) throw new Error('rollupBars: Bars nicht sortiert');
      if (group.length > 0) out.push(composeBars(bucket, group));
      group = [];
      bucket = k;
    }
    group.push(b);
  }
  if (group.length > 0) out.push(composeBars(bucket, group));
  return out;
}

export type BarTableName = 'bar_1m' | 'bar_1h' | 'bar_1d';

export function computeBarRollups(bars1m: readonly Bar[]): { bar_1h: Bar[]; bar_1d: Bar[] } {
  const bar_1h = rollupBars(bars1m, 60);
  const bar_1d = rollupBars(bar_1h, 1440);
  return { bar_1h, bar_1d };
}
