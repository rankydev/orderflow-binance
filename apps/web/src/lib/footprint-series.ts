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
import { colorIndex, colorIndexVolume, NEUTRAL_INDEX } from './color.ts';
import {
  imbalanceKey,
  IMB_BUY,
  IMB_BUY_STACK,
  IMB_SELL,
  IMB_SELL_STACK,
  stackZones,
  zoneTouch,
  type ImbalanceOptions,
} from './footprint-marks.ts';
import {
  tileImbalance,
  tileValueArea,
  type FootprintStore,
  type PreparedTile,
  type TileState,
} from './footprint-store.ts';
import {
  L2_MIN_BAR_SPACING,
  L2_MIN_ROW_HEIGHT,
  selectLod,
  VISIBLE_CELL_BUDGET,
  visibleCells,
} from './lod.ts';
import type { BarItem, ColorMode, ColorScope, FootprintMode, FootprintType, Lod } from './types.ts';

export type FpItem = BarItem & CustomData<Time>;

type Target = Parameters<ICustomSeriesPaneRenderer['draw']>[0];
type Scope = Parameters<Parameters<Target['useBitmapCoordinateSpace']>[0]>[0];

export const UP_COLOR = '#26a69a';
export const DOWN_COLOR = '#ef5350';
const POC_COLOR = '#f2c94c';
/** Bar-VA-Balken erst ab diesem Bar-Abstand (darunter läge er in der Nachbarspalte, H-3). */
export const BAR_VA_MIN_BS = 12;

// Marken im Footprint (P4): Indizes in die Markenbündel und ihre Farben
export const MK_DPOC_POS = 0;
export const MK_DPOC_NEG = 1;
export const MK_VA = 2;
export const MK_IMB_BUY = 3;
export const MK_IMB_SELL = 4;
export const MK_STACK_BUY = 5;
export const MK_STACK_SELL = 6;
export const MK_PROJ_BUY = 7;
export const MK_PROJ_SELL = 8;
export const MARK_STYLES: readonly string[] = [
  '#5ee7f0', // Delta-POC positiv (Rahmen)
  '#ff9a5c', // Delta-POC negativ (Rahmen)
  'rgba(200, 208, 225, 0.85)', // Value Area je Bar
  '#3cf0b4', // Buy-Imbalance
  '#ff5c7a', // Sell-Imbalance
  'rgba(60, 240, 180, 0.16)', // Stacked Buy (Zone)
  'rgba(255, 92, 122, 0.16)', // Stacked Sell (Zone)
  'rgba(60, 240, 180, 0.08)', // Stacked Buy (Projektion)
  'rgba(255, 92, 122, 0.08)', // Stacked Sell (Projektion)
];
/** Gefüllte Marken (die Delta-POC-Rahmen werden gestrichen). */
const MARK_FILLS = [
  MK_VA,
  MK_STACK_BUY,
  MK_STACK_SELL,
  MK_PROJ_BUY,
  MK_PROJ_SELL,
  MK_IMB_BUY,
  MK_IMB_SELL,
];
/** Zellschrift; die Palette ist so begrenzt, dass der Kontrast auf jeder Stufe ≥ 4,5 : 1 ist (W9). */
export const TEXT_COLOR = '#eef1f5';
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
  /** Box (Zahl in gefärbter Zelle) oder Profil (Balken je Zeile) */
  mode: FootprintMode = 'box';
  showPoc = true;
  showDeltaPoc = false;
  showBarVa = false;
  vaPct = 70;
  /** Imbalance-Optionen; null = aus */
  imbalance: ImbalanceOptions | null = null;
  colorMode: ColorMode = 'gradient';
  colorScope: ColorScope = 'visible';
  /** Farbreferenz (P95) über die sichtbaren Bars, am Gestenende/Laden berechnet. */
  colorRef = 1;
  /** Farbreferenz der Volumen-Hälfte (Typ Delta + Volume). */
  colorRef2 = 1;
  palette: string[] = [];
  /**
   * Vorige Zeilengröße nach einem R-Wechsel (W6): Bars, deren Kachel der neuen Größe noch fehlt, werden
   * mit der alten gezeichnet statt als Kerzen; der Controller löscht `prev`, sobald alle sichtbaren
   * Kacheln der neuen Größe da sind.
   */
  prev: Fallback | null = null;
  readonly stats = new FrameStats();
  onFirstFootprint: (() => void) | null = null;
}

export type Fallback = { series: string; n: number; width: number };

/**
 * Rückfall-Größe nach einem R-Wechsel (W6/N2): die bisherige Größe `current` nur übernehmen, wenn sie
 * im sichtbaren Bereich vollständig geladen ist; sonst die ältere `prev` behalten (die noch zeichnet).
 * Wechselt R auf die Rückfall-Größe selbst zurück, entfällt sie.
 */
export function nextFallback(
  prev: Fallback | null,
  current: Fallback,
  currentComplete: boolean,
  nextSeries: string,
): Fallback | null {
  const pick = currentComplete || !prev ? current : prev;
  return pick.series === nextSeries ? null : pick;
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
  fill(ctx: CanvasRenderingContext2D, styles: readonly string[], only?: readonly number[]): void {
    for (let c = 0; c < this.colors; c++) {
      if (only && !only.includes(c)) continue;
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

/** Texte eines Frames: Position, Wert (Lots), verfügbare Breite (Bitmap-px). */
class TextBatch {
  x = new Float64Array(1024);
  y = new Float64Array(1024);
  w = new Float64Array(1024);
  v = new Float64Array(1024);
  n = 0;
  push(x: number, y: number, v: number, w: number): void {
    if (this.n === this.x.length) {
      const g = (a: Float64Array) => {
        const b = new Float64Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.x = g(this.x);
      this.y = g(this.y);
      this.w = g(this.w);
      this.v = g(this.v);
    }
    this.x[this.n] = x;
    this.y[this.n] = y;
    this.w[this.n] = w;
    this.v[this.n] = v;
    this.n++;
  }
}

export class FootprintRenderer implements ICustomSeriesPaneRenderer {
  data: PaneRendererCustomData<Time, FpItem> | null = null;
  private readonly cells = new RectBatch(NEUTRAL_INDEX + 1);
  /** 0 = up, 1 = down, 2 = POC. */
  private readonly misc = new RectBatch(3);
  /** Marken: Delta-POC, VA, Imbalance, Stacked, Projektion (Indizes MK_*). */
  private readonly marks = new RectBatch(MARK_STYLES.length);
  private readonly texts = new TextBatch();
  private readonly rowsPerBar: number[] = [];
  private readonly fallback: number[] = [];
  private readonly highs: number[] = [];
  private readonly lows: number[] = [];
  /** sichtbare Bars als {h, l} (Projektion der Stacked-Zonen, ohne Kopie der Werte) */
  private readonly hl: { h: number; l: number }[] = [];

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
    this.hl.length = 0;
    for (let i = from; i < to; i++) {
      const it = d.bars[i]!.originalData;
      this.highs.push(it.h);
      this.lows.push(it.l);
      this.hl.push(it);
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
    const type = rc.type;
    const twoCol = type === 'bidask' || type === 'deltavol';
    const colW = bs * (twoCol ? 0.92 : 0.86) * hpr;
    const mode = rc.colorMode;
    const perBar = rc.colorScope === 'bar';
    const profile = rc.mode === 'profile';
    const imbOpts = rc.imbalance;
    this.cells.reset();
    this.misc.reset();
    this.marks.reset();
    this.texts.n = 0;
    this.rowsPerBar.length = 0;
    // Innenabstand der Zahl zur Zellkante (Bitmap-px), damit sie den Nachbarbar nie berührt.
    const pad = 2 * hpr;
    const mw = Math.max(1, Math.round(2 * hpr)); // Imbalance-Markierung
    const W = scope.bitmapSize.width;
    let cells = 0;
    let curK = Number.NaN;
    let curTile: PreparedTile | undefined;
    const prev = rc.prev;
    const prevTiles = prev ? store.tiles(prev.series) : undefined;
    const prevSpan = prev ? prev.n * rc.tfSec : 1;
    let prevK = Number.NaN;
    let prevTile: PreparedTile | undefined;
    const allBars = d.bars;
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
      // Farbreferenzen: erste Größe (Delta/Seiten/Volumen) und Volumen-Hälfte bei Delta + Volume
      const cref = perBar
        ? type === 'bidask'
          ? tile.refVol[bi]!
          : type === 'volume'
            ? tile.refTot[bi]!
            : tile.refDelta[bi]!
        : rc.colorRef;
      const cref2 = perBar ? tile.refTot[bi]! : rc.colorRef2;
      const row = tile.row;
      const buy = tile.buy;
      const sell = tile.sell;
      const pr = rc.showPoc ? tile.poc[bi]! : NaN;
      const dpr = rc.showDeltaPoc ? tile.deltaPoc[bi]! : NaN;
      const flags = imbOpts ? tileImbalance(tile, imbOpts) : null;
      // Profilmodus: Länge ∝ Wert / Max im Bar
      const mVol = tile.maxVol[bi]!;
      const mSide = tile.maxSide[bi]!;
      const mDelta = tile.maxAbsDelta[bi]!;
      const len = (v: number, max: number, full: number) =>
        v === 0 || max <= 0 ? 0 : Math.max(1, Math.round((Math.abs(v) / max) * full));
      for (let j = s; j < e; j++) {
        const r = row[j]!;
        if (r < rowMin || r > rowMax) continue;
        const yt = Math.round(yU((r + 1) * width));
        const yb = Math.round(yU(r * width));
        const h = Math.max(1, yb - yt - gap);
        const b = buy[j]!;
        const sl = sell[j]!;
        const ym = yt + h / 2;
        if (twoCol) {
          // links: Bid (Bid×Ask) bzw. Delta (Delta + Volume); rechts: Ask bzw. Volumen
          const lv = type === 'bidask' ? sl : b - sl;
          const rv = type === 'bidask' ? b : b + sl;
          const cl = colorIndex(lv, cref, type === 'bidask', mode);
          const cr =
            type === 'bidask'
              ? colorIndex(rv, cref, false, mode)
              : colorIndexVolume(rv, cref2, mode);
          if (!profile) {
            this.cells.push(cl, x0, yt, Math.max(1, xm - x0 - 1), h);
            this.cells.push(cr, xm, yt, Math.max(1, x1 - xm), h);
          } else if (type === 'bidask') {
            // Bid wächst von der Mitte nach links, Ask nach rechts (Länge ∝ Seite / größte Seite im Bar)
            const wl = len(lv, mSide, xm - x0 - 1);
            const wr = len(rv, mSide, x1 - xm);
            if (wl > 0) this.cells.push(cl, xm - 1 - wl, yt, wl, h);
            if (wr > 0) this.cells.push(cr, xm, yt, wr, h);
          } else {
            const wl = len(lv, mDelta, xm - x0 - 1);
            const wr = len(rv, mVol, x1 - xm);
            if (wl > 0) this.cells.push(cl, x0, yt, wl, h);
            if (wr > 0) this.cells.push(cr, xm, yt, wr, h);
          }
          if (lod === 3) {
            this.texts.push((x0 + xm) / 2, ym, lv, xm - x0 - pad);
            this.texts.push((xm + x1) / 2, ym, rv, x1 - xm - pad);
          }
        } else {
          const v = type === 'volume' ? b + sl : b - sl;
          const c =
            type === 'volume' ? colorIndexVolume(v, cref, mode) : colorIndex(v, cref, false, mode);
          if (!profile) this.cells.push(c, x0, yt, x1 - x0, h);
          else {
            const w = len(v, type === 'volume' ? mVol : mDelta, x1 - x0);
            if (w > 0) this.cells.push(c, x0, yt, w, h);
          }
          if (lod === 3) this.texts.push(xc, ym, v, x1 - x0 - pad);
        }
        if (r === pr) this.misc.push(2, x0 + 0.5, yt + 0.5, x1 - x0 - 1, h - 1);
        if (r === dpr) {
          // Delta-POC: eigener Rahmen innerhalb des POC-Rahmens, Farbe nach Vorzeichen
          const q = Math.max(1, Math.round(2 * hpr));
          this.marks.push(
            b - sl >= 0 ? MK_DPOC_POS : MK_DPOC_NEG,
            x0 + q + 0.5,
            yt + q + 0.5,
            x1 - x0 - 2 * q - 1,
            Math.max(1, h - 2 * q - 1),
          );
        }
        if (flags) {
          const f = flags[j]!;
          // Buy-Imbalance am rechten (Ask-)Rand, Sell-Imbalance am linken (Bid-)Rand; Stacked breiter
          if (f & IMB_BUY)
            this.marks.push(
              MK_IMB_BUY,
              x1 - (f & IMB_BUY_STACK ? 2 * mw : mw),
              yt,
              f & IMB_BUY_STACK ? 2 * mw : mw,
              h,
            );
          if (f & IMB_SELL)
            this.marks.push(MK_IMB_SELL, x0, yt, f & IMB_SELL_STACK ? 2 * mw : mw, h);
        }
        cells++;
        barRows++;
      }
      // Value Area je Bar: schmaler Balken links neben der Spalte (VAL … VAH)
      // H-3: unter BAR_VA_MIN_BS läge der Balken in der Nachbarspalte → ausgeblendet
      if (rc.showBarVa && bs >= BAR_VA_MIN_BS) {
        const [vlo, vhi] = tileValueArea(tile, rc.vaPct);
        const lo = vlo[bi]!;
        const hi = vhi[bi]!;
        if (lo >= 0) {
          const yt = Math.round(yU((Math.min(hi, rowMax) + 1) * width));
          const yb = Math.round(yU(Math.max(lo, rowMin) * width));
          if (yb > yt) this.marks.push(MK_VA, x0 - 2 * mw, yt, mw, yb - yt);
        }
      }
      // Stacked-Zonen: Fläche über der Spalte, nach rechts projiziert bis ein späterer Bar hineinhandelt
      if (flags) {
        for (const [lo, hi, side] of stackZones(row, flags, s, e)) {
          if (hi < rowMin || lo > rowMax) continue;
          const yt = Math.round(yU((hi + 1) * width));
          const yb = Math.round(yU(lo * width));
          this.marks.push(side === 0 ? MK_STACK_BUY : MK_STACK_SELL, x0, yt, x1 - x0, yb - yt);
          const touch = zoneTouch(this.hl, i + 1 - from, to - from, lo * width, (hi + 1) * width);
          const tIdx = touch < 0 ? -1 : touch + from;
          const xe = tIdx < 0 ? W : Math.round(allBars[tIdx]!.x * hpr - colW / 2);
          if (xe > x1)
            this.marks.push(side === 0 ? MK_PROJ_BUY : MK_PROJ_SELL, x1, yt, xe - x1, yb - yt);
        }
      }
      this.rowsPerBar.push(barRows);
    }
    // H-2: Stacked-Zonen von Bars links der Ansicht, deren Projektion noch in die Pane reicht
    if (imbOpts && tiles && from > 0)
      this.leftZones(d, from, tiles, span, imbOpts, unitBottom, unitTop, yU, hpr, colW, W);
    this.cells.fill(ctx, rc.palette);
    this.marks.fill(ctx, MARK_STYLES, MARK_FILLS);
    ctx.lineWidth = Math.max(1, Math.floor(vpr));
    ctx.strokeStyle = POC_COLOR;
    this.misc.stroke(ctx, 2);
    for (const m of [MK_DPOC_POS, MK_DPOC_NEG]) {
      ctx.strokeStyle = MARK_STYLES[m]!;
      this.marks.stroke(ctx, m);
    }
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
      const text = store.text;
      const tb = this.texts;
      ctx.fillStyle = TEXT_COLOR;
      for (let q = 0; q < tb.n; q++) {
        const v = tb.v[q]!;
        let str = text.full(v);
        if (str.length * charW > tb.w[q]!) {
          str = text.short(v);
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

  /** Projektionsende je Zone (Index in d.bars oder −1), gültig für `zoneVersion` (je Fenster/Option) */
  private readonly zoneEnd = new Map<string, number>();
  private zoneVersion = '';

  /**
   * Zonen links der Ansicht (H-2): Ursprungs-Bar im Fenster vor `from`; gezeichnet, wenn die Zone bis
   * mindestens `from` unberührt bleibt. Das Ende je Zone wird einmal je Fenster und Option gesucht
   * (bis zum Fensterende, früher Abbruch bei Berührung) und zwischengespeichert – nicht je Frame.
   */
  private leftZones(
    d: PaneRendererCustomData<Time, FpItem>,
    from: number,
    tiles: Map<number, TileState>,
    span: number,
    o: ImbalanceOptions,
    unitBottom: number,
    unitTop: number,
    yU: (u: number) => number,
    hpr: number,
    colW: number,
    W: number,
  ): void {
    const bars = d.bars;
    const n = bars.length;
    const version = `${this.rc.series}|${n}|${bars[0]!.originalData.t}|${bars[n - 1]!.originalData.t}|${imbalanceKey(o)}`;
    if (version !== this.zoneVersion) {
      this.zoneVersion = version;
      this.zoneEnd.clear();
    }
    const tFrom = bars[from]!.originalData.t;
    const k0 = Math.floor(bars[0]!.originalData.t / span);
    const k1 = Math.floor(tFrom / span);
    const idxOf = (t: number) => {
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (bars[m]!.originalData.t < t) lo = m + 1;
        else hi = m;
      }
      return lo < n && bars[lo]!.originalData.t === t ? lo : -1;
    };
    for (let k = k0; k <= k1; k++) {
      const st = tiles.get(k);
      if (!st || st === 'rejected') continue;
      const flags = tileImbalance(st, o);
      const w = st.width;
      for (let bi = 0; bi < st.nBars; bi++) {
        const t = st.time[bi]!;
        if (t >= tFrom) break;
        const s = st.levelOffset[bi]!;
        const e = st.levelOffset[bi + 1]!;
        let any = false;
        for (let j = s; j < e; j++) if (flags[j]! & (IMB_BUY_STACK | IMB_SELL_STACK)) any = true;
        if (!any) continue;
        const oi = idxOf(t);
        if (oi < 0) continue;
        for (const [lo, hi, side] of stackZones(st.row, flags, s, e)) {
          if ((hi + 1) * w <= unitBottom || lo * w > unitTop) continue;
          const key = zoneKey(t, lo, hi, side);
          let end = this.zoneEnd.get(key);
          if (end === undefined) {
            end = -1;
            for (let i = oi + 1; i < n; i++) {
              const b = bars[i]!.originalData;
              if (b.l < (hi + 1) * w && b.h >= lo * w) {
                end = i;
                break;
              }
            }
            this.zoneEnd.set(key, end);
          }
          if (end >= 0 && end <= from) continue; // vor der Ansicht berührt
          const xe = end < 0 ? W : Math.round(bars[end]!.x * hpr - colW / 2);
          const yt = Math.round(yU((hi + 1) * w));
          const yb = Math.round(yU(lo * w));
          if (xe > 0) this.marks.push(side === 0 ? MK_PROJ_BUY : MK_PROJ_SELL, 0, yt, xe, yb - yt);
        }
      }
    }
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

/** Schlüssel des Projektionsendes einer Zone: Ursprungs-Bar, Unter- UND Oberkante (eine neu geladene
 * Kachel kann bei gleicher Unterkante eine längere Zone haben), Seite. */
export function zoneKey(t: number, lo: number, hi: number, side: number): string {
  return `${t}|${lo}|${hi}|${side}`;
}
