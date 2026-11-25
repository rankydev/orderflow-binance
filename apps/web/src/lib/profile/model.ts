// Volume Profile (KONZEPT §6.3, docs/PROFILE-API.md): reine Funktionen – Tagesfenster mit Offset,
// Bündelung sichtbarer Tage zu Anfragen, Bereichsauswahl auf Minuten, Cache-Schlüssel, Zeilengröße nach
// Pixelhöhe und das Layout der Balken (getestet, auch mit exakten Koordinaten).
import type { ProfileBody } from '@orderflow/core/browser';

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;

/** Profilmodi und Ansichten (URL: pm, pv). */
export type ProfileMode = 'off' | 'daily' | 'range' | 'both';
export type ProfileView = 'total' | 'buysell' | 'delta';

/**
 * Standard: Tagesprofile an, Ansicht Buy/Sell (Umschalten auf Delta mit einem Klick in der Werkzeugleiste).
 * Eine Konstante, damit die Voreinstellung in einer Zeile geändert werden kann.
 */
export const PROFILE_DEFAULTS: {
  mode: ProfileMode;
  view: ProfileView;
  va: number;
  offsetH: number;
} = {
  mode: 'daily',
  view: 'buysell',
  va: 70,
  offsetH: 0,
};

/** Tage je Anfrage an /profiles/daily (ausgerichtet an Vielfachen seit Epoch, damit Batches cachebar sind). */
export const DAILY_BATCH_DAYS = 16;
/**
 * Detailstufen der Tagesprofile nach Tagesbreite (Review B): unter MIN_DAY_PX ausgelassen (bei 6–8 px
 * ist ein Volumenunterschied von 10 % kleiner als ein Pixel), bis FULL_DAY_PX nur die Silhouette
 * (Total-Form + kurzer POC-Strich, keine VA, keine Linien), darüber alles.
 */
export const MIN_DAY_PX = 16;
export const FULL_DAY_PX = 48;
export type DayDetail = 'skip' | 'silhouette' | 'full';
export function dayDetail(dayWidthPx: number): DayDetail {
  return dayWidthPx < MIN_DAY_PX ? 'skip' : dayWidthPx < FULL_DAY_PX ? 'silhouette' : 'full';
}
/** Profilbreite: Deckel in Pixeln (Review W-2): max(PROFILE_CAP_MIN_PX, PROFILE_CAP_PANE · Panebreite). */
export const PROFILE_CAP_MIN_PX = 120;
export const PROFILE_CAP_PANE = 0.3;
/** Tag breiter als die Pane und Footprint-Detailstufe aktiv: höchstens so viel der Panebreite. */
export const PROFILE_CAP_PANE_FOOTPRINT = 0.25;
/** Anteil der Tagesbreite, den das Tagesprofil nach rechts einnimmt (§6.3: 0,8). */
export const DAY_PROFILE_SHARE = 0.8;
/** Anteil der Bereichsbreite für das Bereichsprofil. */
export const RANGE_PROFILE_SHARE = 0.6;

/**
 * Lage eines Profils in CSS-px (Review W-2): Zeitraum [xa, xb) auf der Zeitachse, Pane [0, paneW).
 *  - Breite maxW = min(share · (xb − xa), max(120, 0,3 · paneW)); ist der Zeitraum breiter als die Pane
 *    und die Footprint-Detailstufe aktiv, höchstens 0,25 · paneW (Zellen bleiben lesbar);
 *  - Anker „klebend": x0 = clamp(xa, 0, xb − maxW) – liegt der Beginn links außerhalb, bleibt das Profil
 *    am linken Rand sichtbar, solange sein Zeitraum reicht; sonst hängt es am Beginn.
 * Liefert null, wenn das Profil die Pane nicht schneidet.
 */
export function profilePlacement(
  xa: number,
  xb: number,
  paneW: number,
  footprint: boolean,
  share = DAY_PROFILE_SHARE,
  minW = 0,
): { x0: number; maxW: number } | null {
  const span = xb - xa;
  if (!(span > 0)) return null;
  let maxW = Math.min(share * span, Math.max(PROFILE_CAP_MIN_PX, PROFILE_CAP_PANE * paneW));
  if (footprint && span > paneW) maxW = Math.min(maxW, PROFILE_CAP_PANE_FOOTPRINT * paneW);
  maxW = Math.max(maxW, Math.min(minW, span));
  const x0 = Math.min(Math.max(xa, 0), xb - maxW);
  if (x0 + maxW <= 0 || x0 >= paneW) return null;
  return { x0, maxW };
}

/** Tagesindex d des Profiltags, der t (ms) enthält: Tag d überdeckt [d·24h + off, (d+1)·24h + off). */
export function profileDayOf(tMs: number, offsetH: number): number {
  return Math.floor((tMs - offsetH * 3_600_000) / DAY_MS);
}

/** [from, to) des Profiltags d in ms. */
export function profileDayWindow(d: number, offsetH: number): [number, number] {
  const from = d * DAY_MS + offsetH * 3_600_000;
  return [from, from + DAY_MS];
}

/** Batch b überdeckt die Tage [b·B, (b+1)·B). */
export function batchOfDay(d: number, B = DAILY_BATCH_DAYS): number {
  return Math.floor(d / B);
}

export function batchWindow(b: number, offsetH: number, B = DAILY_BATCH_DAYS): [number, number] {
  return [profileDayWindow(b * B, offsetH)[0], profileDayWindow((b + 1) * B, offsetH)[0]];
}

/**
 * Benötigte Tagesprofil-Batches für einen sichtbaren Zeitraum (s): sichtbare Tage ± 1 Tag Padding, nur
 * innerhalb der Daten; sortiert von der Mitte nach außen.
 */
export function wantedDayBatches(
  fromSec: number,
  toSec: number,
  offsetH: number,
  dataFromMs: number,
  dataToMs: number,
  B = DAILY_BATCH_DAYS,
): number[] {
  if (dataToMs <= dataFromMs) return [];
  const dMin = profileDayOf(dataFromMs, offsetH);
  const dMax = profileDayOf(dataToMs - 1, offsetH);
  const d0 = Math.max(dMin, profileDayOf(fromSec * 1000, offsetH) - 1);
  const d1 = Math.min(dMax, profileDayOf(toSec * 1000, offsetH) + 1);
  if (d0 > d1) return [];
  const b0 = batchOfDay(d0, B);
  const b1 = batchOfDay(d1, B);
  const mid = (b0 + b1) / 2;
  const out: number[] = [];
  for (let b = b0; b <= b1; b++) out.push(b);
  return out.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
}

/** Bereich [a, b) (ms) auf Minuten gerundet, a < b, mindestens eine Minute; Reihenfolge der Klicks egal. */
export function snapRange(aMs: number, bMs: number): [number, number] {
  const lo = Math.min(aMs, bMs);
  const hi = Math.max(aMs, bMs);
  const from = Math.floor(lo / MINUTE_MS) * MINUTE_MS;
  const to = Math.max(from + MINUTE_MS, Math.ceil(hi / MINUTE_MS) * MINUTE_MS);
  return [from, to];
}

/**
 * Bereich aus zwei angeklickten Bars (Bar-Beginn in s) und dem Zeitrahmen: von Beginn des früheren bis
 * Ende des späteren Bars (beide eingeschlossen).
 */
export function rangeFromBars(t1Sec: number, t2Sec: number, tfSec: number): [number, number] {
  const a = Math.min(t1Sec, t2Sec) * 1000;
  const b = (Math.max(t1Sec, t2Sec) + tfSec) * 1000;
  return snapRange(a, b);
}

export interface ProfileKeyParts {
  sym: string;
  R: number;
  va: number;
}

export function dailyKey(p: ProfileKeyParts & { offsetH: number; batch: number }): string {
  return `pd|${p.sym}|${p.R}|${p.va}|${p.offsetH}|${p.batch}`;
}

export function rangeKey(p: ProfileKeyParts & { from: number; to: number }): string {
  return `pr|${p.sym}|${p.R}|${p.va}|${p.from}|${p.to}`;
}

/** Profil-Zeilengrößen der Leiter {1,2,5}·10^k bis 1 000 000, nicht feiner als der Tick. */
export function profileLadder(tickRefUnits: number, tickUnits: number): number[] {
  const out: number[] = [];
  for (let p = 1; p <= 1_000_000; p *= 10) {
    for (const m of [1, 2, 5]) {
      const r = m * p;
      if (r <= 1_000_000 && r * tickRefUnits >= tickUnits) out.push(r);
    }
  }
  return out;
}

/** Zielhöhe einer Profilzeile (px) und das Band, in dem ein gewähltes R bleibt (Hysterese). */
export const PROFILE_ROW = { min: 3, target: 5, keepMin: 2.5, keepMax: 12 };

/**
 * Automatische Profil-Zeilengröße nach Pixelhöhe (unabhängig vom Footprint-R, §6.3): R behalten, solange
 * die Zeilenhöhe im Band liegt; sonst das R mit Zeilenhöhe ≥ min und kleinstem |ln(rh / target)|.
 */
export function profileRowSize(
  current: number | null,
  ladder: readonly number[],
  pxPerUnit: number,
  tickRefUnits: number,
): number {
  if (ladder.length === 0) return current ?? 1;
  const rh = (r: number) => pxPerUnit * r * tickRefUnits;
  if (current !== null && ladder.includes(current)) {
    const h = rh(current);
    if (h >= PROFILE_ROW.keepMin && h <= PROFILE_ROW.keepMax) return current;
  }
  let best = ladder[ladder.length - 1]!;
  let bestD = Infinity;
  for (const r of ladder) {
    const h = rh(r);
    if (h < PROFILE_ROW.min) continue;
    const d = Math.abs(Math.log(h / PROFILE_ROW.target));
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

// ---------------------------------------------------------------- Layout der Balken

/** Ein vorbereitetes Profil (aus ProfileBody, Zahlen als Typed Arrays). */
export interface PreparedProfile {
  key: string;
  from: number;
  to: number;
  final: boolean;
  R: number;
  width: number;
  rowLo: number;
  buy: Float64Array;
  sell: Float64Array;
  poc: number | null;
  vah: number | null;
  val: number | null;
  deltaPoc: number | null;
  buyQ: number;
  sellQ: number;
  notional: bigint;
  low: number | null;
  high: number | null;
  maxVol: number;
  maxAbsDelta: number;
  /** Version des Tages (PROFILE-API.md) bzw. vwap (price_unit) der Antwort, wenn bekannt */
  dataVersion?: string;
  vwap?: number | null;
}

export function prepareProfile(
  key: string,
  body: ProfileBody,
  from: number,
  to: number,
  final: boolean,
  R: number,
  tickRefUnits: number,
): PreparedProfile {
  const n = body.buy.length;
  const buy = Float64Array.from(body.buy);
  const sell = Float64Array.from(body.sell);
  let maxVol = 0;
  let maxAbsDelta = 0;
  for (let i = 0; i < n; i++) {
    maxVol = Math.max(maxVol, buy[i]! + sell[i]!);
    maxAbsDelta = Math.max(maxAbsDelta, Math.abs(buy[i]! - sell[i]!));
  }
  return {
    key,
    from,
    to,
    final,
    R,
    width: R * tickRefUnits,
    rowLo: body.rowLo ?? 0,
    buy,
    sell,
    poc: body.poc,
    vah: body.vah,
    val: body.val,
    deltaPoc: body.deltaPoc,
    buyQ: body.buyQ,
    sellQ: body.sellQ,
    notional: BigInt(body.notional),
    low: body.low,
    high: body.high,
    maxVol,
    maxAbsDelta,
  };
}

/** Farbklassen der Balken. */
export const Paint = { Total: 0, Buy: 1, Sell: 2, DeltaPos: 3, DeltaNeg: 4 } as const;
export type Paint = (typeof Paint)[keyof typeof Paint];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  paint: Paint;
}

/**
 * Balken eines Profils in Pixeln (CSS-px oder Bitmap-px, je nach Eingabe):
 *  - x0: linke Kante (Tagesbeginn bzw. Bereichsbeginn), maxW: volle Balkenlänge;
 *  - yOfUnit(u): y der Preiseinheit u (lineare Skala), Zeile r von yOf((r+1)·w) bis yOf(r·w);
 *  - total: ein Balken je Zeile, Länge ∝ Volumen / maxVol;
 *  - buysell: gestapelt – Sell-Teil links (rot), Buy-Teil rechts daran (grün), Gesamtlänge wie total;
 *  - delta: ab der linken Kante, Länge ∝ |buy − sell| / max|Δ|, Farbe nach Vorzeichen.
 * Zeilen außerhalb [yTop, yBottom] werden übersprungen; Längen < minLen werden nicht gezeichnet.
 */
export function profileRects(
  p: PreparedProfile,
  view: ProfileView,
  x0: number,
  maxW: number,
  yOfUnit: (u: number) => number,
  yTop: number,
  yBottom: number,
  gap: number,
  out: Rect[] = [],
  minLen = 0.5,
  scaleOverride = 0,
  rowRange: [number, number] | null = null,
): Rect[] {
  const n = p.buy.length;
  if (n === 0) return out;
  const scale = scaleOverride > 0 ? scaleOverride : profileScale(p, view);
  if (!(scale > 0)) return out;
  // sichtbare Zeilen analytisch (rowRange = [rTop, rBottom] absolute Zeilen), sonst alle
  const i0 = rowRange ? Math.max(0, Math.min(rowRange[0], rowRange[1]) - p.rowLo) : 0;
  const i1 = rowRange ? Math.min(n - 1, Math.max(rowRange[0], rowRange[1]) - p.rowLo) : n - 1;
  for (let i = i0; i <= i1; i++) {
    const r = p.rowLo + i;
    const yt = Math.round(yOfUnit((r + 1) * p.width));
    const yb = Math.round(yOfUnit(r * p.width));
    if (yb < yTop || yt > yBottom) continue;
    const h = Math.max(1, yb - yt - gap);
    const b = p.buy[i]!;
    const s = p.sell[i]!;
    if (view === 'delta') {
      const d = b - s;
      const len = (Math.abs(d) / scale) * maxW;
      if (len >= minLen)
        out.push({ x: x0, y: yt, w: len, h, paint: d >= 0 ? Paint.DeltaPos : Paint.DeltaNeg });
      continue;
    }
    const total = ((b + s) / scale) * maxW;
    if (total < minLen) continue;
    if (view === 'total') {
      out.push({ x: x0, y: yt, w: total, h, paint: Paint.Total });
    } else {
      const sw = (s / scale) * maxW;
      const bw = total - sw;
      if (sw > 0) out.push({ x: x0, y: yt, w: sw, h, paint: Paint.Sell });
      if (bw > 0) out.push({ x: x0 + sw, y: yt, w: bw, h, paint: Paint.Buy });
    }
  }
  return out;
}

/** Kürzeste gezeichnete Balkenlänge (CSS-px); Hover trifft dieselben Balken (H-4). */
export const MIN_BAR_PX = 0.5;

/**
 * Gemeinsame Skala (W-B): größtes Zeilenvolumen bzw. |Delta| über alle Profile der Zeilenbreite `width`
 * (andere Breiten, z. B. nach einem 422-Vorschlag, zählen nicht).
 */
export function commonScale(
  profiles: Iterable<Pick<PreparedProfile, 'width' | 'maxVol' | 'maxAbsDelta'>>,
  width: number,
): { width: number; total: number; delta: number } {
  let total = 0;
  let delta = 0;
  for (const p of profiles) {
    if (p.width !== width) continue;
    total = Math.max(total, p.maxVol);
    delta = Math.max(delta, p.maxAbsDelta);
  }
  return { width, total, delta };
}

/** Skala eines Profils: größtes Volumen bzw. größtes |Delta| einer Zeile. */
export function profileScale(
  p: Pick<PreparedProfile, 'maxVol' | 'maxAbsDelta'>,
  view: ProfileView,
): number {
  return view === 'delta' ? p.maxAbsDelta : p.maxVol;
}

/** Länge (px) des Balkens der Zeile i (Index ab rowLo) bei voller Länge maxW – für den Hover (W-1). */
export function rowBarLength(
  p: PreparedProfile,
  view: ProfileView,
  i: number,
  maxW: number,
  scale: number,
): number {
  if (i < 0 || i >= p.buy.length || !(scale > 0)) return 0;
  const b = p.buy[i]!;
  const s = p.sell[i]!;
  return ((view === 'delta' ? Math.abs(b - s) : b + s) / scale) * maxW;
}

/** Zeile r → Mitte in y (für POC/VAH/VAL-Linien). */
export function rowMidY(r: number, width: number, yOfUnit: (u: number) => number): number {
  return (yOfUnit(r * width) + yOfUnit((r + 1) * width)) / 2;
}

/**
 * Naked-Level (§6.3 „Linien verlängern"): ab Index `fromIdx` der erste Bar, dessen [low, high] das
 * Zeilenintervall [lo, hi) schneidet (konservativer als nur die Zeilenmitte); −1 = bis `end` (exklusiv)
 * nicht berührt.
 */
export function firstTouch(
  bars: ArrayLike<{ h: number; l: number }>,
  fromIdx: number,
  lo: number,
  hi: number,
  end = bars.length,
): number {
  const e = Math.min(bars.length, end);
  for (let i = Math.max(0, fromIdx); i < e; i++) {
    const b = bars[i]!;
    if (b.l < hi && b.h >= lo) return i;
  }
  return -1;
}

/**
 * Querprüfung (Auftrag 6): Summe buy+sell des Profils gegen die Bars desselben Zeitraums. Liefert '' bei
 * Gleichheit, sonst eine Beschreibung. `bars` = Mengen (buyQ+sellQ) und Zeiten (s) der geladenen Bars.
 */
export function compareProfileWithBars(
  p: Pick<PreparedProfile, 'buyQ' | 'sellQ' | 'from' | 'to'>,
  times: ArrayLike<number>,
  vols: ArrayLike<number>,
): string {
  let sum = 0;
  const a = p.from / 1000;
  const b = p.to / 1000;
  for (let i = 0; i < times.length; i++) if (times[i]! >= a && times[i]! < b) sum += vols[i]!;
  const tot = p.buyQ + p.sellQ;
  return sum === tot ? '' : `Profil ${tot} Lots, Bars ${sum} Lots`;
}

// ---------------------------------------------------------------- URL-Zustand

/** Profil-Einstellungen in der URL: pm, pv, va, oh, pr, pe, pl, ps, pf/pt (nur abweichend vom Standard). */
export interface ProfileParams {
  mode: ProfileMode;
  view: ProfileView;
  va: number;
  offsetH: number;
  /** manuelles Profil-R (Ticks) oder null = auto */
  R: number | null;
  extend: boolean;
  showVa: boolean;
  /** Skala der Tagesprofile: je Profil (Standard) oder gemeinsam über die sichtbaren Tage (ps=common) */
  scale: ProfileScaleMode;
  range: [number, number] | null;
  /** Hinweis zum Bereich aus der URL (z. B. vertauscht), sonst '' */
  rangeNote: string;
}

export type ProfileScaleMode = 'profile' | 'common';

const MODES: readonly ProfileMode[] = ['off', 'daily', 'range', 'both'];
const VIEWS: readonly ProfileView[] = ['total', 'buysell', 'delta'];

/** R auf der Leiter {1, 2, 5}·10^k bis 1 000 000? */
export function isProfileLadderR(r: number): boolean {
  if (!Number.isSafeInteger(r) || r < 1 || r > 1_000_000) return false;
  let x = r;
  while (x % 10 === 0) x /= 10;
  return x === 1 || x === 2 || x === 5;
}

/** Zeitpunkt aus der URL: ganze ms oder ISO-Minute (UTC, z. B. 2026-10-27T08:00). */
export function parseUrlTime(v: string | null): number | null {
  if (!v) return null;
  if (/^\d{1,15}$/.test(v)) return Number(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})Z?$/.exec(v);
  if (!m) return null;
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  return Number.isFinite(t) ? t : null;
}

export function formatUrlTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

/** Offset auf −11…12 normieren (o und o ± 24 ergeben dieselben Tagesgrenzen). */
export function normalizeOffset(o: number): number {
  return ((((o + 11) % 24) + 24) % 24) - 11;
}

export function parseProfileParams(q: URLSearchParams): ProfileParams {
  const d = PROFILE_DEFAULTS;
  const int = (k: string, lo: number, hi: number): number | null => {
    const v = q.get(k);
    if (v === null || !/^-?\d+$/.test(v)) return null;
    const n = Number(v);
    return n >= lo && n <= hi ? n : null;
  };
  const pm = q.get('pm') as ProfileMode | null;
  const pv = q.get('pv') as ProfileView | null;
  const pr = int('pr', 1, 1_000_000);
  const oh = int('oh', -23, 23);
  const f = parseUrlTime(q.get('pf'));
  const t = parseUrlTime(q.get('pt'));
  let mode = pm && MODES.includes(pm) ? pm : d.mode;
  const range = f !== null && t !== null && f !== t ? snapRange(f, t) : null;
  const rangeNote = range && f! > t! ? 'Bereich: pf nach pt – vertauscht übernommen' : '';
  // Bereich in der URL, Modus ohne Bereich → Bereich zusätzlich zeigen
  if (range && mode === 'daily') mode = 'both';
  if (range && mode === 'off') mode = 'range';
  return {
    mode,
    view: pv && VIEWS.includes(pv) ? pv : d.view,
    va: int('va', 1, 100) ?? d.va,
    offsetH: oh === null ? d.offsetH : normalizeOffset(oh),
    R: pr !== null && isProfileLadderR(pr) ? pr : null,
    extend: q.get('pe') === '1',
    showVa: q.get('pl') !== '0',
    scale: q.get('ps') === 'common' ? 'common' : 'profile',
    range,
    rangeNote,
  };
}

/** Query-Teil (mit führendem &) für die vom Standard abweichenden Profil-Einstellungen. */
export function profileParamsQuery(p: ProfileParams): string {
  const d = PROFILE_DEFAULTS;
  let q = '';
  if (p.mode !== d.mode) q += `&pm=${p.mode}`;
  if (p.view !== d.view) q += `&pv=${p.view}`;
  if (p.va !== d.va) q += `&va=${p.va}`;
  if (p.offsetH !== d.offsetH) q += `&oh=${p.offsetH}`;
  if (p.R !== null) q += `&pr=${p.R}`;
  if (p.extend) q += '&pe=1';
  if (!p.showVa) q += '&pl=0';
  if (p.scale === 'common') q += '&ps=common';
  if (p.range && (p.mode === 'range' || p.mode === 'both'))
    q += `&pf=${formatUrlTime(p.range[0])}&pt=${formatUrlTime(p.range[1])}`;
  return q;
}
