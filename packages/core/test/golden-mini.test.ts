// T7 Mini-Golden (KONZEPT §4.10): handgerechnete aggTrades mit Grenzfällen (T = k·60000,
// k·60000 − 1, k·60000 + 1, Kandidat genau bei 59 900 ms, erneutes Antesten von High/Low,
// Minute ohne Trades). Alle Erwartungswerte sind von Hand gerechnet (Kommentare).
import { describe, expect, it } from 'vitest';
import {
  aggregateDay,
  computeBarRollups,
  computeFpRollups,
  detectHeader,
  fpRows,
  getSymbol,
  parseAggTradeLine,
  parseDay,
} from '../src/index.ts';

const BTC = getSymbol('BTCUSDT');
const D = parseDay('2026-11-20');
const T0 = 1795132800000; // 2026-11-20 00:00:00 UTC

const CSV = `agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker
1,100.0,0.005,1,1,1795132800000,false
2,100.1,0.002,2,3,1795132800500,true
3,99.9,0.010,4,4,1795132810000,true
4,100.2,0.003,5,5,1795132820000,false
5,99.9,0.001,6,6,1795132830000,false
6,100.20,0.004,7,9,1795132859900,false
7,100.0,0.002,10,10,1795132859999,true
8,100.0,0.007,11,12,1795132860000,true
9,100.3,0.001,13,13,1795132860001,false
10,100.3,0.002,14,14,1795132900000,false
11,101.0,0.100,15,20,1795133039950,true`;

function parseCsv(text: string) {
  const lines = text.split('\n');
  const start = detectHeader(lines[0]!, 'aggTrades') ? 1 : 0;
  return lines.slice(start).map((l) => parseAggTradeLine(l, BTC));
}

describe('Mini-Golden BTCUSDT (handgerechnet)', () => {
  const trades = parseCsv(CSV);
  const agg = aggregateDay(D, trades);

  it('mit und ohne Kopfzeile identisch', () => {
    const noHeader = CSV.split('\n').slice(1).join('\n');
    expect(aggregateDay(D, parseCsv(noHeader))).toEqual(agg);
  });

  it('fp_1m: Level je Minute und Preis', () => {
    expect(fpRows(agg.fp1m)).toEqual([
      // Minute 0: 99.9 → a5 buy 1, a3 sell 10; 100.0 → a1 buy 5, a7 sell 2; 100.1 → a2 sell 2; 100.2 → a4+a6 buy 7
      { ts: T0, px: 9990, buyQ: 1, sellQ: 10, buyA: 1, sellA: 1 },
      { ts: T0, px: 10000, buyQ: 5, sellQ: 2, buyA: 1, sellA: 1 },
      { ts: T0, px: 10010, buyQ: 0, sellQ: 2, buyA: 0, sellA: 1 },
      { ts: T0, px: 10020, buyQ: 7, sellQ: 0, buyA: 2, sellA: 0 },
      // Minute 1 (a8 bei T = k·60000 gehört in Minute 1, a7 bei k·60000 − 1 in Minute 0)
      { ts: T0 + 60_000, px: 10000, buyQ: 0, sellQ: 7, buyA: 0, sellA: 1 },
      { ts: T0 + 60_000, px: 10030, buyQ: 3, sellQ: 0, buyA: 2, sellA: 0 },
      // Minute 2 ohne Trades: keine Zeile; Minute 3
      { ts: T0 + 180_000, px: 10100, buyQ: 0, sellQ: 100, buyA: 0, sellA: 1 },
    ]);
  });

  it('bar_1m: OHLC, Notional, Max/Min-Delta, COT', () => {
    const [m0, m1, m3] = agg.bars;
    expect(agg.bars).toHaveLength(3);
    // Minute 0: Deltas +5 −2 −10 +3 +1 +4 −2 → kumuliert 5 3 −7 −4 −3 1 −1
    expect(m0).toEqual({
      ts: T0,
      open: 10000,
      high: 10020,
      low: 9990,
      close: 10000,
      buyQ: 13,
      sellQ: 14,
      buyA: 4,
      sellA: 3,
      notional: 270050n, // 50000+20020+99900+30060+9990+40080+20000
      firstAggId: 1,
      lastAggId: 7,
      firstTradeMs: T0,
      lastTradeMs: T0 + 59_999,
      runMax: 5,
      runMin: -7,
      dFromLow: -4, // ab a3 (erstes 99.9; a5 testet nur erneut): −1 − 3
      dFromHigh: 6, // ab a4 (erstes 100.2; a6 testet erneut): −1 − (−7)
    });
    // Minute 1: −7 +1 +2 → −7 −6 −4
    expect(m1).toMatchObject({
      open: 10000,
      high: 10030,
      low: 10000,
      close: 10030,
      runMax: -4,
      runMin: -7,
      dFromLow: -4,
      dFromHigh: 3,
      notional: 100090n,
    });
    expect(m3).toMatchObject({ runMax: -100, runMin: -100, dFromLow: -100, dFromHigh: -100 });
  });

  it('Kandidaten: a6 (T mod 60000 = 59900, 3 Fills, Käufer) und a11 (Verkäufer)', () => {
    expect(agg.candQ[0]).toBe(4);
    expect(agg.candB[0]).toBe(4);
    expect(agg.candQ[1]).toBe(0); // a8: Mehrfach-Fill, aber T mod 60000 = 0
    expect(agg.candQ[3]).toBe(100);
    expect(agg.candB[3]).toBe(0);
    expect(agg.candCount).toBe(2);
    expect(agg.minStepUnits).toBe(10);
  });

  it('Rollups: fp_5m_b10 (Breite 100 price_unit) und bar_1h-Komposition', () => {
    const fp = computeFpRollups(agg.fp1m, BTC.tickRefUnits);
    expect(fpRows(fp.fp_5m_b10)).toEqual([
      { ts: T0, px: 9900, buyQ: 1, sellQ: 10, buyA: 1, sellA: 1 },
      { ts: T0, px: 10000, buyQ: 15, sellQ: 11, buyA: 5, sellA: 3 },
      { ts: T0, px: 10100, buyQ: 0, sellQ: 100, buyA: 0, sellA: 1 },
    ]);
    const { bar_1h, bar_1d } = computeBarRollups(agg.bars);
    // d: −1, −4, −100; P_{i−1}: 0, −1, −5
    const want = {
      ts: T0,
      open: 10000,
      high: 10100,
      low: 9990,
      close: 10100,
      buyQ: 16,
      sellQ: 121,
      runMax: 5, // max(0+5, −1−4, −5−100)
      runMin: -105, // min(0−7, −1−7, −5−100)
      dFromLow: -108, // erste Minute mit Low (0): −4 + (−4) + (−100)
      dFromHigh: -100, // erste Minute mit High (3): −100
      notional: 270050n + 100090n + 1010000n,
    };
    expect(bar_1h).toHaveLength(1);
    expect(bar_1h[0]).toMatchObject(want);
    expect(bar_1d[0]).toMatchObject(want);
  });
});
