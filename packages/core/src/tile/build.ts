// Aufbau von Kacheln aus Footprint-Zeilen (FpTable) und Bars (KONZEPT §5.2/§5.3). Rein; die künftige
// API baut dieselben Spalten aus SQL-Ergebnissen, der Fixture-Generator aus den Rollups von core.
import type { Bar } from '../aggregation/bar.ts';
import type { FpTable } from '../aggregation/fp.ts';
import type { FpTableName } from '../aggregation/rollup.ts';
import { FP_ROLLUPS } from '../aggregation/rollup.ts';
import type { BarColumns, LevelColumns, TileData, TileMeta } from './codec.ts';

/** Zeitraster (min) und Bin (Ticks) jeder gespeicherten Footprint-Tabelle. */
export function fpTableGrid(t: FpTableName): { tfMin: number; bin: number } {
  if (t === 'fp_1m') return { tfMin: 1, bin: 1 };
  const r = FP_ROLLUPS.find((x) => x.table === t);
  if (!r) throw new Error(`Unbekannte Tabelle ${t}`);
  return { tfMin: r.tfMin, bin: r.bin };
}

/**
 * Quellenwahl (KONZEPT §5.2): Kandidaten sind alle Tabellen, deren Zeitraster tf teilt und deren Bin R
 * teilt; gewählt wird die mit den wenigsten geschätzten Quellzeilen (Zeilen/Tag aus einer Statistik).
 * Bei Gleichstand gewinnt die gröbere Tabelle (weniger Arbeit beim Re-Bucketing).
 */
export function chooseFpSource(
  tfMin: number,
  r: number,
  rowsPerDay: Partial<Record<FpTableName, number>>,
): FpTableName {
  let best: FpTableName = 'fp_1m';
  let bestRows = Infinity;
  for (const t of ['fp_1m', ...FP_ROLLUPS.map((x) => x.table)] as FpTableName[]) {
    const g = fpTableGrid(t);
    if (tfMin % g.tfMin !== 0 || r % g.bin !== 0) continue;
    const rows = rowsPerDay[t];
    if (rows === undefined) continue;
    if (rows <= bestRows) {
      best = t;
      bestRows = rows;
    }
  }
  if (bestRows === Infinity) throw new Error(`Keine Quelltabelle für tf=${tfMin}m, R=${r}`);
  return best;
}

/**
 * Wert für eine Int32-Spalte; wirft statt still zu überlaufen (Int32Array schneidet ab 2^31 ab und
 * der Encoder erkennt nur negative Ergebnisse – Review E).
 */
export function i32(v: number, what: string): number {
  if (!Number.isInteger(v) || v < -2_147_483_648 || v > 2_147_483_647) {
    throw new RangeError(`${what} = ${v} passt nicht in Int32`);
  }
  return v;
}

function barColumns(n: number): BarColumns {
  return {
    time: new Int32Array(n),
    open: new Int32Array(n),
    high: new Int32Array(n),
    low: new Int32Array(n),
    close: new Int32Array(n),
    buyQ: new Float64Array(n),
    sellQ: new Float64Array(n),
    buyA: new Int32Array(n),
    sellA: new Int32Array(n),
  };
}

function lowerBound(a: ArrayLike<number>, n: number, v: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function fillBars(cols: BarColumns, bars: readonly Bar[], s: number, e: number): void {
  for (let i = s; i < e; i++) {
    const b = bars[i]!;
    const k = i - s;
    cols.time[k] = i32(b.ts / 1000, 'time');
    cols.open[k] = i32(b.open, 'open');
    cols.high[k] = i32(b.high, 'high');
    cols.low[k] = i32(b.low, 'low');
    cols.close[k] = i32(b.close, 'close');
    cols.buyQ[k] = b.buyQ;
    cols.sellQ[k] = b.sellQ;
    cols.buyA[k] = i32(b.buyA, 'buyA');
    cols.sellA[k] = i32(b.sellA, 'sellA');
  }
}

/** Bars (nach ts sortiert) im Zeitraum [fromMs, toMs) als bars-Kachel. */
export function buildBarsTile(
  meta: Omit<TileMeta, 'kind' | 'R' | 'tile'>,
  bars: readonly Bar[],
): TileData {
  const ts = bars.map((b) => b.ts);
  const s = lowerBound(ts, ts.length, meta.from);
  const e = lowerBound(ts, ts.length, meta.to);
  const cols = barColumns(e - s);
  fillBars(cols, bars, s, e);
  return { meta: { ...meta, kind: 'bars', R: null, tile: null }, bars: cols };
}

/**
 * Footprint-Kachel k aus Zeilen, die bereits auf (tf, R) gebucketet sind (rollupFp mit Breite
 * R·tick_ref_units; px = untere Zeilenkante), und den Bars desselben tf. Jeder Bar muss Level haben
 * und umgekehrt (beide entstehen aus denselben aggTrades).
 */
export function buildFootprintTile(
  meta: Omit<TileMeta, 'kind' | 'from' | 'to'> & { R: number; tile: { index: number; n: number } },
  fp: FpTable,
  bars: readonly Bar[],
): TileData {
  const span = meta.tile.n * meta.tfSec * 1000;
  const from = meta.tile.index * span;
  const to = from + span;
  const width = meta.R * meta.tickRefUnits;
  const ts = bars.map((b) => b.ts);
  const s = lowerBound(ts, ts.length, from);
  const e = lowerBound(ts, ts.length, to);
  const cols = barColumns(e - s);
  fillBars(cols, bars, s, e);
  const ls = lowerBound(fp.ts, fp.n, from);
  const le = lowerBound(fp.ts, fp.n, to);
  const nl = le - ls;
  const levels: LevelColumns = {
    levelOffset: new Int32Array(e - s + 1),
    row: new Int32Array(nl),
    buy: new Float64Array(nl),
    sell: new Float64Array(nl),
    buyA: new Int32Array(nl),
    sellA: new Int32Array(nl),
  };
  let j = ls;
  for (let i = 0; i < e - s; i++) {
    const t = bars[s + i]!.ts;
    levels.levelOffset[i] = j - ls;
    if (j >= le || fp.ts[j] !== t) throw new Error(`Bar ${t} ohne Footprint-Zeilen`);
    while (j < le && fp.ts[j] === t) {
      const k = j - ls;
      const px = fp.px[j]!;
      if (px % width !== 0) throw new Error(`Zeile ${px} liegt nicht auf dem Raster ${width}`);
      levels.row[k] = i32(px / width, 'row');
      levels.buy[k] = fp.buyQ[j]!;
      levels.sell[k] = fp.sellQ[j]!;
      levels.buyA[k] = i32(fp.buyA[j]!, 'buyA');
      levels.sellA[k] = i32(fp.sellA[j]!, 'sellA');
      j++;
    }
  }
  if (j !== le) throw new Error(`Footprint-Zeilen ohne Bar bei ts=${fp.ts[j]}`);
  levels.levelOffset[e - s] = nl;
  return {
    meta: { ...meta, kind: 'footprint', from, to },
    bars: cols,
    levels,
  };
}
