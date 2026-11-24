// Komponentenprüfung des Footprint-Renderers mit einem aufzeichnenden Canvas-Kontext: nur sichtbare
// Bars/Zeilen, Zellbudget erzwungen (über 25 000 keine Zellen), Texte nur in L3, gebündelte Füllungen.
import { describe, expect, it } from 'vitest';
import { encodeTile, type TileData } from '@orderflow/core/browser';
import { palette } from '../src/lib/color.ts';
import { FootprintStore } from '../src/lib/footprint-store.ts';
import {
  FootprintRenderer,
  nextFallback,
  RenderContext,
  type FpItem,
} from '../src/lib/footprint-series.ts';

class RecordingCtx {
  rects = 0;
  fills = 0;
  strokes = 0;
  texts = 0;
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textAlign = '';
  textBaseline = '';
  beginPath() {}
  rect() {
    this.rects++;
  }
  fill() {
    this.fills++;
  }
  stroke() {
    this.strokes++;
  }
  fillText() {
    this.texts++;
  }
  // Monospace-Näherung: 6,5 CSS-px je Zeichen bei 10 px Schrift, Bitmap ×2
  measureText(t: string) {
    return { width: t.length * 13 };
  }
}

const W = 50; // R=5 · tick 10
const N_ROWS = 40;

function makeTile(nBars: number): TileData {
  const n = 1024;
  const nl = nBars * N_ROWS;
  const off = new Int32Array(nBars + 1);
  const row = new Int32Array(nl);
  const buy = new Float64Array(nl);
  const sell = new Float64Array(nl);
  const bars = {
    time: new Int32Array(nBars),
    open: new Int32Array(nBars),
    high: new Int32Array(nBars),
    low: new Int32Array(nBars),
    close: new Int32Array(nBars),
    buyQ: new Float64Array(nBars),
    sellQ: new Float64Array(nBars),
    buyA: new Int32Array(nBars),
    sellA: new Int32Array(nBars),
  };
  for (let i = 0; i < nBars; i++) {
    bars.time[i] = i * 60;
    off[i] = i * N_ROWS;
    for (let j = 0; j < N_ROWS; j++) {
      const q = i * N_ROWS + j;
      row[q] = 1000 + j;
      buy[q] = 1 + ((i + j) % 7);
      sell[q] = 1 + ((i * j) % 5);
      bars.buyQ[i]! += buy[q]!;
      bars.sellQ[i]! += sell[q]!;
    }
    bars.low[i] = 1000 * W;
    bars.high[i] = (1000 + N_ROWS) * W - 1;
    bars.open[i] = bars.low[i]!;
    bars.close[i] = bars.high[i]!;
  }
  off[nBars] = nl;
  return {
    meta: {
      kind: 'footprint',
      sym: 'X',
      tf: '1m',
      tfSec: 60,
      R: 5,
      priceDecimals: 2,
      qtyDecimals: 3,
      tickRefUnits: 10,
      from: 0,
      to: n * 60_000,
      tile: { index: 0, n },
      dataVersion: 'v',
      final: true,
    },
    bars,
    levels: {
      levelOffset: off,
      row,
      buy,
      sell,
      buyA: new Int32Array(nl),
      sellA: new Int32Array(nl),
    },
  };
}

function setup(nBars: number, bs: number, heightPx: number, visible: [number, number]) {
  const rc = new RenderContext();
  const store = new FootprintStore(3);
  store.addEncoded('X|1m|5', encodeTile(makeTile(nBars)).buffer as ArrayBuffer);
  rc.store = store;
  rc.series = 'X|1m|5';
  rc.n = 1024;
  rc.tfSec = 60;
  rc.width = W;
  rc.priceScale = 100;
  rc.palette = palette('gradient');
  const r = new FootprintRenderer(rc);
  const bars = Array.from({ length: nBars }, (_, i) => {
    const it: FpItem = {
      time: (i * 60) as FpItem['time'],
      t: i * 60,
      open: 500,
      high: 520,
      low: 500,
      close: 520,
      o: 50_000,
      h: 51_999,
      l: 50_000,
      c: 51_999,
    };
    return { x: i * bs + bs / 2, time: i, originalData: it, barColor: '' };
  });
  r.data = {
    bars,
    barSpacing: bs,
    visibleRange: { from: visible[0], to: visible[1] },
    conflationFactor: 1,
  };
  // Preisbereich exakt die 40 Zeilen der Bars auf heightPx
  const lo = 1000 * W;
  const hi = (1000 + N_ROWS) * W;
  const conv = (p: number) => heightPx - ((p * 100 - lo) / (hi - lo)) * heightPx;
  let ctx = new RecordingCtx();
  const draw = () => {
    ctx = new RecordingCtx();
    const c = ctx;
    const target = {
      useBitmapCoordinateSpace: (f: (s: unknown) => void) =>
        f({
          context: c,
          mediaSize: { width: 2000, height: heightPx },
          bitmapSize: { width: 4000, height: heightPx * 2 },
          horizontalPixelRatio: 2,
          verticalPixelRatio: 2,
        }),
    };
    r.draw(target as never, conv as never);
    return c;
  };
  ctx = draw();
  return { rc, ctx, draw };
}

describe('FootprintRenderer', () => {
  it('L2: zeichnet genau die sichtbaren Zellen, gebündelt (wenige fill-Aufrufe), ohne Text', () => {
    const { rc, ctx } = setup(300, 7, 400, [100, 150]); // rh = 10 px, 50 Bars sichtbar
    expect(rc.stats.lod).toBe(2);
    expect(rc.stats.cellsDrawn).toBe(50 * N_ROWS);
    expect(rc.stats.vc).toBe(50 * N_ROWS);
    expect(ctx.texts).toBe(0);
    expect(ctx.fills).toBeLessThanOrEqual(21);
    expect(ctx.rects).toBe(50 * N_ROWS + 50); // Zellen + POC-Rahmen
  });

  it('L3: Text je Zelle (vorformatiert)', () => {
    const { rc, ctx } = setup(300, 50, 600, [0, 20]); // rh 15 px, bs 50
    expect(rc.stats.lod).toBe(3);
    expect(ctx.texts).toBe(20 * N_ROWS);
    expect(rc.stats.textBars).toBe(20);
    expect(rc.stats.textsSkipped).toBe(0);
  });

  it('L3 schmal: zu lange Zahlen werden gekürzt statt den ganzen Bar auszublenden', () => {
    // bs 44 → Spalte ≈ 37,8 px − 2 px Rand ≈ 36 px → 5 Zeichen à 6,5 px passen, 6 nicht
    const { rc, ctx } = setup(300, 44, 600, [0, 20]);
    expect(rc.stats.lod).toBe(3);
    expect(ctx.texts).toBe(20 * N_ROWS); // nichts ausgelassen
    expect(rc.stats.textsShortened).toBeGreaterThan(0); // "-0.001" (6 Zeichen) → "-.001"
    expect(rc.stats.textsSkipped).toBe(0);
  });

  it('Zellbudget: über 25 000 geschätzten Zellen werden keine Zellen gezeichnet (Kerzen statt dessen)', () => {
    const { rc, ctx } = setup(700, 6, 400, [0, 700]); // 700 · 40 = 28 000 > 25 000
    expect(rc.stats.vc).toBe(28_000);
    expect(rc.stats.lod).toBe(1);
    expect(rc.stats.cellsDrawn).toBe(0);
    expect(rc.stats.budgetFallbacks).toBe(1);
    expect(ctx.fills).toBeLessThanOrEqual(2); // Kerzen: eine Füllung je Farbe
  });

  it('knapp unter dem Budget werden Zellen gezeichnet', () => {
    const { rc } = setup(700, 6, 400, [0, 625]); // 625 · 40 = 25 000
    expect(rc.stats.lod).toBe(2);
    expect(rc.stats.cellsDrawn).toBe(25_000);
    expect(rc.stats.maxVcWithCells).toBeLessThanOrEqual(25_000);
  });

  it('Bars ohne geladene Kachel werden als Kerzen gezeichnet (kein Warten aufs Netz)', () => {
    const { rc, draw } = setup(10, 7, 400, [0, 10]);
    expect(rc.stats.cellsDrawn).toBe(10 * N_ROWS);
    rc.series = 'X|1m|10'; // andere Zeilengröße, noch nichts geladen
    const ctx = draw();
    expect(rc.stats.lod).toBe(2);
    expect(rc.stats.cellsDrawn).toBe(0);
    expect(ctx.rects).toBe(20); // Docht + Körper je Bar
    expect(ctx.fills).toBe(1); // alle Bars steigend: eine Füllung
  });

  it('W6: nach einem R-Wechsel zeichnet die alte Größe, bis die neue geladen ist', () => {
    const { rc, draw } = setup(10, 7, 400, [0, 10]);
    rc.prev = { series: 'X|1m|5', n: 1024, width: W };
    rc.series = 'X|1m|10';
    rc.width = 2 * W;
    draw();
    expect(rc.stats.cellsDrawn).toBe(10 * N_ROWS); // aus der alten Größe
  });

  it('K2: Kachellänge passt nicht zur Anfrage → Kerzen statt leerer Bars (kein Absturz)', () => {
    const { rc, draw } = setup(10, 7, 400, [0, 10]);
    rc.n = 7; // falsche Kachellänge: nur die ersten 7 Bars treffen die Kachel, der Rest fällt auf Kerzen
    const ctx = draw();
    expect(rc.stats.cellsDrawn).toBe(7 * N_ROWS);
    expect(ctx.fills).toBeGreaterThan(0);
    // Slot-Index außerhalb der Tabelle (undefined) darf nicht als gültiger Bar gelten
    const tile = rc.store!.tiles('X|1m|5')!.get(0) as { slot: Int32Array };
    expect(tile.slot[5000]).toBeUndefined();
  });

  it('N2: zweiter R-Wechsel vor dem Laden behält die geladene Größe als Rückfall', () => {
    const A = { series: 'X|1m|5', n: 1024, width: W };
    const B = { series: 'X|1m|10', n: 1024, width: 2 * W };
    // A → B: A ist geladen → Rückfall A
    let prev = nextFallback(null, A, true, B.series);
    expect(prev).toEqual(A);
    // B → C, B noch nicht geladen → A bleibt Rückfall
    prev = nextFallback(prev, B, false, 'X|1m|20');
    expect(prev).toEqual(A);
    // zurück auf A → kein Rückfall nötig
    expect(nextFallback(prev, B, false, A.series)).toBeNull();
    // Renderer: Serie C leer, Rückfall A → Bars aus A gezeichnet
    const { rc, draw } = setup(10, 7, 400, [0, 10]);
    rc.prev = prev;
    rc.series = 'X|1m|20';
    draw();
    expect(rc.stats.cellsDrawn).toBe(10 * N_ROWS);
  });
});
