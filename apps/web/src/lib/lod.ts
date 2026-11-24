// Level of Detail und Zeilengrößenwahl (KONZEPT §7.2, §6.1 Auto-R). Rein und getestet; der Renderer
// wertet selectLod je Frame aus (billig), die Zeilengröße ändert nur der Controller am Gestenende.
import type { FootprintType, Lod } from './types.ts';

export const VISIBLE_CELL_BUDGET = 25_000;
export const L3_MIN_BAR_SPACING: Record<FootprintType, number> = { delta: 44, bidask: 80 };
export const L3_MIN_ROW_HEIGHT = 11;
export const L2_MIN_BAR_SPACING = 6;
export const L2_MIN_ROW_HEIGHT = 2;
export const ROW_HEIGHT_MAX = 40;
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

/** Nächste/vorige Stufe in einer aufsteigend sortierten Liste zulässiger R (Leiter ∩ verfügbar). */
function stepIndex(rs: readonly number[], r: number): number {
  let i = rs.indexOf(r);
  if (i < 0) {
    i = 0;
    while (i < rs.length - 1 && rs[i]! < r) i++;
  }
  return i;
}

/**
 * Auto-R am Gestenende (§7.2): fällt rh unter 2 px oder überschreitet vc 25 000, eine Leiterstufe
 * größer (wiederholt); steigt rh über 40 px, kleiner – mit 10 % Hysterese, und nur wenn die kleinere
 * Stufe die Bedingungen weiterhin (mit Reserve) erfüllt. Liefert R aus `rs` (aufsteigend).
 */
export function adjustRowSize(
  current: number,
  rs: readonly number[],
  g: ViewGeometry,
  tickRefUnits: number,
): number {
  if (rs.length === 0) return current;
  let i = stepIndex(rs, current);
  const m = (k: number) => {
    const w = rs[k]! * tickRefUnits;
    return { rh: rowHeightPx(g, w), vc: visibleCells(g, w) };
  };
  let x = m(i);
  let grew = false;
  while ((x.rh < L2_MIN_ROW_HEIGHT || x.vc > VISIBLE_CELL_BUDGET) && i < rs.length - 1) {
    i++;
    x = m(i);
    grew = true;
  }
  if (grew) return rs[i]!;
  while (x.rh > ROW_HEIGHT_MAX * (1 + HYSTERESIS) && i > 0) {
    const y = m(i - 1);
    if (
      y.rh < L2_MIN_ROW_HEIGHT * (1 + HYSTERESIS) ||
      y.vc > VISIBLE_CELL_BUDGET * (1 - HYSTERESIS)
    )
      break;
    i--;
    x = y;
  }
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
): number {
  const n = Math.min(highs.length, lows.length);
  const allowed = rs.filter((r) => r * tickRefUnits >= tickUnits);
  if (allowed.length === 0) throw new Error('keine zulässige Zeilengröße');
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

/** Hinweis bei manuellem R, wenn die Bedingungen für L2 nicht erfüllt sind (§7.2). */
export const MANUAL_R_TOO_FINE = 'Zeilengröße zu fein für diesen Ausschnitt';
