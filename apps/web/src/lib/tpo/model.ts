// TPO (Market Profile, KONZEPT §6.5, §7.4, Phase P6): reine Funktionen. Ein Tagesprofil (Grenze UTC +
// offsetH wie die Volumenprofile) aus den Bars des Tages: jeder Block (Standard 30 min) markiert jede
// Preiszeile zwischen seinem Low und High; Zählung je Zeile = TPOs. POC/Value Area mit den Kern-Helfern
// (gleiche Regeln wie Profile und Bars), Single Prints, Initial Balance, Open/Close, Zusammenfassung.
// Rein, ganzzahlig in price_unit; keine I/O. Erweiterungspunkte: Periode (Woche/Monat), Split/Merge,
// Sessions, Poor High/Low, Rotation Factor – siehe `TpoPeriod` und `computeTpo`.
import { maxNearMiddle, valueArea } from '@orderflow/core/browser';
import { isProfileLadderR } from '../profile/model.ts';

export const DAY_MS = 86_400_000;

/** Buchstabenfolge: Block i → LETTERS[i mod 52] (§6.5: A–Z, a–z, danach von vorn). */
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Blockgrößen in Minuten (Toolbar). */
export const TPO_BLOCK_MINUTES = [5, 10, 15, 30, 60, 120, 240] as const;

/** Periode eines TPO-Profils (v1: Tag; Woche/Monat später – Erweiterungspunkt). */
export type TpoPeriod = 'day';

export interface TpoOptions {
  period: TpoPeriod;
  blockMin: number;
  /** Initial Balance: die ersten ib_min Minuten (unabhängig von der Blockgröße, §6.5) */
  ibMin: number;
  vaPct: number;
  /** jeder Buchstabe in seiner eigenen Spalte (Spalte = Block) statt links gestapelt */
  split: boolean;
  /** Volumenprofil neben jedem TPO-Profil */
  volume: boolean;
  /** manuelle Zeilengröße (Ticks) oder null = automatisch */
  R: number | null;
}

export const TPO_DEFAULTS: TpoOptions = {
  period: 'day',
  blockMin: 30,
  ibMin: 60,
  vaPct: 70,
  split: false,
  volume: true,
  R: null,
};

/** Buchstabe des Blocks i. Bei 5-min-Blöcken (288 je Tag) wiederholt sich die Folge nach 52 Blöcken; die
 * Farbe (Verlauf über den Tag) unterscheidet die Durchläufe. */
export function letterOf(i: number): string {
  return LETTERS[((i % 52) + 52) % 52]!;
}

/** Durchlauf der Buchstabenfolge (0 = erste 52 Blöcke). */
export function letterCycle(i: number): number {
  return Math.floor(i / 52);
}

/** Beginn (ms) des Profiltags d bei offsetH. */
export function tpoDayStart(d: number, offsetH: number): number {
  return d * DAY_MS + offsetH * 3_600_000;
}

export function tpoDayOf(tMs: number, offsetH: number): number {
  return Math.floor((tMs - offsetH * 3_600_000) / DAY_MS);
}

/** Block eines Zeitpunkts (s) im Tag ab dayStart (ms). */
export function blockOf(tSec: number, dayStartMs: number, blockMin: number): number {
  return Math.floor((tSec * 1000 - dayStartMs) / (blockMin * 60_000));
}

/**
 * Quell-Zeitrahmen der Bars (Regel): der gröbste angebotene Zeitrahmen tf mit
 *   blockSec mod tf = 0 (jeder Bar liegt ganz in einem Block → Block-Low/High exakt),
 *   ibSec mod tf = 0 (Initial Balance exakt),
 *   (offsetH · 3600) mod tf = 0 und 86 400 mod tf = 0 (Tagesgrenze liegt auf einer Bar-Grenze).
 * 1m erfüllt das immer; gröbere Bars sparen Daten (30-min-Blöcke: 30m statt 1 440 1m-Bars je Tag).
 */
export function chooseSourceTf(
  offered: readonly { tf: string; sec: number }[],
  blockMin: number,
  ibMin: number,
  offsetH: number,
): string {
  const ok = offered.filter(
    ({ sec }) =>
      (blockMin * 60) % sec === 0 &&
      (ibMin * 60) % sec === 0 &&
      (((offsetH * 3600) % sec) + sec) % sec === 0 &&
      86_400 % sec === 0,
  );
  ok.sort((a, b) => b.sec - a.sec);
  return ok[0]?.tf ?? '1m';
}

/** Bars eines Tages (Typed Arrays aus der Bar-Kachel, aufsteigend). */
export interface TpoBars {
  time: ArrayLike<number>; // s
  open: ArrayLike<number>;
  high: ArrayLike<number>;
  low: ArrayLike<number>;
  close: ArrayLike<number>;
}

export interface TpoDay {
  dayStart: number;
  /** Zeilenbreite (price_unit) */
  width: number;
  blockMin: number;
  nBlocks: number;
  /** je Block unterste/oberste Zeile (absolut) oder −1 ohne Bars */
  blockLo: Int32Array;
  blockHi: Int32Array;
  /** Zeilenbereich des Tages; counts[i] = TPOs in Zeile rowLo + i */
  rowLo: number;
  counts: Int32Array;
  /**
   * Zellen in Blockreihenfolge: cellBlock/cellRow/cellCol; cellCol = Spalte im gestapelten Modus (k-ter
   * TPO dieser Zeile, links beginnend). Im Split-Modus ist die Spalte = Block.
   */
  cellBlock: Uint16Array;
  cellRow: Int32Array;
  cellCol: Uint16Array;
  /** Index der ersten Zelle je Block (Zellen eines Blocks liegen zusammen, Zeilen aufsteigend) */
  blockStart: Int32Array;
  maxCount: number;
  total: number;
  poc: number | null;
  vah: number | null;
  val: number | null;
  /** Single Prints: Zeilen mit genau 1 TPO, außer oberster/unterster (absolut) */
  singles: number[];
  /** Initial Balance (Zeilen und Preise) oder null */
  ibRows: [number, number] | null;
  ibPrice: [number, number] | null;
  open: number | null;
  close: number | null;
  above: number;
  below: number;
  /** Blöcke, die im Datenbereich liegen, aber keine Bars haben (Löcher in den Daten) */
  missingBlocks: number;
  /** letzter Block mit Daten (laufender Tag) oder −1 */
  lastBlock: number;
  /** Poor High/Low (§6.5): oberste bzw. unterste Zeile mit ≥ 2 TPOs */
  poorHigh: boolean;
  poorLow: boolean;
}

/**
 * TPO-Profil eines Tages. `dataTo` (ms) begrenzt die erwarteten Blöcke (laufender Tag): ein Block vor
 * dataTo ohne Bars zählt als fehlend (Loch, z. B. 2026-10-27) – er markiert nichts; ein teilweise
 * gefüllter Block zählt mit den Bars, die es gibt.
 */
export function computeTpo(
  bars: TpoBars,
  dayStart: number,
  o: Pick<TpoOptions, 'blockMin' | 'ibMin' | 'vaPct'>,
  width: number,
  dataTo = Infinity,
  dataFrom = -Infinity,
): TpoDay {
  const nBlocks = Math.round(1440 / o.blockMin);
  const blockLo = new Int32Array(nBlocks).fill(-1);
  const blockHi = new Int32Array(nBlocks).fill(-1);
  const lowP = new Float64Array(nBlocks).fill(Infinity);
  const highP = new Float64Array(nBlocks).fill(-Infinity);
  let open: number | null = null;
  let close: number | null = null;
  let ibLo = Infinity;
  let ibHi = -Infinity;
  const ibEnd = dayStart + o.ibMin * 60_000;
  const n = bars.time.length;
  for (let i = 0; i < n; i++) {
    const t = bars.time[i]!;
    const tMs = t * 1000;
    if (tMs < dayStart || tMs >= dayStart + DAY_MS) continue;
    const b = blockOf(t, dayStart, o.blockMin);
    const h = bars.high[i]!;
    const l = bars.low[i]!;
    if (l < lowP[b]!) lowP[b] = l;
    if (h > highP[b]!) highP[b] = h;
    if (open === null) open = bars.open[i]!;
    close = bars.close[i]!;
    if (tMs < ibEnd) {
      ibLo = Math.min(ibLo, l);
      ibHi = Math.max(ibHi, h);
    }
  }
  let rowLo = Infinity;
  let rowHi = -Infinity;
  let lastBlock = -1;
  for (let b = 0; b < nBlocks; b++) {
    if (lowP[b] === Infinity) continue;
    blockLo[b] = Math.floor(lowP[b]! / width);
    blockHi[b] = Math.floor(highP[b]! / width);
    rowLo = Math.min(rowLo, blockLo[b]!);
    rowHi = Math.max(rowHi, blockHi[b]!);
    lastBlock = b;
  }
  // fehlende Blöcke (H-7): ohne Bars, aber ganz im Datenbereich [dataFrom, dataTo) – vor dem Datenbeginn
  // bzw. nach dem Datenende erwartet niemand Bars
  const bms = o.blockMin * 60_000;
  let missingBlocks = 0;
  for (let b = 0; b < nBlocks; b++) {
    const bs = dayStart + b * bms;
    if (bs < dataFrom || bs >= dataTo) continue;
    if (blockLo[b] === -1) missingBlocks++;
  }
  if (lastBlock < 0) {
    return {
      dayStart,
      width,
      blockMin: o.blockMin,
      nBlocks,
      blockLo,
      blockHi,
      rowLo: 0,
      counts: new Int32Array(0),
      cellBlock: new Uint16Array(0),
      cellRow: new Int32Array(0),
      cellCol: new Uint16Array(0),
      blockStart: new Int32Array(nBlocks),
      maxCount: 0,
      total: 0,
      poc: null,
      vah: null,
      val: null,
      singles: [],
      ibRows: null,
      ibPrice: null,
      open: null,
      close: null,
      above: 0,
      below: 0,
      missingBlocks,
      lastBlock,
      poorHigh: false,
      poorLow: false,
    };
  }
  const rows = rowHi - rowLo + 1;
  const counts = new Int32Array(rows);
  let total = 0;
  for (let b = 0; b < nBlocks; b++) {
    if (blockLo[b] === -1) continue;
    for (let r = blockLo[b]!; r <= blockHi[b]!; r++) counts[r - rowLo]!++;
    total += blockHi[b]! - blockLo[b]! + 1;
  }
  const cellBlock = new Uint16Array(total);
  const cellRow = new Int32Array(total);
  const cellCol = new Uint16Array(total);
  const blockStart = new Int32Array(nBlocks);
  const fill = new Int32Array(rows);
  let k = 0;
  for (let b = 0; b < nBlocks; b++) {
    blockStart[b] = k;
    if (blockLo[b] === -1) continue;
    for (let r = blockLo[b]!; r <= blockHi[b]!; r++) {
      cellBlock[k] = b;
      cellRow[k] = r;
      cellCol[k] = fill[r - rowLo]!++;
      k++;
    }
  }
  let maxCount = 0;
  for (let i = 0; i < rows; i++) maxCount = Math.max(maxCount, counts[i]!);
  const pi = maxNearMiddle(counts);
  const va = pi >= 0 ? valueArea(counts, pi, o.vaPct) : null;
  const poc = pi >= 0 ? rowLo + pi : null;
  const singles: number[] = [];
  for (let i = 1; i < rows - 1; i++) if (counts[i] === 1) singles.push(rowLo + i);
  let above = 0;
  let below = 0;
  if (poc !== null)
    for (let i = 0; i < rows; i++) {
      if (rowLo + i > poc) above += counts[i]!;
      else if (rowLo + i < poc) below += counts[i]!;
    }
  return {
    dayStart,
    width,
    blockMin: o.blockMin,
    nBlocks,
    blockLo,
    blockHi,
    rowLo,
    counts,
    cellBlock,
    cellRow,
    cellCol,
    blockStart,
    maxCount,
    total,
    poc,
    vah: va ? rowLo + va[1] : null,
    val: va ? rowLo + va[0] : null,
    singles,
    ibRows: ibLo === Infinity ? null : [Math.floor(ibLo / width), Math.floor(ibHi / width)],
    ibPrice: ibLo === Infinity ? null : [ibLo, ibHi],
    open,
    close,
    above,
    below,
    missingBlocks,
    lastBlock,
    poorHigh: rows >= 1 && counts[rows - 1]! >= 2,
    poorLow: rows >= 1 && counts[0]! >= 2,
  };
}

/**
 * Zeilengröße mit Untergrenze (W-2): höchstens TPO_MAX_ROWS_PER_DAY Zeilen je Tag über alle gegebenen
 * Tagesspannen (price_unit). Liefert das kleinste R der Leiter ≥ R, das passt (sonst das größte).
 */
export const TPO_MAX_ROWS_PER_DAY = 20_000;
export function tpoMinR(
  ranges: readonly [number, number][],
  tickRefUnits: number,
  ladder: readonly number[],
  R: number,
  maxRows = TPO_MAX_ROWS_PER_DAY,
): number {
  const fits = (r: number) =>
    ranges.every(
      ([lo, hi]) =>
        Math.floor(hi / (r * tickRefUnits)) - Math.floor(lo / (r * tickRefUnits)) + 1 <= maxRows,
    );
  if (fits(R)) return R;
  for (const r of ladder) if (r > R && fits(r)) return r;
  return ladder[ladder.length - 1] ?? R;
}

/**
 * Sichtbare Zellen eines Tages im Zeilenbereich [rowBot, rowTop] (W-2: nicht alle Zellen prüfen): je
 * Block der Teilbereich seiner Zellen; ruft f(k) für jede sichtbare Zelle k auf.
 */
export function forVisibleCells(
  day: TpoDay,
  rowBot: number,
  rowTop: number,
  f: (k: number) => void,
): void {
  for (let b = 0; b <= day.lastBlock; b++) {
    const lo = day.blockLo[b]!;
    if (lo === -1) continue;
    const r0 = Math.max(lo, rowBot);
    const r1 = Math.min(day.blockHi[b]!, rowTop);
    const k0 = day.blockStart[b]!;
    for (let r = r0; r <= r1; r++) f(k0 + (r - lo));
  }
}

/** Spalte einer Zelle: gestapelt (k-ter TPO der Zeile) oder Split (Spalte = Block). */
export function cellColumn(day: TpoDay, k: number, split: boolean): number {
  return split ? day.cellBlock[k]! : day.cellCol[k]!;
}

/** Spaltenzahl des Profils (Breitenbedarf in Zellen). */
export function tpoColumns(day: TpoDay, split: boolean): number {
  return split ? day.lastBlock + 1 : day.maxCount;
}

/**
 * Lage der Zellen eines Tages (px): Spalte c ab x0 mit Zellbreite cellW, Zeile r über yOfUnit (lineare
 * Preisskala, Zeile r von yOf((r+1)·w) bis yOf(r·w)). Für Tests und den Renderer.
 */
export function cellRect(
  day: TpoDay,
  k: number,
  split: boolean,
  x0: number,
  cellW: number,
  yOfUnit: (u: number) => number,
): { x: number; y: number; w: number; h: number } {
  const c = cellColumn(day, k, split);
  const r = day.cellRow[k]!;
  const yt = Math.round(yOfUnit((r + 1) * day.width));
  const yb = Math.round(yOfUnit(r * day.width));
  return { x: x0 + c * cellW, y: yt, w: cellW, h: Math.max(1, yb - yt) };
}

/** Automatische Zeilengröße nach Pixelhöhe: Ziel 12 px (Buchstaben ab 9 px), Halteband 9…20 px. */
export const TPO_ROW = { min: 6, target: 12, keepMin: 9, keepMax: 20, letterMin: 9 };

export function tpoRowSize(
  current: number | null,
  ladder: readonly number[],
  pxPerUnit: number,
  tickRefUnits: number,
): number {
  if (ladder.length === 0) return current ?? 1;
  const rh = (r: number) => pxPerUnit * r * tickRefUnits;
  if (current !== null && ladder.includes(current)) {
    const h = rh(current);
    if (h >= TPO_ROW.keepMin && h <= TPO_ROW.keepMax) return current;
  }
  let best = ladder[ladder.length - 1]!;
  let bestD = Infinity;
  for (const r of ladder) {
    const h = rh(r);
    if (h < TPO_ROW.min) continue;
    const d = Math.abs(Math.log(h / TPO_ROW.target));
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

/** Hover: Buchstaben (Blöcke) einer Zeile und Anzahl. */
export function rowLetters(day: TpoDay, row: number): { blocks: number[]; letters: string } {
  const blocks: number[] = [];
  for (let b = 0; b < day.nBlocks; b++)
    if (day.blockLo[b] !== -1 && day.blockLo[b]! <= row && row <= day.blockHi[b]!) blocks.push(b);
  return { blocks, letters: blocks.map(letterOf).join('') };
}

/** Farbstufe eines Blocks im Verlauf über den Tag (0…steps−1). */
export function blockShade(b: number, nBlocks: number, steps: number): number {
  return nBlocks <= 1 ? 0 : Math.min(steps - 1, Math.floor((b / (nBlocks - 1)) * steps));
}

// ---------------------------------------------------------------- URL-Zustand

export function parseTpoParams(q: URLSearchParams): { view: 'chart' | 'tpo'; tpo: TpoOptions } {
  const d = TPO_DEFAULTS;
  const int = (k: string, ok: (n: number) => boolean, def: number) => {
    const v = q.get(k);
    if (v === null || !/^\d+$/.test(v)) return def;
    const n = Number(v);
    return ok(n) ? n : def;
  };
  return {
    view: q.get('view') === 'tpo' ? 'tpo' : 'chart',
    tpo: {
      period: 'day',
      blockMin: int('tb', (n) => (TPO_BLOCK_MINUTES as readonly number[]).includes(n), d.blockMin),
      ibMin: int('tib', (n) => n >= 1 && n <= 1440, d.ibMin),
      vaPct: d.vaPct,
      split: q.get('ts') === '1',
      volume: q.get('tvp') !== '0',
      // H-6: nur Werte der Leiter {1, 2, 5}·10^k bis 1 000 000
      R: int('tr', isProfileLadderR, -1) > 0 ? Number(q.get('tr')) : null,
    },
  };
}

export function tpoParamsQuery(view: 'chart' | 'tpo', o: TpoOptions): string {
  if (view !== 'tpo') return '';
  const d = TPO_DEFAULTS;
  let q = '&view=tpo';
  if (o.blockMin !== d.blockMin) q += `&tb=${o.blockMin}`;
  if (o.ibMin !== d.ibMin) q += `&tib=${o.ibMin}`;
  if (o.split) q += '&ts=1';
  if (!o.volume) q += '&tvp=0';
  if (o.R !== null) q += `&tr=${o.R}`;
  return q;
}
