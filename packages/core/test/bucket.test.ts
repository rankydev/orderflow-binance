// T2 Zeilenbildung (KONZEPT §4.10): jeder px in genau einer Zeile; Rebinning aus jedem gespeicherten
// Bin = direkte Bildung für alle R der Leiter {1,2,5}·10^k. Referenz per BigInt-Division.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ladder, rowIndex, rowPx, STORED_BINS, storedBinFor } from '../src/index.ts';

const TICK = 10; // tick_ref_units BTC/ETH
const LADDER = ladder(5000);
const px = fc.integer({ min: 1, max: 2 ** 31 - 1 });

describe('rowPx / rowIndex', () => {
  it('Leiter ist {1,2,5}·10^k', () => {
    expect(LADDER.slice(0, 10)).toEqual([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]);
  });

  it('jeder px liegt in genau einer Zeile: rowPx ≤ px < rowPx + w, rowPx Vielfaches von w', () => {
    fc.assert(
      fc.property(px, fc.constantFrom(...LADDER), (p, r) => {
        const w = r * TICK;
        const lo = rowPx(p, w);
        expect(lo % w).toBe(0);
        expect(lo <= p && p < lo + w).toBe(true);
        expect(BigInt(lo)).toBe((BigInt(p) / BigInt(w)) * BigInt(w));
        expect(BigInt(rowIndex(p, w))).toBe(BigInt(p) / BigInt(w));
      }),
    );
  });

  it('Grenzpreise: px genau auf der Kante gehört zur oberen Zeile, px − 1 zur unteren', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.constantFrom(...LADDER), (k, r) => {
        const w = r * TICK;
        expect(rowPx(k * w, w)).toBe(k * w);
        expect(rowPx(k * w - 1, w)).toBe((k - 1) * w);
      }),
    );
  });

  it('Rebinning aus jedem gespeicherten Bin, der R teilt, = direkte Bildung', () => {
    fc.assert(
      fc.property(px, fc.constantFrom(...LADDER), (p, r) => {
        for (const b of STORED_BINS) {
          if (r % b !== 0) continue;
          expect(rowPx(rowPx(p, b * TICK), r * TICK)).toBe(rowPx(p, r * TICK));
        }
      }),
    );
  });

  it('jede Leiterstufe ist Vielfaches eines gespeicherten Bins (≥ dem nächstkleineren 10er-Bin)', () => {
    for (const r of LADDER) {
      const b = storedBinFor(r);
      expect(r % b).toBe(0);
      expect(b * 10).toBeGreaterThan(r);
    }
  });
});
