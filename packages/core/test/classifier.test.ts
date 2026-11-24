// T5 Klassifikator (KONZEPT §4.6, §4.10): synthetische Tage aus Einzelfills (Kline = Fills nach
// eigener Zeit, wie Binance; wir = aggTrade nach T). Erwartung aus der wahren Verschiebung s(m):
// exact genau dann, wenn s(m) = s(m−1) = 0 (für q und b), sonst shift; nie mismatch/missing.
// Dazu: eingebauter Off-by-one → mismatch; Tagesrand-Fälle; Begrenzung nach mismatch.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_FROM_MS,
  inferCarryIn,
  MinuteClass,
  reconcileDay,
  type ReconcileInput,
} from '../src/index.ts';

const N = 1440;
const MIN = 60_000;

interface SynTrade {
  T: number; // ms ab Tagesbeginn (darf für Fills über 86 400 000 hinausreichen)
  q: number;
  m: boolean;
  /** Fills: [Offset ms ab T, Menge] */
  fills: [number, number][];
}

/** Ein Tag mit mindestens einem Trade je Minute in [0, minutes), Straddler bevorzugt nahe Grenzen. */
function dayArb(minutes = N): fc.Arbitrary<SynTrade[]> {
  const tradeInMinute = (minute: number) =>
    fc
      .record({
        off: fc.oneof(
          fc.integer({ min: 0, max: 59_999 }),
          fc.integer({ min: 59_850, max: 59_999 }),
        ),
        fills: fc.array(
          fc.tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 1, max: 40 })),
          {
            minLength: 1,
            maxLength: 4,
          },
        ),
        m: fc.boolean(),
      })
      .map(({ off, fills, m }) => {
        const offs = fills.map((f) => f[0]).sort((a, b) => a - b);
        offs[0] = 0; // T = Zeit des ersten Fills
        const fl: [number, number][] = offs.map((o, i) => [o, fills[i]![1]]);
        return { T: minute * MIN + off, q: fl.reduce((a, f) => a + f[1], 0), m, fills: fl };
      });
  return fc
    .tuple(
      ...Array.from({ length: minutes }, (_, i) =>
        fc.array(tradeInMinute(i), { minLength: 1, maxLength: 3 }),
      ),
    )
    .map((perMin) => perMin.flat().sort((a, b) => a.T - b.T));
}

interface Built {
  inp: ReconcileInput;
  /** wahre Verschiebung s(m) von m nach m+1 (aus den Fills) */
  sQ: number[];
  sB: number[];
  carryOut: { q: number; b: number };
}

function build(
  trades: SynTrade[],
  carryIn = { q: 0, b: 0 },
  mutateOurs?: (ourQ: Float64Array, ourB: Float64Array) => void,
): Built {
  const inp: ReconcileInput = {
    ourQ: new Float64Array(N),
    ourB: new Float64Array(N),
    hasRow: new Uint8Array(N),
    klQ: new Float64Array(N),
    klB: new Float64Array(N),
    hasKline: new Uint8Array(N).fill(1),
    candQ: new Float64Array(N),
    candB: new Float64Array(N),
  };
  const sQ = new Array<number>(N).fill(0);
  const sB = new Array<number>(N).fill(0);
  inp.klQ[0] = carryIn.q;
  inp.klB[0] = carryIn.b;
  let outQ = 0;
  let outB = 0;
  for (const t of trades) {
    const m = Math.floor(t.T / MIN);
    inp.ourQ[m]! += t.q;
    inp.hasRow[m] = 1;
    if (!t.m) inp.ourB[m]! += t.q;
    if (t.fills.length > 1 && t.T % MIN >= CANDIDATE_FROM_MS) {
      inp.candQ[m]! += t.q;
      if (!t.m) inp.candB[m]! += t.q;
    }
    for (const [o, q] of t.fills) {
      const fm = Math.floor((t.T + o) / MIN);
      if (fm >= N) {
        outQ += q;
        if (!t.m) outB += q;
      } else {
        inp.klQ[fm]! += q;
        if (!t.m) inp.klB[fm]! += q;
      }
      if (fm > m) {
        // nur in die Folgeminute (Spanne ≤ 100 ms)
        expect(fm).toBe(m + 1);
        sQ[m]! += q;
        if (!t.m) sB[m]! += q;
      }
    }
  }
  if (mutateOurs) mutateOurs(inp.ourQ, inp.ourB);
  return { inp, sQ, sB, carryOut: { q: outQ, b: outB } };
}

function expectedCls(b: Built, carryIn: { q: number; b: number }): number[] {
  return b.sQ.map((_, m) => {
    const pq = m === 0 ? carryIn.q : b.sQ[m - 1]!;
    const pb = m === 0 ? carryIn.b : b.sB[m - 1]!;
    return b.sQ[m] === 0 && b.sB[m] === 0 && pq === 0 && pb === 0
      ? MinuteClass.exact
      : MinuteClass.shift;
  });
}

describe('T5 Klassifikator', () => {
  it('synthetische Tage: Straddler-Minuten genau shift, Rest exact, kein mismatch; Tagessumme = s(1439) − s(−1)', () => {
    fc.assert(
      fc.property(
        dayArb(),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        (trades, cq, cb) => {
          const carryIn = { q: Math.max(cq, cb), b: Math.min(cq, cb) };
          const b = build(trades, carryIn);
          const r = reconcileDay(b.inp, {
            prev: { carry: carryIn, cand: { q: 10_000, b: 10_000 } },
            nextReconciled: true,
          });
          expect(Array.from(r.cls)).toEqual(expectedCls(b, carryIn));
          expect(Array.from(r.sQ)).toEqual(b.sQ);
          expect(Array.from(r.sB)).toEqual(b.sB);
          expect(r.counts.mismatch + r.counts.missing).toBe(0);
          expect(r.carryOut).toEqual(b.carryOut);
          expect(r.totals.ourQ - r.totals.klQ).toBe(r.carryOut.q - r.carryIn.q);
          expect(r.totals.identityQ && r.totals.identityB && r.totals.carryBoundsOk).toBe(true);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('s(−1) aus dem Tag geschätzt = wahrer Übertrag; Minute 0 bleibt edge_pending', () => {
    fc.assert(
      fc.property(dayArb(), fc.integer({ min: 0, max: 30 }), (trades, c) => {
        const carryIn = { q: c, b: c };
        const b = build(trades, carryIn);
        const r = reconcileDay(b.inp, { nextReconciled: true });
        expect(r.carryInKnown).toBe(false);
        expect(r.carryInInferred).toEqual(carryIn);
        expect(r.cls[0]).toBe(MinuteClass.edge_pending);
        expect(r.ownCls[0]).toBe(expectedCls(b, carryIn)[0]);
        expect(r.counts.mismatch).toBe(0);
      }),
      { numRuns: 25 },
    );
  });

  it('Minute 1439 bleibt edge_pending, solange der Folgetag nicht abgeglichen ist', () => {
    const b = build([{ T: 5, q: 1, m: false, fills: [[0, 1]] }]);
    const r = reconcileDay(b.inp, { prev: { carry: { q: 0, b: 0 }, cand: { q: 0, b: 0 } } });
    expect(r.cls[1439]).toBe(MinuteClass.edge_pending);
    expect(r.ownCls[1439]).toBe(MinuteClass.exact);
    expect(r.counts.edge_pending).toBe(1);
  });

  it('Off-by-one (T = k·60000 in die Vorminute) ohne deckenden Kandidaten → mismatch', () => {
    const trades: SynTrade[] = [];
    for (let m = 0; m < N; m++)
      trades.push({ T: m * MIN + 30_000, q: 5, m: false, fills: [[0, 5]] });
    trades.push({ T: 100 * MIN, q: 7, m: true, fills: [[0, 7]] }); // genau auf der Grenze
    trades.sort((a, b) => a.T - b.T);
    const ok = build(trades);
    const okR = reconcileDay(ok.inp, {
      prev: { carry: { q: 0, b: 0 }, cand: { q: 0, b: 0 } },
      nextReconciled: true,
    });
    expect(okR.counts.exact).toBe(N);
    const bug = build(trades, { q: 0, b: 0 }, (q) => {
      q[99]! += 7;
      q[100]! -= 7;
    });
    const r = reconcileDay(bug.inp, {
      prev: { carry: { q: 0, b: 0 }, cand: { q: 0, b: 0 } },
      nextReconciled: true,
    });
    expect(r.cls[99]).toBe(MinuteClass.mismatch);
    // Begrenzung auf [0, cand]: der Fehler zieht nicht durch alle Folgeminuten
    expect(r.counts.mismatch).toBeLessThanOrEqual(2);
    expect(r.cls[102]).toBe(MinuteClass.exact);
  });

  it('Menge in der falschen Richtung (wir später als die Kline) ist nie shift', () => {
    const trades: SynTrade[] = [];
    for (let m = 0; m < N; m++)
      trades.push({ T: m * MIN + 59_950, q: 10, m: false, fills: [[0, 10]] });
    // 8 Lots, die die Kline in Minute 10 hat, liegen bei uns in Minute 11 → D(10) = −8 ⇒ s(10) < 0
    const b = build(trades, { q: 0, b: 0 }, (q) => {
      q[10]! -= 8;
      q[11]! += 8;
    });
    const r = reconcileDay(b.inp, {
      prev: { carry: { q: 0, b: 0 }, cand: { q: 0, b: 0 } },
      nextReconciled: true,
    });
    expect(r.cls[10]).toBe(MinuteClass.mismatch);
    expect(r.cls[11]).toBe(MinuteClass.mismatch);
    expect(r.cls[12]).toBe(MinuteClass.exact);
  });

  it('Tagesrand über zwei Tage: Übertrag des Vortags löst Minute 0 auf; falscher Übertrag → mismatch', () => {
    // Tag 1: letzter aggTrade 23:59:59.939 mit zweitem Fill nach Mitternacht (wie BTCUSDT 2026-11-19/20)
    const day1: SynTrade[] = [];
    for (let m = 0; m < N; m++) day1.push({ T: m * MIN + 1000, q: 4, m: false, fills: [[0, 4]] });
    day1.push({
      T: 1439 * MIN + 59_939,
      q: 20,
      m: false,
      fills: [
        [0, 7],
        [64, 13],
      ],
    });
    const b1 = build(day1);
    const r1 = reconcileDay(b1.inp, { nextReconciled: true });
    expect(r1.carryOut).toEqual({ q: 13, b: 13 });
    expect(r1.ownCls[1439]).toBe(MinuteClass.shift);
    const day2: SynTrade[] = [];
    for (let m = 0; m < N; m++) day2.push({ T: m * MIN + 1000, q: 4, m: false, fills: [[0, 4]] });
    const b2 = build(day2, r1.carryOut);
    const good = reconcileDay(b2.inp, {
      prev: { carry: r1.carryOut, cand: r1.candLast },
      nextReconciled: true,
    });
    expect(good.dQ[0]).toBe(-13);
    expect(good.cls[0]).toBe(MinuteClass.shift);
    expect(good.counts.mismatch).toBe(0);
    const wrong = reconcileDay(b2.inp, {
      prev: { carry: { q: 0, b: 0 }, cand: r1.candLast },
      nextReconciled: true,
    });
    expect(wrong.cls[0]).toBe(MinuteClass.mismatch);
  });

  it('missing: Kline mit Volumen ohne eigene Zeile und umgekehrt', () => {
    const trades: SynTrade[] = [];
    for (let m = 0; m < N; m++)
      if (m !== 500) trades.push({ T: m * MIN + 10, q: 3, m: true, fills: [[0, 3]] });
    const b = build(trades);
    b.inp.klQ[500] = 9;
    const r = reconcileDay(b.inp, {
      prev: { carry: { q: 0, b: 0 }, cand: { q: 0, b: 0 } },
      nextReconciled: true,
    });
    expect(r.cls[500]).toBe(MinuteClass.missing);
    b.inp.klQ[500] = 0;
    b.inp.hasKline[700] = 0;
    const r2 = reconcileDay(b.inp, {
      prev: { carry: { q: 0, b: 0 }, cand: { q: 0, b: 0 } },
      nextReconciled: true,
    });
    expect(r2.cls[500]).toBe(MinuteClass.exact);
    expect(r2.cls[700]).toBe(MinuteClass.missing);
  });

  it('inferCarryIn: erste Minute ohne Kandidaten erzwingt s = 0', () => {
    const d = new Float64Array([-13, 5, -5, 0]);
    const c = new Float64Array([20, 6, 0, 0]);
    expect(inferCarryIn(d, c)).toBe(13);
  });
});
