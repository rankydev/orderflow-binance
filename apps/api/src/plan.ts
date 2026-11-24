// Quellenwahl, Zerlegung von Zeiträumen und Zeilenschätzung (KONZEPT §5.1, §5.2). Rein, ohne I/O.
//
// Footprint-Kacheln: chooseFpSource (@orderflow/core) über alle Tabellen, deren Zeitraster tf teilt und
// deren Bin R teilt. Bars: die gröbste Bar-Tabelle, deren Raster tf teilt (bar_1d, bar_1h, bar_1m).
// Profile: ein Zeitraum wird von grob nach fein zerlegt – ganze UTC-Tage aus den 1d-Tabellen (falls ein
// gespeicherter 1d-Bin R teilt), ganze Stunden aus 1h, dann 15m, 5m, Minuten. Jede Zeile einer Quelle
// gehört ganz zu genau einem Teilbereich; Re-Binning auf R ist exakt, weil der Bin der Quelle R teilt
// (floor(floor(px/b)·b / w) = floor(px/w) für b | w). Damit ist jedes Profil gleich der Summe über
// fp_1m im Zeitraum, neu gebinnt – keine Näherung.
import { FP_ROLLUPS, fpTableGrid, type FpTableName } from '@orderflow/core';
import { DAY_MS, MINUTE_MS } from './params.ts';

export type BarTable = 'bar_1m' | 'bar_1h' | 'bar_1d';
export const BAR_TABLES: readonly BarTable[] = ['bar_1m', 'bar_1h', 'bar_1d'];
export const FP_TABLE_NAMES: readonly FpTableName[] = ['fp_1m', ...FP_ROLLUPS.map((r) => r.table)];
const BAR_TABLE_MIN: Record<BarTable, number> = { bar_1m: 1, bar_1h: 60, bar_1d: 1440 };

export function barTableMinutes(t: BarTable): number {
  return BAR_TABLE_MIN[t];
}

/** Gröbste Bar-Tabelle, deren Zeitraster tfMin teilt. */
export function barTableFor(tfMin: number): BarTable {
  if (tfMin % 1440 === 0) return 'bar_1d';
  if (tfMin % 60 === 0) return 'bar_1h';
  return 'bar_1m';
}

/** Zeitraster (Minuten) eines Teilbereichs → Bar-Tabelle für Preisbereich, Summen und Notional. */
function barTableForGrid(gridMin: number): BarTable {
  return gridMin >= 1440 ? 'bar_1d' : gridMin >= 60 ? 'bar_1h' : 'bar_1m';
}

export interface Segment<T extends string = FpTableName> {
  table: T;
  /** [from, to) in ms; an das Zeitraster der Tabelle ausgerichtet. */
  from: number;
  to: number;
}

/**
 * Zeitraster für Profile mit Zeilengröße R, grob → fein: je Zeitraster die Tabelle mit dem größten
 * Bin, der R teilt. fp_1m (1 Minute, Bin 1) ist immer dabei, also ist jede minutengenaue Zerlegung möglich.
 */
export function profileGrids(R: number): { gridMin: number; table: FpTableName }[] {
  const out: { gridMin: number; table: FpTableName }[] = [];
  for (const gridMin of [1440, 60, 15, 5, 1]) {
    let best: FpTableName | null = null;
    let bestBin = 0;
    for (const t of FP_TABLE_NAMES) {
      const g = fpTableGrid(t);
      if (g.tfMin !== gridMin || R % g.bin !== 0) continue;
      if (g.bin > bestBin) {
        best = t;
        bestBin = g.bin;
      }
    }
    if (best) out.push({ gridMin, table: best });
  }
  return out;
}

/** Fügt aneinanderstoßende Teilbereiche derselben Tabelle zusammen (Eingabe nach from sortiert). */
export function mergeSegments<T extends string>(segs: Segment<T>[]): Segment<T>[] {
  const out: Segment<T>[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.table === s.table && last.to === s.from) last.to = s.to;
    else out.push({ ...s });
  }
  return out;
}

/**
 * Zerlegt [from, to) (minutengenau) in Teilbereiche, grob → fein (KONZEPT §5.2: „Mitte aus 1h,
 * Ränder aus 1m"). Ergebnis nach from sortiert, lückenlos, ohne Überlappung.
 */
export function decomposeRange(from: number, to: number, R: number): Segment[] {
  if (from % MINUTE_MS !== 0 || to % MINUTE_MS !== 0) throw new Error('nicht minutengenau');
  const grids = profileGrids(R);
  const out: Segment[] = [];
  const rec = (a: number, b: number, gi: number) => {
    if (a >= b) return;
    const g = grids[gi]!;
    const step = g.gridMin * MINUTE_MS;
    const s = Math.ceil(a / step) * step;
    const e = Math.floor(b / step) * step;
    if (gi === grids.length - 1 || s >= e) {
      if (gi === grids.length - 1) out.push({ table: g.table, from: a, to: b });
      else rec(a, b, gi + 1);
      return;
    }
    rec(a, s, gi + 1);
    out.push({ table: g.table, from: s, to: e });
    rec(e, b, gi + 1);
  };
  rec(from, to, 0);
  return mergeSegments(out.sort((x, y) => x.from - y.from));
}

/**
 * Tagesprofile: jeder Tag d überdeckt [d·24h + offset, (d+1)·24h + offset) und wird für sich zerlegt
 * (bei Offset ≠ 0 also nie aus 1d-Tabellen, KONZEPT §6.3); danach aneinanderstoßende Teilbereiche
 * derselben Tabelle zusammengefasst. Jede Quellzeile liegt ganz in einem Tag.
 */
export function decomposeDays(from: number, to: number, R: number): Segment[] {
  const out: Segment[] = [];
  for (let a = from; a < to; a += DAY_MS) out.push(...decomposeRange(a, a + DAY_MS, R));
  return mergeSegments(out);
}

/** Bar-Teilbereiche zu Footprint-Teilbereichen (gleiche Grenzen, Bar-Tabelle nach Zeitraster). */
export function barSegmentsFor(segs: Segment[]): Segment<BarTable>[] {
  return mergeSegments(
    segs.map((s) => ({
      table: barTableForGrid(fpTableGrid(s.table).tfMin),
      from: s.from,
      to: s.to,
    })),
  );
}

/** Zeilen je (Tabelle, UTC-Tag); undefined = keine Daten an dem Tag. */
export type RowsOn = (table: FpTableName | BarTable, day: number) => number | undefined;

/** Obergrenze der Bar-Zeilen je Tag (eine Zeile je Minute/Stunde/Tag mit Trades). */
export const BAR_ROWS_PER_DAY: Record<BarTable, number> = { bar_1m: 1440, bar_1h: 24, bar_1d: 1 };

/**
 * Geschätzte gelesene Quellzeilen in [from, to): Σ über die überdeckten UTC-Tage von
 * Zeilen(Tag) × überdeckter Anteil des Tages (KONZEPT §5.1: Statistik je Tag × Zeitraum).
 */
export function estimateRows(
  table: FpTableName | BarTable,
  from: number,
  to: number,
  rowsOn: RowsOn,
): number {
  let sum = 0;
  const d0 = Math.floor(from / DAY_MS);
  const d1 = Math.floor((to - 1) / DAY_MS);
  for (let d = d0; d <= d1; d++) {
    const r = rowsOn(table, d);
    if (!r) continue;
    const a = Math.max(from, d * DAY_MS);
    const b = Math.min(to, (d + 1) * DAY_MS);
    sum += (r * (b - a)) / DAY_MS;
  }
  return Math.ceil(sum);
}

export function estimateSegments(segs: Segment<string>[], rowsOn: RowsOn): number {
  let s = 0;
  for (const g of segs) s += estimateRows(g.table as FpTableName | BarTable, g.from, g.to, rowsOn);
  return s;
}

/** UTC-Tage, die [from, to) überdeckt: [d0, d1] inklusive. */
export function coveredDays(from: number, to: number): [number, number] {
  return [Math.floor(from / DAY_MS), Math.floor((to - 1) / DAY_MS)];
}
