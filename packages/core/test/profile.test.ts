// Volume Profile (KONZEPT §6.1, Test T6): POC/Delta-POC-Gleichstandsregel, Value Area enthält den POC,
// ist zusammenhängend, erreicht va_pct, ist deterministisch und folgt dem Paarverfahren; Antwortprüfung.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkProfileBody,
  deltaPocIndex,
  maxNearMiddle,
  pocIndex,
  profileMarks,
  valueArea,
  type ProfileBody,
} from '../src/index.ts';

const volArb = fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 60 });

/** Referenz: Paarverfahren Schritt für Schritt, unabhängig formuliert. */
function refValueArea(vol: number[], poc: number, va: number): [number, number] {
  const total = vol.reduce((a, b) => a + b, 0);
  let lo = poc;
  let hi = poc;
  let cum = vol[poc]!;
  while (cum * 100 < va * total) {
    const above = vol.slice(hi + 1, hi + 3);
    const below = vol.slice(Math.max(0, lo - 2), lo);
    const sa = above.reduce((a, b) => a + b, 0);
    const sb = below.reduce((a, b) => a + b, 0);
    if (above.length > 0 && (below.length === 0 || sa >= sb)) {
      hi += above.length;
      cum += sa;
    } else {
      lo -= below.length;
      cum += sb;
    }
  }
  return [lo, hi];
}

describe('maxNearMiddle / POC', () => {
  it('größter Wert; Gleichstand näher an der Mitte, dann tiefer', () => {
    expect(maxNearMiddle([1, 5, 3])).toBe(1);
    expect(maxNearMiddle([5, 0, 0, 0, 5])).toBe(0); // gleich weit von der Mitte → tiefer
    expect(maxNearMiddle([5, 0, 5, 0, 5])).toBe(2); // Mitte gewinnt
    expect(maxNearMiddle([0, 5, 5, 0])).toBe(1); // beide gleich weit → tiefer
    expect(maxNearMiddle([0, 0])).toBe(-1);
    expect(maxNearMiddle([])).toBe(-1);
  });

  it('Eigenschaft: POC hat das Maximum, kein anderer Kandidat ist näher an der Mitte', () => {
    fc.assert(
      fc.property(volArb, (vol) => {
        const p = maxNearMiddle(vol);
        const max = Math.max(...vol);
        if (max === 0) return p === -1;
        if (vol[p] !== max) return false;
        const n = vol.length;
        const d = (i: number) => Math.abs(2 * i - (n - 1));
        return vol.every((v, i) => v < max || d(i) > d(p) || (d(i) === d(p) && i >= p));
      }),
    );
  });

  it('pocIndex und deltaPocIndex über buy/sell', () => {
    expect(pocIndex([1, 2, 0], [0, 2, 9])).toBe(2);
    expect(deltaPocIndex([1, 2, 0], [0, 2, 9])).toBe(2);
    expect(deltaPocIndex([3, 2], [3, 2])).toBe(-1);
  });
});

describe('valueArea', () => {
  it('Beispiel nach dem Paarverfahren (Gleichstand → oben)', () => {
    // POC = Index 3 (10); oben [4,5] = 4+4 = 8, unten [2,1] = 4+4 = 8 → Gleichstand → oben
    const vol = [1, 4, 4, 10, 4, 4, 1];
    expect(valueArea(vol, 3, 50)).toEqual([3, 5]);
    expect(valueArea(vol, 3, 70)).toEqual([1, 5]);
    expect(valueArea(vol, 3, 100)).toEqual([0, 6]);
    expect(valueArea([0, 0], 0, 70)).toBeNull();
    expect(valueArea([3], 0, 70)).toEqual([0, 0]);
  });

  it('Eigenschaft (T6): enthält POC, zusammenhängend, ≥ va_pct, = Referenz, deterministisch', () => {
    fc.assert(
      fc.property(volArb, fc.integer({ min: 1, max: 100 }), (vol, va) => {
        const total = vol.reduce((a, b) => a + b, 0);
        const p = maxNearMiddle(vol);
        const r = valueArea(vol, p, va);
        if (total === 0) return r === null;
        if (!r) return false;
        const [lo, hi] = r;
        const cum = vol.slice(lo, hi + 1).reduce((a, b) => a + b, 0);
        const ref = refValueArea(vol, p, va);
        const again = valueArea(vol, p, va);
        return (
          lo <= p &&
          p <= hi &&
          lo >= 0 &&
          hi < vol.length &&
          cum * 100 >= va * total &&
          lo === ref[0] &&
          hi === ref[1] &&
          again![0] === lo &&
          again![1] === hi
        );
      }),
    );
  });

  it('lehnt va außerhalb 1…100 ab', () => {
    expect(() => valueArea([1, 2], 1, 0)).toThrow(RangeError);
    expect(() => valueArea([1, 2], 1, 101)).toThrow(RangeError);
  });
});

describe('profileMarks / checkProfileBody', () => {
  it('absolute Zeilen und gültige Antwortform', () => {
    const buy = [1, 0, 5, 2];
    const sell = [0, 0, 7, 1];
    const m = profileMarks(100, buy, sell, 70);
    expect(m).toEqual({ poc: 102, vah: 102, val: 102, deltaPoc: 102 });
    const body: ProfileBody = {
      rowLo: 100,
      buy,
      sell,
      ...m,
      buyQ: 8,
      sellQ: 8,
      notional: '123456789012345678901',
      vwap: 1019.5,
      low: 1000,
      high: 1039,
    };
    expect(checkProfileBody(body)).toEqual([]);
    expect(checkProfileBody({ ...body, buyQ: 9 })).not.toEqual([]);
    expect(checkProfileBody({ ...body, poc: 99 })).not.toEqual([]);
    expect(checkProfileBody({ ...body, notional: '1e21' })).not.toEqual([]);
    expect(checkProfileBody({ ...body, vwap: null })).not.toEqual([]);
    expect(
      checkProfileBody({ ...body, buy: [0, 0, 5, 2], buyQ: 7, sell: [0, 0, 7, 1] }),
    ).not.toEqual([]);
  });
});
