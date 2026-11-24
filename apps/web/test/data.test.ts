// Sichtbarer Bereich → Kacheln, Farbskalierung, Textformat, Kachel-Cache, Anfrage-Warteschlange.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeTile, encodeTile, tileBoundsSec, type TileData } from '@orderflow/core/browser';
import {
  colorIndex,
  intensity,
  intensityStep,
  INTENSITY_STEPS,
  NEUTRAL_INDEX,
  palette,
  quantileInPlace,
} from '../src/lib/color.ts';
import { formatQty, formatQtyShort, TextCache } from '../src/lib/format.ts';
import {
  FootprintStore,
  NONFINAL_TTL_MS,
  REJECT_TTL_MS,
  pocRow,
  prepareTile,
  TileMismatchError,
} from '../src/lib/footprint-store.ts';
import {
  MAX_RETRY_AFTER_MS,
  PARK_MS,
  RequestQueue,
  retryAfterMs,
} from '../src/lib/request-queue.ts';
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

describe('Kontrast der Zellschrift (W9)', () => {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const lum = (r: number, g: number, b: number) =>
    0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  it('helle Schrift hat auf jeder Farbstufe ≥ 4,5 : 1', () => {
    const text = lum(0xee, 0xf1, 0xf5);
    for (const mode of ['gradient', 'fixed', 'off'] as const) {
      for (const css of palette(mode)) {
        const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(css)!;
        const a = Number(m[4]);
        const mix = (c: number, i: number) => c * a + [15, 18, 23][i]! * (1 - a);
        const bg = lum(mix(Number(m[1]), 0), mix(Number(m[2]), 1), mix(Number(m[3]), 2));
        expect((text + 0.05) / (bg + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
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
      fc.property(fc.integer({ min: -1e11, max: 1e11 }), (v) => {
        expect(formatQty(Math.abs(v), 3).length).toBeLessThanOrEqual(6);
      }),
    );
  });
  it('W10: ganzzahlige Rundung, Klassengrenze nach dem Runden, nie "0" für Werte ≠ 0', () => {
    expect(formatQty(999_960, 3)).toBe('1000'); // nicht "1000.0"
    expect(formatQty(-999_960, 3)).toBe('-1000');
    expect(formatQty(9_999_600, 3)).toBe('10.0k');
    expect(formatQty(100_250, 3)).toBe('100.3'); // half-up, exakt
    expect(formatQty(100_350, 3)).toBe('100.4');
    expect(formatQty(9_9996, 3)).toBe('100.0');
    expect(formatQty(4, 6)).toBe('<0.001');
    expect(formatQty(-4, 6)).toBe('-<0.001');
    expect(formatQty(500, 6)).toBe('0.001');
    fc.assert(
      fc.property(
        fc.integer({ min: -1e9, max: 1e9 }),
        fc.constantFrom(0, 1, 2, 3, 4, 6),
        (v, qd) => {
          const s = formatQty(v, qd);
          expect(s.replace('-', '').length).toBeLessThanOrEqual(6);
          if (v !== 0) expect(s).not.toBe('0');
          // Wert innerhalb der Rundungsgenauigkeit (nur reine Zahlen ohne Suffix prüfen)
          if (/^-?\d+(\.\d+)?$/.test(s)) {
            const dp = s.includes('.') ? s.length - s.indexOf('.') - 1 : 0;
            expect(Math.abs(Number(s) - v / 10 ** qd)).toBeLessThanOrEqual(0.5 * 10 ** -dp + 1e-9);
          }
        },
      ),
    );
  });

  it('Kurzform für schmale Zellen: ≤ 4 Zeichen ohne Vorzeichen', () => {
    expect(formatQtyShort(1, 3)).toBe('.001');
    expect(formatQtyShort(250, 3)).toBe('.25');
    expect(formatQtyShort(-1234, 3)).toBe('-1.2');
    expect(formatQtyShort(12_345, 3)).toBe('12');
    expect(formatQtyShort(123_456, 3)).toBe('123');
    expect(formatQtyShort(1_234_567, 3)).toBe('1.2k');
    expect(formatQtyShort(45_678_000, 3)).toBe('46k');
    expect(formatQtyShort(2_500_000_000, 3)).toBe('2.5M');
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e11 }), (v) => {
        expect(formatQtyShort(v, 3).length).toBeLessThanOrEqual(4);
        expect(formatQtyShort(v, 3).length).toBeLessThanOrEqual(formatQty(v, 3).length);
      }),
    );
  });

  it('Textcache formatiert jeden Wert einmal und bleibt begrenzt (W5)', () => {
    const t = new TextCache(3, 100);
    expect(t.full(1500)).toBe('1.500');
    expect(t.short(1500)).toBe('1.5');
    expect(t.size).toBe(2);
    for (let v = 0; v < 10_000; v++) t.full(v);
    expect(t.size).toBeLessThanOrEqual(101 + 1);
    expect(t.full(1500)).toBe('1.500');
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
  it('prepareTile: Slots, POC', () => {
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
    const bars = decodeTile(
      encodeTile({ meta: { ...t.meta, kind: 'bars', R: null, tile: null }, bars: t.bars }),
    );
    expect(() => prepareTile('S', bars)).toThrow(/keine Footprint-Kachel/);
  });
  it('K2: Header wird gegen die Anfrage geprüft (Index, n, sym, tf, R)', () => {
    const store = new FootprintStore(3);
    const buf = encodeTile(tile(7, 32, [[1, 2]])).buffer as ArrayBuffer;
    const ok = { sym: 'X', tf: '1m', R: 5, k: 7, n: 32 };
    expect(() => store.addEncoded('X|1m|5', buf, ok)).not.toThrow();
    for (const bad of [{ k: 8 }, { n: 64 }, { sym: 'Y' }, { tf: '5m' }, { R: 10 }]) {
      expect(() => store.addEncoded('X|1m|5', buf, { ...ok, ...bad })).toThrow(TileMismatchError);
    }
  });
  it('W-3: Ablehnungen sind nicht endgültig (nach 5 min erneut), forget entfernt', () => {
    let now = 0;
    const store = new FootprintStore(3, 1e9, () => now);
    store.markRejected('S', 4);
    expect(store.has('S', 4)).toBe(true);
    now = REJECT_TTL_MS;
    expect(store.has('S', 4)).toBe(false);
    store.addEncoded('S', encodeTile(tile(1, 32, [[1]])).buffer as ArrayBuffer);
    store.forget('S', 1);
    expect(store.has('S', 1)).toBe(false);
    expect(store.cells).toBe(0);
  });
  it('W3: nicht finale Kacheln laufen nach 60 s ab (werden neu angefragt), finale nie', () => {
    let now = 0;
    const store = new FootprintStore(3, 1e9, () => now);
    const fin = tile(1, 32, [[1]]);
    const prov = tile(2, 32, [[1]]);
    prov.meta.final = false;
    store.addEncoded('S', encodeTile(fin).buffer as ArrayBuffer);
    store.addEncoded('S', encodeTile(prov).buffer as ArrayBuffer);
    now = NONFINAL_TTL_MS + 1;
    expect(store.has('S', 1)).toBe(true);
    expect(store.has('S', 2)).toBe(false);
    expect(store.get('S', 2)).not.toBeUndefined(); // zeichnet weiter, bis Ersatz da ist
  });
});

describe('RequestQueue (§5.4 + Review W2)', () => {
  type Pending = {
    url: string;
    signal: AbortSignal;
    resolve: (r: Response) => void;
    reject: (e: unknown) => void;
  };
  const setup = (onLoadedThrows = false) => {
    const pending: Pending[] = [];
    const loaded: string[] = [];
    const rejected: [string, number][] = [];
    const timers: { at: number; fn: () => void; live: boolean }[] = [];
    let now = 0;
    const q = new RequestQueue(
      (k) => {
        if (onLoadedThrows) throw new Error('kaputt');
        loaded.push(k);
      },
      (k, st) => rejected.push([k, st]),
      (url, init) =>
        new Promise<Response>((resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('abort', 'AbortError')),
          );
          pending.push({ url, signal: init.signal, resolve, reject });
        }),
      4,
      () => now,
      (fn, ms) => {
        const t = { at: now + ms, fn, live: true };
        timers.push(t);
        return () => (t.live = false);
      },
    );
    /** Zeit vorstellen und fällige Timer ausführen. */
    const advance = (ms: number) => {
      now += ms;
      for (const t of [...timers]) {
        if (t.live && t.at <= now) {
          t.live = false;
          t.fn();
        }
      }
    };
    return { q, pending, loaded, rejected, advance };
  };
  const want = (keys: string[]) => keys.map((k, i) => ({ key: k, url: `/x/${k}`, priority: i }));
  const tick = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const all = (keys: string[]) => new Set(keys);

  it('höchstens 4 parallel, nach Priorität', async () => {
    const { q, pending } = setup();
    q.setWanted(want(['a', 'b', 'c', 'd', 'e', 'f']), all(['a', 'b', 'c', 'd', 'e', 'f']));
    expect(pending.map((p) => p.url)).toEqual(['/x/a', '/x/b', '/x/c', '/x/d']);
    pending[0]!.resolve(new Response(new ArrayBuffer(8)));
    await tick();
    expect(pending.map((p) => p.url)).toContain('/x/e');
    expect(q.stats.inFlight).toBeLessThanOrEqual(4);
  });

  it('bricht ab, was den Bedarf verlässt; behält die Rückhaltezone; späte Antworten nach Abbruch zählen nicht', async () => {
    const { q, pending, loaded } = setup();
    q.setWanted(want(['a', 'b']), all(['a', 'b']));
    q.setWanted(want(['c']), all(['c', 'b']));
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(pending[1]!.signal.aborted).toBe(false);
    expect(q.stats.aborted).toBe(1);
    pending[0]!.resolve(new Response(new ArrayBuffer(8))); // trotz Abbruch noch geantwortet
    pending[1]!.resolve(new Response(new ArrayBuffer(8)));
    await tick();
    expect(loaded).toEqual(['b']);
  });

  it('404/422 endgültig, nie erneut', async () => {
    const { q, pending, rejected, advance } = setup();
    q.setWanted(want(['x']), all(['x']));
    pending[0]!.resolve(new Response('no', { status: 422 }));
    await tick();
    expect(rejected).toEqual([['x', 422]]);
    advance(10 * PARK_MS);
    q.setWanted(want(['x']), all(['x']));
    expect(pending).toHaveLength(1);
    expect(q.isFinal('x')).toBe(true);
  });

  it('429 mit Retry-After: Wiederholung per Timer, ohne neuen Bedarf', async () => {
    const { q, pending, loaded, advance } = setup();
    q.setWanted(want(['y']), all(['y']));
    pending[0]!.resolve(
      new Response('slow down', { status: 429, headers: { 'Retry-After': '5' } }),
    );
    await tick();
    expect(pending).toHaveLength(1);
    advance(4_000);
    expect(pending).toHaveLength(1); // Retry-After (5 s) > Backoff (2 s)
    advance(1_000);
    expect(pending).toHaveLength(2);
    pending[1]!.resolve(new Response(new ArrayBuffer(8)));
    await tick();
    expect(loaded).toEqual(['y']);
  });

  it('5xx: Backoff, nach 3 Fehlschlägen 30 s Pause, danach wieder (nicht dauerhaft gesperrt)', async () => {
    const { q, pending, advance } = setup();
    q.setWanted(want(['z']), all(['z']));
    const failLast = async () => {
      pending[pending.length - 1]!.resolve(new Response('err', { status: 503 }));
      await tick();
    };
    await failLast();
    advance(2_000); // 2 s
    expect(pending).toHaveLength(2);
    await failLast();
    advance(4_000); // 4 s
    expect(pending).toHaveLength(3);
    await failLast(); // 3. Fehlschlag → Pause
    advance(PARK_MS - 1);
    expect(pending).toHaveLength(3);
    advance(1);
    expect(pending).toHaveLength(4);
    expect(q.isFinal('z')).toBe(false);
  });

  it('nicht mehr gewünschte Schlüssel werden auch per Timer nicht wiederholt', async () => {
    const { q, pending, advance } = setup();
    q.setWanted(want(['w']), all(['w']));
    pending[0]!.resolve(new Response('err', { status: 500 }));
    await tick();
    q.setWanted([], all([]));
    advance(60_000);
    expect(pending).toHaveLength(1);
  });

  it('Verarbeitungsfehler (Decoder wirft) werden gezählt, sichtbar und nicht als Netzfehler wiederholt', async () => {
    const { q, pending, rejected, advance } = setup(true);
    const err = console.error;
    console.error = () => {};
    q.setWanted(want(['d']), all(['d']));
    pending[0]!.resolve(new Response(new ArrayBuffer(8)));
    await tick();
    console.error = err;
    expect(q.stats.decodeErrors).toBe(1);
    expect(q.lastError).toContain('kaputt');
    expect(rejected).toEqual([['d', 0]]);
    advance(10 * PARK_MS);
    q.setWanted(want(['d']), all(['d']));
    expect(pending).toHaveLength(1);
    q.clearFailures(); // per Knopf aufhebbar
    expect(pending).toHaveLength(2);
  });

  it('N5: Retry-After wird auf 5 min begrenzt (kein setTimeout-Überlauf, keine enge Schleife)', async () => {
    const { q, pending, advance } = setup();
    q.setWanted(want(['r']), all(['r']));
    pending[0]!.resolve(
      new Response('', { status: 503, headers: { 'Retry-After': '99999999999' } }),
    );
    await tick();
    advance(MAX_RETRY_AFTER_MS - 1);
    expect(pending).toHaveLength(1);
    advance(1);
    expect(pending).toHaveLength(2);
  });

  it('Retry-After: Sekunden und HTTP-Datum', () => {
    expect(retryAfterMs('7')).toBe(7000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs('quatsch')).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });
});
