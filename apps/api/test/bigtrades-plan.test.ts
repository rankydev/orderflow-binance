// Abdeckung und Schätzung von /bigtrades (rein): Gründe je Tag, Live-Bereich und Lückenminuten,
// Zusammenfassen, Ränder, final, Stufenstatistik als obere Schranke.
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
const HOUR = 3_600_000;
const MIN = 60_000;
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
  it('Tagesebene: fasst gleiche Tage zusammen, schneidet an from/to ab, liest nur Tage mit Daten', () => {
    const from = 10 * DAY + HOUR;
    const to = 15 * DAY + 2 * HOUR;
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

  it('final nur, wenn alles ok und unveränderlich ist (nicht bei none, partial, Lückenminuten)', () => {
    expect(coveragePlan(10 * DAY, 12 * DAY, FLOOR, (d) => days.get(d)).final).toBe(true);
    // partial: ein Neuimport mit anderer Untergrenze ändert die Antwort
    expect(coveragePlan(13 * DAY, 14 * DAY, FLOOR, (d) => days.get(d)).final).toBe(false);
    expect(coveragePlan(13 * DAY, 14 * DAY, 2 * FLOOR, (d) => days.get(d)).final).toBe(true);
    // v1-Tag ist unveränderlich, aber ohne Order-Daten: die Antwort wird sich mit dem Neuimport ändern
    expect(coveragePlan(10 * DAY, 13 * DAY, FLOOR, (d) => days.get(d)).final).toBe(false);
    // Lückenminuten am Tag (Katalog kennt nur die Zahl): nie final, auch außerhalb des Ausschnitts
    expect(coveragePlan(10 * DAY, 10 * DAY + HOUR, FLOOR, () => ({ ...ok, holes: 2 })).final).toBe(
      false,
    );
  });

  it('Live-Tag: vor der Aufzeichnung not_recorded, nach live_until pending (auch Zukunft), gap-Minuten', () => {
    const live: OrderDay = {
      ...ok,
      immutable: false,
      digestVersion: null,
      live: { recordedFrom: 20 * DAY + 10 * HOUR + MIN, recordedTo: 20 * DAY + 15 * HOUR },
    };
    const holes = [
      { ts: 20 * DAY + 12 * HOUR, reason: 'gap' as const },
      { ts: 20 * DAY + 12 * HOUR + MIN, reason: 'gap' as const },
      { ts: 20 * DAY + 13 * HOUR, reason: 'gap' as const },
      { ts: 20 * DAY + 16 * HOUR, reason: 'gap' as const }, // nach live_until: bleibt pending
    ];
    const from = 20 * DAY;
    const to = 22 * DAY; // reicht in die Zukunft (Tag 21 ohne Zeile)
    const p = coveragePlan(from, to, FLOOR, (d) => (d === 20 ? live : undefined), holes);
    const n = (a: number, b: number, reason: string, final = false) => ({
      from: a,
      to: b,
      status: 'none',
      reason,
      floorN: null,
      final,
    });
    const o = (a: number, b: number) => ({
      from: a,
      to: b,
      status: 'ok',
      reason: null,
      floorN: FLOOR,
      final: false,
    });
    const at = (h: number, m = 0) => 20 * DAY + h * HOUR + m * MIN;
    expect(p.spans).toEqual([
      n(from, at(10, 1), 'not_recorded'),
      o(at(10, 1), at(12)),
      n(at(12), at(12, 2), 'gap'),
      o(at(12, 2), at(13)),
      n(at(13), at(13, 1), 'gap'),
      o(at(13, 1), at(15)),
      n(at(15), 21 * DAY, 'pending'),
      n(21 * DAY, to, 'no_day'),
    ]);
    expect(p.ranges).toEqual([
      { from: at(10, 1), to: at(12) },
      { from: at(12, 2), to: at(13) },
      { from: at(13, 1), to: at(15) },
    ]);
    // nichts aufgezeichnet (live_until NULL): ganzer Tag pending
    const empty = coveragePlan(from, from + DAY, FLOOR, () => ({
      ...live,
      live: { recordedFrom: from, recordedTo: from },
    }));
    expect(empty.spans).toEqual([n(from, from + DAY, 'pending')]);
    expect(empty.ranges).toEqual([]);
  });

  it('final_bad-Tag mit missing-Minuten: source_missing, Rest ok, nicht final', () => {
    const p = coveragePlan(5 * DAY, 6 * DAY, FLOOR, () => ({ ...ok, holes: 1 }), [
      { ts: 5 * DAY + 100 * MIN, reason: 'source_missing' },
    ]);
    expect(p.spans.map((x) => [x.from - 5 * DAY, x.to - 5 * DAY, x.status, x.reason])).toEqual([
      [0, 100 * MIN, 'ok', null],
      [100 * MIN, 101 * MIN, 'none', 'source_missing'],
      [101 * MIN, DAY, 'ok', null],
    ]);
    expect(p.final).toBe(false);
  });
});

describe('Stufenstatistik', () => {
  const idx = (u: number) => BIG_LADDER_USDT.indexOf(u);
  // Index i: [L[i−1], L[i]); Index 0 < 100 000 USDT
  const h = new Int32Array(BIG_LADDER_USDT.length + 1);
  h[idx(250_000) + 1] = 1000; // 250 000 … 280 000
  h[idx(500_000) + 1] = 400; // 500 000 … 550 000
  h[idx(1_000_000) + 1] = 100; // 1 … 1,1 Mio.
  h[BIG_LADDER_USDT.length] = 3; // ≥ 1 Mrd.
  it('Stufen: 22 je Dekade, benachbart höchstens Faktor 7/6, enthält die Untergrenzen', () => {
    expect(BIG_LADDER_USDT[0]).toBe(100_000);
    expect(BIG_LADDER_USDT.at(-1)).toBe(1_000_000_000);
    for (let i = 1; i < BIG_LADDER_USDT.length; i++) {
      const r = BIG_LADDER_USDT[i]! / BIG_LADDER_USDT[i - 1]!;
      expect(r).toBeGreaterThan(1);
      expect(r).toBeLessThanOrEqual(7 / 6 + 1e-9);
    }
    expect(BIG_LADDER_USDT).toEqual(expect.arrayContaining([250_000, 500_000, 1_000_000]));
  });
  it('exakt auf einer Stufe, sonst Schranke ab der Stufe darunter', () => {
    expect(matchedAtLeast(h, 500_000)).toBe(503);
    expect(matchedAtLeast(h, 540_000)).toBe(503); // ≥ tatsächlich (Intervall 500 000 … 550 000)
    expect(matchedAtLeast(h, 550_000)).toBe(103);
    // mit 1-2-5-Stufen zählte 999 999 alles ab 500 000; jetzt nur ab 900 000
    expect(matchedAtLeast(h, 999_999)).toBe(103);
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
