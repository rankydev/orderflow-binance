// Live-Aggregation (KONZEPT §4.2): minutenweise Neuberechnung der betroffenen Buckets ergibt nach
// der letzten Minute genau die Tabellen des Tagesimports (gleiche Funktionen, gleiche Hierarchie).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  aggregateDay,
  computeBarRollups,
  computeFpRollups,
  FP_TABLES,
  fpRows,
  getSymbol,
  LiveDay,
  MINUTE_MS,
} from '../src/index.ts';
import { DAY, DAY_START, tradesArb } from './gen.ts';

const BTC = getSymbol('BTCUSDT');

describe('LiveDay', () => {
  it('minutenweise = Tagesimport (alle fp-Tabellen, bar_1m/1h/1d), auch bei Abschluss in Etappen', () => {
    fc.assert(
      fc.property(
        tradesArb({ spanMin: 1440, maxTrades: 400 }),
        fc.integer({ min: 1, max: 6 }),
        (trades, steps) => {
          const live = new LiveDay(BTC, DAY);
          let done = 0;
          const per = Math.ceil(trades.length / steps);
          for (let i = 0; i < trades.length; i++) {
            live.add(trades[i]!);
            if ((i + 1) % per === 0) {
              // nur Minuten vor der Minute des aktuellen Trades sind sicher abgeschlossen
              const m = (trades[i]!.T - DAY_START - (trades[i]!.T % MINUTE_MS)) / MINUTE_MS;
              done += live.complete(m).length;
            }
          }
          done += live.complete(1440).length;
          const imp = aggregateDay(DAY, trades);
          expect(done).toBe(imp.bars.length);
          const snap = live.snapshot();
          const fp = computeFpRollups(imp.fp1m, BTC.tickRefUnits);
          for (const t of FP_TABLES) expect(fpRows(snap.fp[t]), t).toEqual(fpRows(fp[t]));
          const { bar_1h, bar_1d } = computeBarRollups(imp.bars);
          expect(snap.bar_1m).toEqual(imp.bars);
          expect(snap.bar_1h).toEqual(bar_1h);
          expect(snap.bar_1d).toEqual(bar_1d);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('Delta einer Minute enthält genau die betroffenen Buckets; verspäteter Trade ist ein Fehler', () => {
    const live = new LiveDay(BTC, DAY);
    const t = (a: number, T: number) => ({ a, px: 6_000_000, q: 1, f: a, l: a, T, m: false });
    live.add(t(1, DAY_START + 61 * MINUTE_MS + 5));
    live.add(t(2, DAY_START + 62 * MINUTE_MS + 5));
    const [d] = live.complete(62);
    expect(d!.minute).toBe(61);
    const byTable = Object.fromEntries(
      d!.fp.map((b) => [b.table, [b.from - DAY_START, b.to - DAY_START]]),
    );
    expect(byTable.fp_1m).toEqual([61 * MINUTE_MS, 62 * MINUTE_MS]);
    expect(byTable.fp_5m_b10).toEqual([60 * MINUTE_MS, 65 * MINUTE_MS]);
    expect(byTable.fp_15m_b100).toEqual([60 * MINUTE_MS, 75 * MINUTE_MS]);
    expect(byTable.fp_1h_b100).toEqual([60 * MINUTE_MS, 120 * MINUTE_MS]);
    expect(byTable.fp_1d_b1000).toEqual([0, 1440 * MINUTE_MS]);
    expect(() => live.add(t(3, DAY_START + 61 * MINUTE_MS + 9))).toThrow();
  });
});
