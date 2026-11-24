// Sichtbarer Bereich → Kacheln, Farbskalierung, Textformat, Kachel-Cache, Anfrage-Warteschlange.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeTile, tileBoundsSec, type TileData } from '@orderflow/core/browser';
import {
  colorIndex,
  intensity,
  intensityStep,
  INTENSITY_STEPS,
  NEUTRAL_INDEX,
  palette,
  quantileInPlace,
} from '../src/lib/color.ts';
import { formatQty, TextTable } from '../src/lib/format.ts';
import { FootprintStore, pocRow, prepareTile } from '../src/lib/footprint-store.ts';
import { RequestQueue } from '../src/lib/request-queue.ts';
import { chunkIndexAt, wantedTiles, windowChunks } from '../src/lib/tiles.ts';

describe('wantedTiles (sichtbar + Padding + Prefetch, §5.4)', () => {
  const base = { n: 64, tfSec: 60, dataFromSec: 0, dataToSec: 64 * 60 * 100, panDir: 0 as const };
  it('sichtbare Kacheln von der Mitte nach außen, dann 1 Padding je Seite', () => {
    const span = 64 * 60;
    const w = wantedTiles({ ...base, fromSec: 10 * span + 5, toSec: 12 * span + 5 });
    expect(w.filter((x) => x.priority === 0).map((x) => x.k)).toEqual([11, 10, 12]);
    expect(
      w
        .filter((x) => x.priority === 1)
        .map((x) => x.k)
        .sort(),
    ).toEqual([13, 9]);
    expect(w.some((x) => x.priority === 2)).toBe(false);
  });
  it('Prefetch nur in Panrichtung und nur innerhalb der Daten', () => {
    const span = 64 * 60;
    expect(
      wantedTiles({ ...base, panDir: 1, fromSec: 10 * span, toSec: 10 * span + 1 }).find(
        (x) => x.priority === 2,
      )?.k,
    ).toBe(12);
    expect(
      wantedTiles({ ...base, panDir: -1, fromSec: 10 * span, toSec: 10 * span + 1 }).find(
        (x) => x.priority === 2,
      )?.k,
    ).toBe(8);
    expect(
      wantedTiles({ ...base, panDir: 1, fromSec: 99 * span, toSec: 99 * span + 1 }).map((x) => x.k),
    ).toEqual([99, 98]);
  });
  it('Eigenschaften: Kacheln eindeutig, decken den sichtbaren Bereich ∩ Daten, begrenzte Anzahl', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.constantFrom(32, 64, 1024),
        fc.constantFrom(60, 300, 3600),
        fc.constantFrom(-1 as const, 0 as const, 1 as const),
        (from, len, n, tfSec, panDir) => {
          const dataFromSec = 1_000_000;
          const dataToSec = 9_000_000;
          const w = wantedTiles({
            fromSec: from,
            toSec: from + len,
            n,
            tfSec,
            dataFromSec,
            dataToSec,
            panDir,
          });
          const ks = w.map((x) => x.k);
          expect(new Set(ks).size).toBe(ks.length);
          for (const k of ks) {
            const [a, b] = tileBoundsSec(k, n, tfSec);
            expect(b > dataFromSec && a < dataToSec).toBe(true);
          }
          const visible = Math.ceil(len / (n * tfSec)) + 1;
          expect(ks.length).toBeLessThanOrEqual(visible + 3);
          // jeder sichtbare Zeitpunkt innerhalb der Daten liegt in einer gewünschten Kachel
          for (const t of [from, from + len, from + len / 2]) {
            if (t >= dataFromSec && t < dataToSec)
              expect(ks).toContain(Math.floor(t / (n * tfSec)));
          }
        },
      ),
    );
  });
});

describe('windowChunks (Fenster ≤ cap Abschnitte, am Datenrand verschoben)', () => {
  it('Eigenschaften', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20_000_000 }),
        fc.integer({ min: 1, max: 25 }),
        (center, cap) => {
          const df = 5_000_000;
          const dt = 13_000_000;
          const [a, b] = windowChunks(center, 60, cap, df, dt);
          const first = chunkIndexAt(df, 60);
          const last = chunkIndexAt(dt - 1, 60);
          expect(a).toBeGreaterThanOrEqual(first);
          expect(b).toBeLessThanOrEqual(last);
          expect(b - a + 1).toBe(Math.min(cap, last - first + 1));
          const c = Math.min(Math.max(chunkIndexAt(center, 60), first), last);
          expect(c >= a && c <= b).toBe(true);
        },
      ),
    );
  });
});

describe('Farbskalierung (§6.1)', () => {
  it('Quantil = Sortier-Referenz', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 500 }),
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        (xs, p) => {
          const s = [...xs].sort((a, b) => a - b);
          const ref = s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
          expect(quantileInPlace(Float64Array.from(xs), xs.length, p)).toBe(ref);
        },
      ),
    );
  });
  it('Intensität = min(1, |v| / Ref), quantisiert', () => {
    expect(intensity(50, 100)).toBe(0.5);
    expect(intensity(-300, 100)).toBe(1);
    expect(intensityStep(0, 100)).toBe(0);
    expect(intensityStep(100, 100)).toBe(INTENSITY_STEPS - 1);
    expect(intensityStep(1000, 100)).toBe(INTENSITY_STEPS - 1);
    expect(intensityStep(49, 100)).toBe(4);
  });
  it('Farbindex: Vorzeichen bzw. Seite, 0 neutral, Modi', () => {
    expect(colorIndex(0, 10, false, 'gradient')).toBe(NEUTRAL_INDEX);
    expect(colorIndex(10, 10, false, 'gradient')).toBe(INTENSITY_STEPS - 1);
    expect(colorIndex(-10, 10, false, 'gradient')).toBe(2 * INTENSITY_STEPS - 1);
    expect(colorIndex(10, 10, true, 'gradient')).toBe(2 * INTENSITY_STEPS - 1); // Bid-Seite rot
    expect(colorIndex(1, 1000, false, 'fixed')).toBe(INTENSITY_STEPS - 1);
    expect(palette('gradient')).toHaveLength(NEUTRAL_INDEX + 1);
    expect(new Set(palette('gradient')).size).toBe(NEUTRAL_INDEX + 1);
  });
});

describe('Zelltext', () => {
  it('kompakt, höchstens 6 Zeichen ohne Vorzeichen', () => {
    expect(formatQty(0, 3)).toBe('0');
    expect(formatQty(1, 3)).toBe('0.001');
    expect(formatQty(-1234, 3)).toBe('-1.234');
    expect(formatQty(12_345, 3)).toBe('12.35');
    expect(formatQty(123_456, 3)).toBe('123.5');
    expect(formatQty(1_234_567, 3)).toBe('1235');
    expect(formatQty(12_345_678, 3)).toBe('12.3k');
    expect(formatQty(123_456_789, 3)).toBe('123k');
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), (v) => {
        expect(formatQty(Math.abs(v), 3).length).toBeLessThanOrEqual(6);
      }),
    );
  });
  it('Texttabelle formatiert jeden Wert genau einmal', () => {
    const t = new TextTable(3);
    const a = t.id(1500);
    expect(t.id(1500)).toBe(a);
    expect(t.strings[a]).toBe('1.500');
    expect(t.size).toBe(1);
  });
});

function tile(k: number, n: number, rowsPerBar: number[][], R = 5): TileData {
  const tfSec = 60;
  const from = k * n * tfSec;
  const nb = rowsPerBar.length;
  const lv = { row: [] as number[], buy: [] as number[], sell: [] as number[] };
  const off = new Int32Array(nb + 1);
  const bars = {
    time: new Int32Array(nb),
    open: new Int32Array(nb),
    high: new Int32Array(nb),
    low: new Int32Array(nb),
    close: new Int32Array(nb),
    buyQ: new Float64Array(nb),
    sellQ: new Float64Array(nb),
    buyA: new Int32Array(nb),
    sellA: new Int32Array(nb),
  };
  const w = R * 10;
  rowsPerBar.forEach((rows, i) => {
    bars.time[i] = from + i * 2 * tfSec;
    off[i] = lv.row.length;
    rows.forEach((v, j) => {
      lv.row.push(1000 + j);
      lv.buy.push(v);
      lv.sell.push(j);
      bars.buyQ[i]! += v;
      bars.sellQ[i]! += j;
    });
    bars.low[i] = 1000 * w;
    bars.high[i] = (1000 + rows.length) * w - 1;
    bars.open[i] = bars.low[i]!;
    bars.close[i] = bars.high[i]!;
  });
  off[nb] = lv.row.length;
  const z = (a: number[]) => Int32Array.from(a.map(() => 0));
  return {
    meta: {
      kind: 'footprint',
      sym: 'X',
      tf: '1m',
      tfSec,
      R,
      priceDecimals: 2,
      qtyDecimals: 3,
      tickRefUnits: 10,
      from: from * 1000,
      to: (from + n * tfSec) * 1000,
      tile: { index: k, n },
      dataVersion: 'v',
      final: true,
    },
    bars,
    levels: {
      levelOffset: off,
      row: Int32Array.from(lv.row),
      buy: Float64Array.from(lv.buy),
      sell: Float64Array.from(lv.sell),
      buyA: z(lv.row),
      sellA: z(lv.row),
    },
  };
}

describe('Kachel-Cache', () => {
  it('POC: max. Volumen, Gleichstand → näher an der Mitte, dann tiefer', () => {
    expect(pocRow([0, 1, 2], [5, 9, 5], [0, 0, 0], 0, 3, 0, 2)).toBe(1);
    expect(pocRow([0, 1, 2, 3], [9, 0, 0, 9], [0, 0, 0, 0], 0, 4, 0, 3)).toBe(0); // gleich weit → tiefer
    expect(pocRow([0, 1, 2, 3, 4], [9, 0, 0, 9, 0], [0, 0, 0, 0, 0], 0, 5, 0, 4)).toBe(3); // 3 näher an 2
  });
  it('prepareTile: Slots, POC, Texte einmalig je Kachel', () => {
    const enc = encodeTile(
      tile(7, 32, [
        [1, 2, 3],
        [5, 0],
      ]),
    );
    const store = new FootprintStore(3);
    const t = store.addEncoded('X|1m|5', enc.buffer as ArrayBuffer);
    expect(t.slot[0]).toBe(0);
    expect(t.slot[2]).toBe(1);
    expect(t.slot[1]).toBe(-1);
    expect(t.poc[0]).toBe(1002); // buy+sell: 1, 3, 5
    expect(store.text.strings[t.txtDelta[2]!]).toBe('0.001'); // 3 − 2
    expect(store.text.strings[t.txtSell[1]!]).toBe('0.001');
    expect(store.cells).toBe(5);
  });
  it('LRU nach Zellen, sichtbare (gepinnte) Kacheln bleiben', () => {
    const store = new FootprintStore(3, 10);
    for (let k = 0; k < 5; k++)
      store.addEncoded('S', encodeTile(tile(k, 32, [[1, 1, 1, 1]])).buffer as ArrayBuffer);
    expect(store.cells).toBe(20);
    store.evict(new Set([FootprintStore.key('S', 0)]));
    expect(store.cells).toBeLessThanOrEqual(10);
    expect(store.has('S', 0)).toBe(true);
    expect(store.has('S', 4)).toBe(true);
    expect(store.has('S', 1)).toBe(false);
  });
  it('prepareTile lehnt bars-Kacheln ab', () => {
    const t = tile(1, 32, [[1]]);
    const bars = encodeTile({
      meta: { ...t.meta, kind: 'bars', R: null, tile: null },
      bars: t.bars,
    });
    expect(() =>
      prepareTile('S', { header: { kind: 'bars' } } as never, new TextTable(3)),
    ).toThrow();
    expect(bars.length).toBeGreaterThan(0);
  });
});

describe('RequestQueue (§5.4: ≤ 4 parallel, Abbruch, keine Nachladeschleifen)', () => {
  type Pending = {
    url: string;
    signal: AbortSignal;
    resolve: (r: Response) => void;
    reject: (e: unknown) => void;
  };
  const setup = () => {
    const pending: Pending[] = [];
    const loaded: string[] = [];
    const rejected: string[] = [];
    let now = 0;
    const q = new RequestQueue(
      (k) => loaded.push(k),
      (k) => rejected.push(k),
      (url, init) =>
        new Promise<Response>((resolve, reject) => {
          const p = { url, signal: init.signal, resolve, reject };
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('abort', 'AbortError')),
          );
          pending.push(p);
        }),
      4,
      () => now,
    );
    return { q, pending, loaded, rejected, setNow: (t: number) => (now = t) };
  };
  const want = (keys: string[]) => keys.map((k, i) => ({ key: k, url: `/x/${k}`, priority: i }));
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('höchstens 4 parallel, nach Priorität', async () => {
    const { q, pending } = setup();
    q.setWanted(want(['a', 'b', 'c', 'd', 'e', 'f']), new Set(['a', 'b', 'c', 'd', 'e', 'f']));
    expect(pending.map((p) => p.url)).toEqual(['/x/a', '/x/b', '/x/c', '/x/d']);
    pending[0]!.resolve(new Response(new ArrayBuffer(8)));
    await tick();
    await tick();
    expect(pending.map((p) => p.url)).toContain('/x/e');
    expect(q.stats.inFlight).toBeLessThanOrEqual(4);
  });

  it('bricht ab, was den Bedarf verlässt; behält, was in der Rückhaltezone liegt', async () => {
    const { q, pending, loaded } = setup();
    q.setWanted(want(['a', 'b']), new Set(['a', 'b']));
    q.setWanted(want(['c']), new Set(['c', 'b']));
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(pending[1]!.signal.aborted).toBe(false);
    expect(q.stats.aborted).toBe(1);
    pending[1]!.resolve(new Response(new ArrayBuffer(8)));
    await tick();
    await tick();
    expect(loaded).toEqual(['b']);
  });

  it('4xx endgültig, 5xx mit Backoff und höchstens 3 Versuchen', async () => {
    const { q, pending, rejected, setNow } = setup();
    q.setWanted(want(['x']), new Set(['x']));
    pending[0]!.resolve(new Response('no', { status: 422 }));
    await tick();
    await tick();
    expect(rejected).toEqual(['x']);
    q.setWanted(want(['x']), new Set(['x']));
    expect(pending).toHaveLength(1); // nie erneut

    q.setWanted(want(['y']), new Set(['y']));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const p = pending[pending.length - 1]!;
      expect(p.url).toBe('/x/y');
      p.resolve(new Response('err', { status: 500 }));
      await tick();
      await tick();
      const n = pending.length;
      q.setWanted(want(['y']), new Set(['y']));
      expect(pending).toHaveLength(n); // Backoff: nicht sofort
      setNow(1e9 * attempt);
      q.setWanted(want(['y']), new Set(['y']));
      if (attempt < 3) expect(pending).toHaveLength(n + 1);
      else expect(pending).toHaveLength(n); // nach 3 Fehlschlägen aufgegeben
    }
  });
});
