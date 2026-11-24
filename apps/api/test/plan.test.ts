// Quellenwahl (KONZEPT §5.2), Zerlegung von Profilzeiträumen, Zeilenschätzung, Kachellänge mit
// Zell- und Quellzeilengrenze, tileConfigVersion, Datenversion/final, Cache und Limiter.
import { chooseFpSource, fpTableGrid, ladder, type FpTableName } from '@orderflow/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ResponseCache } from '../src/cache.ts';
import { computeTiles, configVersion, runs, TILE_LADDER, TIMEFRAME_LIST } from '../src/catalog.ts';
import { HttpError } from '../src/errors.ts';
import { Limiter } from '../src/limiter.ts';
import {
  barSegmentsFor,
  barTableFor,
  decomposeDays,
  decomposeRange,
  estimateRows,
  profileGrids,
} from '../src/plan.ts';
import { versionOf } from '../src/versions.ts';

const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;
const NOMINAL: Record<FpTableName, number> = {
  fp_1m: 650_000,
  fp_1m_b10: 70_000,
  fp_5m_b10: 29_000,
  fp_15m_b100: 2_000,
  fp_1h_b10: 10_000,
  fp_1h_b100: 1_000,
  fp_1d_b100: 200,
  fp_1d_b1000: 20,
};

describe('Quellenwahl', () => {
  it('Beispiele aus KONZEPT §5.2', () => {
    expect(chooseFpSource(240, 200, NOMINAL)).toBe('fp_1h_b100');
    expect(chooseFpSource(30, 100, NOMINAL)).toBe('fp_15m_b100');
    expect(chooseFpSource(15, 20, NOMINAL)).toBe('fp_5m_b10');
    expect(chooseFpSource(1, 5, NOMINAL)).toBe('fp_1m');
    expect(chooseFpSource(3, 10, NOMINAL)).toBe('fp_1m_b10');
    expect(chooseFpSource(1440, 1000, NOMINAL)).toBe('fp_1d_b1000');
  });
  it('Bars aus der gröbsten passenden Bar-Tabelle', () => {
    expect([1, 3, 5, 15, 30].map(barTableFor)).toEqual(Array(5).fill('bar_1m'));
    expect([60, 120, 240].map(barTableFor)).toEqual(Array(3).fill('bar_1h'));
    expect(barTableFor(1440)).toBe('bar_1d');
  });
  it('Profil-Raster je R: größter Bin, der R teilt, grob → fein', () => {
    expect(profileGrids(5).map((g) => g.table)).toEqual(['fp_1m']);
    expect(profileGrids(20).map((g) => g.table)).toEqual(['fp_1h_b10', 'fp_5m_b10', 'fp_1m_b10']);
    expect(profileGrids(200).map((g) => g.table)).toEqual([
      'fp_1d_b100',
      'fp_1h_b100',
      'fp_15m_b100',
      'fp_5m_b10',
      'fp_1m_b10',
    ]);
    expect(profileGrids(5000)[0]!.table).toBe('fp_1d_b1000');
  });
});

describe('decomposeRange', () => {
  const rangeArb = fc
    .record({
      a: fc.integer({ min: 20_000 * 1440, max: 20_100 * 1440 }),
      len: fc.integer({ min: 1, max: 40 * 1440 }),
      R: fc.constantFrom(...ladder(100_000)),
    })
    .map(({ a, len, R }) => ({ from: a * M, to: (a + len) * M, R }));

  it('lückenlos, ohne Überlappung, an das Raster der Tabelle ausgerichtet, Bin teilt R', () => {
    fc.assert(
      fc.property(rangeArb, ({ from, to, R }) => {
        const segs = decomposeRange(from, to, R);
        let t = from;
        for (const s of segs) {
          const g = fpTableGrid(s.table);
          if (s.from !== t || s.to <= s.from) return false;
          if (s.from % (g.tfMin * M) !== 0 || s.to % (g.tfMin * M) !== 0) return false;
          if (R % g.bin !== 0) return false;
          t = s.to;
        }
        return t === to;
      }),
    );
  });

  it('Mitte aus der gröbsten Quelle, Ränder fein', () => {
    // 2026-10-01 10:07 … 2026-10-04 13:59 bei R = 100
    const d = 20_727 * D;
    const segs = decomposeRange(d + 10 * H + 7 * M, d + 3 * D + 13 * H + 59 * M, 100);
    expect(segs.map((s) => s.table)).toEqual([
      'fp_1m_b10',
      'fp_5m_b10',
      'fp_15m_b100',
      'fp_1h_b100',
      'fp_1d_b100',
      'fp_1h_b100',
      'fp_15m_b100',
      'fp_5m_b10',
      'fp_1m_b10',
    ]);
    expect(segs[4]).toEqual({ table: 'fp_1d_b100', from: d + D, to: d + 3 * D });
    expect(decomposeRange(d, d + 2 * D, 5)).toEqual([{ table: 'fp_1m', from: d, to: d + 2 * D }]);
  });

  it('Tagesprofile mit Offset nie aus 1d-Tabellen; Offset 0 aus 1d', () => {
    const d = 20_727 * D;
    expect(decomposeDays(d, d + 3 * D, 100)).toEqual([
      { table: 'fp_1d_b100', from: d, to: d + 3 * D },
    ]);
    const off = -7 * H;
    expect(decomposeDays(d + off, d + 3 * D + off, 100)).toEqual([
      { table: 'fp_1h_b100', from: d + off, to: d + 3 * D + off },
    ]);
    expect(decomposeDays(d, d + D, 10)).toEqual([{ table: 'fp_1h_b10', from: d, to: d + D }]);
  });

  it('Bar-Teilbereiche folgen dem Zeitraster', () => {
    const d = 20_727 * D;
    const segs = decomposeRange(d + 30 * M, d + 2 * D, 100);
    expect(barSegmentsFor(segs)).toEqual([
      { table: 'bar_1m', from: d + 30 * M, to: d + H },
      { table: 'bar_1h', from: d + H, to: d + D },
      { table: 'bar_1d', from: d + D, to: d + 2 * D },
    ]);
  });
});

describe('estimateRows', () => {
  it('Σ Zeilen je Tag × überdeckter Anteil; Tage ohne Daten zählen 0', () => {
    const rows = (t: string, day: number) =>
      t === 'fp_1m' ? (day === 10 ? 864_000 : undefined) : 0;
    expect(estimateRows('fp_1m', 10 * D, 11 * D, rows)).toBe(864_000);
    expect(estimateRows('fp_1m', 10 * D + 12 * H, 12 * D, rows)).toBe(432_000);
    expect(estimateRows('fp_1m', 10 * D, 10 * D + M, rows)).toBe(600);
    expect(estimateRows('fp_1m', 11 * D, 20 * D, rows)).toBe(0);
  });
});

/** Statistik eines Tages für computeTiles: maxRows je tf aus einer festen Spanne in Ticks. */
function stats(spanTicksByTf: Record<string, number>, rows: Record<string, number>) {
  const maxRows = new Map<string, Int32Array>();
  for (const tf of TIMEFRAME_LIST) {
    const span = spanTicksByTf[tf] ?? 1000;
    maxRows.set(tf, Int32Array.from(TILE_LADDER.map((R) => Math.floor(span / R) + 1)));
  }
  return { version: 1, maxRows, rows: new Map(Object.entries(rows)) } as never;
}

describe('computeTiles (TILE-FORMAT.md Kachellänge)', () => {
  const rows = { ...NOMINAL, bar_1m: 1440, bar_1h: 24, bar_1d: 1 };
  it('n = clamp(2^floor(log2(30000/ceil(1,5·max))), 32, 1024), angeboten nur bei 32·m ≤ 60000', () => {
    const s = {
      tickRefUnits: 10,
      tickUnits: 10,
      stats: new Map([[1, stats({ '1m': 999 }, rows)]]),
    };
    const { tiles } = computeTiles(s, 1_500_000);
    // R = 1: max 1000 Zeilen → m = 1500 → 32·1500 = 48 000 ≤ 60 000 → n = 32 (aus fp_1m: 650k/Tag·32 min ok)
    expect(tiles['1m']!['1']).toBe(32);
    // R = 10: max 100 → m = 150 → 30000/150 = 200 → n = 128
    expect(tiles['1m']!['10']).toBe(128);
    // R = 1000: max 1 → m = 2 → 15000 → 1024
    expect(tiles['1m']!['1000']).toBe(1024);
    // größere Spanne: R = 1 nicht mehr angeboten
    const s2 = { ...s, stats: new Map([[1, stats({ '1m': 1300 }, rows)]]) };
    expect(computeTiles(s2, 1_500_000).tiles['1m']!['1']).toBeUndefined();
  });

  it('nicht angeboten, wenn eine Kachel die Quellzeilengrenze reißen kann', () => {
    // 1d mit R = 5 → Quelle fp_1m; 32 Tage × 650 k Zeilen ≫ 1,5 Mio.
    const s = {
      tickRefUnits: 10,
      tickUnits: 10,
      stats: new Map([[1, stats({ '1d': 3000 }, rows)]]),
    };
    const { tiles, src } = computeTiles(s, 1_500_000);
    expect(tiles['1d']?.['5']).toBeUndefined();
    expect(tiles['1d']?.['100']).toBeDefined();
    expect(src.get('1d|100')).toBe('fp_1d_b100');
  });

  it('R unter dem aktuellen Tick wird nicht angeboten', () => {
    const s = { tickRefUnits: 10, tickUnits: 100, stats: new Map([[1, stats({}, rows)]]) };
    const { tiles } = computeTiles(s, 1_500_000);
    for (const m of Object.values(tiles)) {
      expect(m['1']).toBeUndefined();
      expect(m['5']).toBeUndefined();
    }
    expect(tiles['1m']!['10']).toBeDefined();
  });

  it('tileConfigVersion: deterministisch, sichere Ganzzahl, ändert sich mit jedem n', () => {
    const a = { '1m': { '10': 32, '20': 64 } };
    const b = { '1m': { '20': 64, '10': 32 } };
    expect(configVersion(a)).toBe(configVersion(b));
    expect(Number.isSafeInteger(configVersion(a))).toBe(true);
    expect(configVersion(a)).toBeGreaterThan(0);
    expect(configVersion({ '1m': { '10': 32, '20': 128 } })).not.toBe(configVersion(a));
    expect(configVersion({ '1m': { '10': 32 } })).not.toBe(configVersion(a));
  });

  it('runs: zusammenhängende Läufe mit Höchstlänge', () => {
    expect(runs([1, 2, 3, 5, 6, 9], 31)).toEqual([
      [1, 3],
      [5, 6],
      [9, 9],
    ]);
    expect(runs([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

describe('versionOf', () => {
  const days = new Map([
    [1, { day: 1, version: 2, immutable: true }],
    [2, { day: 2, version: 5, immutable: true }],
    [3, { day: 3, version: 1, immutable: false }],
  ]);
  it('final nur, wenn jeder Tag existiert und immutable ist; Version ändert sich mit jedem Tag', () => {
    const v12 = versionOf(['x'], 1, 2, (d) => days.get(d));
    expect(v12.final).toBe(true);
    expect(versionOf(['x'], 1, 3, (d) => days.get(d)).final).toBe(false);
    expect(versionOf(['x'], 1, 4, (d) => days.get(d)).final).toBe(false);
    const bumped = new Map(days);
    bumped.set(2, { day: 2, version: 6, immutable: true });
    expect(versionOf(['x'], 1, 2, (d) => bumped.get(d)).dataVersion).not.toBe(v12.dataVersion);
    expect(versionOf(['y'], 1, 2, (d) => days.get(d)).dataVersion).not.toBe(v12.dataVersion);
    expect(versionOf(['x'], 1, 2, (d) => days.get(d)).dataVersion).toBe(v12.dataVersion);
    expect(v12.dataVersion).toMatch(/^[A-Za-z0-9_-]{27}$/);
  });
});

describe('ResponseCache', () => {
  it('LRU mit Byte-Grenze; Riesenantworten werden nicht gecacht', () => {
    const c = new ResponseCache(10_000);
    const e = (n: number) => ({
      body: Buffer.alloc(n),
      gzip: null,
      type: 'x',
      etag: 'e',
      final: true,
    });
    for (const k of ['a', 'b', 'c']) c.set(k, e(2300));
    expect(c.get('a')).toBeDefined(); // a ist jetzt am frischesten
    c.set('d', e(2300));
    expect(c.get('b')).toBeDefined(); // noch Platz (4 · 2428 B)
    c.set('e', e(2300)); // verdrängt den ältesten: c
    expect(c.get('c')).toBeUndefined();
    expect(c.get('a')).toBeDefined();
    expect(c.stats().bytes).toBeLessThanOrEqual(10_000);
    c.set('huge', e(5000));
    expect(c.get('huge')).toBeUndefined();
  });
});

describe('Limiter', () => {
  it('höchstens max gleichzeitig, Warteschlange begrenzt, Abbruch und Zeitüberschreitung', async () => {
    const l = new Limiter(2, 1, 50);
    const sig = new AbortController().signal;
    const r1 = await l.acquire(sig);
    const r2 = await l.acquire(sig);
    expect(l.running).toBe(2);
    const p3 = l.acquire(sig);
    await expect(l.acquire(sig)).rejects.toMatchObject({ status: 503 });
    r1();
    const r3 = await p3;
    expect(l.running).toBe(2);
    // Abbruch in der Warteschlange
    const ac = new AbortController();
    const p4 = l.acquire(ac.signal);
    ac.abort();
    await expect(p4).rejects.toBeInstanceOf(HttpError);
    expect(l.waiting).toBe(0);
    // Zeitüberschreitung
    await expect(l.acquire(sig)).rejects.toMatchObject({ status: 503 });
    r2();
    r3();
    expect(l.running).toBe(0);
  });
});
