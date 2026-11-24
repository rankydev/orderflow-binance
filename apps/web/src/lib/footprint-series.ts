// Footprint als Custom Series für lightweight-charts 5.x (KONZEPT §7.1, §7.2). Der Renderer zeichnet
// nur sichtbare Bars und nur Zeilen im sichtbaren Preisbereich, entscheidet die Detailstufe je Frame
// (billig: Bar-Abstand, Zeilenhöhe, geschätzte Zellen) und erzwingt das Zellbudget: über 25 000
// geschätzten sichtbaren Zellen werden keine Zellen gezeichnet, sondern Kerzen. Zellen werden je
// Farbstufe gebündelt (ein fillStyle je Stufe), Texte sind vorformatiert (Index in die Texttabelle).
import {
  customSeriesDefaultOptions,
  type CustomData,
  type CustomSeriesOptions,
  type CustomSeriesPricePlotValues,
  type CustomSeriesWhitespaceData,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type Time,
} from 'lightweight-charts';
import { colorIndex, INTENSITY_STEPS, NEUTRAL_INDEX } from './color.ts';
import type { FootprintStore, PreparedTile } from './footprint-store.ts';
import {
  L2_MIN_BAR_SPACING,
  L2_MIN_ROW_HEIGHT,
  selectLod,
  VISIBLE_CELL_BUDGET,
  visibleCells,
} from './lod.ts';
import type { BarItem, ColorMode, ColorScope, FootprintType, Lod } from './types.ts';

export type FpItem = BarItem & CustomData<Time>;

type Target = Parameters<ICustomSeriesPaneRenderer['draw']>[0];
type Scope = Parameters<Parameters<Target['useBitmapCoordinateSpace']>[0]>[0];

export const UP_COLOR = '#26a69a';
export const DOWN_COLOR = '#ef5350';
const POC_COLOR = '#f2c94c';
const TEXT_LIGHT = '#eef1f5';
/** Dunkle Schrift auf kräftigen Zellen (Kontrast), ab dieser Intensitätsstufe. */
const TEXT_DARK = '#0b0e13';
const DARK_TEXT_FROM_STEP = 6;
const DRAW_RING = 4096;

/** Laufende Messwerte je Frame (für Anzeige und Playwright-Messung; nicht reaktiv). */
export class FrameStats {
  lod: Lod = 1;
  vc = 0;
  rh = 0;
  bs = 0;
  cellsDrawn = 0;
  lastDrawMs = 0;
  frames = 0;
  /** Größtes vc in einem Frame, der Zellen gezeichnet hat (muss ≤ 25 000 bleiben). */
  maxVcWithCells = 0;
  maxCellsDrawn = 0;
  readonly drawMs = new Float64Array(DRAW_RING);
  /** Frames je Stufe (Index 1–3). */
  readonly lodFrames = [0, 0, 0, 0];
  /** Frames, die nur wegen vc > 25 000 Kerzen statt Zellen zeichneten (Budget greift). */
  budgetFallbacks = 0;
  /** Letzter Frame: Bars mit Zellen, Bars mit Zahlen, Texte (gezeichnet/gekürzt/ausgelassen), sichtbare Zeilen je Bar. */
  barsWithCells = 0;
  textBars = 0;
  textsDrawn = 0;
  textsShortened = 0;
  textsSkipped = 0;
  rowsPerBar: readonly number[] = [];
  firstFootprintAt = 0;

  record(ms: number): void {
    this.lastDrawMs = ms;
    this.drawMs[this.frames % DRAW_RING] = ms;
    this.frames++;
  }
}

/** Vom Controller gesetzter Zeichenzustand (keine Reaktivität, kein Kopieren je Frame). */
export class RenderContext {
  store: FootprintStore | null = null;
  /** sym|tf|R der aktuellen Kacheln. */
  series = '';
  n = 1;
  tfSec = 60;
  /** Zeilenbreite in price_unit (R · tick_ref_units). */
  width = 1;
  /** 10^priceDecimals. */
  priceScale = 100;
  type: FootprintType = 'delta';
  colorMode: ColorMode = 'gradient';
  colorScope: ColorScope = 'visible';
  /** Farbreferenz (P95) über die sichtbaren Bars, am Gestenende/Laden berechnet. */
  colorRef = 1;
  palette: string[] = [];
  /**
   * Vorige Zeilengröße nach einem R-Wechsel (W6): Bars, deren Kachel der neuen Größe noch fehlt, werden
   * mit der alten gezeichnet statt als Kerzen; der Controller löscht `prev`, sobald alle sichtbaren
   * Kacheln der neuen Größe da sind.
   */
  prev: { series: string; n: number; width: number } | null = null;
  readonly stats = new FrameStats();
  onFirstFootprint: (() => void) | null = null;
}

/** Wachsender Rechteckpuffer je Farbe (x, y, w, h in Bitmap-px). */
class RectBatch {
  private data: Float64Array[] = [];
  private count: Int32Array;
  readonly colors: number;
  constructor(colors: number) {
    this.colors = colors;
    this.count = new Int32Array(colors);
    for (let i = 0; i < colors; i++) this.data.push(new Float64Array(256));
  }
  reset(): void {
    this.count.fill(0);
  }
  push(c: number, x: number, y: number, w: number, h: number): void {
    let a = this.data[c]!;
    const n = this.count[c]!;
    if (n * 4 + 4 > a.length) {
      const b = new Float64Array(a.length * 2);
      b.set(a);
      this.data[c] = a = b;
    }
    a[n * 4] = x;
    a[n * 4 + 1] = y;
    a[n * 4 + 2] = w;
    a[n * 4 + 3] = h;
    this.count[c] = n + 1;
  }
  fill(ctx: CanvasRenderingContext2D, styles: readonly string[]): void {
    for (let c = 0; c < this.colors; c++) {
      const n = this.count[c]!;
      if (n === 0) continue;
      const a = this.data[c]!;
      ctx.fillStyle = styles[c]!;
      ctx.beginPath();
      for (let i = 0; i < n; i++) ctx.rect(a[i * 4]!, a[i * 4 + 1]!, a[i * 4 + 2]!, a[i * 4 + 3]!);
      ctx.fill();
    }
  }
  stroke(ctx: CanvasRenderingContext2D, c: number): void {
    const n = this.count[c]!;
    if (n === 0) return;
    const a = this.data[c]!;
    ctx.beginPath();
    for (let i = 0; i < n; i++) ctx.rect(a[i * 4]!, a[i * 4 + 1]!, a[i * 4 + 2]!, a[i * 4 + 3]!);
    ctx.stroke();
  }
}

/** Texte eines Frames: Position, Text-Index, verfügbare Breite (Bitmap-px), dunkle Schrift ja/nein. */
class TextBatch {
  x = new Float64Array(1024);
  y = new Float64Array(1024);
  w = new Float64Array(1024);
  s = new Int32Array(1024);
  dark = new Uint8Array(1024);
  n = 0;
  push(x: number, y: number, s: number, w: number, dark: boolean): void {
    if (this.n === this.x.length) {
      const g = <T extends Float64Array | Int32Array | Uint8Array>(a: T, mk: (n: number) => T) => {
        const b = mk(a.length * 2);
        b.set(a);
        return b;
      };
      this.x = g(this.x, (n) => new Float64Array(n));
      this.y = g(this.y, (n) => new Float64Array(n));
      this.w = g(this.w, (n) => new Float64Array(n));
      this.s = g(this.s, (n) => new Int32Array(n));
      this.dark = g(this.dark, (n) => new Uint8Array(n));
    }
    this.x[this.n] = x;
    this.y[this.n] = y;
    this.w[this.n] = w;
    this.s[this.n] = s;
    this.dark[this.n] = dark ? 1 : 0;
    this.n++;
  }
}

/** Dunkle Schrift, wenn die Zellfarbe kräftig ist (Stufe ≥ DARK_TEXT_FROM_STEP, nicht neutral). */
function darkText(ci: number, mode: ColorMode): boolean {
  if (mode === 'off' || ci === NEUTRAL_INDEX) return false;
  return ci % INTENSITY_STEPS >= DARK_TEXT_FROM_STEP;
}

export class FootprintRenderer implements ICustomSeriesPaneRenderer {
  data: PaneRendererCustomData<Time, FpItem> | null = null;
  private readonly cells = new RectBatch(NEUTRAL_INDEX + 1);
  /** 0 = up, 1 = down, 2 = POC. */
  private readonly misc = new RectBatch(3);
  private readonly texts = new TextBatch();
  private readonly rowsPerBar: number[] = [];
  private readonly fallback: number[] = [];
  private readonly highs: number[] = [];
  private readonly lows: number[] = [];

  readonly rc: RenderContext;
  constructor(rc: RenderContext) {
    this.rc = rc;
  }

  draw(target: Target, priceToCoordinate: PriceToCoordinateConverter): void {
    const t0 = performance.now();
    target.useBitmapCoordinateSpace((scope) => this.drawImpl(scope, priceToCoordinate));
    this.rc.stats.record(performance.now() - t0);
  }

  private drawImpl(scope: Scope, conv: PriceToCoordinateConverter): void {
    const d = this.data;
    const rc = this.rc;
    const st = rc.stats;
    if (!d || !d.visibleRange || d.bars.length === 0) return;
    const from = Math.max(0, d.visibleRange.from);
    const to = Math.min(d.bars.length, d.visibleRange.to);
    if (to <= from) return;
    // Affine Abbildung price_unit → y (CSS-px), aus zwei Stützstellen je Frame (lineare Preisskala).
    const ref = d.bars[from]!.originalData.h;
    const yA = conv(ref / rc.priceScale);
    const yB = conv((ref + 1000) / rc.priceScale);
    if (yA === null || yB === null || yA === yB) return;
    const A = (yB - yA) / 1000;
    const B = yA - A * ref;
    const H = scope.mediaSize.height;
    const unitTop = (0 - B) / A;
    const unitBottom = (H - B) / A;
    const bs = d.barSpacing;
    const width = rc.width;
    const rh = -A * width;
    this.highs.length = 0;
    this.lows.length = 0;
    for (let i = from; i < to; i++) {
      const it = d.bars[i]!.originalData;
      this.highs.push(it.h);
      this.lows.push(it.l);
    }
    const vc = visibleCells(
      {
        highs: this.highs,
        lows: this.lows,
        from: 0,
        to: this.highs.length - 1,
        unitBottom,
        unitTop,
        pxPerUnit: -A,
      },
      width,
    );
    const lod = rc.store ? selectLod({ bs, rh, vc, type: rc.type }) : 1;
    st.lod = lod;
    st.lodFrames[lod]!++;
    if (
      lod === 1 &&
      vc > VISIBLE_CELL_BUDGET &&
      bs >= L2_MIN_BAR_SPACING &&
      rh >= L2_MIN_ROW_HEIGHT
    )
      st.budgetFallbacks++;
    st.vc = vc;
    st.rh = rh;
    st.bs = bs;
    const ctx = scope.context;
    const hpr = scope.horizontalPixelRatio;
    const vpr = scope.verticalPixelRatio;
    const yU = (u: number) => (A * u + B) * vpr;
    this.fallback.length = 0;
    if (lod === 1) {
      for (let i = from; i < to; i++) this.fallback.push(i);
      st.cellsDrawn = 0;
      st.barsWithCells = 0;
      st.textBars = 0;
      st.textsDrawn = 0;
      st.rowsPerBar = [];
      this.drawCandles(ctx, d, hpr, yU);
      return;
    }
    const store = rc.store!;
    const tiles = store.tiles(rc.series);
    const span = rc.n * rc.tfSec;
    const colW = bs * (rc.type === 'bidask' ? 0.92 : 0.86) * hpr;
    const bid = rc.type === 'bidask';
    const mode = rc.colorMode;
    const perBar = rc.colorScope === 'bar';
    this.cells.reset();
    this.misc.reset();
    this.texts.n = 0;
    this.rowsPerBar.length = 0;
    // Innenabstand der Zahl zur Zellkante (Bitmap-px), damit sie den Nachbarbar nie berührt.
    const pad = 2 * hpr;
    let cells = 0;
    let curK = Number.NaN;
    let curTile: PreparedTile | undefined;
    const prev = rc.prev;
    const prevTiles = prev ? store.tiles(prev.series) : undefined;
    const prevSpan = prev ? prev.n * rc.tfSec : 1;
    let prevK = Number.NaN;
    let prevTile: PreparedTile | undefined;
    for (let i = from; i < to; i++) {
      const bar = d.bars[i]!;
      const t = bar.originalData.t;
      const k = Math.floor(t / span);
      if (k !== curK) {
        curK = k;
        const s = tiles?.get(k);
        curTile = s && s !== 'rejected' ? s : undefined;
        if (curTile) store.touch(curTile);
      }
      let tile = curTile;
      let bi = tile ? tile.slot[(t - tile.fromSec) / rc.tfSec] : undefined;
      let width = rc.width;
      // !(bi >= 0) fängt auch undefined (Slot außerhalb der Kachel) ab (K2)
      if (!(bi !== undefined && bi >= 0) && prev) {
        const pk = Math.floor(t / prevSpan);
        if (pk !== prevK) {
          prevK = pk;
          const s = prevTiles?.get(pk);
          prevTile = s && s !== 'rejected' ? s : undefined;
        }
        tile = prevTile;
        bi = tile ? tile.slot[(t - tile.fromSec) / rc.tfSec] : undefined;
        width = prev.width;
      }
      if (!tile || !(bi !== undefined && bi >= 0)) {
        this.fallback.push(i);
        continue;
      }
      const rowMin = Math.floor(unitBottom / width);
      const rowMax = Math.floor(unitTop / width);
      const gap = -A * width * vpr >= 5 ? Math.max(1, Math.floor(vpr)) : 0;
      const xc = bar.x * hpr;
      const x0 = Math.round(xc - colW / 2);
      const x1 = Math.max(x0 + 1, Math.round(xc + colW / 2));
      const xm = Math.round(xc);
      const s = tile.levelOffset[bi]!;
      const e = tile.levelOffset[bi + 1]!;
      let barRows = 0;
      const cref = perBar ? (bid ? tile.refVol[bi]! : tile.refDelta[bi]!) : rc.colorRef;
      const row = tile.row;
      const buy = tile.buy;
      const sell = tile.sell;
      const pr = tile.poc[bi]!;
      for (let j = s; j < e; j++) {
        const r = row[j]!;
        if (r < rowMin || r > rowMax) continue;
        const yt = Math.round(yU((r + 1) * width));
        const yb = Math.round(yU(r * width));
        const h = Math.max(1, yb - yt - gap);
        const b = buy[j]!;
        const sl = sell[j]!;
        const ym = yt + h / 2;
        if (bid) {
          const cs = colorIndex(sl, cref, true, mode);
          const cb = colorIndex(b, cref, false, mode);
          this.cells.push(cs, x0, yt, Math.max(1, xm - x0 - 1), h);
          this.cells.push(cb, xm, yt, Math.max(1, x1 - xm), h);
          if (lod === 3) {
            this.texts.push((x0 + xm) / 2, ym, tile.txtSell[j]!, xm - x0 - pad, darkText(cs, mode));
            this.texts.push((xm + x1) / 2, ym, tile.txtBuy[j]!, x1 - xm - pad, darkText(cb, mode));
          }
        } else {
          const cd = colorIndex(b - sl, cref, false, mode);
          this.cells.push(cd, x0, yt, x1 - x0, h);
          if (lod === 3)
            this.texts.push(xc, ym, tile.txtDelta[j]!, x1 - x0 - pad, darkText(cd, mode));
        }
        if (r === pr) this.misc.push(2, x0 + 0.5, yt + 0.5, x1 - x0 - 1, h - 1);
        cells++;
        barRows++;
      }
      this.rowsPerBar.push(barRows);
    }
    this.cells.fill(ctx, rc.palette);
    ctx.lineWidth = Math.max(1, Math.floor(vpr));
    ctx.strokeStyle = POC_COLOR;
    this.misc.stroke(ctx, 2);
    st.textsDrawn = 0;
    st.textsShortened = 0;
    st.textsSkipped = 0;
    if (this.texts.n > 0) {
      // 10 px, ab 18 px Zeilenhöhe 11 px; Breite je Zeichen einmal je Frame gemessen (Monospace).
      const fontPx = rh >= 18 ? 11 : 10;
      ctx.font = `${Math.round(fontPx * vpr)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const charW = ctx.measureText('0').width;
      const full = store.text.strings;
      const short = store.text.short;
      const tb = this.texts;
      for (const dark of [0, 1]) {
        ctx.fillStyle = dark ? TEXT_DARK : TEXT_LIGHT;
        for (let q = 0; q < tb.n; q++) {
          if (tb.dark[q] !== dark) continue;
          const id = tb.s[q]!;
          let str = full[id]!;
          if (str.length * charW > tb.w[q]!) {
            str = short[id]!;
            if (str.length * charW > tb.w[q]!) {
              st.textsSkipped++; // nur diese Zahl passt nicht; der Rest des Bars bleibt beschriftet
              continue;
            }
            st.textsShortened++;
          }
          ctx.fillText(str, tb.x[q]!, tb.y[q]!);
          st.textsDrawn++;
        }
      }
    }
    st.cellsDrawn = cells;
    st.barsWithCells = this.rowsPerBar.length;
    st.textBars = lod === 3 ? this.rowsPerBar.length : 0;
    st.rowsPerBar = this.rowsPerBar;
    if (cells > 0) {
      if (vc > st.maxVcWithCells) st.maxVcWithCells = vc;
      if (cells > st.maxCellsDrawn) st.maxCellsDrawn = cells;
      if (st.firstFootprintAt === 0) {
        st.firstFootprintAt = performance.now();
        rc.onFirstFootprint?.();
      }
    }
    if (this.fallback.length > 0) this.drawCandles(ctx, d, hpr, yU);
  }

  /** Kerzen für die Bars in `fallback` (L1 oder Bars ohne geladene Kachel), zwei Füllungen insgesamt. */
  private drawCandles(
    ctx: CanvasRenderingContext2D,
    d: PaneRendererCustomData<Time, FpItem>,
    hpr: number,
    yU: (u: number) => number,
  ): void {
    const m = this.misc;
    m.reset();
    const bodyW = Math.max(1, Math.floor(d.barSpacing * 0.7 * hpr));
    const wickW = Math.max(1, Math.floor(hpr));
    for (const i of this.fallback) {
      const bar = d.bars[i]!;
      const it = bar.originalData;
      const c = it.c >= it.o ? 0 : 1;
      const xc = Math.round(bar.x * hpr);
      const yh = Math.round(yU(it.h));
      const yl = Math.round(yU(it.l));
      const yo = Math.round(yU(it.o));
      const yc = Math.round(yU(it.c));
      m.push(c, xc - Math.floor(wickW / 2), yh, wickW, Math.max(1, yl - yh));
      if (bodyW > wickW)
        m.push(
          c,
          xc - Math.floor(bodyW / 2),
          Math.min(yo, yc),
          bodyW,
          Math.max(1, Math.abs(yo - yc)),
        );
    }
    m.fill(ctx, [UP_COLOR, DOWN_COLOR, POC_COLOR]);
  }
}

export class FootprintSeriesView implements ICustomSeriesPaneView<
  Time,
  FpItem,
  CustomSeriesOptions
> {
  private readonly r: FootprintRenderer;
  constructor(rc: RenderContext) {
    this.r = new FootprintRenderer(rc);
  }
  renderer(): FootprintRenderer {
    return this.r;
  }
  update(data: PaneRendererCustomData<Time, FpItem>): void {
    this.r.data = data;
  }
  priceValueBuilder(item: FpItem): CustomSeriesPricePlotValues {
    return [item.low, item.high, item.close];
  }
  isWhitespace(
    item: FpItem | CustomSeriesWhitespaceData<Time>,
  ): item is CustomSeriesWhitespaceData<Time> {
    return (item as Partial<FpItem>).close === undefined;
  }
  defaultOptions(): CustomSeriesOptions {
    return { ...customSeriesDefaultOptions, lastValueVisible: false, priceLineVisible: false };
  }
}
