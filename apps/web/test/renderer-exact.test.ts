// H4: Renderer gegen eine von Hand gerechnete Mini-Kachel – Koordinaten, Farben, Seiten, Texte, POC.
import { describe, expect, it } from 'vitest';
import { encodeTile, type TileData } from '@orderflow/core/browser';
import { INTENSITY_STEPS, palette } from '../src/lib/color.ts';
import { FootprintStore } from '../src/lib/footprint-store.ts';
import { FootprintRenderer, RenderContext, type FpItem } from '../src/lib/footprint-series.ts';

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

function draw(type: 'delta' | 'bidask') {
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
    expect(top.some((r) => r.style === pal[2 * INTENSITY_STEPS])).toBe(true); // buy 0 → neutral
  });
});
