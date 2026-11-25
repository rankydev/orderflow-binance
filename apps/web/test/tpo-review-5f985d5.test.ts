// Review von 5f985d5: W-1 … W-5 und Hinweise (reine Rechnungen; das Verhalten im Browser ist zusätzlich
// headless geprüft).
import { describe, expect, it } from 'vitest';
import {
  clampScroll,
  normalizeWheel,
  pinchStep,
  priceAxisDrag,
  priceSpanLimits,
  scalePriceSpan,
  scrollBounds,
  TPO_COL_MAX,
  TPO_COL_MIN,
  wheelIntent,
  wheelPan,
  wheelZoomFactor,
  zoomColumnsAt,
} from '../src/lib/tpo/interaction.ts';
import { RATIO_OFF_NOTE, ratioNotes } from '../src/lib/stats-grid.ts';
import { candleHint } from '../src/lib/controller.ts';
import { CANDLE_WINDOW_BARS } from '../src/lib/bar-store.ts';

describe('W-1: Footprint aus → High/Low Ratio leer', () => {
  it('Notiz für beide Ratio-Zeilen nur bei ausgeschaltetem Footprint', () => {
    expect(ratioNotes(true)).toEqual({ hiRatio: RATIO_OFF_NOTE, loRatio: RATIO_OFF_NOTE });
    expect(ratioNotes(false)).toEqual({});
    expect(RATIO_OFF_NOTE).toBe('– (Footprint aus)');
  });
});

describe('Hinweis: Kerzen-Hinweis auch im frühen Rücksprung', () => {
  it('über dem Kerzenfenster der Hinweis, sonst leer (alter Hinweis wird gelöscht)', () => {
    expect(candleHint(CANDLE_WINDOW_BARS + 1)).toMatch(/^Mehr als \d+ Bars sichtbar/);
    expect(candleHint(CANDLE_WINDOW_BARS)).toBe('');
    expect(candleHint(0)).toBe('');
  });
});

describe('W-2: Verschiebung nach Größenänderung neu begrenzt', () => {
  it('breite Fläche → schmal: Verschiebung rückt in die neuen Grenzen', () => {
    // 5 Tage à 200 px; bei 900 px Fläche bis −700 erlaubt, bei 470 px nur bis −270
    expect(clampScroll(-700, 5, 200, 900)).toBe(-700);
    expect(clampScroll(-700, 5, 200, 470)).toBe(-270);
    // Tage bleiben danach sichtbar: der letzte Tag beginnt höchstens am linken Rand
    const s = clampScroll(-700, 5, 200, 470);
    expect(470 + s - 200).toBeGreaterThanOrEqual(0);
  });
  it('null Tage: keine Verschiebung, kein NaN', () => {
    expect(scrollBounds(0, 200, 1000)).toEqual([-800, 0]);
    expect(clampScroll(500, 0, 200, 1000)).toBe(0);
    const z = zoomColumnsAt(200, 0, 2, 500, 1000, 0);
    expect(Number.isFinite(z.colW) && Number.isFinite(z.scrollPx)).toBe(true);
  });
});

describe('W-3: deltaMode und sehr große Deltas', () => {
  it('Zeilen ×16, Seiten × Höhe, Pixel unverändert', () => {
    expect(normalizeWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 600)).toEqual({
      deltaX: 0,
      deltaY: 48,
    });
    expect(normalizeWheel({ deltaX: 1, deltaY: 0, deltaMode: 2 }, 600)).toEqual({
      deltaX: 600,
      deltaY: 0,
    });
    expect(normalizeWheel({ deltaX: 2, deltaY: 100, deltaMode: 0 }, 600)).toEqual({
      deltaX: 2,
      deltaY: 100,
    });
  });
  it('Firefox-Zeilen (3) zoomen spürbar, wie ~48 px', () => {
    const n = normalizeWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 600);
    expect(wheelZoomFactor(n.deltaY, false)).toBeCloseTo(Math.exp(-48 * 0.002), 9);
    expect(wheelZoomFactor(3, false)).toBeGreaterThan(0.99); // ohne Normierung fast nichts
  });
  it('Faktor je Ereignis auf [1/2, 2] begrenzt', () => {
    expect(wheelZoomFactor(1e6, false)).toBe(0.5);
    expect(wheelZoomFactor(-1e6, false)).toBe(2);
    expect(wheelZoomFactor(1e6, true)).toBe(0.5);
    const z = zoomColumnsAt(200, 0, wheelZoomFactor(-1e9, false), 500, 1000, 10);
    expect(z.colW).toBe(400);
    expect(z.colW).toBeLessThanOrEqual(TPO_COL_MAX);
    expect(zoomColumnsAt(TPO_COL_MIN, 0, 0.5, 500, 1000, 10).colW).toBe(TPO_COL_MIN);
  });
  it('waagrechtes Verschieben ± eine Flächenbreite je Ereignis', () => {
    expect(wheelPan(30, 1000)).toBe(-30);
    expect(wheelPan(1e7, 1000)).toBe(-1000);
    expect(wheelPan(-1e7, 1000)).toBe(1000);
    // Seitenmodus waagrecht wird als Verschieben erkannt
    const n = normalizeWheel({ deltaX: 1, deltaY: 0, deltaMode: 2 }, 600);
    expect(wheelIntent({ ...n, ctrlKey: false, shiftKey: false })).toBe('pan');
  });
});

describe('W-4: Preisachse ziehen begrenzt', () => {
  const tick = 10; // Einheiten je Tick
  const data = 5000; // Datenspanne der sichtbaren Tage
  const [lo, hi] = priceSpanLimits(tick, data);
  it('Grenzen: 20 Ticks … 20 × Datenspanne', () => {
    expect([lo, hi]).toEqual([200, 100000]);
    expect(priceSpanLimits(10, 0)).toEqual([200, 200]); // keine Daten: nicht unter die Untergrenze
  });
  it('8 000 px nach oben: Spanne bleibt ≥ 20 Ticks, Mitte bleibt', () => {
    const [t, b] = priceAxisDrag(105000, 100000, -8000, lo, hi);
    expect(t - b).toBeCloseTo(lo, 9);
    expect((t + b) / 2).toBeCloseTo(102500, 9);
    expect(Number.isFinite(t) && Number.isFinite(b)).toBe(true);
  });
  it('8 000 px nach unten: Spanne ≤ 20 × Datenspanne', () => {
    const [t, b] = priceAxisDrag(105000, 100000, 8000, lo, hi);
    expect(t - b).toBeCloseTo(hi, 9);
  });
  it('innerhalb der Grenzen wie bisher', () => {
    const [t, b] = priceAxisDrag(105000, 100000, -50, lo, hi);
    expect(t - b).toBeCloseTo(5000 * Math.exp(-0.2), 9);
    expect(scalePriceSpan(105000, 100000, 1, lo, hi)).toEqual([105000, 100000]);
  });
});

describe('W-5: zwei Zeiger', () => {
  it('Pinch: Faktor aus dem Abstand, Anker in der Mitte', () => {
    expect(pinchStep({ x: 100 }, { x: 300 }, { x: 50 }, { x: 450 })).toEqual({ f: 2, x: 250 });
    expect(pinchStep({ x: 300 }, { x: 100 }, { x: 250 }, { x: 150 })).toEqual({ f: 0.5, x: 200 });
  });
  it('Finger fast übereinander (< 10 px): kein Zoom (keine Division durch ~0)', () => {
    expect(pinchStep({ x: 100 }, { x: 105 }, { x: 100 }, { x: 400 }).f).toBe(1);
    expect(pinchStep({ x: 100 }, { x: 400 }, { x: 200 }, { x: 201 }).f).toBe(1);
  });
});
