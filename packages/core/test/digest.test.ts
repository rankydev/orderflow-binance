// Digest-Textform (KONZEPT §4.8): muss exakt der Postgres-Zeilentextform ROW(...)::text bei
// timezone = UTC entsprechen (siehe Migration 0005); hier gegen handgeschriebene Erwartung.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  barDigest,
  combineDigests,
  DIGEST_TABLES,
  FpBuilder,
  fpDigest,
  klineDigest,
  pgTimestamptz,
  type Bar,
} from '../src/index.ts';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('Digest-Textform', () => {
  it('timestamptz wie Postgres (UTC, ISO)', () => {
    expect(pgTimestamptz(1795132800000)).toBe('2026-11-20 00:00:00+00');
    expect(pgTimestamptz(1795132860000)).toBe('2026-11-20 00:01:00+00');
    expect(() => pgTimestamptz(1795132800001)).toThrow();
  });

  it('fp-Zeilen: (sym,"ts",px,buy_q,sell_q,buy_a,sell_a) mit \\n, ohne abschließendes \\n', () => {
    const b = new FpBuilder();
    b.push(1795132800000, 6195920, 1516, 0, 1, 0);
    b.push(1795132800000, 6195930, 0, 2, 0, 1);
    const want =
      '(1,"2026-11-20 00:00:00+00",6195920,1516,0,1,0)\n(1,"2026-11-20 00:00:00+00",6195930,0,2,0,1)';
    expect(fpDigest(1, b.build())).toBe(sha(want));
    expect(fpDigest(1, new FpBuilder().build())).toBe(sha(''));
  });

  it('lehnt unsortierte Zeilen ab', () => {
    const b = new FpBuilder();
    b.push(1795132800000, 6195930, 1, 0, 1, 0);
    b.push(1795132800000, 6195920, 1, 0, 1, 0);
    expect(() => fpDigest(1, b.build())).toThrow(/sortiert/);
  });

  it('bar_1m mit source (ohne check_state), bar_1h ohne beide; negative Werte', () => {
    const bar: Bar = {
      ts: 1795132800000,
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      buyQ: 3,
      sellQ: 5,
      buyA: 1,
      sellA: 2,
      notional: 12345678901234567n,
      firstAggId: 1,
      lastAggId: 3,
      firstTradeMs: 1795132800001,
      lastTradeMs: 1795132859999,
      runMax: 3,
      runMin: -2,
      dFromLow: -1,
      dFromHigh: -2,
    };
    const cols = '10,12,9,11,3,5,1,2,12345678901234567,1,3,1795132800001,1795132859999,3,-2,-1,-2';
    expect(barDigest(2, [bar], 3)).toBe(sha(`(2,"2026-11-20 00:00:00+00",${cols},3)`));
    expect(barDigest(2, [bar])).toBe(sha(`(2,"2026-11-20 00:00:00+00",${cols})`));
  });

  it('kline_1m und kombinierter Tages-Digest', () => {
    const k = {
      openTime: 1795132800000,
      open: 1,
      high: 2,
      low: 1,
      close: 2,
      vol: 5,
      closeTime: 1795132859999,
      quoteVolN: 7,
      trades: 3,
      takerBuy: 4,
      takerBuyQuoteN: 6,
    };
    expect(klineDigest(1, [k])).toBe(sha('(1,"2026-11-20 00:00:00+00",1,2,1,2,5,4,3,7)'));
    const per = Object.fromEntries(DIGEST_TABLES.map((t) => [t, 'x'])) as Record<
      (typeof DIGEST_TABLES)[number],
      string
    >;
    expect(combineDigests(per)).toBe(sha(DIGEST_TABLES.map((t) => `${t}:x`).join('\n')));
  });
});
