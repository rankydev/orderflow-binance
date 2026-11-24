// BarStore, Fenster-Anker (K1/W8) und kleine Helfer des Controllers.
import { describe, expect, it } from 'vitest';
import { encodeTile } from '@orderflow/core/browser';
import {
  BarStore,
  chunksReadyInWindow,
  indexAtOrAfter,
  indexAtOrBefore,
  logicalIndexOfTime,
  rangeAfterRebuild,
  tfSwitchAnchorTime,
} from '../src/lib/bar-store.ts';
import {
  compareTileWithBars,
  countItemsIn,
  exactDecimal,
  pricePrecision,
} from '../src/lib/controller.ts';
import type { BarItem } from '../src/lib/types.ts';

const items = (times: number[], v = 1) =>
  times.map((t) => ({ time: t, t, v }) as unknown as BarItem);

function chunk(sym: string, tf: string, from: number, to: number, times: number[]) {
  const n = times.length;
  const i = (v: number) => Int32Array.from({ length: n }, () => v);
  return encodeTile({
    meta: {
      kind: 'bars',
      sym,
      tf,
      tfSec: 60,
      R: null,
      priceDecimals: 2,
      qtyDecimals: 3,
      tickRefUnits: 10,
      from,
      to,
      tile: null,
      dataVersion: 'v',
      final: true,
    },
    bars: {
      time: Int32Array.from(times),
      open: i(100),
      high: i(100),
      low: i(100),
      close: i(100),
      buyQ: Float64Array.from(times, () => 1),
      sellQ: new Float64Array(n),
      buyA: i(1),
      sellA: i(0),
    },
  }).buffer as ArrayBuffer;
}

describe('Index-Suche und Anker', () => {
  const xs = items([600, 660, 780, 840]);
  it('indexAtOrAfter / indexAtOrBefore', () => {
    expect(indexAtOrAfter(xs, 700)).toBe(2);
    expect(indexAtOrBefore(xs, 700)).toBe(1);
    expect(indexAtOrBefore(xs, 660)).toBe(1);
    expect(indexAtOrBefore(xs, 599)).toBe(-1);
  });
  it('indexAtOrBefore bei echten Zeitstempeln (~1,8·10^9 s) exakt', () => {
    const big = items([1_795_391_880, 1_795_391_940, 1_795_392_000]);
    expect(indexAtOrBefore(big, 1_795_391_940)).toBe(1);
    expect(indexAtOrBefore(big, 1_795_391_999)).toBe(1);
  });
  it('W8: Zeit im Bar → dieser Bar (10:20 im 1h-Bar 10:00, nicht 11:00)', () => {
    const h = items([36_000, 39_600, 43_200]); // 10:00, 11:00, 12:00
    expect(logicalIndexOfTime(h, 37_200, 3600)).toBe(0); // 10:20
  });
  it('K1: Zeit weit außerhalb wird auf das neue Fenster begrenzt (nie daneben)', () => {
    expect(logicalIndexOfTime(xs, -1e9, 60)).toBe(0);
    expect(logicalIndexOfTime(xs, 1e9, 60)).toBe(3);
  });
});

describe('BarStore', () => {
  it('K2: Abschnitt wird gegen die Anfrage geprüft', () => {
    const b = new BarStore('S|1m', 2);
    const buf = chunk('S', '1m', 0, 60_000_000, [0, 60]);
    expect(() =>
      b.addEncoded(0, buf, { sym: 'S', tf: '1m', from: 0, to: 60_000_000 }),
    ).not.toThrow();
    expect(() =>
      b.addEncoded(1, buf, { sym: 'S', tf: '1m', from: 60_000_000, to: 120_000_000 }),
    ).toThrow(/Zeitraum/);
    expect(() => b.addEncoded(0, buf, { sym: 'T', tf: '1m', from: 0, to: 60_000_000 })).toThrow(
      /sym/,
    );
  });
  it('loadedRun wächst über Lücken (markEmpty), Items sind aufsteigend', () => {
    const b = new BarStore('S|1m', 2);
    const span = 60_000_000;
    b.addEncoded(0, chunk('S', '1m', 0, span, [0, 60]));
    b.markEmpty(1);
    b.addEncoded(2, chunk('S', '1m', 2 * span, 3 * span, [120_000]));
    expect(b.loadedRun(0, 5, 2)).toEqual([0, 2]);
    expect(b.loadedRun(0, 5, 4)).toBeNull();
    expect(b.items(0, 2).map((x) => x.time)).toEqual([0, 60, 120_000]);
  });
  it('evict hält das Fenster', () => {
    const b = new BarStore('S|1m', 2);
    for (let c = 0; c < 90; c++) b.markEmpty(c);
    b.evict(85, 89);
    expect(b.size).toBe(80);
    for (let c = 85; c < 90; c++) expect(b.has(c)).toBe(true);
  });
});

describe('Helfer', () => {
  it('exactDecimal ohne Gleitkomma', () => {
    expect(exactDecimal(1234, 3)).toBe('1.234');
    expect(exactDecimal(-5, 3)).toBe('-0.005');
    expect(exactDecimal(6_123_690, 2)).toBe('61236.90');
    expect(exactDecimal(7, 0)).toBe('7');
  });
  it('H3: Preisgenauigkeit auch für Ticks ≠ 10^k', () => {
    expect(pricePrecision(10, 2)).toBe(1); // 0.1
    expect(pricePrecision(25, 2)).toBe(2); // 0.25
    expect(pricePrecision(100, 2)).toBe(0); // 1
    expect(pricePrecision(5, 3)).toBe(3); // 0.005
  });
});

describe('K1: Ausschnitt nach Fensterwechsel (rangeAfterRebuild)', () => {
  // altes Fenster: 1 000 1m-Bars ab t0; die Geste hat die Ansicht 8 500…8 300 Bars links davon geschoben
  const t0 = 10_000_000 * 60;
  const old = items(Array.from({ length: 1000 }, (_, i) => t0 + i * 60));
  const lr = { from: -8500, to: -8300 };
  const target = t0 - 8400 * 60; // Zeit der Bildmitte
  // neu geladener Abschnitt (1 000 Bars), der die Zielzeit enthält
  const c0 = target - 300 * 60;
  const fresh = items(Array.from({ length: 1000 }, (_, i) => c0 + i * 60));

  it('liegt im neuen Fenster und ist auf den Bar der Zielzeit zentriert', () => {
    const r = rangeAfterRebuild(old, lr, fresh, 60);
    const mid = (r.from + r.to) / 2;
    expect(mid).toBeGreaterThanOrEqual(0);
    expect(mid).toBeLessThanOrEqual(fresh.length - 1);
    expect(fresh[Math.round(mid)]!.time).toBe(target);
    expect(r.to - r.from).toBe(200);
  });

  it('die frühere Logik (Anker = nächster Index im alten Fenster) hätte daneben gelegen', () => {
    const i = Math.min(old.length - 1, Math.max(0, Math.round((lr.from + lr.to) / 2)));
    const oldAnchor = old[i]!.time; // = t0, 8 400 Bars rechts vom Ziel
    const idx = Math.min(fresh.length - 1, indexAtOrAfter(fresh, oldAnchor));
    expect(fresh[idx]!.time).not.toBe(target);
  });

  it('Zielzeit außerhalb des neuen Fensters → Rand des Fensters, nie daneben', () => {
    const r = rangeAfterRebuild(old, { from: -50_000, to: -49_800 }, fresh, 60);
    expect((r.from + r.to) / 2).toBe(0);
  });
});

describe('W8: Anker beim tf-Wechsel', () => {
  it('auf feineren tf: Mitte des alten Bars; auf gröberen: unverändert', () => {
    expect(tfSwitchAnchorTime(36_000 + 1200, 3600, 60)).toBe(36_000 + 1800); // 1h-Bar 10:00 → 10:30
    expect(tfSwitchAnchorTime(37_200, 60, 3600)).toBe(37_200);
  });
});

describe('A: Querprüfung Kachel ↔ Bars', () => {
  it('countItemsIn zählt Items in [a, b)', () => {
    const xs = items([60, 120, 180, 300]);
    expect(countItemsIn(xs, 60, 181)).toBe(3);
    expect(countItemsIn(xs, 61, 300)).toBe(2);
    expect(countItemsIn(xs, 0, 60)).toBe(0);
    expect(countItemsIn(xs, 400, 500)).toBe(0);
  });
});

describe('W-3/H-1: Querprüfung Kachel ↔ /bars', () => {
  const xs = items([60, 120, 180, 300], 5);
  it('gleiche Bars und Mengen → keine Abweichung', () => {
    expect(compareTileWithBars(xs, [60, 120, 180], [5, 5, 5], 3, 0, 240)).toBe('');
  });
  it('fehlender Bar oder andere Menge wird gemeldet', () => {
    expect(compareTileWithBars(xs, [60, 180], [5, 5], 2, 0, 240)).toMatch(/Bar 120 nur in \/bars/);
    expect(compareTileWithBars(xs, [60, 120, 180], [5, 6, 5], 3, 0, 240)).toMatch(
      /Bar 120: Menge 6/,
    );
    expect(compareTileWithBars(xs, [], [], 0, 0, 240)).toMatch(/Bar 60 nur in \/bars/);
  });
  it('BarStore: nur finale Abschnitte ohne Lücke gelten als prüfbar; drop lädt neu', () => {
    const b = new BarStore('S|1m', 2);
    const span = 60_000_000;
    b.addEncoded(0, chunk('S', '1m', 0, span, [0, 60]));
    b.markEmpty(1);
    expect(b.allFinal(0, 0)).toBe(true);
    expect(b.allFinal(0, 1)).toBe(false); // Lücke → keine Querprüfung (W-3a)
    b.drop(0);
    expect(b.has(0)).toBe(false);
    expect(b.allFinal(0, 0)).toBe(false);
  });
});

describe('Review b: zurückgestellte Kachel erst nach neu geladenen Abschnitten im Fenster', () => {
  it('Kachel vor dem Abschnitt → nicht bereit; Abschnitt da, Fenster alt → nicht bereit; beides → bereit', () => {
    const loaded = new Set<number>();
    const has = (c: number) => loaded.has(c);
    expect(chunksReadyInWindow([3, 4], has, [0, 5])).toBe(false); // Abschnitte noch unterwegs
    loaded.add(3);
    loaded.add(4);
    expect(chunksReadyInWindow([3, 4], has, [0, 3])).toBe(false); // Fenster noch ohne Abschnitt 4
    expect(chunksReadyInWindow([3, 4], has, null)).toBe(false);
    expect(chunksReadyInWindow([3, 4], has, [2, 6])).toBe(true);
  });
});
