// H4: Renderer gegen eine von Hand gerechnete Mini-Kachel – Koordinaten, Farben, Seiten, Texte, POC.
import { describe, expect, it } from 'vitest';
import { encodeTile, type TileData } from '@orderflow/core/browser';
import { INTENSITY_STEPS, NEUTRAL_INDEX, palette } from '../src/lib/color.ts';
import { FootprintStore } from '../src/lib/footprint-store.ts';
import {
  FootprintRenderer,
  MARK_STYLES,
  MK_DPOC_NEG,
  MK_IMB_BUY,
  MK_IMB_SELL,
  MK_PROJ_SELL,
  MK_STACK_SELL,
  MK_VA,
  RenderContext,
  type FpItem,
} from '../src/lib/footprint-series.ts';
import { IMBALANCE_DEFAULTS } from '../src/lib/footprint-marks.ts';
import type { FootprintType } from '../src/lib/types.ts';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  style: string;
  op: 'fill' | 'stroke';
}

/** Zeichnet Pfade auf: Rechtecke mit Füll-/Strichfarbe, Texte mit Inhalt und Position. */
class Ctx {
  rects: Rect[] = [];
  texts: { s: string; x: number; y: number; style: string }[] = [];
  private path: Omit<Rect, 'style' | 'op'>[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textAlign = '';
  textBaseline = '';
  beginPath() {
    this.path = [];
  }
  rect(x: number, y: number, w: number, h: number) {
    this.path.push({ x, y, w, h });
  }
  fill() {
    for (const p of this.path) this.rects.push({ ...p, style: this.fillStyle, op: 'fill' });
  }
  stroke() {
    for (const p of this.path) this.rects.push({ ...p, style: this.strokeStyle, op: 'stroke' });
  }
  fillText(s: string, x: number, y: number) {
    this.texts.push({ s, x, y, style: this.fillStyle });
  }
  measureText(t: string) {
    return { width: t.length * 12 };
  }
}

const W = 50; // R = 5 Ticks · 10
// Ein Bar, Zeilen 1000…1002: buy 3/1/0, sell 1/2/4 → Delta +2/−1/−4; Volumen 4/3/4 → POC-Gleichstand
// zwischen 1000 und 1002, gleich weit von der Mitte 1001 → die tiefere (1000).
function tile(): TileData {
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
      to: 32 * 60_000,
      tile: { index: 0, n: 32 },
      dataVersion: 'v',
      final: true,
    },
    bars: {
      time: Int32Array.of(0),
      open: Int32Array.of(1000 * W),
      high: Int32Array.of(1003 * W - 1),
      low: Int32Array.of(1000 * W),
      close: Int32Array.of(1003 * W - 1),
      buyQ: Float64Array.of(4),
      sellQ: Float64Array.of(7),
      buyA: Int32Array.of(0),
      sellA: Int32Array.of(0),
    },
    levels: {
      levelOffset: Int32Array.of(0, 3),
      row: Int32Array.of(1000, 1001, 1002),
      buy: Float64Array.of(3, 1, 0),
      sell: Float64Array.of(1, 2, 4),
      buyA: new Int32Array(3),
      sellA: new Int32Array(3),
    },
  };
}

function draw(type: FootprintType, over: Partial<RenderContext> = {}) {
  const rc = new RenderContext();
  const store = new FootprintStore(3);
  store.addEncoded('X|1m|5', encodeTile(tile()).buffer as ArrayBuffer);
  Object.assign(rc, {
    store,
    series: 'X|1m|5',
    n: 32,
    tfSec: 60,
    width: W,
    priceScale: 100,
    type,
    colorRef: 4,
    colorRef2: 4,
    ...over,
  });
  rc.palette = palette('gradient');
  const r = new FootprintRenderer(rc);
  const bs = 100;
  const it: FpItem = {
    time: 0 as FpItem['time'],
    t: 0,
    open: 500,
    high: 501.49,
    low: 500,
    close: 501.49,
    o: 50_000,
    h: 50_149,
    l: 50_000,
    c: 50_149,
    v: 11,
    b: 4,
    s: 7,
    ba: 0,
    sa: 0,
  };
  r.data = {
    bars: [{ x: 50, time: 0, originalData: it, barColor: '' }],
    barSpacing: bs,
    visibleRange: { from: 0, to: 1 },
    conflationFactor: 1,
  };
  // Preisbereich genau die drei Zeilen auf 300 CSS-px (100 px je Zeile), Bitmap ×2
  const lo = 1000 * W;
  const hi = 1003 * W;
  const H = 300;
  const conv = (p: number) => H - ((p * 100 - lo) / (hi - lo)) * H;
  const ctx = new Ctx();
  r.draw(
    {
      useBitmapCoordinateSpace: (f: (s: unknown) => void) =>
        f({
          context: ctx,
          mediaSize: { width: 200, height: H },
          bitmapSize: { width: 400, height: 2 * H },
          horizontalPixelRatio: 2,
          verticalPixelRatio: 2,
        }),
    } as never,
    conv as never,
  );
  return { ctx, rc };
}

const pal = palette('gradient');
const isBuy = (s: string) => pal.indexOf(s) >= 0 && pal.indexOf(s) < INTENSITY_STEPS;
const isSell = (s: string) =>
  pal.indexOf(s) >= INTENSITY_STEPS && pal.indexOf(s) < 2 * INTENSITY_STEPS;

describe('Renderer exakt (Mini-Kachel)', () => {
  it('Delta: Zeilenkanten, Vorzeichenfarbe, Texte, POC-Zeile', () => {
    const { ctx, rc } = draw('delta');
    expect(rc.stats.lod).toBe(3);
    const cells = ctx.rects.filter((r) => r.op === 'fill').sort((a, b) => b.y - a.y); // unten zuerst
    expect(cells).toHaveLength(3);
    // Zeile 1000 (unten): Bitmap y ∈ [400, 600), Abstand 2 px → Höhe 198
    expect(cells[0]).toMatchObject({ y: 400, h: 198 });
    expect(cells[1]).toMatchObject({ y: 200, h: 198 });
    expect(cells[2]).toMatchObject({ y: 0, h: 198 });
    expect(isBuy(cells[0]!.style)).toBe(true); // +2
    expect(isSell(cells[1]!.style)).toBe(true); // −1
    expect(isSell(cells[2]!.style)).toBe(true); // −4
    // Spalte 0,86 · 100 px um x = 50 → Bitmap [14, 186)
    expect(cells[0]).toMatchObject({ x: 14, w: 172 });
    const texts = [...ctx.texts].sort((a, b) => b.y - a.y).map((t) => t.s);
    expect(texts).toEqual(['0.002', '-0.001', '-0.004']);
    const poc = ctx.rects.filter((r) => r.op === 'stroke');
    expect(poc).toHaveLength(1);
    expect(poc[0]!.y).toBeCloseTo(400.5); // Zeile 1000
  });

  it('Bid×Ask: Bid (Verkäufer) links rot, Ask (Käufer) rechts grün, Texte je Hälfte', () => {
    const { ctx } = draw('bidask');
    const cells = ctx.rects.filter((r) => r.op === 'fill' && r.y === 400); // Zeile 1000
    const left = cells.reduce((a, b) => (a.x < b.x ? a : b));
    const right = cells.reduce((a, b) => (a.x > b.x ? a : b));
    expect(left.x).toBeLessThan(100); // Mitte x = 100 (Bitmap)
    expect(right.x).toBe(100);
    expect(isSell(left.style)).toBe(true);
    expect(isBuy(right.style)).toBe(true);
    const row = ctx.texts
      .filter((t) => t.y === 499)
      .sort((a, b) => a.x - b.x)
      .map((t) => t.s);
    expect(row).toEqual(['0.001', '0.003']); // sell 1 links, buy 3 rechts
    // Nullen werden als "0" geschrieben, neutral gefärbt
    const top = ctx.rects.filter((r) => r.op === 'fill' && r.y === 0);
    expect(top.some((r) => r.style === pal[NEUTRAL_INDEX])).toBe(true); // buy 0 → neutral
  });
});

const isVol = (s: string) =>
  pal.indexOf(s) >= 2 * INTENSITY_STEPS && pal.indexOf(s) < 3 * INTENSITY_STEPS;
const texts = (ctx: Ctx, y: number) =>
  ctx.texts
    .filter((t) => t.y === y)
    .sort((a, b) => a.x - b.x)
    .map((t) => t.s);

describe('Renderer exakt: Typen Volume und Delta + Volume, Profilmodus (P4)', () => {
  it('Volume: eine Zahl b + s je Zeile, Volumen-Farbton', () => {
    const { ctx } = draw('volume');
    const cells = ctx.rects.filter((r) => r.op === 'fill' && r.w === 172).sort((a, b) => b.y - a.y);
    expect(cells).toHaveLength(3);
    expect(cells.every((c) => isVol(c.style))).toBe(true);
    expect(texts(ctx, 499)).toEqual(['0.004']); // Zeile 1000: 3 + 1
    expect(texts(ctx, 299)).toEqual(['0.003']); // Zeile 1001: 1 + 2
    expect(texts(ctx, 99)).toEqual(['0.004']); // Zeile 1002: 0 + 4
  });

  it('Delta + Volume: Delta links (Vorzeichenfarbe), Volumen rechts (Volumen-Farbton)', () => {
    const { ctx } = draw('deltavol');
    expect(texts(ctx, 499)).toEqual(['0.002', '0.004']);
    expect(texts(ctx, 99)).toEqual(['-0.004', '0.004']);
    const row = ctx.rects.filter((r) => r.op === 'fill' && r.y === 400);
    const left = row.reduce((a, b) => (a.x < b.x ? a : b));
    const right = row.reduce((a, b) => (a.x > b.x ? a : b));
    expect(isBuy(left.style)).toBe(true); // +2
    expect(isVol(right.style)).toBe(true);
    expect(right.x).toBe(100);
  });

  it('Profilmodus Delta: Balken ab der linken Kante, Länge ∝ |Delta| / max |Delta| im Bar', () => {
    const { ctx } = draw('delta', { mode: 'profile' });
    const fills = ctx.rects.filter((r) => r.op === 'fill').sort((a, b) => b.y - a.y);
    // max |Delta| = 4; Spalte 172 px ab x = 14
    expect(fills.map((r) => [r.x, r.w])).toEqual([
      [14, 86], // +2 → 2/4
      [14, 43], // −1 → 1/4
      [14, 172], // −4 → 4/4
    ]);
  });

  it('Profilmodus Bid×Ask: Bid von der Mitte nach links, Ask nach rechts (∝ Seite / größte Seite)', () => {
    const { ctx } = draw('bidask', { mode: 'profile' });
    const row = ctx.rects.filter((r) => r.op === 'fill' && r.y === 400); // sell 1, buy 3, max Seite 4
    const left = row.find((r) => r.x < 100)!;
    const right = row.find((r) => r.x >= 100)!;
    // linke Hälfte xm − x0 − 1 = 100 − 8 − 1 = 91 px (Spalte 0,92 · 100 → x0 = 8)
    expect(left.w).toBe(Math.round((1 / 4) * 91));
    expect(left.x + left.w).toBe(99);
    expect(right).toMatchObject({ x: 100, w: Math.round((3 / 4) * 92) });
  });
});

describe('Renderer exakt: Marken (P4)', () => {
  const marks = (ctx: Ctx, i: number) => ctx.rects.filter((r) => r.style === MARK_STYLES[i]);

  it('ohne includeZero keine Imbalance (Mini-Kachel); POC aus → kein Rahmen', () => {
    const { ctx } = draw('delta', { imbalance: { ...IMBALANCE_DEFAULTS }, showPoc: false });
    expect(marks(ctx, MK_IMB_BUY)).toHaveLength(0);
    expect(marks(ctx, MK_IMB_SELL)).toHaveLength(0);
    expect(ctx.rects.filter((r) => r.op === 'stroke')).toHaveLength(0);
  });

  it('includeZero + Stacked ab 2: Sell 1001/1002 als Stack (Rand breiter), Zone und Projektion', () => {
    const { ctx } = draw('delta', {
      imbalance: { ...IMBALANCE_DEFAULTS, includeZero: true, stack: 2 },
    });
    // Buy in der untersten Zeile (fehlende Vergleichszeile, includeZero): rechter Rand, 4 px
    expect(marks(ctx, MK_IMB_BUY)).toEqual([
      { x: 182, y: 400, w: 4, h: 198, style: MARK_STYLES[MK_IMB_BUY], op: 'fill' },
    ]);
    // Sell 1001 (Gegenseite 0) und 1002 (oberste Zeile): linker Rand, gestapelt 8 px
    const sells = marks(ctx, MK_IMB_SELL).sort((a, b) => a.y - b.y);
    expect(sells.map((r) => [r.x, r.y, r.w])).toEqual([
      [14, 0, 8],
      [14, 200, 8],
    ]);
    expect(marks(ctx, MK_STACK_SELL)).toEqual([
      { x: 14, y: 0, w: 172, h: 400, style: MARK_STYLES[MK_STACK_SELL], op: 'fill' },
    ]);
    // keine späteren Bars → Projektion bis zum rechten Rand (Bitmap 400)
    expect(marks(ctx, MK_PROJ_SELL)).toEqual([
      { x: 186, y: 0, w: 214, h: 400, style: MARK_STYLES[MK_PROJ_SELL], op: 'fill' },
    ]);
  });

  it('Delta-POC (−4 in Zeile 1002, orange Rahmen innen) und Bar-VA [1000, 1002] links der Spalte', () => {
    const { ctx } = draw('delta', { showDeltaPoc: true, showBarVa: true, vaPct: 70 });
    expect(marks(ctx, MK_DPOC_NEG)).toEqual([
      { x: 18.5, y: 4.5, w: 163, h: 189, style: MARK_STYLES[MK_DPOC_NEG], op: 'stroke' },
    ]);
    expect(marks(ctx, MK_VA)).toEqual([
      { x: 6, y: 0, w: 4, h: 600, style: MARK_STYLES[MK_VA], op: 'fill' },
    ]);
  });
});

describe('Renderer exakt: Stacked-Zone eines Bars links der Ansicht (H-2)', () => {
  it('unberührt → Projektion vom linken Rand bis zum rechten Rand', () => {
    const t = tile();
    // zweiter Bar (t = 60 s) weit oberhalb der Zone: Zeile 1010
    t.bars = {
      time: Int32Array.of(0, 60),
      open: Int32Array.of(1000 * W, 1010 * W),
      high: Int32Array.of(1003 * W - 1, 1011 * W - 1),
      low: Int32Array.of(1000 * W, 1010 * W),
      close: Int32Array.of(1003 * W - 1, 1011 * W - 1),
      buyQ: Float64Array.of(4, 1),
      sellQ: Float64Array.of(7, 1),
      buyA: new Int32Array(2),
      sellA: new Int32Array(2),
    };
    t.levels = {
      levelOffset: Int32Array.of(0, 3, 4),
      row: Int32Array.of(1000, 1001, 1002, 1010),
      buy: Float64Array.of(3, 1, 0, 1),
      sell: Float64Array.of(1, 2, 4, 1),
      buyA: new Int32Array(4),
      sellA: new Int32Array(4),
    };
    const rc = new RenderContext();
    const store = new FootprintStore(3);
    store.addEncoded('X|1m|5', encodeTile(t).buffer as ArrayBuffer);
    Object.assign(rc, {
      store,
      series: 'X|1m|5',
      n: 32,
      tfSec: 60,
      width: W,
      priceScale: 100,
      type: 'delta',
      colorRef: 4,
      imbalance: { ...IMBALANCE_DEFAULTS, includeZero: true, stack: 2 },
    });
    rc.palette = palette('gradient');
    const r = new FootprintRenderer(rc);
    const mk = (time: number, h: number, l: number): FpItem => ({
      time: time as FpItem['time'],
      t: time,
      open: l / 100,
      high: h / 100,
      low: l / 100,
      close: h / 100,
      o: l,
      h,
      l,
      c: h,
      v: 2,
      b: 1,
      s: 1,
      ba: 0,
      sa: 0,
    });
    r.data = {
      bars: [
        { x: -50, time: 0, originalData: mk(0, 1003 * W - 1, 1000 * W), barColor: '' },
        { x: 150, time: 60, originalData: mk(60, 1011 * W - 1, 1010 * W), barColor: '' },
      ],
      barSpacing: 100,
      visibleRange: { from: 1, to: 2 },
      conflationFactor: 1,
    };
    const lo = 1000 * W;
    const hi = 1003 * W;
    const conv = (p: number) => 300 - ((p * 100 - lo) / (hi - lo)) * 300;
    const ctx = new Ctx();
    r.draw(
      {
        useBitmapCoordinateSpace: (f: (s: unknown) => void) =>
          f({
            context: ctx,
            mediaSize: { width: 200, height: 300 },
            bitmapSize: { width: 400, height: 600 },
            horizontalPixelRatio: 2,
            verticalPixelRatio: 2,
          }),
      } as never,
      conv as never,
    );
    expect(ctx.rects.filter((x) => x.style === MARK_STYLES[MK_PROJ_SELL])).toEqual([
      { x: 0, y: 0, w: 400, h: 400, style: MARK_STYLES[MK_PROJ_SELL], op: 'fill' },
    ]);
  });
});
