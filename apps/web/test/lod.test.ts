// LOD-Auswahl, Zellbudget und Zeilengrößenwahl (KONZEPT §7.2, §6.1).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ladder } from '@orderflow/core/browser';
import {
  chooseRowSize,
  initialRowSize,
  ROW_TARGET,
  rowClassFor,
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

describe('Zeilenklasse (Lesbarkeit zuerst)', () => {
  it('Zahlen ab der L3-Schwelle des Typs, Hysterese 10 % beim Verlassen', () => {
    expect(rowClassFor(44, 'delta', null)).toBe('text');
    expect(rowClassFor(43.9, 'delta', null)).toBe('cells');
    expect(rowClassFor(40, 'delta', 'text')).toBe('text'); // ≥ 39,6
    expect(rowClassFor(39.5, 'delta', 'text')).toBe('cells');
    expect(rowClassFor(42, 'delta', 'cells')).toBe('cells');
    expect(rowClassFor(79, 'bidask', null)).toBe('cells');
    expect(rowClassFor(80, 'bidask', null)).toBe('text');
  });
});

describe('chooseRowSize (automatische Zeilengröße am Gestenende)', () => {
  // 30 Bars über 4 000 price_unit Range; ppu frei wählbar
  const view = (ppu: number, n = 30, range = 4_000): ViewGeometry => ({
    highs: Array.from({ length: n }, () => 500_000 + range),
    lows: Array.from({ length: n }, () => 500_000),
    from: 0,
    to: n - 1,
    unitBottom: 500_000,
    unitTop: 500_000 + 700 / ppu,
    pxPerUnit: ppu,
  });
  const rh = (g: ViewGeometry, r: number) => g.pxPerUnit * r * TICK;

  it('Zahlen: rh(R) ≥ 11,5 px und am nächsten an 14 px (logarithmisch)', () => {
    // ppu 0,16 px/unit: R=10 → 16 px exakt
    expect(chooseRowSize(null, RS, view(0.16), TICK, 'text')).toBe(10);
    // ppu 0,1: R=10 → 10 px (zu klein), R=20 → 20 px
    expect(chooseRowSize(null, RS, view(0.1), TICK, 'text')).toBe(20);
    fc.assert(
      fc.property(fc.double({ min: 0.0005, max: 5, noNaN: true }), (ppu) => {
        const g = view(ppu, 10, 400);
        const r = chooseRowSize(null, RS, g, TICK, 'text');
        // (ist schon R = 1 Tick höher als 44 px, gibt es nichts Feineres – dann R = 1)
        if (
          rh(g, RS[RS.length - 1]!) >= ROW_TARGET.text.min &&
          rh(g, 1) <= ROW_TARGET.text.keepMax
        ) {
          expect(rh(g, r)).toBeGreaterThanOrEqual(ROW_TARGET.text.min);
          // gewähltes rh liegt im Behalten-Band → keine Rückwechsel ohne Änderung der Skala
          expect(rh(g, r)).toBeLessThanOrEqual(ROW_TARGET.text.keepMax);
          expect(chooseRowSize(r, RS, g, TICK, 'text')).toBe(r);
        }
      }),
    );
  });

  it('Zellen: rh ≥ 4 px, Ziel 6 px', () => {
    expect(chooseRowSize(null, RS, view(0.06), TICK, 'cells')).toBe(10); // 6 px
    const r = chooseRowSize(null, RS, view(0.013), TICK, 'cells');
    expect(rh(view(0.013), r)).toBeGreaterThanOrEqual(4);
  });

  it('Hysterese: R bleibt im Band, folgt beim Strecken (feiner) und Stauchen (gröber)', () => {
    const g = view(0.16);
    expect(chooseRowSize(10, RS, view(0.25), TICK, 'text')).toBe(10); // 25 px: im Band, bleibt
    expect(chooseRowSize(10, RS, view(0.12), TICK, 'text')).toBe(10); // 12 px: bleibt
    expect(chooseRowSize(10, RS, view(0.1), TICK, 'text')).toBe(20); // 10 px < 11,5: gröber
    // 50 px > 44: feiner; R=2 hätte 10 px (< 11,5), also R=5 mit 25 px
    expect(chooseRowSize(10, RS, view(0.5), TICK, 'text')).toBe(5);
    // Wechsel text → cells: 16 px liegt noch im Zellen-Band [3, 16] → bleibt
    expect(chooseRowSize(10, RS, g, TICK, 'cells')).toBe(10);
    // 20 px ist für Zellen zu hoch → feiner, Ziel 6 px (R=5 → 6,25 px)
    expect(chooseRowSize(10, RS, view(0.2) /* 20 px */, TICK, 'cells')).toBe(2);
  });

  it('Zellbudget: R wird vergrößert, bis vc ≤ 22 500', () => {
    // 600 Bars, je 400 Zeilen bei R=1 im sichtbaren Bereich; rh-Ziel würde R=1 wählen
    const g: ViewGeometry = {
      highs: Array.from({ length: 600 }, () => 504_000),
      lows: Array.from({ length: 600 }, () => 500_000),
      from: 0,
      to: 599,
      unitBottom: 500_000,
      unitTop: 504_000,
      pxPerUnit: 0.6,
    };
    const r = chooseRowSize(null, RS, g, TICK, 'cells');
    expect(visibleCells(g, r * TICK)).toBeLessThanOrEqual(VISIBLE_CELL_BUDGET * 0.9);
    const prev = RS[RS.indexOf(r) - 1]!;
    expect(visibleCells(g, prev * TICK)).toBeGreaterThan(VISIBLE_CELL_BUDGET * 0.9);
  });

  it('nur verfügbare R (Liste), sonst das größte', () => {
    expect(chooseRowSize(null, [50, 100], view(0.01), TICK, 'text')).toBe(100);
    expect(chooseRowSize(7, [5, 10], view(0.16), TICK, 'text')).toBe(10);
  });
});

describe('Start-R (vorläufig, vor der ersten Bewertung)', () => {
  it('N3: ohne zulässige Zeilengröße null statt Ausnahme', () => {
    expect(initialRowSize([1], [1], [], TICK, TICK)).toBeNull();
    expect(initialRowSize([1], [1], [1, 2], TICK, 1000)).toBeNull();
  });
  it('nie feiner als der aktuelle Tick', () => {
    expect(initialRowSize([100_010], [100_000], RS, TICK, 50)).toBe(5);
  });
});

void rowHeightPx;
void wantsFootprintMode;

describe('Manuelles R und Startansicht', () => {
  it('Beschriftung in Preiseinheiten, nächstes verfügbares R, Start-Bar-Abstand über der L3-Schwelle', async () => {
    const { rowLabel, nearestR, initialBarSpacing } = await import('../src/lib/controller.ts');
    const btc = { name: 'BTCUSDT', tickRefUnits: 10, priceDecimals: 2 };
    expect(rowLabel(1, btc)).toBe('0.1 USDT');
    expect(rowLabel(50, btc)).toBe('5 USDT');
    expect(rowLabel(1000, btc)).toBe('100 USDT');
    expect(nearestR([5, 10, 20, 50], 2)).toBe(5);
    expect(nearestR([5, 10, 20, 50], 30)).toBe(20); // ln: 30/20 < 50/30
    expect(initialBarSpacing('delta')).toBeGreaterThanOrEqual(44);
    expect(initialBarSpacing('bidask')).toBeGreaterThanOrEqual(80);
  });
});
