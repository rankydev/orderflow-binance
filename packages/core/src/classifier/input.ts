// Aufbau der Abgleich-Eingaben aus Tagesaggregat und Klines eines UTC-Tages.
import { DAY_MS, MINUTE_MS } from '../constants.ts';
import type { DayAggregate } from '../aggregation/day.ts';
import type { Kline } from '../parser/csv.ts';
import { MINUTES_PER_DAY } from '../time.ts';
import type { ReconcileInput } from './reconcile.ts';

/** Prüft die Klines eines Tages (im Tag, eindeutig, aufsteigend) und liefert sie je Minute. */
export function indexKlines(day: number, klines: readonly Kline[]): (Kline | undefined)[] {
  const start = day * DAY_MS;
  const out: (Kline | undefined)[] = new Array(MINUTES_PER_DAY).fill(undefined);
  let prev = -1;
  for (const k of klines) {
    const m = (k.openTime - start) / MINUTE_MS;
    if (!Number.isInteger(m) || m < 0 || m >= MINUTES_PER_DAY) {
      throw new Error(`Kline open_time ${k.openTime} liegt nicht im Tag ${day}`);
    }
    if (m <= prev) throw new Error(`Klines nicht streng aufsteigend bei open_time ${k.openTime}`);
    prev = m;
    out[m] = k;
  }
  return out;
}

export function buildReconcileInput(agg: DayAggregate, klines: readonly Kline[]): ReconcileInput {
  const n = MINUTES_PER_DAY;
  const start = agg.day * DAY_MS;
  const inp: ReconcileInput = {
    ourQ: new Float64Array(n),
    ourB: new Float64Array(n),
    hasRow: new Uint8Array(n),
    klQ: new Float64Array(n),
    klB: new Float64Array(n),
    hasKline: new Uint8Array(n),
    candQ: agg.candQ,
    candB: agg.candB,
  };
  for (const b of agg.bars) {
    const m = (b.ts - start) / MINUTE_MS;
    inp.ourQ[m] = b.buyQ + b.sellQ;
    // Taker-Buy = Käufer-Aggressor (m = false) = buy_q.
    inp.ourB[m] = b.buyQ;
    inp.hasRow[m] = 1;
  }
  const byMin = indexKlines(agg.day, klines);
  for (let m = 0; m < n; m++) {
    const k = byMin[m];
    if (!k) continue;
    inp.hasKline[m] = 1;
    inp.klQ[m] = k.vol;
    inp.klB[m] = k.takerBuy;
  }
  return inp;
}

/** OHLC-Bericht (keine Klasse): Minuten, in denen unser OHLC vom Kline-OHLC abweicht. */
export function ohlcReport(
  agg: DayAggregate,
  klines: readonly Kline[],
): { compared: number; open: number; high: number; low: number; close: number } {
  const byMin = indexKlines(agg.day, klines);
  const start = agg.day * DAY_MS;
  const r = { compared: 0, open: 0, high: 0, low: 0, close: 0 };
  for (const b of agg.bars) {
    const k = byMin[(b.ts - start) / MINUTE_MS];
    if (!k || k.vol === 0) continue;
    r.compared++;
    if (k.open !== b.open) r.open++;
    if (k.high !== b.high) r.high++;
    if (k.low !== b.low) r.low++;
    if (k.close !== b.close) r.close++;
  }
  return r;
}
