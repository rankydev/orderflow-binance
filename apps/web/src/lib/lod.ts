// Level of Detail und Zeilengrößenwahl (KONZEPT §7.2, §6.1 Auto-R). Rein und getestet; der Renderer
// wertet selectLod je Frame aus (billig), die Zeilengröße ändert nur der Controller am Gestenende.
import type { FootprintType, Lod } from './types.ts';

export const VISIBLE_CELL_BUDGET = 25_000;
export const L3_MIN_BAR_SPACING: Record<FootprintType, number> = { delta: 44, bidask: 80 };
export const L3_MIN_ROW_HEIGHT = 11;
export const L2_MIN_BAR_SPACING = 6;
export const L2_MIN_ROW_HEIGHT = 2;
export const HYSTERESIS = 0.1;
export const AUTO_R_TARGET_ROWS = 24;
export const GESTURE_DEBOUNCE_MS = 150;

export interface LodInput {
  /** Bar-Abstand in CSS-px. */
  bs: number;
  /** Zeilenhöhe in CSS-px. */
  rh: number;
  /** Geschätzte sichtbare Zellen. */
  vc: number;
  type: FootprintType;
}

/** Stufe nach der Tabelle in §7.2 (ohne Hysterese). */
export function selectLod({ bs, rh, vc, type }: LodInput): Lod {
  if (vc > VISIBLE_CELL_BUDGET) return 1;
  if (bs >= L3_MIN_BAR_SPACING[type] && rh >= L3_MIN_ROW_HEIGHT) return 3;
  if (bs >= L2_MIN_BAR_SPACING && rh >= L2_MIN_ROW_HEIGHT) return 2;
  return 1;
}

/**
 * Footprint-Modus (Footprint-Serie aktiv) vs. Kerzen-Modus, mit 10 % Hysterese gegen Flackern beim
 * Wechsel am Gestenende: hinein erst ab Schwelle·1,1, heraus erst unter Schwelle·0,9.
 */
export function wantsFootprintMode(cur: boolean, x: Omit<LodInput, 'type'>): boolean {
  const f = cur ? 1 - HYSTERESIS : 1 + HYSTERESIS;
  const budget = cur ? VISIBLE_CELL_BUDGET : VISIBLE_CELL_BUDGET * (1 - HYSTERESIS);
  return x.bs >= L2_MIN_BAR_SPACING * f && x.rh >= L2_MIN_ROW_HEIGHT * f && x.vc <= budget;
}

/** Sichtbarer Ausschnitt in Ganzzahl-Einheiten (price_unit) und Pixelmaßstab. */
export interface ViewGeometry {
  /** Hoch/Tief der sichtbaren Bars (price_unit). */
  highs: ArrayLike<number>;
  lows: ArrayLike<number>;
  /** Index-Bereich [from, to] der sichtbaren Bars in highs/lows (inklusive). */
  from: number;
  to: number;
  /** Sichtbarer Preisbereich (price_unit), unten/oben. */
  unitBottom: number;
  unitTop: number;
  /** CSS-px je price_unit (> 0). */
  pxPerUnit: number;
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);

/** vc nach §7.2: Σ über sichtbare Bars der Zeilen innerhalb des sichtbaren Preisbereichs. */
export function visibleCells(g: ViewGeometry, width: number): number {
  let vc = 0;
  const top = floorDiv(g.unitTop, width);
  const bot = floorDiv(g.unitBottom, width);
  for (let i = Math.max(0, g.from); i <= g.to && i < g.highs.length; i++) {
    const hi = Math.min(floorDiv(g.highs[i]!, width), top);
    const lo = Math.max(floorDiv(g.lows[i]!, width), bot);
    if (hi >= lo) vc += hi - lo + 1;
  }
  return vc;
}

export function rowHeightPx(g: Pick<ViewGeometry, 'pxPerUnit'>, width: number): number {
  return g.pxPerUnit * width;
}

/**
 * Zeilenklasse (Abweichung von §6.1/§7.2, Nutzerentscheid 2026-11-24, „Lesbarkeit zuerst"):
 * reichen die Bars für Zahlen (bs ≥ L3-Schwelle des Typs), werden die Zeilen so grob gewählt, dass eine
 * Zahl hineinpasst ("text"); sonst so, dass Zellen als Blöcke erkennbar sind ("cells").
 * Hysterese: einmal "text", bleibt es bis bs < 0,9 · Schwelle.
 */
export type RowClass = 'text' | 'cells';

export const ROW_TARGET: Record<
  RowClass,
  { min: number; target: number; keepMin: number; keepMax: number }
> = {
  // Zahlen: Ziel 14 px, mindestens 11,5 px (über der L3-Grenze 11 px); behalten in [11,5, 44] px
  text: { min: 11.5, target: 14, keepMin: 11.5, keepMax: 44 },
  // Zellen: Ziel 6 px, mindestens 4 px; behalten in [3, 16] px
  cells: { min: 4, target: 6, keepMin: 3, keepMax: 16 },
};

export function rowClassFor(bs: number, type: FootprintType, prev: RowClass | null): RowClass {
  const th = L3_MIN_BAR_SPACING[type];
  return bs >= (prev === 'text' ? th * (1 - HYSTERESIS) : th) ? 'text' : 'cells';
}

/**
 * Automatische Zeilengröße am Gestenende (ersetzt §7.2 „Auto-R"):
 *  1. Behalten, wenn rh(R_akt) ∈ [keepMin, keepMax] der Klasse und vc(R_akt) ≤ 25 000.
 *  2. Sonst: unter allen R mit rh(R) ≥ min das R mit minimalem |ln(rh(R) / target)|
 *     (gibt es keins, das größte R).
 *  3. Danach so lange eine Stufe größer, bis vc ≤ 0,9 · 25 000.
 * rh(R) = Pixel je price_unit · R · tick_ref_units (aus der aktuellen Preisskala).
 * Weil die gewählten rh in [min, target · 2,5 · …] ⊂ [keepMin, keepMax] liegen, springt R nicht zurück.
 */
export function chooseRowSize(
  current: number | null,
  rs: readonly number[],
  g: ViewGeometry,
  tickRefUnits: number,
  cls: RowClass,
): number {
  if (rs.length === 0) return current ?? 1;
  const t = ROW_TARGET[cls];
  const rh = (r: number) => rowHeightPx(g, r * tickRefUnits);
  const vc = (r: number) => visibleCells(g, r * tickRefUnits);
  if (current !== null && rs.includes(current)) {
    const h = rh(current);
    if (h >= t.keepMin && h <= t.keepMax && vc(current) <= VISIBLE_CELL_BUDGET) return current;
  }
  let i = rs.length - 1;
  let best = Infinity;
  for (let k = 0; k < rs.length; k++) {
    const h = rh(rs[k]!);
    if (h < t.min) continue;
    const d = Math.abs(Math.log(h / t.target));
    if (d < best) {
      best = d;
      i = k;
    }
  }
  while (i < rs.length - 1 && vc(rs[i]!) > VISIBLE_CELL_BUDGET * (1 - HYSTERESIS)) i++;
  return rs[i]!;
}

/**
 * Start-R (§6.1): Median-Range der letzten 200 Bars ≈ 24 Zeilen; nächste zulässige Stufe
 * (logarithmisch), mindestens der aktuelle Tick.
 */
export function initialRowSize(
  highs: ArrayLike<number>,
  lows: ArrayLike<number>,
  rs: readonly number[],
  tickRefUnits: number,
  tickUnits: number,
): number | null {
  const n = Math.min(highs.length, lows.length);
  const allowed = rs.filter((r) => r * tickRefUnits >= tickUnits);
  if (allowed.length === 0) return null; // N3: kein Wurf; Aufrufer zeigt „kein Footprint"
  if (n === 0) return allowed[0]!;
  const from = Math.max(0, n - 200);
  const ranges: number[] = [];
  for (let i = from; i < n; i++) ranges.push(highs[i]! - lows[i]!);
  ranges.sort((a, b) => a - b);
  const mid = ranges.length >> 1;
  const median = ranges.length % 2 ? ranges[mid]! : (ranges[mid - 1]! + ranges[mid]!) / 2;
  const target = Math.max(median, tickRefUnits) / AUTO_R_TARGET_ROWS / tickRefUnits;
  let best = allowed[0]!;
  let bestD = Infinity;
  for (const r of allowed) {
    const d = Math.abs(Math.log(r / target));
    if (d < bestD - 1e-12) {
      best = r;
      bestD = d;
    }
  }
  return best;
}

/** Hinweise bei manuellem R (§7.2: Rückfall statt stillem Ignorieren). */
export const MANUAL_R_TOO_FINE = 'Zeilengröße zu fein für diesen Ausschnitt – Kerzen';
export const MANUAL_R_NO_TEXT = 'Zeilen zu niedrig für Zahlen – nur Zellen';
