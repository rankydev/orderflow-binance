// TpoView mit minimalem DOM-Ersatz (kein jsdom): fit() verdrahtet fitPriceRange, Doppelklick auf die
// Preisachse passt neu ein, Doppelklick in die Fläche nicht.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fitPriceRange } from '../src/lib/tpo/interaction.ts';
import type { SymbolInfo } from '../src/lib/types.ts';
import { ApiClient } from '../src/lib/api.ts';

type Handler = (e: unknown) => void;
const handlers = new Map<string, Handler>();
const W = 800;
const H = 600;
const rect = { left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 };
const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeAll(() => {
  const ctx = new Proxy({}, { get: () => () => ({ width: 0 }), set: () => true });
  const container = { appendChild() {}, getBoundingClientRect: () => rect };
  const canvas = {
    className: '',
    width: 0,
    height: 0,
    style: {},
    parentElement: container,
    setAttribute() {},
    getContext: () => ctx,
    addEventListener: (ev: string, f: Handler) => handlers.set(ev, f),
    removeEventListener() {},
    getBoundingClientRect: () => rect,
    setPointerCapture() {},
    remove() {},
  };
  const stubs: Record<string, unknown> = {
    document: { createElement: () => canvas },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    window: {
      devicePixelRatio: 1,
      innerHeight: H,
      matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    fetch: () => new Promise(() => {}),
  };
  for (const [k, v] of Object.entries(stubs)) {
    saved[k] = g[k];
    g[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v;
});

const D = 86_400_000;
const T0 = Date.UTC(2026, 10, 20);
function sym(): SymbolInfo {
  return {
    name: 'LOWUSDT',
    priceDecimals: 4,
    qtyDecimals: 0,
    tickRefUnits: 10,
    tickUnits: 10,
    dataFrom: T0,
    dataTo: T0 + 3 * D,
    tileConfigVersion: 1,
    tiles: { '1m': { '1': 1000 } },
  };
}

async function makeView() {
  const { TpoView } = await import('../src/lib/tpo/view.ts');
  const s = sym();
  const v = new TpoView({ appendChild() {} } as unknown as HTMLElement, {
    api: new ApiClient(''),
    sym: () => s,
    offsetH: () => 0,
  });
  // private Felder für den Test
  const pv = v as unknown as {
    raw: Map<string, unknown>;
    rawKey(sym: string, tf: string, d: number): string;
    resize(): void;
    fit(): void;
    pTop: number;
    pBot: number;
    fitted: boolean;
  };
  pv.resize();
  return { v, pv, s };
}

function putDay(
  pv: { raw: Map<string, unknown>; rawKey(s: string, tf: string, d: number): string },
  s: SymbolInfo,
  tf: string,
  d: number,
  lo: number,
  hi: number,
) {
  pv.raw.set(pv.rawKey(s.name, tf, d), {
    bars: { time: [(d * D) / 1000], open: [lo], high: [hi], low: [lo], close: [hi], volume: [1] },
  });
}

describe('TpoView: fit() und Doppelklick auf die Preisachse', () => {
  it('fit() setzt den Bereich über fitPriceRange (Unterkante ≥ 0 bei niedrigem Preis)', async () => {
    const { v, pv, s } = await makeView();
    const tf = v.sourceTf();
    const vis = v.visibleDays()!;
    expect(vis).not.toBeNull();
    for (let d = vis[0]; d <= vis[1]; d++) putDay(pv, s, tf, d, 3, 100);
    pv.fit();
    expect([pv.pTop, pv.pBot]).toEqual(fitPriceRange(3, 100, s.tickRefUnits));
    expect(pv.pBot).toBe(0);
    v.destroy();
  });

  it('Doppelklick rechts der Fläche (Preisachse) passt neu ein, in der Fläche nicht', async () => {
    const { v, pv, s } = await makeView();
    const tf = v.sourceTf();
    const vis = v.visibleDays()!;
    for (let d = vis[0]; d <= vis[1]; d++) putDay(pv, s, tf, d, 50_000, 60_000);
    pv.fit();
    const fitted: [number, number] = [pv.pTop, pv.pBot];
    expect(fitted).toEqual(fitPriceRange(50_000, 60_000, s.tickRefUnits));
    // Bereich verstellen
    pv.pTop = 1e9;
    pv.pBot = 5e8;
    const dbl = handlers.get('dblclick')!;
    dbl({ clientX: 100, clientY: 300 }); // in der Fläche: nichts
    expect([pv.pTop, pv.pBot]).toEqual([1e9, 5e8]);
    dbl({ clientX: W - 10, clientY: 300 }); // Preisachse rechts
    expect([pv.pTop, pv.pBot]).toEqual(fitted);
    v.destroy();
  });
});
