// LOD-Auswahl, Zellbudget und Zeilengrößenwahl (KONZEPT §7.2, §6.1).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ladder } from '@orderflow/core/browser';
import {
  adjustRowSize,
  initialRowSize,
  rowHeightPx,
  selectLod,
  VISIBLE_CELL_BUDGET,
  visibleCells,
  wantsFootprintMode,
  type ViewGeometry,
} from '../src/lib/lod.ts';

const TICK = 10;
const RS = ladder(10_000);

describe('selectLod (§7.2)', () => {
  it('Schwellen der Tabelle', () => {
    expect(selectLod({ bs: 44, rh: 11, vc: 100, type: 'delta' })).toBe(3);
    expect(selectLod({ bs: 43.9, rh: 11, vc: 100, type: 'delta' })).toBe(2);
    expect(selectLod({ bs: 44, rh: 10.9, vc: 100, type: 'delta' })).toBe(2);
    expect(selectLod({ bs: 79, rh: 20, vc: 100, type: 'bidask' })).toBe(2);
    expect(selectLod({ bs: 80, rh: 20, vc: 100, type: 'bidask' })).toBe(3);
    expect(selectLod({ bs: 6, rh: 2, vc: 25_000, type: 'delta' })).toBe(2);
    expect(selectLod({ bs: 5.99, rh: 50, vc: 10, type: 'delta' })).toBe(1);
    expect(selectLod({ bs: 50, rh: 1.99, vc: 10, type: 'delta' })).toBe(1);
  });

  it('über dem Zellbudget immer L1, egal wie groß die Zellen sind', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 500, noNaN: true }),
        fc.double({ min: 0, max: 500, noNaN: true }),
        fc.integer({ min: 25_001, max: 10_000_000 }),
        fc.constantFrom('delta' as const, 'bidask' as const),
        (bs, rh, vc, type) => {
          expect(selectLod({ bs, rh, vc, type })).toBe(1);
        },
      ),
    );
  });

  it('Footprint-Modus mit 10 % Hysterese', () => {
    const x = { bs: 6.3, rh: 3, vc: 1000 };
    expect(wantsFootprintMode(false, x)).toBe(false); // hinein erst ab 6,6
    expect(wantsFootprintMode(true, x)).toBe(true); // heraus erst unter 5,4
    expect(wantsFootprintMode(true, { ...x, bs: 5.3 })).toBe(false);
    expect(wantsFootprintMode(false, { ...x, bs: 7, vc: 23_000 })).toBe(false);
    expect(wantsFootprintMode(true, { ...x, bs: 7, vc: 25_001 })).toBe(false);
  });
});

function geom(
  bars: [number, number][],
  unitBottom: number,
  unitTop: number,
  heightPx: number,
): ViewGeometry {
  return {
    highs: bars.map((b) => b[0]),
    lows: bars.map((b) => b[1]),
    from: 0,
    to: bars.length - 1,
    unitBottom,
    unitTop,
    pxPerUnit: heightPx / (unitTop - unitBottom),
  };
}

describe('visibleCells (vc)', () => {
  it('zählt nur Zeilen im sichtbaren Preisbereich', () => {
    const g = geom(
      [
        [1_000, 900], // Zeilen 90…100 bei w=10 → im Bereich [950, 1050]: 95…100 = 6
        [2_000, 1_900], // außerhalb
        [1_049, 1_000], // 100…104 = 5
      ],
      950,
      1_050,
      100,
    );
    expect(visibleCells(g, 10)).toBe(6 + 5);
  });

  it('entspricht der Brute-Force-Zählung', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 5_000 }), fc.integer({ min: 0, max: 500 })), {
          minLength: 1,
          maxLength: 40,
        }),
        fc.integer({ min: 0, max: 5_000 }),
        fc.integer({ min: 1, max: 3_000 }),
        fc.constantFrom(1, 2, 5, 10, 20, 50),
        (raw, bottom, span, w) => {
          const bars = raw.map(([lo, d]) => [lo + d, lo] as [number, number]);
          const g = geom(bars, bottom, bottom + span, 500);
          let ref = 0;
          for (const [h, l] of bars) {
            for (let r = Math.floor(l / w); r <= Math.floor(h / w); r++) {
              if (r >= Math.floor(bottom / w) && r <= Math.floor((bottom + span) / w)) ref++;
            }
          }
          expect(visibleCells(g, w)).toBe(ref);
        },
      ),
    );
  });
});

describe('Zeilengröße (Auto-R)', () => {
  it('Start-R: Median-Range der letzten 200 Bars ≈ 24 Zeilen, nächste Leiterstufe', () => {
    // Range 4 800 price_unit = 480 Ticks → 20 Ticks je Zeile
    const highs = Array.from({ length: 300 }, (_, i) => 100_000 + 4_800 + (i % 3));
    const lows = Array.from({ length: 300 }, () => 100_000);
    expect(initialRowSize(highs, lows, RS, TICK, TICK)).toBe(20);
    // ältere Bars (vor den letzten 200) zählen nicht
    const h2 = [...Array.from({ length: 100 }, () => 1e9), ...highs.slice(0, 200)];
    const l2 = [...Array.from({ length: 100 }, () => 0), ...lows.slice(0, 200)];
    expect(initialRowSize(h2, l2, RS, TICK, TICK)).toBe(20);
    // nie feiner als der aktuelle Tick
    expect(initialRowSize([100_010], [100_000], RS, TICK, 50)).toBe(5);
  });

  const flat = (n: number, range: number, heightPx: number, viewRange: number): ViewGeometry =>
    geom(
      Array.from({ length: n }, () => [500_000 + range, 500_000] as [number, number]),
      500_000,
      500_000 + viewRange,
      heightPx,
    );

  it('vergrößert R, solange rh < 2 px oder vc > 25 000', () => {
    // 300 Bars, je 4 000 price_unit Range, sichtbar 4 000 auf 800 px → R=1: rh 2 px, vc 300·401 > 25 000
    const g = flat(300, 4_000, 800, 4_000);
    const r = adjustRowSize(1, RS, g, TICK);
    const w = r * TICK;
    expect(visibleCells(g, w)).toBeLessThanOrEqual(VISIBLE_CELL_BUDGET);
    expect(rowHeightPx(g, w)).toBeGreaterThanOrEqual(2);
    // und es ist die kleinste solche Stufe
    const prev = RS[RS.indexOf(r) - 1]!;
    expect(
      visibleCells(g, prev * TICK) > VISIBLE_CELL_BUDGET || rowHeightPx(g, prev * TICK) < 2,
    ).toBe(true);
  });

  it('verkleinert R erst über 44 px (40 + 10 %) und nur, wenn die feinere Stufe passt', () => {
    const g = flat(20, 1_000, 800, 1_000); // 0,8 px je price_unit
    // R=50: rh = 400 px → schrittweise kleiner bis R=5 (40 px); R=2 hätte 16 px, wird aber nicht
    // gewählt, weil 40 px ≤ 44 px schon im Band liegt.
    expect(adjustRowSize(50, RS, g, TICK)).toBe(5);
    expect(adjustRowSize(5, RS, g, TICK)).toBe(5);
    // 45 px (knapp über 44) → eine Stufe kleiner
    const g2 = { ...g, pxPerUnit: 0.9 }; // R=5: 45 px
    expect(adjustRowSize(5, RS, g2, TICK)).toBe(2);
  });

  it('bleibt stehen innerhalb des Bands [2, 44] px (keine Änderung ohne Grund)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RS),
        fc.double({ min: 0.001, max: 5, noNaN: true }),
        (r, ppu) => {
          const rh = ppu * r * TICK;
          const g: ViewGeometry = {
            highs: [1_000],
            lows: [1_000],
            from: 0,
            to: 0,
            unitBottom: 0,
            unitTop: 2_000,
            pxPerUnit: ppu,
          };
          if (rh >= 2 && rh <= 44) expect(adjustRowSize(r, RS, g, TICK)).toBe(r);
        },
      ),
    );
  });

  it('Ergebnis liegt immer in der Liste und erfüllt das Budget, wenn möglich', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RS),
        fc.integer({ min: 1, max: 600 }),
        fc.integer({ min: 10, max: 50_000 }),
        fc.integer({ min: 100, max: 50_000 }),
        (r0, n, range, view) => {
          const g = flat(n, range, 700, view);
          const r = adjustRowSize(r0, RS, g, TICK);
          expect(RS).toContain(r);
          const w = r * TICK;
          if (r !== RS[RS.length - 1]) {
            expect(visibleCells(g, w)).toBeLessThanOrEqual(VISIBLE_CELL_BUDGET);
            expect(rowHeightPx(g, w)).toBeGreaterThanOrEqual(2);
          }
        },
      ),
    );
  });
});
