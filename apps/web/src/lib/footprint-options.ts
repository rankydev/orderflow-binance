// Einstellungen der Footprint-Marken und des Stats-Grids (KONZEPT §6.1/§6.2, P4) samt URL-Zustand.
// Standard bewusst ruhig: Typ Delta, Box, POC an, Imbalances aus, Stats-Grid aus (ein Klick entfernt).
import { IMBALANCE_DEFAULTS, type ImbalanceOptions } from './footprint-marks.ts';
import { STAT_ROWS, STATS_DEFAULT_ROWS, type StatRow } from './stats-grid.ts';
import type { FootprintMode, FootprintType } from './types.ts';

export interface FootprintOptions {
  /** false = Footprint aus, nur OHLC-Kerzen in jeder Zoomstufe (URL fp=0) */
  footprint: boolean;
  type: FootprintType;
  mode: FootprintMode;
  poc: boolean;
  deltaPoc: boolean;
  barVa: boolean;
  imbalance: boolean;
  imb: ImbalanceOptions;
  stats: boolean;
  statsRows: StatRow[];
}

/** Voreinstellung (eine Konstante; Änderung = eine Zeile). */
export const FOOTPRINT_DEFAULTS: FootprintOptions = {
  footprint: true,
  type: 'delta',
  mode: 'box',
  poc: true,
  deltaPoc: false,
  barVa: false,
  imbalance: false,
  imb: { ...IMBALANCE_DEFAULTS },
  stats: false,
  statsRows: [...STATS_DEFAULT_ROWS],
};

const TYPES: readonly FootprintType[] = ['delta', 'bidask', 'volume', 'deltavol'];

/**
 * URL: fp=0 (nur Kerzen), type, fm=profile, poc=0, dpoc=1, bva=1, imb=1, imbr=<%>, imbd=<Lots>, imbz=1, imbh=1, imbs=<n>,
 * sg=1, sgr=<Zeilen, kommagetrennt>. Ungültiges → Standard.
 */
export function parseFootprintParams(q: URLSearchParams): FootprintOptions {
  const d = FOOTPRINT_DEFAULTS;
  const int = (k: string, lo: number, hi: number, def: number) => {
    const v = q.get(k);
    if (v === null || !/^\d+$/.test(v)) return def;
    const n = Number(v);
    return n >= lo && n <= hi ? n : def;
  };
  const t = q.get('type') as FootprintType | null;
  const rows = (q.get('sgr') ?? '')
    .split(',')
    .filter((r): r is StatRow => STAT_ROWS.some((x) => x.id === r));
  return {
    footprint: q.get('fp') !== '0',
    type: t && TYPES.includes(t) ? t : d.type,
    mode: q.get('fm') === 'profile' ? 'profile' : d.mode,
    poc: q.get('poc') === null ? d.poc : q.get('poc') !== '0',
    deltaPoc: q.get('dpoc') === null ? d.deltaPoc : q.get('dpoc') === '1',
    barVa: q.get('bva') === null ? d.barVa : q.get('bva') === '1',
    imbalance: q.get('imb') === null ? d.imbalance : q.get('imb') === '1',
    imb: {
      ratio: int('imbr', 101, 10_000, d.imb.ratio),
      minDiff: int('imbd', 0, 1e12, d.imb.minDiff),
      includeZero: q.get('imbz') === '1',
      horizontal: q.get('imbh') === '1',
      stack: int('imbs', 2, 20, d.imb.stack),
    },
    stats: q.get('sg') === '1',
    statsRows: rows.length > 0 ? [...new Set(rows)] : [...d.statsRows],
  };
}

/** Query-Teil (mit führendem &) für die vom Standard abweichenden Einstellungen (ohne `type`). */
export function footprintParamsQuery(o: FootprintOptions): string {
  const d = FOOTPRINT_DEFAULTS;
  let q = '';
  if (!o.footprint) q += '&fp=0';
  if (o.mode !== d.mode) q += `&fm=${o.mode}`;
  if (o.poc !== d.poc) q += `&poc=${o.poc ? 1 : 0}`;
  if (o.deltaPoc !== d.deltaPoc) q += `&dpoc=${o.deltaPoc ? 1 : 0}`;
  if (o.barVa !== d.barVa) q += `&bva=${o.barVa ? 1 : 0}`;
  if (o.imbalance !== d.imbalance) q += `&imb=${o.imbalance ? 1 : 0}`;
  if (o.imb.ratio !== d.imb.ratio) q += `&imbr=${o.imb.ratio}`;
  if (o.imb.minDiff !== d.imb.minDiff) q += `&imbd=${o.imb.minDiff}`;
  if (o.imb.includeZero) q += '&imbz=1';
  if (o.imb.horizontal) q += '&imbh=1';
  if (o.imb.stack !== d.imb.stack) q += `&imbs=${o.imb.stack}`;
  if (o.stats) q += '&sg=1';
  if (o.statsRows.join(',') !== d.statsRows.join(',')) q += `&sgr=${o.statsRows.join(',')}`;
  return q;
}
