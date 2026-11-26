// Messung (nicht Teil des normalen Laufs): Zeichenzeit der Big-Trades-Schicht bei 20 Abschnitten ×
// 20 000 Orders (400 000 Zeilen sichtbar). Start: BT_PERF=1 npx vitest run apps/web/test/bigtrades-perf.test.ts
// Gemessen werden (a) Neuzeichnen ohne Änderung (z. B. Hover), (b) nach Verschieben des Bereichs.
import { describe, expect, it } from 'vitest';
import { encodeBigTrades, type BigTradeColumns } from '@orderflow/core/browser';
import { BigTradesLayer, type BigTradesHost } from '../src/lib/bigtrades/layer.ts';
import type { BarItem, SymbolInfo } from '../src/lib/types.ts';

const RUN =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BT_PERF ===
  '1';
const CHUNKS = 20;
const ROWS = 20_000;
const SPAN = 60_000_000; // 1 000 Bars 1m
const C0 = 29_800;
const T0 = C0 * SPAN;

const SYM: SymbolInfo = {
  name: 'BTCUSDT',
  priceDecimals: 2,
  qtyDecimals: 3,
  tickRefUnits: 10,
  tickUnits: 10,
  dataFrom: T0,
  dataTo: T0 + CHUNKS * SPAN,
  tileConfigVersion: 1,
  tiles: {},
  bigTrades: { floorN: 50_000_000_000, minUsdt: 500_000, notionalDecimals: 5 },
};

function chunkBody(c: number): ArrayBuffer {
  const from = c * SPAN;
  const ts = new Float64Array(ROWS);
  for (let i = 0; i < ROWS; i++) ts[i] = from + Math.floor((i * SPAN) / ROWS);
  let seed = c * 7919 + 1;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const notional = Float64Array.from(ts, () => Math.round(5e10 * (1 + 20 * rnd() ** 4)));
  const px = Int32Array.from(ts, () => 9_000_000 + Math.floor(rnd() * 200_000));
  const cols: BigTradeColumns = {
    ts,
    bar: Int32Array.from(ts, (t) => Math.floor(t / 60_000) * 60),
    side: Int32Array.from(ts, (_, i) => 1 + (i % 2)),
    pxFirst: px,
    pxLast: px,
    qty: Float64Array.from(notional, (n, i) => Math.max(1, Math.round(n / px[i]!))),
    notional,
    aggN: Int32Array.from(ts, () => 2),
    firstAggId: Float64Array.from(ts, (_, i) => c * 1e6 + i),
  };
  const day = 86_400_000;
  const coverage = [];
  for (let a = from; a < from + SPAN;) {
    const b = Math.min(from + SPAN, (Math.floor(a / day) + 1) * day);
    coverage.push({
      from: a,
      to: b,
      status: 'ok' as const,
      reason: null,
      floorN: 5e10,
      final: true,
    });
    a = b;
  }
  const bytes = encodeBigTrades({
    meta: {
      kind: 'bigtrades',
      sym: 'BTCUSDT',
      tf: '1m',
      tfSec: 60,
      priceDecimals: 2,
      qtyDecimals: 3,
      tickRefUnits: 10,
      notionalDecimals: 5,
      from,
      to: from + SPAN,
      minUsdt: 500_000,
      minN: 5e10,
      maxRows: 20_000,
      total: ROWS,
      omitted: 0,
      k: null,
      coverage,
      dataVersion: 'v',
      final: true,
    },
    rows: cols,
  });
  return bytes.slice().buffer;
}

/** Kontext ohne Zeichnen (zählt nur Aufrufe). */
function fakeCtx() {
  const noop = () => {};
  return new Proxy(
    { measureText: () => ({ width: 20 }) },
    {
      get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : noop),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

describe.skipIf(!RUN)('Big Trades: Zeichenzeit 20 × 20 000', () => {
  it('misst', async () => {
    const items: BarItem[] = [];
    for (let i = 0; i < CHUNKS * 1000; i++) items.push({ time: T0 / 1000 + i * 60 } as BarItem);
    let shift = 0;
    const W = 1600;
    const bs = W / items.length; // alles sichtbar
    const host: BigTradesHost = {
      chart: {
        timeScale: () => ({ logicalToCoordinate: (l: number) => (l - shift) * bs }),
      } as never,
      apiBase: '',
      sym: () => SYM,
      tf: () => '1m',
      tfSec: () => 60,
      items: () => items,
      visibleTimeRange: () => [T0 / 1000, (T0 + CHUNKS * SPAN) / 1000 - 60],
      priceToY: (p) => 800 - (p - 90_000) * 0.4,
      footprintActive: () => false,
      busy: () => false,
      gestureActive: () => false,
    };
    const layer = new BigTradesLayer(host, (url) => {
      const c = Number(new URL(url, 'http://x').searchParams.get('from')) / SPAN;
      return Promise.resolve(new Response(chunkBody(c)));
    });
    layer.enabled = true;
    layer.minUsdt = 500_000;
    layer.frame();
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (layer.readout().loading === 0) break;
    }
    expect(layer.readout().loading).toBe(0);
    const scope = {
      context: fakeCtx(),
      horizontalPixelRatio: 2,
      verticalPixelRatio: 2,
      bitmapSize: { width: 2 * W, height: 1600 },
      mediaSize: { width: W, height: 800 },
    };
    const target = { useBitmapCoordinateSpace: (f: (s: unknown) => void) => f(scope) };
    const paint = () => {
      (layer as { updateAllViews?: () => void }).updateAllViews?.(); // ältere Fassung
      for (const v of layer.paneViews()) v.renderer()!.draw(target as never, undefined as never);
    };
    paint();
    const time = (n: number, f: () => void) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) f();
      return (performance.now() - t0) / n;
    };
    const same = time(20, paint);
    const hover = time(20, () => {
      layer.hoverText(800, 400);
      paint();
    });
    const panned = time(20, () => {
      shift += 1;
      paint();
    });
    console.log(
      `BT_PERF rows=${CHUNKS * ROWS} markers=${layer.readout().markers} drawn=${layer.readout().drawn} ` +
        `repaint=${same.toFixed(2)}ms hover+repaint=${hover.toFixed(2)}ms pan+repaint=${panned.toFixed(2)}ms`,
    );
  }, 120_000);
});
