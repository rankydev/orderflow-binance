// Abdeckung und Schätzung von /bigtrades (rein): Gründe je Tag, Zusammenfassen, Ränder, final,
// Stufenstatistik als obere Schranke.
import { describe, expect, it } from 'vitest';
import {
  BIG_LADDER_USDT,
  coveragePlan,
  dayCoverage,
  estimateBig,
  matchedAtLeast,
  type OrderDay,
} from '../src/bigtrades-plan.ts';

const DAY = 86_400_000;
const FLOOR = 50_000_000_000;
const ok: OrderDay = {
  hasData: true,
  immutable: true,
  digestVersion: 2,
  ordersKnown: true,
  floorN: FLOOR,
};

describe('dayCoverage', () => {
  it('Gründe in fester Reihenfolge; Untergrenze über der Schwelle → partial', () => {
    expect(dayCoverage(undefined, FLOOR)).toEqual({
      status: 'none',
      reason: 'no_day',
      floorN: null,
      final: false,
    });
    expect(dayCoverage({ ...ok, hasData: false }, FLOOR).reason).toBe('no_day');
    // v1-Tag: auch mit (fälschlich) gesetzten Feldern nie als vorhanden
    expect(dayCoverage({ ...ok, digestVersion: 1 }, FLOOR)).toMatchObject({
      status: 'none',
      reason: 'digest_v1',
      final: true,
    });
    expect(dayCoverage({ ...ok, digestVersion: null, ordersKnown: false }, FLOOR).reason).toBe(
      'unknown_totals',
    );
    expect(dayCoverage({ ...ok, floorN: null }, FLOOR).reason).toBe('no_floor');
    expect(dayCoverage(ok, FLOOR)).toEqual({
      status: 'ok',
      reason: null,
      floorN: FLOOR,
      final: true,
    });
    expect(dayCoverage(ok, FLOOR - 1)).toEqual({
      status: 'partial',
      reason: 'floor_above',
      floorN: FLOOR,
      final: true,
    });
    // Live-Tag mit bekannten Summen (digest_version NULL): ok, nicht final
    expect(dayCoverage({ ...ok, digestVersion: null, immutable: false }, FLOOR)).toEqual({
      status: 'ok',
      reason: null,
      floorN: FLOOR,
      final: false,
    });
  });
});

describe('coveragePlan', () => {
  const days = new Map<number, OrderDay>([
    [10, ok],
    [11, ok],
    [12, { ...ok, digestVersion: 1 }],
    [13, { ...ok, floorN: 2 * FLOOR }],
    [15, { ...ok, immutable: false, digestVersion: null }],
  ]);
  it('fasst gleiche Tage zusammen, schneidet an from/to ab, liest nur Tage mit Daten', () => {
    const from = 10 * DAY + 3_600_000;
    const to = 15 * DAY + 7_200_000;
    const p = coveragePlan(from, to, FLOOR, (d) => days.get(d));
    expect(p.spans).toEqual([
      { from, to: 12 * DAY, status: 'ok', reason: null, floorN: FLOOR, final: true },
      {
        from: 12 * DAY,
        to: 13 * DAY,
        status: 'none',
        reason: 'digest_v1',
        floorN: null,
        final: true,
      },
      {
        from: 13 * DAY,
        to: 14 * DAY,
        status: 'partial',
        reason: 'floor_above',
        floorN: 2 * FLOOR,
        final: true,
      },
      {
        from: 14 * DAY,
        to: 15 * DAY,
        status: 'none',
        reason: 'no_day',
        floorN: null,
        final: false,
      },
      { from: 15 * DAY, to, status: 'ok', reason: null, floorN: FLOOR, final: false },
    ]);
    expect(p.ranges).toEqual([
      { from, to: 12 * DAY },
      { from: 13 * DAY, to: 14 * DAY },
      { from: 15 * DAY, to },
    ]);
    expect(p.final).toBe(false);
  });
  it('final nur, wenn alle Tage unveränderlich sind und Order-Daten haben', () => {
    expect(coveragePlan(10 * DAY, 12 * DAY, FLOOR, (d) => days.get(d)).final).toBe(true);
    expect(coveragePlan(13 * DAY, 14 * DAY, FLOOR, (d) => days.get(d)).final).toBe(true);
    // v1-Tag ist unveränderlich, aber ohne Order-Daten: die Antwort wird sich mit dem Neuimport ändern
    expect(coveragePlan(10 * DAY, 13 * DAY, FLOOR, (d) => days.get(d)).final).toBe(false);
  });
});

describe('Stufenstatistik', () => {
  // Index i: [L[i−1], L[i]); Index 0 < 100 000 USDT
  const h = new Int32Array(BIG_LADDER_USDT.length + 1);
  h[2] = 1000; // 200 000 … 500 000
  h[3] = 400; // 500 000 … 1 Mio.
  h[4] = 100; // 1 … 2 Mio.
  h[BIG_LADDER_USDT.length] = 3; // ≥ 1 Mrd.
  it('exakt auf einer Stufe, sonst Schranke ab der Stufe darunter', () => {
    expect(matchedAtLeast(h, 500_000)).toBe(503);
    expect(matchedAtLeast(h, 600_000)).toBe(503); // ≥ tatsächlich
    expect(matchedAtLeast(h, 1_000_000)).toBe(103);
    expect(matchedAtLeast(h, 250_000)).toBe(1503);
    expect(matchedAtLeast(h, 50_000)).toBe(1503);
    expect(matchedAtLeast(h, 1_000_000_000)).toBe(3);
  });
  it('estimateBig: Tagesanteile der gelesenen Bereiche', () => {
    const on = (d: number) => (d === 3 || d === 4 ? h : undefined);
    expect(estimateBig([{ from: 3 * DAY, to: 5 * DAY }], on, 500_000)).toEqual({
      scanned: 3006,
      matched: 1006,
    });
    expect(estimateBig([{ from: 3 * DAY + DAY / 2, to: 4 * DAY }], on, 1_000_000)).toEqual({
      scanned: 752,
      matched: 52,
    });
    expect(estimateBig([], on, 500_000)).toEqual({ scanned: 0, matched: 0 });
  });
});
