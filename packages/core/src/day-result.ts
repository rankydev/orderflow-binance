// Alles, was aus einem Tagesaggregat und den Klines des Tages ohne Nachbartage folgt:
// Rollups, Bars höherer Zeitrahmen, Digests. Der Abgleich hängt zusätzlich von den Nachbartagen ab
// und wird separat (reconcileDay) berechnet.
import type { Bar } from './aggregation/bar.ts';
import type { DayAggregate } from './aggregation/day.ts';
import type { FpTable } from './aggregation/fp.ts';
import {
  computeBarRollups,
  computeFpRollups,
  FP_TABLES,
  type FpTableName,
} from './aggregation/rollup.ts';
import { buildReconcileInput, ohlcReport } from './classifier/input.ts';
import type { ReconcileInput } from './classifier/reconcile.ts';
import {
  barDigest,
  combineDigests,
  fpDigest,
  klineDigest,
  SOURCE_VISION,
  type DigestTable,
} from './digest.ts';
import type { Kline } from './parser/csv.ts';
import type { SymbolSpec } from './symbols.ts';
import { formatDay } from './time.ts';

export interface DayData {
  spec: SymbolSpec;
  day: number;
  dayStr: string;
  agg: DayAggregate;
  klines: Kline[];
  fp: Record<FpTableName, FpTable>;
  bar_1m: Bar[];
  bar_1h: Bar[];
  bar_1d: Bar[];
  reconcileInput: ReconcileInput;
  ohlc: ReturnType<typeof ohlcReport>;
  digests: Record<DigestTable, string>;
  /** Kombinierter Daten-Digest des Tages (data_day.digest). */
  digest: string;
}

export function buildDayData(spec: SymbolSpec, agg: DayAggregate, klines: Kline[]): DayData {
  const fp = computeFpRollups(agg.fp1m, spec.tickRefUnits);
  const { bar_1h, bar_1d } = computeBarRollups(agg.bars);
  const digests = {} as Record<DigestTable, string>;
  for (const t of FP_TABLES) digests[t] = fpDigest(spec.symId, fp[t]);
  digests.bar_1m = barDigest(spec.symId, agg.bars, SOURCE_VISION);
  digests.bar_1h = barDigest(spec.symId, bar_1h);
  digests.bar_1d = barDigest(spec.symId, bar_1d);
  digests.kline_1m = klineDigest(spec.symId, klines);
  return {
    spec,
    day: agg.day,
    dayStr: formatDay(agg.day),
    agg,
    klines,
    fp,
    bar_1m: agg.bars,
    bar_1h,
    bar_1d,
    reconcileInput: buildReconcileInput(agg, klines),
    ohlc: ohlcReport(agg, klines),
    digests,
    digest: combineDigests(digests),
  };
}
