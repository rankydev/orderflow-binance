// Big-Trades-Format (docs/BIGTRADES-API.md): Rundtrip, Ablehnung ungültiger Inhalte und korrupter
// Eingaben, Abgrenzung zum Kachelformat (eigenes Magic).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BigTradesFormatError,
  decodeBigTrades,
  decodeTile,
  encodeBigTrades,
  TileFormatError,
  type BigTradeColumns,
  type BigTradesData,
  type CoverageSpan,
} from '../src/index.ts';

const DAY = 86_400_000;
const D0 = 20_700 * DAY;
const UNIT = 100_000; // BTC: 10^(2+3)
const MIN_USDT = 500_000;
const MIN_N = MIN_USDT * UNIT;

interface Row {
  ts: number;
  id: number;
  side: 1 | 2;
  pf: number;
  pl: number;
  qty: number;
  notional: number;
  aggN: number;
}

function columns(rows: Row[], tfSec: number): BigTradeColumns {
  const tfMs = tfSec * 1000;
  return {
    ts: Float64Array.from(rows, (r) => r.ts),
    bar: Int32Array.from(rows, (r) => (r.ts - (r.ts % tfMs)) / 1000),
    side: Int32Array.from(rows, (r) => r.side),
    pxFirst: Int32Array.from(rows, (r) => r.pf),
    pxLast: Int32Array.from(rows, (r) => r.pl),
    qty: Float64Array.from(rows, (r) => r.qty),
    notional: Float64Array.from(rows, (r) => r.notional),
    aggN: Int32Array.from(rows, (r) => r.aggN),
    firstAggId: Float64Array.from(rows, (r) => r.id),
  };
}

function data(
  rows: Row[],
  over: Partial<BigTradesData['meta']> = {},
  coverage?: CoverageSpan[],
): BigTradesData {
  const tfSec = over.tfSec ?? 3600;
  return {
    meta: {
      kind: 'bigtrades',
      sym: 'BTCUSDT',
      tf: '1h',
      tfSec,
      priceDecimals: 2,
      qtyDecimals: 3,
      tickRefUnits: 10,
      notionalDecimals: 5,
      from: D0,
      to: D0 + 2 * DAY,
      minUsdt: MIN_USDT,
      minN: MIN_N,
      maxRows: 20_000,
      total: rows.length,
      omitted: 0,
      k: null,
      coverage: coverage ?? [
        { from: D0, to: D0 + 2 * DAY, status: 'ok', reason: null, floorN: MIN_N, final: true },
      ],
      dataVersion: 'v',
      final: true,
      ...over,
    },
    rows: columns(rows, tfSec),
  };
}

const rowArb = fc.record({
  ts: fc.integer({ min: D0, max: D0 + 2 * DAY - 1 }),
  id: fc.integer({ min: 0, max: 2 ** 40 }),
  side: fc.constantFrom(1 as const, 2 as const),
  pf: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
  pl: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
  qty: fc.integer({ min: 1, max: 2 ** 40 }),
  notional: fc.integer({ min: MIN_N, max: 2 ** 53 - 1 }),
  aggN: fc.integer({ min: 1, max: 100_000 }),
});

const sorted = (rows: Row[]) => {
  const out = [...rows].sort((a, b) => a.ts - b.ts || a.id - b.id);
  return out.filter((r, i) => i === 0 || r.ts !== out[i - 1]!.ts || r.id !== out[i - 1]!.id);
};

describe('Big-Trades-Format', () => {
  it('Rundtrip: Header und Spalten unverändert, 8-Byte-ausgerichtet', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 60 }), fc.boolean(), (raw, final) => {
        const rows = sorted(raw);
        const d = data(rows, { final }, [
          { from: D0, to: D0 + DAY, status: 'ok', reason: null, floorN: MIN_N, final },
          { from: D0 + DAY, to: D0 + 2 * DAY, status: 'ok', reason: null, floorN: 1, final },
        ]);
        const u8 = encodeBigTrades(d);
        expect(u8.length % 8).toBe(0);
        const back = decodeBigTrades(u8);
        expect(back.meta).toEqual(d.meta);
        expect(back.header.n).toBe(rows.length);
        for (const k of Object.keys(d.rows) as (keyof BigTradeColumns)[])
          expect([...back.rows[k]]).toEqual([...d.rows[k]]);
      }),
      { numRuns: 200 },
    );
  });

  it('leere Antwort mit Bereichen ohne Daten ist gültig (none ≠ leer)', () => {
    const cov: CoverageSpan[] = [
      { from: D0, to: D0 + DAY, status: 'none', reason: 'digest_v1', floorN: null, final: true },
      {
        from: D0 + DAY,
        to: D0 + 2 * DAY,
        status: 'none',
        reason: 'no_day',
        floorN: null,
        final: false,
      },
    ];
    const back = decodeBigTrades(encodeBigTrades(data([], { final: false }, cov)));
    expect(back.meta.coverage).toEqual(cov);
    expect(back.header.n).toBe(0);
  });

  const r1: Row = {
    ts: D0 + 1000,
    id: 5,
    side: 1,
    pf: 9_000_000,
    pl: 9_000_100,
    qty: 60_000,
    notional: 540_003_000_000,
    aggN: 3,
  };
  const r2: Row = { ...r1, ts: D0 + DAY + 5, id: 9, side: 2 };

  const bad: [string, () => BigTradesData][] = [
    ['unsortiert', () => data([r2, r1])],
    ['doppelt (ts, id)', () => data([r1, r1])],
    ['unter minN', () => data([{ ...r1, notional: MIN_N - 1 }])],
    ['side 3', () => data([{ ...r1, side: 3 as 1 }])],
    ['qty 0', () => data([{ ...r1, qty: 0 }])],
    ['nicht ganzzahlig', () => data([{ ...r1, notional: MIN_N + 0.5 }])],
    ['ts außerhalb', () => data([{ ...r1, ts: D0 - 1 }])],
    [
      'Zeile in Bereich ohne Daten',
      () =>
        data([r1], { final: false }, [
          { from: D0, to: D0 + DAY, status: 'none', reason: 'no_day', floorN: null, final: false },
          {
            from: D0 + DAY,
            to: D0 + 2 * DAY,
            status: 'ok',
            reason: null,
            floorN: MIN_N,
            final: true,
          },
        ]),
    ],
    [
      'Zeile unter der Tagesuntergrenze (partial)',
      () =>
        data([r1], {}, [
          {
            from: D0,
            to: D0 + 2 * DAY,
            status: 'partial',
            reason: 'floor_above',
            floorN: r1.notional + 1,
            final: true,
          },
        ]),
    ],
    [
      'final trotz none',
      () =>
        data([], { final: true }, [
          {
            from: D0,
            to: D0 + 2 * DAY,
            status: 'none',
            reason: 'digest_v1',
            floorN: null,
            final: true,
          },
        ]),
    ],
    [
      'Abdeckung mit Lücke',
      () =>
        data([], {}, [
          { from: D0, to: D0 + DAY, status: 'ok', reason: null, floorN: MIN_N, final: true },
        ]),
    ],
    [
      'ok mit Untergrenze über minN',
      () =>
        data([], {}, [
          {
            from: D0,
            to: D0 + 2 * DAY,
            status: 'ok',
            reason: null,
            floorN: MIN_N + 1,
            final: true,
          },
        ]),
    ],
    ['total ≠ n + omitted', () => data([r1], { total: 5 })],
    ['omitted ohne k', () => data([r1], { total: 2, omitted: 1 })],
    ['minN ≠ minUsdt · 10^d', () => data([], { minN: MIN_N + 1 })],
    ['from nicht ausgerichtet', () => data([], { from: D0 + 1000 })],
    [
      'final trotz partial',
      () =>
        data([], { final: true }, [
          {
            from: D0,
            to: D0 + 2 * DAY,
            status: 'partial',
            reason: 'floor_above',
            floorN: MIN_N + 1,
            final: true,
          },
        ]),
    ],
    [
      'Abschnittsgrenze nicht an einer Minute',
      () =>
        data([], { final: false }, [
          { from: D0, to: D0 + 90_000, status: 'none', reason: 'gap', floorN: null, final: false },
          {
            from: D0 + 90_000,
            to: D0 + 2 * DAY,
            status: 'ok',
            reason: null,
            floorN: MIN_N,
            final: false,
          },
        ]),
    ],
    [
      'unbekannter Grund (Encoder streng)',
      () =>
        data([], { final: false }, [
          {
            from: D0,
            to: D0 + 2 * DAY,
            status: 'none',
            reason: 'future_x' as 'gap',
            floorN: null,
            final: false,
          },
        ]),
    ],
  ];
  for (const [name, mk] of bad)
    it(`Encoder lehnt ab: ${name}`, () => {
      expect(() => encodeBigTrades(mk())).toThrow(BigTradesFormatError);
    });

  it('bar muss zu ts passen (Decoder prüft auch fremde Eingaben)', () => {
    const d = data([r1, r2]);
    const u8 = encodeBigTrades(d);
    const back = decodeBigTrades(u8);
    back.rows.bar[0] = back.rows.bar[0]! + 3600; // Sicht auf u8
    expect(() => decodeBigTrades(u8)).toThrow(/bar passt nicht/);
  });

  it('Minutenabschnitte (Live, Lücken); Decoder nimmt künftige none-Gründe an', () => {
    const M = 60_000;
    const cov: CoverageSpan[] = [
      {
        from: D0,
        to: D0 + 600 * M,
        status: 'none',
        reason: 'not_recorded',
        floorN: null,
        final: false,
      },
      {
        from: D0 + 600 * M,
        to: D0 + 601 * M,
        status: 'none',
        reason: 'gap',
        floorN: null,
        final: false,
      },
      {
        from: D0 + 601 * M,
        to: D0 + 900 * M,
        status: 'ok',
        reason: null,
        floorN: MIN_N,
        final: false,
      },
      {
        from: D0 + 900 * M,
        to: D0 + 2 * DAY,
        status: 'none',
        reason: 'pending',
        floorN: null,
        final: false,
      },
    ];
    const row = { ...r1, ts: D0 + 700 * M };
    const u8 = encodeBigTrades(data([row], { final: false }, cov));
    expect(decodeBigTrades(u8).meta.coverage).toEqual(cov);
    // Zeile in einer gap-Minute: abgelehnt
    expect(() =>
      encodeBigTrades(data([{ ...row, ts: D0 + 600 * M + 5 }], { final: false }, cov)),
    ).toThrow(/ohne Order-Daten/);
    // künftiger Grund: Header-JSON gleich lang umschreiben, Decoder akzeptiert ihn als none
    const text = new TextDecoder().decode(u8);
    const i = text.indexOf('"pending"');
    const patched = u8.slice();
    patched.set(new TextEncoder().encode('"later1"  '.slice(0, 9)), i);
    const back = decodeBigTrades(patched);
    expect(back.meta.coverage[3]!.reason as string).toBe('later1');
  });

  it('korrupte Eingaben: Magic, Padding, Länge, Kachel-Decoder', () => {
    const u8 = encodeBigTrades(data([r1]));
    const m = u8.slice();
    m[0] = 0;
    expect(() => decodeBigTrades(m)).toThrow(/Magic/);
    expect(() => decodeBigTrades(u8.slice(0, u8.length - 8))).toThrow(BigTradesFormatError);
    const extra = new Uint8Array(u8.length + 8);
    extra.set(u8);
    expect(() => decodeBigTrades(extra)).toThrow(/nach der letzten Spalte/);
    // Spalte bar (i32, 1 Wert) hat 4 Padding-Bytes: eines ungleich 0
    const hlen = new DataView(u8.buffer).getUint32(4, true);
    const p = u8.slice();
    p[8 + hlen + 8 + 4] = 1;
    expect(() => decodeBigTrades(p)).toThrow(/Padding/);
    // eigenes Magic: ein Kachel-Decoder liest die Antwort nie als Kachel
    expect(() => decodeTile(u8)).toThrow(TileFormatError);
  });
});
