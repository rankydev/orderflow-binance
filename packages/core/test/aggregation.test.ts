// T3 Minutenzuordnung und T4 Rollup-Äquivalenz / Komposition (KONZEPT §3.3–§3.6, §4.10).
// Referenzen sind naive Brute-Force-Rechnungen direkt über die aggTrades.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  aggregateDay,
  computeBarRollups,
  computeFpRollups,
  dayIndex,
  FP_ROLLUPS,
  fpRows,
  minuteOfDay,
  minuteStart,
  rollupBars,
  rollupFp,
  rowPx,
  type AggTrade,
  type Bar,
} from '../src/index.ts';
import { DAY, DAY_START, tradesArb } from './gen.ts';

const TICK = 10;

/** Brute force: Level je (tf-Bucket, Zeile) direkt aus den Trades, sortiert. */
function refLevels(trades: AggTrade[], tfMin: number, width: number) {
  const m = new Map<
    string,
    { ts: number; px: number; buyQ: number; sellQ: number; buyA: number; sellA: number }
  >();
  for (const t of trades) {
    const ts = t.T - (t.T % (tfMin * 60_000));
    const px = Math.floor(t.px / width) * width;
    const k = `${ts}|${px}`;
    const e = m.get(k) ?? { ts, px, buyQ: 0, sellQ: 0, buyA: 0, sellA: 0 };
    if (t.m) {
      e.sellQ += t.q;
      e.sellA++;
    } else {
      e.buyQ += t.q;
      e.buyA++;
    }
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => a.ts - b.ts || a.px - b.px);
}

/** Brute force: Bar über alle Trades eines Buckets nach den Definitionen in §3.5. */
function refBars(trades: AggTrade[], tfMin: number): Bar[] {
  const groups = new Map<number, AggTrade[]>();
  for (const t of trades) {
    const ts = t.T - (t.T % (tfMin * 60_000));
    groups.set(ts, [...(groups.get(ts) ?? []), t]);
  }
  const out: Bar[] = [];
  for (const [ts, g] of [...groups].sort((a, b) => a[0] - b[0])) {
    const deltas = g.map((t) => (t.m ? -t.q : t.q));
    const cum: number[] = [];
    deltas.reduce((acc, d, i) => (cum[i] = acc + d), 0);
    const high = Math.max(...g.map((t) => t.px));
    const low = Math.min(...g.map((t) => t.px));
    const total = cum[cum.length - 1]!;
    const iLow = g.findIndex((t) => t.px === low);
    const iHigh = g.findIndex((t) => t.px === high);
    const before = (i: number) => (i === 0 ? 0 : cum[i - 1]!);
    out.push({
      ts,
      open: g[0]!.px,
      high,
      low,
      close: g[g.length - 1]!.px,
      buyQ: g.filter((t) => !t.m).reduce((a, t) => a + t.q, 0),
      sellQ: g.filter((t) => t.m).reduce((a, t) => a + t.q, 0),
      buyA: g.filter((t) => !t.m).length,
      sellA: g.filter((t) => t.m).length,
      notional: g.reduce((a, t) => a + BigInt(t.px) * BigInt(t.q), 0n),
      firstAggId: g[0]!.a,
      lastAggId: g[g.length - 1]!.a,
      firstTradeMs: g[0]!.T,
      lastTradeMs: g[g.length - 1]!.T,
      runMax: Math.max(...cum),
      runMin: Math.min(...cum),
      dFromLow: total - before(iLow),
      dFromHigh: total - before(iHigh),
    });
  }
  return out;
}

const trade = (a: number, T: number, px = 6_000_000, q = 1, m = false): AggTrade => ({
  a,
  px,
  q,
  f: a,
  l: a,
  T,
  m,
});

describe('T3 Minutenzuordnung', () => {
  it('Grenzen k·60000 − 1, k·60000, k·60000 + 1 und Tagesgrenze', () => {
    for (const k of [1, 2, 59, 60, 61, 1439]) {
      const b = DAY_START + k * 60_000;
      expect(minuteStart(b - 1)).toBe(b - 60_000);
      expect(minuteStart(b)).toBe(b);
      expect(minuteStart(b + 1)).toBe(b);
      expect(minuteOfDay(b - 1)).toBe(k - 1);
      expect(minuteOfDay(b)).toBe(k % 1440);
    }
    const nextDay = DAY_START + 86_400_000;
    expect(dayIndex(nextDay - 1)).toBe(DAY);
    expect(dayIndex(nextDay)).toBe(DAY + 1);
    expect(minuteOfDay(nextDay - 1)).toBe(1439);
    expect(minuteOfDay(nextDay)).toBe(0);
  });

  it('Aggregator legt Trades an der Grenze in die richtige Minute (kein Off-by-one)', () => {
    const b = DAY_START + 5 * 60_000;
    const agg = aggregateDay(DAY, [
      trade(1, b - 1, 6_000_000, 3),
      trade(2, b, 6_000_010, 5),
      trade(3, b + 1, 6_000_010, 7),
    ]);
    expect(agg.bars.map((x) => [x.ts, x.buyQ])).toEqual([
      [b - 60_000, 3],
      [b, 12],
    ]);
    expect(() => aggregateDay(DAY, [trade(1, DAY_START + 86_400_000)])).toThrow(/nicht im UTC-Tag/);
    expect(() => aggregateDay(DAY, [trade(1, DAY_START - 1)])).toThrow(/nicht im UTC-Tag/);
    expect(() => aggregateDay(DAY, [trade(1, b), trade(2, b - 1)])).toThrow(/zurück/);
  });

  it('Kandidatenregel: Mehrfach-Fill und T mod 60000 ≥ 59900', () => {
    const b = DAY_START + 60_000;
    const mk = (a: number, T: number, fills: number, m = false): AggTrade => ({
      a,
      px: 6_000_000,
      q: 10,
      f: a * 10,
      l: a * 10 + fills - 1,
      T,
      m,
    });
    const agg = aggregateDay(DAY, [
      mk(1, b - 101, 2), // 59 899: kein Kandidat
      mk(2, b - 100, 2), // 59 900: Kandidat
      mk(3, b - 1, 1), // Einzel-Fill: kein Kandidat
      mk(4, b - 1, 3, true), // Kandidat, Verkäufer: nur q
    ]);
    expect(agg.candQ[0]).toBe(20);
    expect(agg.candB[0]).toBe(10);
    expect(agg.candCount).toBe(2);
  });

  it('fp_1m = Brute-Force-Level; unabhängig von Permutationen innerhalb der Minute', () => {
    fc.assert(
      fc.property(tradesArb(), (trades) => {
        const agg = aggregateDay(DAY, trades);
        expect(fpRows(agg.fp1m)).toEqual(refLevels(trades, 1, 1));
        // Level-Summen hängen nicht von der Reihenfolge ab
        const shuffled = [...trades].reverse();
        expect(refLevels(shuffled, 1, 1)).toEqual(fpRows(agg.fp1m));
      }),
    );
  });
});

describe('T4 Rollups und Komposition', () => {
  it('bar_1m = Brute force (OHLC, Summen, Notional, Max/Min-Delta, COT)', () => {
    fc.assert(
      fc.property(tradesArb(), (trades) => {
        expect(aggregateDay(DAY, trades).bars).toEqual(refBars(trades, 1));
      }),
    );
  });

  it('hierarchische Footprint-Rollups = direkte Bildung aus fp_1m = Brute force aus Trades', () => {
    fc.assert(
      fc.property(tradesArb({ spanMin: 1440, maxTrades: 400 }), (trades) => {
        const agg = aggregateDay(DAY, trades);
        const all = computeFpRollups(agg.fp1m, TICK);
        for (const r of FP_ROLLUPS) {
          const direct = rollupFp(agg.fp1m, r.tfMin, r.bin * TICK);
          expect(fpRows(all[r.table]), r.table).toEqual(fpRows(direct));
          expect(fpRows(direct), r.table).toEqual(refLevels(trades, r.tfMin, r.bin * TICK));
        }
      }),
    );
  });

  it('Komposition Max/Min-Delta und COT: rollup(1m) = Brute force für 3m, 5m, 15m, 30m, 1h, 4h, 1d', () => {
    fc.assert(
      fc.property(tradesArb({ spanMin: 1440, maxTrades: 400 }), (trades) => {
        const m1 = aggregateDay(DAY, trades).bars;
        for (const tf of [3, 5, 15, 30, 60, 240, 1440]) {
          expect(rollupBars(m1, tf), `${tf}m`).toEqual(refBars(trades, tf));
        }
        // assoziativ: 1d aus 1h = 1d aus 1m
        const { bar_1h, bar_1d } = computeBarRollups(m1);
        expect(bar_1h).toEqual(refBars(trades, 60));
        expect(bar_1d).toEqual(refBars(trades, 1440));
      }),
    );
  });

  it('COT: erneutes Antesten des Extrems verschiebt den Startpunkt nicht', () => {
    const t0 = DAY_START;
    const tr = [
      trade(1, t0 + 1, 6_000_000, 5, false), // +5
      trade(2, t0 + 2, 5_999_990, 2, true), // Low gebildet: −2
      trade(3, t0 + 3, 6_000_010, 4, false), // +4
      trade(4, t0 + 4, 5_999_990, 1, true), // Low erneut: −1
      trade(5, t0 + 5, 6_000_000, 3, false), // +3
    ];
    const [b] = aggregateDay(DAY, tr).bars;
    expect(b!.dFromLow).toBe(-2 + 4 - 1 + 3);
    expect(b!.dFromHigh).toBe(4 - 1 + 3);
    expect(b!.runMax).toBe(9);
    expect(b!.runMin).toBe(3);
  });

  it('rowPx im Rollup ist Ganzzahl-Rest (keine Gleitkommadivision)', () => {
    expect(rowPx(6_195_929, 100)).toBe(6_195_900);
    expect(rowPx(6_195_900, 100)).toBe(6_195_900);
  });
});
