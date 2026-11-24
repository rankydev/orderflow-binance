// Farbskalierung (KONZEPT §6.1): Intensität = min(1, |Wert| / Ref), Ref = 95. Perzentil der |Werte| im
// Bereich (Default sichtbare Bars; Option je Bar); neu am Gestenende und beim Laden, nie je Frame.
// Zum Zeichnen wird die Intensität in wenige Stufen quantisiert (ein fillStyle je Stufe, gebündelt).
import type { ColorMode } from './types.ts';

export const COLOR_REF_PERCENTILE = 0.95;
export const INTENSITY_STEPS = 10;

/** p-Quantil (nächster Rang, 0 < p ≤ 1) der ersten n Werte; ordnet `values` dabei um (Quickselect, O(n)). */
export function quantileInPlace(values: Float64Array, n: number, p: number): number {
  if (n <= 0) return 0;
  const k = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = values[(lo + hi) >>> 1]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (values[i]! < pivot) i++;
      while (values[j]! > pivot) j--;
      if (i <= j) {
        const t = values[i]!;
        values[i] = values[j]!;
        values[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return values[k]!;
}

export function intensity(value: number, ref: number): number {
  if (ref <= 0) return value === 0 ? 0 : 1;
  return Math.min(1, Math.abs(value) / ref);
}

/** Quantisierte Stufe 0…STEPS−1 einer Intensität (0 → 0, 1 → STEPS−1). */
export function intensityStep(value: number, ref: number): number {
  const t = intensity(value, ref);
  return Math.min(INTENSITY_STEPS - 1, Math.floor(t * INTENSITY_STEPS));
}

/**
 * Deckkraft der Zellfarben: höchstens 0,62, damit helle Zellschrift (#eef1f5) auf jeder Stufe über dem
 * Hintergrund #0f1217 einen Kontrast ≥ 4,5 : 1 hat (Review W9; getestet).
 */
export const GRADIENT_ALPHA_MIN = 0.1;
export const GRADIENT_ALPHA_MAX = 0.62;
export const BACKGROUND_RGB = [15, 18, 23] as const;

export const BUY_RGB = [38, 166, 154] as const;
export const SELL_RGB = [239, 83, 80] as const;
export const NEUTRAL_RGB = [120, 128, 140] as const;

function rgba(rgb: readonly number[], a: number): string {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;
}

/**
 * Farbtabelle: Index = Seite·STEPS + Stufe (Seite 0 = Kauf/positiv, 1 = Verkauf/negativ), dazu
 * Index 2·STEPS = neutral (Wert 0 bzw. Modus „aus").
 */
export function palette(mode: ColorMode): string[] {
  const out: string[] = [];
  for (const rgb of [BUY_RGB, SELL_RGB]) {
    for (let s = 0; s < INTENSITY_STEPS; s++) {
      const t = (s + 0.5) / INTENSITY_STEPS;
      out.push(
        mode === 'gradient'
          ? rgba(rgb, GRADIENT_ALPHA_MIN + (GRADIENT_ALPHA_MAX - GRADIENT_ALPHA_MIN) * t)
          : mode === 'fixed'
            ? rgba(rgb, GRADIENT_ALPHA_MAX)
            : rgba(NEUTRAL_RGB, 0.35),
      );
    }
  }
  out.push(rgba(NEUTRAL_RGB, 0.22));
  return out;
}

export const NEUTRAL_INDEX = 2 * INTENSITY_STEPS;

/** Farbindex eines Werts mit Vorzeichen (Delta) bzw. einer Seite (Bid×Ask: positive Werte). */
export function colorIndex(value: number, ref: number, sellSide: boolean, mode: ColorMode): number {
  if (value === 0) return NEUTRAL_INDEX;
  const side = sellSide || value < 0 ? 1 : 0;
  if (mode === 'off') return side * INTENSITY_STEPS;
  if (mode === 'fixed') return side * INTENSITY_STEPS + INTENSITY_STEPS - 1;
  return side * INTENSITY_STEPS + intensityStep(value, ref);
}
