// Kachelformat (KONZEPT §5.6, docs/TILE-FORMAT.md): Rundtrip, Größe, Ablehnung korrupter Eingaben,
// Aufbau aus Rollups (Footprint-Summen = Bars), Kachelgeometrie (§5.3) und Quellenwahl (§5.2).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  aggregateDay,
  buildBarsTile,
  buildFootprintTile,
  chooseFpSource,
  decodeTile,
  encodeTile,
  maxRowsPerBar,
  medianRowsPerBar,
  rollupBars,
  rollupFp,
  tileBarsFor,
  tileBarsForMax,
  tileBoundsSec,
  tileColumnBytes,
  tileIndexAt,
  TileFormatError,
  type TileData,
} from '../src/index.ts';
import { DAY, tradesArb } from './gen.ts';

const TICK = 10;

interface GenBar {
  rows: { buy: number; sell: number; buyA: number; sellA: number }[];
  rowLo: number;
  gap: number;
}

const barArb: fc.Arbitrary<GenBar> = fc.record({
  rowLo: fc.integer({ min: 1, max: 100_000 }),
  gap: fc.integer({ min: 1, max: 5 }),
  rows: fc.array(
    fc
      .record({
        buy: fc.integer({ min: 0, max: 2 ** 40 }),
        sell: fc.integer({ min: 0, max: 2 ** 40 }),
        buyA: fc.integer({ min: 0, max: 100_000 }),
        sellA: fc.integer({ min: 0, max: 100_000 }),
      })
      .filter((r) => r.buy + r.sell > 0),
    { minLength: 1, maxLength: 12 },
  ),
});

const tileArb = fc
  .record({
    R: fc.constantFrom(1, 2, 5, 10, 20, 50, 100, 1000),
    tfSec: fc.constantFrom(60, 300, 900, 3600),
    n: fc.constantFrom(32, 64, 256, 1024),
    index: fc.integer({ min: 0, max: 5_000 }),
    bars: fc.array(barArb, { maxLength: 24 }),
    sym: fc.constantFrom('BTCUSDT', 'ETHUSDT'),
    version: fc.string({ maxLength: 40 }),
    final: fc.boolean(),
  })
  .map(({ R, tfSec, n, index: idx, bars, sym, version, final }): TileData => {
    const width = R * TICK;
    const index = idx % Math.floor(2 ** 31 / (n * tfSec)); // Zeit als Int32-Sekunden

    const nb = Math.min(bars.length, n);
    const fromSec = index * n * tfSec;
    const time = new Int32Array(nb);
    const open = new Int32Array(nb);
    const high = new Int32Array(nb);
    const low = new Int32Array(nb);
    const close = new Int32Array(nb);
    const buyQ = new Float64Array(nb);
    const sellQ = new Float64Array(nb);
    const buyA = new Int32Array(nb);
    const sellA = new Int32Array(nb);
    const off = new Int32Array(nb + 1);
    const lv = {
      row: [] as number[],
      buy: [] as number[],
      sell: [] as number[],
      ba: [] as number[],
      sa: [] as number[],
    };
    // Zeiten mit Lücken (Minuten ohne Trades haben keinen Bar), innerhalb der Kachel
    let slot = -1;
    for (let i = 0; i < nb; i++) {
      const b = bars[i]!;
      slot = Math.min(slot + b.gap, n - (nb - i));
      time[i] = fromSec + slot * tfSec;
      off[i] = lv.row.length;
      let r = b.rowLo;
      for (const x of b.rows) {
        lv.row.push(r);
        lv.buy.push(x.buy);
        lv.sell.push(x.sell);
        lv.ba.push(x.buyA);
        lv.sa.push(x.sellA);
        buyQ[i]! += x.buy;
        sellQ[i]! += x.sell;
        buyA[i]! += x.buyA;
        sellA[i]! += x.sellA;
        r += 1 + (x.buyA % 3); // Lücken zwischen Zeilen erlaubt
      }
      const lastRow = lv.row[lv.row.length - 1]!;
      low[i] = b.rowLo * width + (width > 1 ? 1 : 0);
      high[i] = lastRow * width + width - 1;
      open[i] = low[i]!;
      close[i] = high[i]!;
    }
    off[nb] = lv.row.length;
    return {
      meta: {
        kind: 'footprint',
        sym,
        tf: `${tfSec / 60}m`,
        tfSec,
        R,
        priceDecimals: 2,
        qtyDecimals: 3,
        tickRefUnits: TICK,
        from: fromSec * 1000,
        to: (fromSec + n * tfSec) * 1000,
        tile: { index, n },
        dataVersion: version,
        final,
      },
      bars: { time, open, high, low, close, buyQ, sellQ, buyA, sellA },
      levels: {
        levelOffset: off,
        row: Int32Array.from(lv.row),
        buy: Float64Array.from(lv.buy),
        sell: Float64Array.from(lv.sell),
        buyA: Int32Array.from(lv.ba),
        sellA: Int32Array.from(lv.sa),
      },
    };
  });

function plain(t: TileData) {
  const arr = (o: Record<string, ArrayLike<number>>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.from(v)]));
  return {
    meta: t.meta,
    bars: arr(t.bars as unknown as Record<string, ArrayLike<number>>),
    levels: t.levels ? arr(t.levels as unknown as Record<string, ArrayLike<number>>) : undefined,
  };
}

describe('Kachel-Codec', () => {
  it('decode(encode(x)) = x (footprint)', () => {
    fc.assert(
      fc.property(tileArb, (t) => {
        const enc = encodeTile(t);
        const dec = decodeTile(enc);
        expect(plain(dec)).toEqual(plain(t));
        expect(dec.header.nBars).toBe(t.bars.time.length);
        expect(dec.header.nLevels).toBe(t.levels!.row.length);
      }),
      { numRuns: 300 },
    );
  });

  it('decode(encode(x)) = x (bars) und Zusatzspalten werden durchgereicht', () => {
    fc.assert(
      fc.property(tileArb, (t) => {
        const bars: TileData = {
          meta: { ...t.meta, kind: 'bars', R: null, tile: null },
          bars: t.bars,
          extra: { 'x.trades': Int32Array.from(t.bars.buyA, (v, i) => v + t.bars.sellA[i]!) },
        };
        const dec = decodeTile(encodeTile(bars));
        expect(plain(dec)).toEqual(plain(bars));
        expect(Array.from(dec.extra!['x.trades']!)).toEqual(Array.from(bars.extra!['x.trades']!));
      }),
      { numRuns: 100 },
    );
  });

  it('Größe: 8-Byte-ausgerichtet, ≈ 28 B/Level + 44 B/Bar + Header (KONZEPT §5.6)', () => {
    fc.assert(
      fc.property(tileArb, (t) => {
        const enc = encodeTile(t);
        const nb = t.bars.time.length;
        const nl = t.levels!.row.length;
        const hlen = new DataView(enc.buffer, enc.byteOffset).getUint32(4, true);
        expect(enc.length % 8).toBe(0);
        expect(enc.length).toBe(8 + hlen + tileColumnBytes(nb, nl, 'footprint'));
        const cols = tileColumnBytes(nb, nl, 'footprint');
        expect(cols).toBeGreaterThanOrEqual(28 * nl + 44 * nb + 4);
        expect(cols).toBeLessThanOrEqual(28 * nl + 44 * nb + 4 + 15 * 7);
        expect(hlen).toBeLessThan(2048);
      }),
    );
  });

  it('Spalten sind Sichten auf den Puffer (keine Kopie) bei ausgerichteter Eingabe', () => {
    const t = fc.sample(tileArb, { numRuns: 1, seed: 7 })[0]!;
    const enc = encodeTile(t);
    const dec = decodeTile(enc);
    expect(dec.levels!.row.buffer).toBe(enc.buffer);
    const shifted = new Uint8Array(enc.length + 3);
    shifted.set(enc, 3);
    expect(plain(decodeTile(shifted.subarray(3)))).toEqual(plain(t));
  });

  it('lehnt jede Verkürzung und jedes Anhängen ab', () => {
    fc.assert(
      fc.property(tileArb, fc.nat(), (t, cut) => {
        const enc = encodeTile(t);
        const n = cut % enc.length;
        expect(() => decodeTile(enc.slice(0, n))).toThrow(TileFormatError);
        const longer = new Uint8Array(enc.length + 8);
        longer.set(enc);
        expect(() => decodeTile(longer)).toThrow(TileFormatError);
      }),
      { numRuns: 200 },
    );
  });

  it('lehnt zufällige Bitfehler ab oder dekodiert nur gültige Kacheln', () => {
    fc.assert(
      fc.property(tileArb, fc.nat(), fc.integer({ min: 0, max: 7 }), (t, pos, bit) => {
        const enc = encodeTile(t).slice();
        const p = pos % enc.length;
        enc[p]! ^= 1 << bit;
        try {
          const dec = decodeTile(enc);
          // Ein Bitfehler, der die Invarianten nicht verletzt (z. B. Menge in einem Level und
          // gleichzeitig nicht prüfbarer Header-Text), ergibt trotzdem eine in sich gültige Kachel.
          expect(() => encodeTile(dec)).not.toThrow();
        } catch (e) {
          expect(e).toBeInstanceOf(TileFormatError);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('erkennt Bitfehler in Mengen über Level-Summe = Bar-Summe', () => {
    const t = fc.sample(
      tileArb.filter((x) => x.levels!.row.length > 0),
      { numRuns: 1, seed: 3 },
    )[0]!;
    const enc = encodeTile(t);
    const byteOff = decodeTile(enc).levels!.buy.byteOffset;
    const copy = enc.slice();
    // Menge des ersten Levels um 1 Lot erhöhen
    new Float64Array(copy.buffer, byteOff, 1)[0]! += 1;
    expect(() => decodeTile(copy)).toThrow(/Level-Summen/);
  });

  it('lehnt falsche Magic, Formatversion, Kachelgeometrie und unbekannte Spalten ab', () => {
    const t = fc.sample(tileArb, { numRuns: 1, seed: 11 })[0]!;
    const enc = encodeTile(t);
    const bad = enc.slice();
    bad[0] = 0;
    expect(() => decodeTile(bad)).toThrow(/Magic/);
    const reHeader = (mut: (h: Record<string, unknown>) => void) => {
      const hlen = new DataView(enc.buffer).getUint32(4, true);
      const h = JSON.parse(new TextDecoder().decode(enc.subarray(8, 8 + hlen))) as Record<
        string,
        unknown
      >;
      mut(h);
      let js = JSON.stringify(h);
      const body = enc.subarray(8 + hlen);
      while ((8 + new TextEncoder().encode(js).length) % 8 !== 0) js += ' ';
      const hb = new TextEncoder().encode(js);
      const out = new Uint8Array(8 + hb.length + body.length);
      new DataView(out.buffer).setUint32(0, 0x3154464f, true);
      new DataView(out.buffer).setUint32(4, hb.length, true);
      out.set(hb, 8);
      out.set(body, 8 + hb.length);
      return out;
    };
    expect(() => decodeTile(reHeader(() => {}))).not.toThrow();
    expect(() => decodeTile(reHeader((h) => (h.format = 2)))).toThrow(/Formatversion/);
    expect(() => decodeTile(reHeader((h) => (h.from = (h.from as number) + 60_000)))).toThrow(
      /tile/,
    );
    expect(() =>
      decodeTile(reHeader((h) => ((h.columns as { name: string }[])[0]!.name = 'zeit'))),
    ).toThrow(/Spalte|Pflichtspalte/);
    expect(() => decodeTile(reHeader((h) => (h.kind = 'bars')))).toThrow(TileFormatError);
  });

  it('Encoder lehnt inkonsistente Daten ab (nie ungültige Kacheln ausliefern)', () => {
    const t = fc.sample(
      tileArb.filter((x) => x.bars.time.length > 1),
      { numRuns: 1, seed: 5 },
    )[0]!;
    const swapped: TileData = { ...t, bars: { ...t.bars, time: t.bars.time.slice().reverse() } };
    expect(() => encodeTile(swapped)).toThrow(/aufsteigend/);
    const outOfRange: TileData = {
      ...t,
      bars: { ...t.bars, time: t.bars.time.map((x) => x + 10 ** 6) },
    };
    expect(() => encodeTile(outOfRange)).toThrow(TileFormatError);
  });
});

describe('Kachelaufbau aus Rollups', () => {
  it('Footprint-Kacheln über alle Kachelindizes = Rollup-Zeilen; Bars-Kachel = Bars', () => {
    fc.assert(
      fc.property(
        tradesArb({ maxTrades: 400, spanMin: 600 }),
        fc.constantFrom(1, 5, 15, 60),
        fc.constantFrom(1, 2, 5, 10, 20),
        fc.constantFrom(32, 64),
        (trades, tfMin, R, n) => {
          const agg = aggregateDay(DAY, trades);
          const fp = rollupFp(agg.fp1m, tfMin, R * TICK);
          const bars = rollupBars(agg.bars, tfMin);
          const tfSec = tfMin * 60;
          const k0 = tileIndexAt(bars[0]!.ts / 1000, n, tfSec);
          const k1 = tileIndexAt(bars[bars.length - 1]!.ts / 1000, n, tfSec);
          let cells = 0;
          let nb = 0;
          for (let k = k0; k <= k1; k++) {
            const tile = buildFootprintTile(
              {
                sym: 'BTCUSDT',
                tf: `${tfMin}m`,
                tfSec,
                R,
                priceDecimals: 2,
                qtyDecimals: 3,
                tickRefUnits: TICK,
                tile: { index: k, n },
                dataVersion: 'x',
                final: true,
              },
              fp,
              bars,
            );
            const dec = decodeTile(encodeTile(tile));
            cells += dec.header.nLevels;
            nb += dec.header.nBars;
            const [fs, ts] = tileBoundsSec(k, n, tfSec);
            for (const t of dec.bars.time) expect(t >= fs && t < ts).toBe(true);
          }
          expect(cells).toBe(fp.n);
          expect(nb).toBe(bars.length);
          const bt = decodeTile(
            encodeTile(
              buildBarsTile(
                {
                  sym: 'BTCUSDT',
                  tf: `${tfMin}m`,
                  tfSec,
                  priceDecimals: 2,
                  qtyDecimals: 3,
                  tickRefUnits: TICK,
                  from: bars[0]!.ts,
                  to: bars[bars.length - 1]!.ts + tfSec * 1000,
                  dataVersion: 'x',
                  final: true,
                },
                bars,
              ),
            ),
          );
          expect(Array.from(bt.bars.high)).toEqual(bars.map((b) => b.high));
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('Kachelgeometrie und Quellenwahl', () => {
  it('Kachellänge n = clamp(2^floor(log2(30 000 / Zeilen)), 32, 1024) (KONZEPT §5.3)', () => {
    expect(tileBarsFor(450)).toBe(64); // Beispiel aus §5.3: BTC 1m, R = 1 Tick
    expect(tileBarsFor(1)).toBe(1024);
    expect(tileBarsFor(29.3)).toBe(512);
    expect(tileBarsFor(29.29)).toBe(1024);
    expect(tileBarsFor(30)).toBe(512);
    expect(tileBarsFor(5000)).toBe(32);
    expect(tileBarsFor(0)).toBe(1024);
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 1e6, noNaN: true }), (r) => {
        const n = tileBarsFor(r);
        expect([32, 64, 128, 256, 512, 1024]).toContain(n);
        if (n > 32) expect(n * r).toBeLessThanOrEqual(30_000);
        if (n < 1024) expect(2 * n * r).toBeGreaterThan(30_000);
      }),
    );
  });

  it('Kachelindex und Grenzen sind konsistent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.constantFrom(32, 64, 1024),
        fc.constantFrom(60, 300, 3600),
        (t, n, tf) => {
          const k = tileIndexAt(t, n, tf);
          const [a, b] = tileBoundsSec(k, n, tf);
          expect(t >= a && t < b).toBe(true);
          expect(b - a).toBe(n * tf);
        },
      ),
    );
  });

  it('Kachellänge aus dem Maximum: keine Kachel über 30 000 Zellen, nie über 60 000', () => {
    expect(tileBarsForMax(1875)).toBe(32); // 32 · 1875 = 60 000
    expect(tileBarsForMax(1876)).toBeNull(); // nicht angeboten
    expect(maxRowsPerBar([105, 130, 99], [100, 100, 99], 10)).toBe(4);
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.integer({ min: 1, max: 10_000_000 }), fc.integer({ min: 0, max: 100_000 })),
          {
            minLength: 1,
            maxLength: 3_000,
          },
        ),
        fc.constantFrom(10, 20, 50, 100, 500, 1000, 10_000),
        fc.integer({ min: 0, max: 5_000 }),
        (raw, w, start) => {
          const high = raw.map(([l, d]) => l + d);
          const low = raw.map(([l]) => l);
          const n = tileBarsForMax(maxRowsPerBar(high, low, w));
          if (n === null) {
            expect(maxRowsPerBar(high, low, w) * 32).toBeGreaterThan(60_000);
            return;
          }
          // beliebige n aufeinanderfolgende Bars (eine Kachel) haben ≤ 30 000 Zellen bzw. ≤ 60 000 bei n = 32
          let cells = 0;
          for (
            let i = start % raw.length;
            i < Math.min(raw.length, (start % raw.length) + n);
            i++
          ) {
            cells += Math.floor(high[i]! / w) - Math.floor(low[i]! / w) + 1;
          }
          expect(cells).toBeLessThanOrEqual(n === 32 ? 60_000 : 30_000);
        },
      ),
    );
  });

  it('Median der Zeilen je Bar', () => {
    expect(medianRowsPerBar([105, 130, 99], [100, 100, 99], 10)).toBe(1);
    expect(medianRowsPerBar([105, 130], [100, 100], 10)).toBe(2.5);
    expect(medianRowsPerBar([], [], 10)).toBe(0);
  });

  it('Quellenwahl nach §5.2 (Beispiele BTC)', () => {
    const rows = {
      fp_1m: 650_000,
      fp_1m_b10: 70_000,
      fp_5m_b10: 29_000,
      fp_15m_b100: 2_000,
      fp_1h_b10: 10_000,
      fp_1h_b100: 1_000,
      fp_1d_b100: 200,
      fp_1d_b1000: 20,
    };
    expect(chooseFpSource(240, 200, rows)).toBe('fp_1h_b100');
    expect(chooseFpSource(30, 100, rows)).toBe('fp_15m_b100');
    expect(chooseFpSource(15, 20, rows)).toBe('fp_5m_b10');
    expect(chooseFpSource(1, 5, rows)).toBe('fp_1m');
    expect(chooseFpSource(1, 20, rows)).toBe('fp_1m_b10');
  });
});
