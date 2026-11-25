// Stats-Spalten je Bar (KONZEPT §3.5, §6.2) als optionale `x.`-Spalten der bars- und footprint-Kacheln:
//   x.maxDelta, x.minDelta  f64 Lots: max/min über die Teilbars i von P_{i−1} + run_max_i / run_min_i
//   x.cotHigh               f64 Lots: Delta seit der Bar ihr LOW gebildet hat (DeepCharts „COT High"):
//                           j = erste Teilbar mit low_j = Bar-Low, d_from_low_j + Σ_{i>j} d_i
//   x.cotLow                f64 Lots: dasselbe mit dem High und d_from_high
//   x.trades                i32: Σ kline_1m.trades der Minuten der Bar (Binance-Zählung)
// Komposition ausschließlich mit composeBars aus @orderflow/core – derselbe Code, mit dem der Importer
// bar_1h/bar_1d aus bar_1m bildet (dort durch Property-Tests gegen Brute-Force über aggTrades belegt).
import { composeBars, type Bar } from '@orderflow/core';
import { DataInconsistency } from './db.ts';
import type { BarRows, SubBar } from './queries.ts';

export const STATS_COLUMNS = [
  'x.trades',
  'x.maxDelta',
  'x.minDelta',
  'x.cotHigh',
  'x.cotLow',
] as const;

const asBar = (b: SubBar): Bar => ({
  ...b,
  notional: 0n,
  firstAggId: 0,
  lastAggId: 0,
  firstTradeMs: 0,
  lastTradeMs: 0,
});

/**
 * Stats-Spalten zu den Bars (gleiche Reihenfolge und Länge wie `time`). `trades` = null → keine
 * x.trades-Spalte (zu teuer für den Zeitraum). Die Komposition prüft zugleich die Konsistenz
 * (Σ Teilbars = Bar); eine Abweichung ist eine DataInconsistency (503, nie 500).
 */
export function statsColumns(
  bars: BarRows,
  sub: SubBar[],
  tfSec: number,
  trades: Map<number, number> | null,
  immutable: boolean,
  where: Record<string, unknown>,
): Record<string, Int32Array | Float64Array> {
  const n = bars.time.length;
  const maxD = new Float64Array(n);
  const minD = new Float64Array(n);
  const cotH = new Float64Array(n);
  const cotL = new Float64Array(n);
  const tr = trades ? new Int32Array(n) : null;
  const tfMs = tfSec * 1000;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = bars.time[i]! * 1000;
    while (j < sub.length && sub[j]!.ts < t) j++;
    const j0 = j;
    while (j < sub.length && sub[j]!.ts < t + tfMs) j++;
    if (j === j0) throw new DataInconsistency(`Bar t=${t / 1000} ohne Teilbars`, immutable, where);
    const c = composeBars(t, sub.slice(j0, j).map(asBar));
    if (
      c.buyQ !== bars.buyQ[i] ||
      c.sellQ !== bars.sellQ[i] ||
      c.high !== bars.high[i] ||
      c.low !== bars.low[i]
    )
      throw new DataInconsistency(`Bar t=${t / 1000}: Teilbars ≠ Bar`, immutable, where);
    maxD[i] = c.runMax;
    minD[i] = c.runMin;
    cotH[i] = c.dFromLow;
    cotL[i] = c.dFromHigh;
    if (tr) {
      const v = trades!.get(t / 1000) ?? 0;
      if (v > 2_147_483_647) throw new RangeError(`x.trades ${v} passt nicht in Int32`);
      tr[i] = v;
    }
  }
  const out: Record<string, Int32Array | Float64Array> = {};
  if (tr) out['x.trades'] = tr;
  out['x.maxDelta'] = maxD;
  out['x.minDelta'] = minD;
  out['x.cotHigh'] = cotH;
  out['x.cotLow'] = cotL;
  return out;
}

/** Höchstzahl geschätzter kline_1m-Zeilen, bis zu der x.trades mitgeliefert wird. */
export const TRADES_MAX_ROWS = 100_000;
