// T12 Order-Merge (KONZEPT §3.7, §4.10): Order-Regel v1 im DayAggregator. Referenz ist eine naive
// Gruppierung direkt über die aggTrades; Eigenschaften: Partition der aggTrades (Σ Menge, Σ Notional,
// Anzahl aggTrades erhalten), keine Order über eine Minutengrenze, big orders = Referenz-Orders mit
// notional ≥ Untergrenze in Primärschlüssel-Reihenfolge, Live-Pfad = Import.
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  aggregateDay,
  bigOrderDigest,
  DayAggregator,
  getSymbol,
  initialBigFloorN,
  LiveDay,
  MINUTE_MS,
  orderDayDigest,
  pgTimestamptzMs,
  type AggTrade,
  type BigOrder,
} from '../src/index.ts';
import { DAY, DAY_START } from './gen.ts';

const BTC = getSymbol('BTCUSDT');
const DAY_END = DAY_START + 86_400_000;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Naive Referenz: Orders als Listen von aggTrades nach Regel v1. */
function refOrders(trades: readonly AggTrade[]): AggTrade[][] {
  const out: AggTrade[][] = [];
  for (const t of trades) {
    const cur = out[out.length - 1];
    const last = cur?.[cur.length - 1];
    if (cur && last && last.T === t.T && last.m === t.m && t.a === last.a + 1) cur.push(t);
    else out.push([t]);
  }
  return out;
}

function toBig(o: AggTrade[]): BigOrder {
  return {
    ts: o[0]!.T,
    firstAggId: o[0]!.a,
    lastAggId: o[o.length - 1]!.a,
    side: o[0]!.m ? 2 : 1,
    pxFirst: o[0]!.px,
    pxLast: o[o.length - 1]!.px,
    qty: o.reduce((x, t) => x + t.q, 0),
    notional: o.reduce((x, t) => x + t.px * t.q, 0),
    aggN: o.length,
  };
}

/**
 * aggTrades eines Tages mit vielen Order-Situationen: gleiches T (Läufe), Seitenwechsel bei
 * gleichem T, aggId-Löcher, T rückwärts innerhalb einer Minute (zulässig), Minutengrenzen.
 */
const ordersArb = fc
  .array(
    fc.record({
      dt: fc.oneof(
        { weight: 6, arbitrary: fc.constant(0) },
        { weight: 2, arbitrary: fc.integer({ min: 1, max: 5 }) },
        { weight: 1, arbitrary: fc.integer({ min: -40, max: -1 }) },
        { weight: 1, arbitrary: fc.integer({ min: 1, max: 90_000 }) },
      ),
      flip: fc.oneof({ weight: 4, arbitrary: fc.constant(false) }, fc.constant(true)),
      gap: fc.oneof({ weight: 8, arbitrary: fc.constant(0) }, fc.integer({ min: 1, max: 3 })),
      dpx: fc.integer({ min: -3, max: 3 }),
      q: fc.oneof(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 200_000 })),
    }),
    { minLength: 1, maxLength: 400 },
  )
  .map((rows) => {
    let T = DAY_START + 59_995;
    let m = false;
    let a = 7_000;
    let px = 6_000_000;
    const out: AggTrade[] = [];
    for (const r of rows) {
      const minStart = T - (T % MINUTE_MS);
      // rückwärts nur innerhalb der Minute (eine Minutengrenze zurück ist ein Fehler, §3.3)
      T = Math.min(DAY_END - 1, Math.max(minStart, T + r.dt));
      if (r.flip) m = !m;
      a += 1 + r.gap;
      px = Math.max(10, px + r.dpx * 10);
      out.push({ a, px, q: r.q, f: a * 3, l: a * 3 + 1, T, m });
    }
    return out;
  });

describe('Order-Regel v1 (DayAggregator)', () => {
  it('Property: Partition der aggTrades, Summen erhalten, keine Order über eine Minutengrenze', () => {
    fc.assert(
      fc.property(ordersArb, fc.integer({ min: 1, max: 3_000_000_000 }), (trades, floor) => {
        const agg = aggregateDay(DAY, trades, floor);
        const ref = refOrders(trades);
        expect(agg.ordersN).toBe(ref.length);
        const sumNtl = trades.reduce((x, t) => x + BigInt(t.px * t.q), 0n);
        expect(agg.ordersNotional).toBe(sumNtl);
        expect(agg.ordersNotional).toBe(agg.bars.reduce((x, b) => x + b.notional, 0n));
        // big orders = Referenz-Orders ≥ Untergrenze, nach (ts, first_agg_id)
        const want = ref
          .map(toBig)
          .filter((o) => o.notional >= floor)
          .sort((x, y) => x.ts - y.ts || x.firstAggId - y.firstAggId);
        expect(agg.bigOrders).toEqual(want);
        expect(agg.bigFloorN).toBe(floor);
        for (const o of agg.bigOrders) expect(o.aggN).toBe(o.lastAggId - o.firstAggId + 1);
        // Digest akzeptiert die Reihenfolge (wirft sonst)
        bigOrderDigest(BTC.symId, agg.bigOrders);
      }),
      { numRuns: 300 },
    );
  });

  it('Property: Untergrenze 1 speichert jede Order; Σ der big orders = Tagessummen', () => {
    fc.assert(
      fc.property(ordersArb, (trades) => {
        const agg = aggregateDay(DAY, trades, 1);
        expect(agg.bigOrders.length).toBe(agg.ordersN);
        expect(agg.bigOrders.reduce((x, o) => x + BigInt(o.notional), 0n)).toBe(agg.ordersNotional);
        expect(agg.bigOrders.reduce((x, o) => x + o.qty, 0)).toBe(
          agg.bars.reduce((x, b) => x + b.buyQ + b.sellQ, 0),
        );
        expect(agg.bigOrders.reduce((x, o) => x + o.aggN, 0)).toBe(trades.length);
        // Eigenschaften der vom Code gebildeten Orders gegen die Eingabe: Partition der aggIds,
        // je Order dasselbe T (also dieselbe Minute) und dieselbe Seite, IDs lückenlos
        const byId = new Map(trades.map((t) => [t.a, t]));
        const ids = agg.bigOrders
          .flatMap((o) => Array.from({ length: o.aggN }, (_, i) => o.firstAggId + i))
          .sort((x, y) => x - y);
        expect(ids).toEqual(trades.map((t) => t.a));
        for (const o of agg.bigOrders) {
          for (let a = o.firstAggId; a <= o.lastAggId; a++) {
            const t = byId.get(a)!;
            expect(t.T).toBe(o.ts);
            expect(t.m ? 2 : 1).toBe(o.side);
          }
          expect(byId.get(o.firstAggId)!.px).toBe(o.pxFirst);
          expect(byId.get(o.lastAggId)!.px).toBe(o.pxLast);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('Property: Live-Pfad (minutenweise) = Import für big orders und Ordersummen', () => {
    fc.assert(
      fc.property(ordersArb, fc.integer({ min: 1, max: 5 }), (trades, steps) => {
        const floor = 1_000_000;
        const live = new LiveDay(BTC, DAY, floor);
        const per = Math.ceil(trades.length / steps);
        const deltas = [];
        for (let i = 0; i < trades.length; i++) {
          live.add(trades[i]!);
          if ((i + 1) % per === 0) {
            const t = trades[i]!.T;
            deltas.push(...live.complete((t - DAY_START - (t % MINUTE_MS)) / MINUTE_MS));
          }
        }
        deltas.push(...live.complete(1440));
        const ref = aggregateDay(DAY, trades, floor);
        expect(deltas.flatMap((d) => d.big.rows)).toEqual(ref.bigOrders);
        for (const d of deltas) {
          for (const o of d.big.rows) expect(o.ts >= d.big.from && o.ts < d.big.to).toBe(true);
        }
        const last = deltas[deltas.length - 1]!;
        expect(last.orders).toEqual({
          n: ref.ordersN,
          notional: ref.ordersNotional,
          bigFloorN: floor,
        });
        // exakter Minutenschlüssel des Tages = Import-Bars
        const key = (bars: typeof ref.bars) =>
          bars
            .map((b) => `${b.ts},${b.firstAggId},${b.lastAggId},${b.buyA + b.sellA},${b.notional}`)
            .join('\n');
        expect(last.dayBarsKey()).toBe(key(ref.bars));
        for (const d of deltas) {
          expect(d.dayBarsKey()).toBe(key(ref.bars.filter((b) => b.ts < d.big.to)));
        }
        // ganzer Tag bis zur jeweiligen Minute (Ersatz nach einem Neustart)
        expect(last.bigDay()).toEqual(ref.bigOrders);
        for (const d of deltas) {
          expect(d.bigDay()).toEqual(ref.bigOrders.filter((o) => o.ts < d.big.to));
        }
        const snap = live.snapshot();
        expect(snap.bigOrders).toEqual(ref.bigOrders);
        expect(snap.orders).toEqual({ n: ref.ordersN, notional: ref.ordersNotional });
        // Tagessummen steigen monoton je Minute (absolut geschrieben, nie Merge)
        for (let i = 1; i < deltas.length; i++) {
          expect(deltas[i]!.orders.n).toBeGreaterThanOrEqual(deltas[i - 1]!.orders.n);
        }
      }),
      { numRuns: 150 },
    );
  });

  const tr = (a: number, T: number, m: boolean, px = 6_000_000, q = 10): AggTrade => ({
    a,
    px,
    q,
    f: a,
    l: a,
    T,
    m,
  });

  it('Randfälle: erster/letzter Trade des Tages, ID-Loch, gleiche ms andere Seite, gleiche ms nicht fortlaufend', () => {
    const t0 = DAY_START;
    const tl = DAY_END - 1;
    const trades = [
      tr(1, t0, false), // erster Trade des Tages, Order mit 2 aggTrades
      tr(2, t0, false, 6_000_010),
      tr(3, t0, true), // gleiche ms, andere Seite → neue Order
      tr(5, t0, true), // gleiche ms und Seite, aber ID-Loch → neue Order
      tr(6, t0 + 1000, false), // gleiche Seite wie 7, gleiche ms, dazwischen 7 andere Seite
      tr(7, t0 + 1000, true),
      tr(8, t0 + 1000, false), // nicht fortlaufend zur Order von 6 → neue Order
      tr(9, tl, true), // letzter ms des Tages, Order mit 3 aggTrades
      tr(10, tl, true, 5_999_990),
      tr(11, tl, true, 5_999_980, 7),
    ];
    const agg = aggregateDay(DAY, trades, 1);
    expect(agg.ordersN).toBe(7);
    expect(
      agg.bigOrders.map((o) => [o.ts - DAY_START, o.firstAggId, o.lastAggId, o.side, o.aggN]),
    ).toEqual([
      [0, 1, 2, 1, 2],
      [0, 3, 3, 2, 1],
      [0, 5, 5, 2, 1],
      [1000, 6, 6, 1, 1],
      [1000, 7, 7, 2, 1],
      [1000, 8, 8, 1, 1],
      [86_399_999, 9, 11, 2, 3],
    ]);
    const last = agg.bigOrders[6]!;
    expect([last.pxFirst, last.pxLast, last.qty]).toEqual([6_000_000, 5_999_980, 27]);
    expect(last.notional).toBe(6_000_000 * 10 + 5_999_990 * 10 + 5_999_980 * 7);
  });

  it('Untergrenze: notional = floor wird gespeichert, floor − 1 nicht; null = keine big orders', () => {
    const trades = [tr(1, DAY_START + 5, false, 1000, 3), tr(2, DAY_START + 5, false, 1000, 2)];
    expect(aggregateDay(DAY, trades, 5000).bigOrders).toHaveLength(1);
    expect(aggregateDay(DAY, trades, 5001).bigOrders).toHaveLength(0);
    const none = aggregateDay(DAY, trades, null);
    expect(none.bigOrders).toEqual([]);
    expect(none.bigFloorN).toBeNull();
    expect([none.ordersN, none.ordersNotional]).toEqual([1, 5000n]);
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new DayAggregator(DAY, bad)).toThrow(/big_floor_n/);
    }
  });

  it('T rückwärts innerhalb der Minute: big orders nach (ts, first_agg_id) sortiert', () => {
    const trades = [
      tr(1, DAY_START + 500, false),
      tr(2, DAY_START + 100, true),
      tr(3, DAY_START + 100, true),
    ];
    const agg = aggregateDay(DAY, trades, 1);
    expect(agg.bigOrders.map((o) => [o.ts - DAY_START, o.firstAggId, o.aggN])).toEqual([
      [100, 2, 2],
      [500, 1, 1],
    ]);
  });

  it('Live-Pfad: Minute ohne Folgetrade abgeschlossen schließt die offene Order', () => {
    const live = new LiveDay(BTC, DAY, 1);
    live.add(tr(1, DAY_START + 30_000, false));
    live.add(tr(2, DAY_START + 30_000, false));
    const [d] = live.complete(1);
    expect(d!.big.rows.map((o) => o.aggN)).toEqual([2]);
    expect(d!.orders.n).toBe(1);
    expect(() => live.add(tr(3, DAY_START + 30_000, false))).toThrow(/abgeschlossen/);
  });
});

describe('Digest-Textform big_order / order_day', () => {
  it('timestamptz mit Millisekunden wie Postgres (abschließende Nullen entfallen)', () => {
    expect(pgTimestamptzMs(1795132800000)).toBe('2026-11-20 00:00:00+00');
    expect(pgTimestamptzMs(1795132800120)).toBe('2026-11-20 00:00:00.12+00');
    expect(pgTimestamptzMs(1795132800007)).toBe('2026-11-20 00:00:00.007+00');
    expect(pgTimestamptzMs(1795132859999)).toBe('2026-11-20 00:00:59.999+00');
  });

  it('big_order-Zeilen und order_day (NULL-Untergrenze als leeres Feld)', () => {
    const o: BigOrder = {
      ts: 1795132800120,
      firstAggId: 10,
      lastAggId: 12,
      side: 2,
      pxFirst: 6195920,
      pxLast: 6195900,
      qty: 30,
      notional: 185876600,
      aggN: 3,
    };
    expect(bigOrderDigest(1, [o])).toBe(
      sha('(1,"2026-11-20 00:00:00.12+00",10,12,2,6195920,6195900,30,185876600,3)'),
    );
    expect(bigOrderDigest(1, [])).toBe(sha(''));
    expect(() => bigOrderDigest(1, [o, { ...o, ts: o.ts - 1 }])).toThrow(/sortiert/);
    const day = Math.floor(1795132800000 / 86_400_000);
    expect(orderDayDigest(1, day, { ordersN: 5, ordersNotional: 123n, bigFloorN: null })).toBe(
      sha('(1,2026-11-20,5,123,)'),
    );
    expect(
      orderDayDigest(1, day, { ordersN: 5, ordersNotional: 123n, bigFloorN: 50_000_000_000 }),
    ).toBe(sha('(1,2026-11-20,5,123,50000000000)'));
  });
});

describe('Untergrenze neuer Symbolzeilen', () => {
  it('BTCUSDT 500 000 USDT und ETHUSDT 250 000 USDT exakt in price_unit·qty_unit; unbekanntes Symbol wirft', () => {
    expect(initialBigFloorN(getSymbol('BTCUSDT'))).toBe(50_000_000_000);
    expect(initialBigFloorN(getSymbol('ETHUSDT'))).toBe(250_000_000_000);
    expect(() => getSymbol('XRPUSDT')).toThrow(/Unbekanntes Symbol/);
    expect(() => initialBigFloorN({ ...getSymbol('BTCUSDT'), bigFloorUsdt: 0 })).toThrow();
  });
});
