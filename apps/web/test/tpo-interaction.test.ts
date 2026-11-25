// TPO-Bedienung wie die Chart-Seite (Punkte 3/4) und der Schalter „nur Kerzen" (Punkt 2).
import { describe, expect, it } from 'vitest';
import {
  clampScroll,
  priceAxisDrag,
  scrollBounds,
  TPO_COL_MAX,
  TPO_COL_MIN,
  wheelIntent,
  wheelZoomFactor,
  zoomColumnsAt,
} from '../src/lib/tpo/interaction.ts';
import {
  FOOTPRINT_DEFAULTS,
  footprintParamsQuery,
  parseFootprintParams,
} from '../src/lib/footprint-options.ts';

describe('TPO: freier Raum rechts (Punkt 3)', () => {
  it('nach rechts bis der letzte Tag am linken Rand steht, nach links bis zum ersten Tag', () => {
    // 10 Tage à 200 px, Zeichenfläche 1 000 px
    expect(scrollBounds(10, 200, 1000)).toEqual([-800, 1800]);
    expect(clampScroll(-5000, 10, 200, 1000)).toBe(-800); // letzter Tag ganz links, Rest leer
    expect(clampScroll(-300, 10, 200, 1000)).toBe(-300); // 300 px leerer Raum rechts
    expect(clampScroll(9999, 10, 200, 1000)).toBe(1800);
    // Spalte breiter als die Fläche: kein Raum rechts
    expect(scrollBounds(3, 1200, 1000)).toEqual([-0, 2400]);
  });
});

describe('TPO: Zoom wie die Chart-Seite (Punkt 4)', () => {
  it('Rad senkrecht und Pinch (ctrl) zoomen, waagrecht/Shift verschiebt', () => {
    expect(wheelIntent({ deltaX: 0, deltaY: 100, ctrlKey: false, shiftKey: false })).toBe('zoom');
    expect(wheelIntent({ deltaX: 0, deltaY: 3, ctrlKey: true, shiftKey: false })).toBe('zoom');
    expect(wheelIntent({ deltaX: 40, deltaY: 5, ctrlKey: false, shiftKey: false })).toBe('pan');
    expect(wheelIntent({ deltaX: 0, deltaY: 100, ctrlKey: false, shiftKey: true })).toBe('pan');
    // nach oben (deltaY < 0) = breiter, wie die Zeitachse der Chart-Seite
    expect(wheelZoomFactor(-100, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, false)).toBeLessThan(1);
    expect(wheelZoomFactor(-10, true)).toBeCloseTo(Math.exp(0.1));
  });

  it('Spaltenbreite um den Zeiger: die Zeitposition unter dem Zeiger bleibt dort', () => {
    // Zeiger bei x = 600 auf 1 000 px, Spalte 200 px, keine Verschiebung: 2 Tage vom rechten Rand
    const z = zoomColumnsAt(200, 0, 2, 600, 1000, 30);
    expect(z.colW).toBe(400);
    // (1000 − 600 + scroll') / 400 = 2 → scroll' = 400
    expect(z.scrollPx).toBe(400);
    // Anker am rechten Rand: Verschiebung skaliert mit
    expect(zoomColumnsAt(200, 100, 2, 1000, 1000, 30)).toEqual({ colW: 400, scrollPx: 200 });
    // Grenzen
    expect(zoomColumnsAt(200, 0, 100, 500, 1000, 30).colW).toBe(TPO_COL_MAX);
    expect(zoomColumnsAt(200, 0, 0.01, 500, 1000, 30).colW).toBe(TPO_COL_MIN);
  });

  it('Preisachse ziehen: nach oben kleinerer Bereich (höhere Zeilen), um die Mitte', () => {
    const [t, b] = priceAxisDrag(200, 100, -100);
    expect((t + b) / 2).toBeCloseTo(150);
    expect(t - b).toBeCloseTo(100 * Math.exp(-0.4));
    const [t2, b2] = priceAxisDrag(200, 100, 50);
    expect(t2 - b2).toBeGreaterThan(100);
  });
});

describe('Schalter „nur Kerzen" (Punkt 2): URL', () => {
  it('Standard an (Footprint), fp=0 schaltet aus und wird geschrieben', () => {
    expect(FOOTPRINT_DEFAULTS.footprint).toBe(true);
    expect(parseFootprintParams(new URLSearchParams('')).footprint).toBe(true);
    const o = parseFootprintParams(new URLSearchParams('fp=0&type=bidask'));
    expect(o.footprint).toBe(false);
    expect(footprintParamsQuery(o)).toBe('&fp=0');
    expect(footprintParamsQuery({ ...o, footprint: true })).toBe('');
  });
});
