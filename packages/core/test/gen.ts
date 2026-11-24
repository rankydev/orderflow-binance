// Generatoren für Property-Tests: zufällige aggTrade-Folgen eines Tages in aggId-Reihenfolge
// (T nicht fallend), mit Preisen auf dem 10er-Tickraster und gelegentlichen Wiederholungen.
import fc from 'fast-check';
import type { AggTrade } from '../src/index.ts';

export const DAY = 20_412; // 2025-11-19 als Tagesindex (beliebig)
export const DAY_START = DAY * 86_400_000;

export interface GenOpts {
  maxTrades?: number;
  /** Zeitraum in Minuten ab Tagesbeginn, über den die Trades verteilt werden. */
  spanMin?: number;
}

export function tradesArb(o: GenOpts = {}): fc.Arbitrary<AggTrade[]> {
  const span = (o.spanMin ?? 180) * 60_000;
  return fc
    .array(
      fc.record({
        dt: fc.oneof(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 120_000 })),
        dpx: fc.integer({ min: -30, max: 30 }),
        q: fc.oneof(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 1, max: 100_000 })),
        m: fc.boolean(),
        fills: fc.integer({ min: 1, max: 4 }),
      }),
      { minLength: 1, maxLength: o.maxTrades ?? 300 },
    )
    .map((rows) => {
      let T = DAY_START + 59_990; // nahe der ersten Minutengrenze beginnen
      let px = 6_000_000;
      let a = 1000;
      let tid = 5000;
      const out: AggTrade[] = [];
      for (const r of rows) {
        T = Math.min(DAY_START + span - 1, T + r.dt);
        px = Math.max(10, px + r.dpx * 10);
        out.push({ a: a++, px, q: r.q, f: tid, l: tid + r.fills - 1, T, m: r.m });
        tid += r.fills;
      }
      return out;
    });
}
