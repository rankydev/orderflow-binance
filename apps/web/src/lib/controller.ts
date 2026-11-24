// Chart-Steuerung (KONZEPT §5.4, §7.2, §7.3). Hält alle Chartdaten außerhalb der Svelte-Reaktivität
// (Typed Arrays in BarStore/FootprintStore, ein Item-Array je Datenfenster). Regeln, die die Fehler des
// Vorgängers strukturell ausschließen:
//  - Pannen/Zoomen ändert nur den sichtbaren Bereich der Bibliothek; Daten werden nie je Frame neu
//    aggregiert. setData nur bei Fensterwechsel (Gestenende/Ankunft, tf-/Symbolwechsel), Fenster
//    begrenzt (Footprint ≤ 5 000, Kerzen ≤ 20 000 Bars).
//  - Bedarfsberechnung höchstens einmal je Animation-Frame; Zeichnen macht die Bibliothek (ein
//    Frame, eigenes Canvas gibt es nicht); Mausbewegungen lösen hier nichts aus.
//  - Zeilengröße und Modus (Footprint/Kerzen) ändern sich nur am Gestenende (Debounce 150 ms).
//  - Kacheln: sichtbar + Padding + Prefetch, höchstens 4 parallel, Abbruch beim Verlassen des Bedarfs,
//    LRU nach Zellen; 4xx endgültig, Fehler mit Backoff (keine Nachladeschleifen).
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts';
import { ApiClient } from './api.ts';
import {
  BarStore,
  CANDLE_WINDOW_BARS,
  FOOTPRINT_WINDOW_BARS,
  indexAtOrAfter,
} from './bar-store.ts';
import { palette, quantileInPlace, COLOR_REF_PERCENTILE } from './color.ts';
import { FootprintStore, type PreparedTile } from './footprint-store.ts';
import {
  DOWN_COLOR,
  FootprintSeriesView,
  RenderContext,
  UP_COLOR,
  type FpItem,
} from './footprint-series.ts';
import {
  adjustRowSize,
  GESTURE_DEBOUNCE_MS,
  initialRowSize,
  L2_MIN_BAR_SPACING,
  MANUAL_R_TOO_FINE,
  rowHeightPx,
  selectLod,
  visibleCells,
  wantsFootprintMode,
  type ViewGeometry,
} from './lod.ts';
import { RequestQueue, type Want } from './request-queue.ts';
import { BAR_CHUNK_BARS, chunkIndexAt, chunkSpanSec, wantedTiles, windowChunks } from './tiles.ts';
import type { BarItem, ColorMode, ColorScope, FootprintType, Lod, SymbolInfo } from './types.ts';
import { tfSeconds } from '@orderflow/core/browser';

export type Mode = 'footprint' | 'candle';

export interface Readout {
  sym: string;
  tf: string;
  R: number;
  rAuto: boolean;
  mode: Mode;
  lod: Lod;
  visibleCells: number;
  cellsDrawn: number;
  lastFrameMs: number;
  barSpacing: number;
  rowHeight: number;
  windowBars: number;
  hint: string;
  requests: number;
  inFlight: number;
  aborted: number;
  fpTiles: number;
  fpCells: number;
  barChunks: number;
}

interface Anchor {
  centerSec: number;
  logicalWidth: number;
  /** Startansicht: rechter Datenrand, ≤ 200 Bars bei Bar-Abstand ≥ 7 px. */
  initial?: boolean;
}

export class ChartController {
  readonly chart: IChartApi;
  private readonly candle: ISeriesApi<'Candlestick'>;
  private readonly fp: ISeriesApi<'Custom', Time, FpItem | WhitespaceData<Time>>;
  readonly rc = new RenderContext();
  private readonly api: ApiClient;
  symbols: SymbolInfo[] = [];
  private sym!: SymbolInfo;
  private tf = '1m';
  private tfSec = 60;
  private R = 1;
  private rAuto = true;
  private rInit = false;
  private mode: Mode = 'candle';
  private items: BarItem[] = [];
  private win: [number, number] | null = null;
  private anchor: Anchor | null = null;
  private bars!: BarStore;
  private fpStore!: FootprintStore;
  private readonly barQueue: RequestQueue;
  private readonly fpQueue: RequestQueue;
  private pointerDown = false;
  private gestureActive = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private frameReq = 0;
  private lastCenter = Number.NaN;
  private panDir: -1 | 0 | 1 = 0;
  private colorRefDirty = false;
  private hint = '';
  private estVc = 0;
  private estRh = 0;
  private firstCandles = false;
  /** Startansicht bis zur ersten Nutzereingabe: rechter Rand, fester Bar-Abstand. */
  private initialView = false;
  private wantedFp = new Set<string>();
  private readonly listeners: (() => void)[] = [];
  /** Zähler für die Messung: Fensterwechsel (setData), Gestenenden, R-Wechsel. */
  readonly counters = { setData: 0, gestureEnds: 0, rChanges: 0, modeChanges: 0, colorRefs: 0 };

  constructor(container: HTMLElement, api = new ApiClient()) {
    this.api = api;
    this.chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0f1217' },
        textColor: '#c9d1d9',
        fontSize: 11,
      },
      grid: { vertLines: { color: '#1a1f27' }, horzLines: { color: '#1a1f27' } },
      rightPriceScale: { borderColor: '#2a313c' },
      timeScale: {
        borderColor: '#2a313c',
        timeVisible: true,
        secondsVisible: false,
        minBarSpacing: 0.1,
        rightOffset: 4,
        enableConflation: true,
      },
      crosshair: { mode: CrosshairMode.Normal },
      kineticScroll: { mouse: false, touch: true },
    });
    this.candle = this.chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      borderVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.fp = this.chart.addCustomSeries(new FootprintSeriesView(this.rc), {});
    this.rc.palette = palette(this.rc.colorMode);
    this.rc.onFirstFootprint = () => performance.mark('of:first-footprint');

    this.barQueue = new RequestQueue(
      (key, buf) => this.onBarChunk(key, buf),
      () => {},
    );
    this.fpQueue = new RequestQueue(
      (key, buf) => this.onFpTile(key, buf),
      (key) => this.onFpRejected(key),
    );

    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onRangeChange);
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement | Window,
      ev: K,
      f: (e: HTMLElementEventMap[K]) => void,
    ) => {
      el.addEventListener(ev, f as EventListener, { passive: true });
      this.listeners.push(() => el.removeEventListener(ev, f as EventListener));
    };
    on(container, 'pointerdown', () => {
      this.pointerDown = true;
      this.beginGesture();
    });
    on(window, 'pointerup', () => this.releasePointer());
    on(window, 'pointercancel', () => this.releasePointer());
    on(container, 'wheel', () => {
      this.beginGesture();
      this.armEnd();
    });
    on(container, 'keydown', () => {
      this.beginGesture();
      this.armEnd();
    });
  }

  destroy(): void {
    this.barQueue.cancelAll();
    this.fpQueue.cancelAll();
    for (const f of this.listeners) f();
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.frameReq) cancelAnimationFrame(this.frameReq);
    this.chart.remove();
  }

  async init(sym?: string, tf = '1m'): Promise<void> {
    const r = await this.api.symbols();
    this.symbols = r.symbols;
    const s = this.symbols.find((x) => x.name === sym) ?? this.symbols[0];
    if (!s) throw new Error('keine Symbole');
    this.setSeries(s.name, tf, null);
  }

  // ---------------------------------------------------------------- Einstellungen (vom UI)

  setSymbol(name: string): void {
    if (name === this.sym?.name) return;
    this.setSeries(name, this.tf, null);
  }

  setTimeframe(tf: string): void {
    if (tf === this.tf) return;
    this.setSeries(this.sym.name, tf, this.currentAnchor());
  }

  setType(t: FootprintType): void {
    this.rc.type = t;
    this.colorRefDirty = true;
    this.evaluate();
  }

  setColorMode(m: ColorMode): void {
    this.rc.colorMode = m;
    this.rc.palette = palette(m);
    this.redraw();
  }

  setColorScope(s: ColorScope): void {
    this.rc.colorScope = s;
    this.colorRefDirty = true;
    this.scheduleFrame();
  }

  /** 'auto' oder feste Zeilengröße in Ticks. */
  setRowMode(r: 'auto' | number): void {
    if (r === 'auto') {
      this.rAuto = true;
      this.applyR(this.initialR());
    } else {
      this.rAuto = false;
      this.applyR(r);
    }
    this.evaluate();
  }

  /**
   * Bewertung wie am Gestenende (Zeilengröße, Modus, Fenster) – für programmatische Änderungen des
   * Ausschnitts (z. B. Messskripte, die den Preisbereich direkt setzen).
   */
  reevaluate(): void {
    this.initialView = false;
    this.evaluate();
  }

  availableR(tf = this.tf): number[] {
    const m = this.sym?.tiles[tf] ?? {};
    return Object.keys(m)
      .map(Number)
      .filter((r) => r * this.sym.tickRefUnits >= this.sym.tickUnits)
      .sort((a, b) => a - b);
  }

  readout(): Readout {
    const st = this.rc.stats;
    const fpMode = this.mode === 'footprint';
    return {
      sym: this.sym?.name ?? '',
      tf: this.tf,
      R: this.R,
      rAuto: this.rAuto,
      mode: this.mode,
      lod: fpMode ? st.lod : 1,
      visibleCells: fpMode ? st.vc : this.estVc,
      cellsDrawn: fpMode ? st.cellsDrawn : 0,
      lastFrameMs: st.lastDrawMs,
      barSpacing: this.chart.timeScale().options().barSpacing,
      rowHeight: fpMode ? st.rh : this.estRh,
      windowBars: this.items.length,
      hint: this.hint,
      requests: this.fpQueue.stats.started + this.barQueue.stats.started,
      inFlight: this.fpQueue.stats.inFlight + this.barQueue.stats.inFlight,
      aborted: this.fpQueue.stats.aborted + this.barQueue.stats.aborted,
      fpTiles: this.fpStore?.tileCount ?? 0,
      fpCells: this.fpStore?.cells ?? 0,
      barChunks: this.bars?.size ?? 0,
    };
  }

  /** Für Messungen (Playwright): Rohzähler. */
  debugSnapshot(): Record<string, unknown> {
    const st = this.rc.stats;
    return {
      readout: this.readout(),
      fpQueue: { ...this.fpQueue.stats },
      barQueue: { ...this.barQueue.stats },
      frames: st.frames,
      maxVcWithCells: st.maxVcWithCells,
      maxCellsDrawn: st.maxCellsDrawn,
      lodFrames: [...st.lodFrames],
      budgetFallbacks: st.budgetFallbacks,
      counters: { ...this.counters },
      textTable: this.fpStore?.text.size ?? 0,
      fpBytes: this.fpStore?.bytes ?? 0,
      gestureActive: this.gestureActive,
    };
  }

  /** Letzte n Zeichenzeiten des Footprint-Renderers (ms). */
  drawTimes(sinceFrame: number): number[] {
    const st = this.rc.stats;
    const out: number[] = [];
    const ring = st.drawMs.length;
    for (let f = Math.max(sinceFrame, st.frames - ring); f < st.frames; f++)
      out.push(st.drawMs[f % ring]!);
    return out;
  }

  // ---------------------------------------------------------------- Serie (Symbol/tf) und Fenster

  private setSeries(symName: string, tf: string, anchor: Anchor | null): void {
    const s = this.symbols.find((x) => x.name === symName);
    if (!s) throw new Error(`unbekanntes Symbol ${symName}`);
    const symChanged = s !== this.sym;
    this.sym = s;
    this.tf = tf;
    this.tfSec = tfSeconds(tf);
    this.barQueue.cancelAll();
    this.fpQueue.cancelAll();
    this.bars = new BarStore(`${s.name}|${tf}`, s.priceDecimals);
    if (symChanged || !this.fpStore) this.fpStore = new FootprintStore(s.qtyDecimals);
    this.rc.store = this.fpStore;
    this.rc.priceScale = 10 ** s.priceDecimals;
    const minMove = s.tickRefUnits / 10 ** s.priceDecimals;
    const precision = Math.max(0, s.priceDecimals - Math.round(Math.log10(s.tickRefUnits)));
    const priceFormat = { type: 'price' as const, precision, minMove };
    this.candle.applyOptions({ priceFormat });
    this.fp.applyOptions({ priceFormat });
    this.items = [];
    this.win = null;
    this.rInit = false;
    this.rAuto = true; // Auto-R neu bei Symbol-/tf-Wechsel (§6.1)
    this.lastCenter = Number.NaN;
    const dataToSec = s.dataTo / 1000;
    this.anchor = anchor ?? {
      centerSec: dataToSec - 100 * this.tfSec,
      logicalWidth: 200,
      initial: true,
    };
    this.candle.setData([]);
    this.fp.setData([]);
    this.ensureWindow();
  }

  private currentAnchor(): Anchor | null {
    const lr = this.chart.timeScale().getVisibleLogicalRange();
    if (!lr || this.items.length === 0) return null;
    const mid = (lr.from + lr.to) / 2;
    return { centerSec: this.timeAtLogical(mid), logicalWidth: lr.to - lr.from };
  }

  /** Zeit (s) an einer logischen Position; außerhalb des Fensters linear mit tf fortgesetzt. */
  private timeAtLogical(x: number): number {
    const n = this.items.length;
    if (n === 0) return this.anchor?.centerSec ?? 0;
    const i = Math.round(x);
    if (i < 0) return this.items[0]!.time + i * this.tfSec;
    if (i >= n) return this.items[n - 1]!.time + (i - n + 1) * this.tfSec;
    return this.items[i]!.time;
  }

  private visibleTimeRange(): [number, number] | null {
    const lr = this.chart.timeScale().getVisibleLogicalRange();
    if (!lr) return null;
    return [this.timeAtLogical(lr.from), this.timeAtLogical(lr.to)];
  }

  private dataRangeSec(): [number, number] {
    return [this.sym.dataFrom / 1000, this.sym.dataTo / 1000];
  }

  private capChunks(): number {
    return (
      (this.mode === 'footprint' ? FOOTPRINT_WINDOW_BARS : CANDLE_WINDOW_BARS) / BAR_CHUNK_BARS
    );
  }

  /** Lädt fehlende Abschnitte und wechselt das Fenster, wenn das aktuelle den Bedarf nicht deckt. */
  /** Liefert true, wenn das Fenster neu gesetzt wurde (setData auf beiden Serien). */
  private ensureWindow(force = false): boolean {
    const [df, dt] = this.dataRangeSec();
    const vis = this.anchor ? null : this.visibleTimeRange();
    const center = this.anchor ? this.anchor.centerSec : vis ? (vis[0] + vis[1]) / 2 : dt;
    const cap = this.capChunks();
    const [c0, c1] = windowChunks(center, this.tfSec, cap, df, dt);
    const cc = Math.min(Math.max(chunkIndexAt(center, this.tfSec), c0), c1);
    // Abschnitte anfordern: Mitte zuerst
    const wants: Want[] = [];
    for (let c = c0; c <= c1; c++) {
      if (this.bars.has(c)) continue;
      const span = chunkSpanSec(this.tfSec);
      wants.push({
        key: `${this.bars.series}#${c}`,
        url: this.api.barsUrl(this.sym.name, this.tf, c * span * 1000, (c + 1) * span * 1000),
        priority: Math.abs(c - cc),
      });
    }
    this.barQueue.setWanted(wants, new Set(wants.map((w) => w.key)));
    this.bars.evict(c0, c1);
    // Deckt das aktuelle Fenster den sichtbaren Bereich ± 1 Abschnitt?
    if (!force && this.win && vis) {
      const n0 = Math.max(c0, chunkIndexAt(vis[0], this.tfSec) - 1);
      const n1 = Math.min(c1, chunkIndexAt(vis[1], this.tfSec) + 1);
      if (this.win[0] <= n0 && this.win[1] >= n1 && this.win[1] - this.win[0] + 1 <= cap)
        return false;
    }
    const run = this.bars.loadedRun(c0, c1, cc);
    if (!run) return false;
    if (!force && this.win && run[0] === this.win[0] && run[1] === this.win[1]) return false;
    this.rebuildWindow(run);
    return true;
  }

  private rebuildWindow(run: [number, number]): void {
    const ts = this.chart.timeScale();
    let anchorTime: number;
    let offset = 0;
    let width: number;
    const lr = ts.getVisibleLogicalRange();
    if (this.anchor || !lr || this.items.length === 0) {
      const a = this.anchor ?? { centerSec: this.dataRangeSec()[1], logicalWidth: 200 };
      anchorTime = a.centerSec;
      width = a.logicalWidth;
    } else {
      const mid = (lr.from + lr.to) / 2;
      const i = Math.min(this.items.length - 1, Math.max(0, Math.round(mid)));
      anchorTime = this.items[i]!.time;
      offset = mid - i;
      width = lr.to - lr.from;
    }
    const items = this.bars.items(run[0], run[1]);
    this.items = items;
    this.win = run;
    this.candle.setData(items);
    this.fp.setData(this.mode === 'footprint' ? items : []);
    this.counters.setData++;
    const idx = Math.min(items.length - 1, indexAtOrAfter(items, anchorTime));
    const c = idx + offset;
    if (this.anchor?.initial) this.initialView = true;
    if (this.initialView) {
      // Startansicht (§1.4: 1m-Footprint, ~200 Bars sichtbar): ≤ 200 Bars, Bar-Abstand ≥ 7 px, damit
      // die erste Darstellung bereits Footprint-Zellen (L2, Schwelle 6 px + 10 % Hysterese) zeigt.
      const paneW = this.chart.paneSize(0).width || 1200;
      ts.applyOptions({ barSpacing: Math.max(7, paneW / 200) });
      ts.scrollToRealTime();
    } else {
      ts.setVisibleLogicalRange({ from: c - width / 2, to: c + width / 2 } as LogicalRange);
    }
    const hadAnchor = this.anchor !== null;
    this.anchor = null;
    if (!this.firstCandles && items.length > 0) {
      this.firstCandles = true;
      requestAnimationFrame(() => performance.mark('of:first-candles'));
    }
    if (!this.rInit && items.length > 0) {
      this.rInit = true;
      if (this.rAuto || !this.availableR().includes(this.R)) {
        this.rAuto = true;
        this.applyR(this.initialR(idx));
      } else {
        this.applyR(this.R);
      }
    }
    // Erstes Fenster einer Serie: Detailstufe sofort bewerten (wie ein Gestenende).
    // Nach dem ersten Zeichnen (Preisskala steht erst dann fest) wie ein Gestenende bewerten.
    if (hadAnchor) requestAnimationFrame(() => requestAnimationFrame(() => this.evaluate()));
    this.scheduleFrame();
  }

  private initialR(atIndex = this.items.length - 1): number {
    const to = Math.max(0, Math.min(this.items.length - 1, atIndex));
    const from = Math.max(0, to - 199);
    const highs: number[] = [];
    const lows: number[] = [];
    for (let i = from; i <= to; i++) {
      highs.push(this.items[i]!.h);
      lows.push(this.items[i]!.l);
    }
    // Abweichung (bewusst): Median der 200 Bars bis zur Ankerposition statt „der letzten 200
    // abgeschlossenen Bars" (§6.1), damit ein tf-Wechsel mitten in der Historie passend startet.
    return initialRowSize(
      highs,
      lows,
      this.availableR(),
      this.sym.tickRefUnits,
      this.sym.tickUnits,
    );
  }

  private applyR(r: number): void {
    const n = this.sym.tiles[this.tf]?.[String(r)];
    if (!n) return;
    if (r !== this.R) this.counters.rChanges++;
    this.R = r;
    this.rc.series = `${this.sym.name}|${this.tf}|${r}`;
    this.rc.n = n;
    this.rc.tfSec = this.tfSec;
    this.rc.width = r * this.sym.tickRefUnits;
    this.colorRefDirty = true;
    this.scheduleFrame();
    this.redraw();
  }

  private setMode(m: Mode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.counters.modeChanges++;
    this.candle.applyOptions({ visible: m === 'candle' });
    // Zu großes Fenster für den Footprint-Modus: aus den (geladenen) Abschnitten neu zuschneiden.
    if (this.win && this.win[1] - this.win[0] + 1 > this.capChunks() && this.ensureWindow(true))
      return;
    const lr = this.chart.timeScale().getVisibleLogicalRange();
    this.fp.setData(m === 'footprint' ? this.items : []);
    if (lr) this.chart.timeScale().setVisibleLogicalRange(lr);
    this.colorRefDirty = true;
    this.scheduleFrame();
  }

  // ---------------------------------------------------------------- Gesten

  // Gesten beginnen nur mit Nutzereingaben (Zeiger, Rad, Tasten); Bereichsänderungen verlängern eine
  // laufende Geste (z. B. Touch-Kinetik), programmatische Änderungen (setData, Fensterwechsel) nicht.
  private readonly onRangeChange = (): void => {
    if (this.gestureActive) this.armEnd();
    this.scheduleFrame();
  };

  private beginGesture(): void {
    this.gestureActive = true;
    this.initialView = false;
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
  }

  private releasePointer(): void {
    if (!this.pointerDown) return;
    this.pointerDown = false;
    this.armEnd();
  }

  private armEnd(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    if (this.pointerDown) return;
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.gestureActive = false;
      this.counters.gestureEnds++;
      this.evaluate();
    }, GESTURE_DEBOUNCE_MS);
  }

  /** Sichtbare Geometrie aus der Bibliothek (nur am Gestenende/bei Bedarf, nicht je Frame). */
  private measure(): ViewGeometry | null {
    const lr = this.chart.timeScale().getVisibleLogicalRange();
    const n = this.items.length;
    if (!lr || n === 0) return null;
    const from = Math.max(0, Math.ceil(lr.from));
    const to = Math.min(n - 1, Math.floor(lr.to));
    const h = this.chart.paneSize(0).height;
    const s = this.mode === 'footprint' ? this.fp : this.candle;
    const pTop = s.coordinateToPrice(0);
    const pBot = s.coordinateToPrice(h);
    if (pTop === null || pBot === null || to < from || h <= 0) return null;
    const unitTop = pTop * this.rc.priceScale;
    const unitBottom = pBot * this.rc.priceScale;
    if (unitTop <= unitBottom) return null;
    const highs: number[] = [];
    const lows: number[] = [];
    for (let i = from; i <= to; i++) {
      highs.push(this.items[i]!.h);
      lows.push(this.items[i]!.l);
    }
    return {
      highs,
      lows,
      from: 0,
      to: highs.length - 1,
      unitBottom,
      unitTop,
      pxPerUnit: h / (unitTop - unitBottom),
    };
  }

  /** Gestenende: Zeilengröße, Modus, Fenster, Farbreferenz (KONZEPT §7.2). */
  private evaluate(): void {
    if (!this.sym || this.items.length === 0) return;
    const g = this.measure();
    if (g) {
      const rs = this.availableR();
      if (this.rAuto) {
        const r = adjustRowSize(this.R, rs, g, this.sym.tickRefUnits);
        if (r !== this.R) this.applyR(r);
      }
      const w = this.R * this.sym.tickRefUnits;
      const bs = this.chart.timeScale().options().barSpacing;
      const rh = rowHeightPx(g, w);
      const vc = visibleCells(g, w);
      this.estVc = vc;
      this.estRh = rh;
      const lod = selectLod({ bs, rh, vc, type: this.rc.type });
      this.hint = !this.rAuto && lod === 1 && bs >= L2_MIN_BAR_SPACING ? MANUAL_R_TOO_FINE : '';
      const fp = wantsFootprintMode(this.mode === 'footprint', { bs, rh, vc });
      this.setMode(fp ? 'footprint' : 'candle');
    }
    this.ensureWindow();
    this.colorRefDirty = true;
    this.scheduleFrame();
  }

  // ---------------------------------------------------------------- Frame: Bedarf, Farbe, Neuzeichnen

  private scheduleFrame(): void {
    if (this.frameReq) return;
    this.frameReq = requestAnimationFrame(() => {
      this.frameReq = 0;
      this.frame();
    });
  }

  private frame(): void {
    if (!this.sym || this.items.length === 0) return;
    const vis = this.visibleTimeRange();
    if (!vis) return;
    const center = (vis[0] + vis[1]) / 2;
    if (!Number.isNaN(this.lastCenter) && center !== this.lastCenter)
      this.panDir = center > this.lastCenter ? 1 : -1;
    this.lastCenter = center;
    if (this.mode === 'footprint') this.updateFootprintWants(vis);
    else if (this.wantedFp.size > 0) {
      this.wantedFp.clear();
      this.fpQueue.cancelAll();
    }
    if (this.colorRefDirty && this.mode === 'footprint') {
      this.colorRefDirty = false;
      this.recomputeColorRef();
    }
  }

  private updateFootprintWants(vis: [number, number]): void {
    const [df, dt] = this.dataRangeSec();
    const n = this.rc.n;
    const list = wantedTiles({
      fromSec: vis[0],
      toSec: vis[1],
      n,
      tfSec: this.tfSec,
      dataFromSec: df,
      dataToSec: dt,
      panDir: this.panDir,
    });
    const series = this.rc.series;
    const wants: Want[] = [];
    const retain = new Set<string>();
    const pinned = new Set<string>();
    let minK = Infinity;
    let maxK = -Infinity;
    for (const w of list) {
      const key = FootprintStore.key(series, w.k);
      pinned.add(key);
      retain.add(key);
      minK = Math.min(minK, w.k);
      maxK = Math.max(maxK, w.k);
      if (this.fpStore.has(series, w.k)) continue;
      wants.push({
        key,
        url: this.api.footprintUrl(this.sym.name, this.tf, this.R, w.k),
        priority: w.priority * 1000 + wants.length,
      });
    }
    // Rückhaltezone: eine weitere Kachel je Seite wird nicht abgebrochen (kein Hin-und-her beim Pannen).
    if (minK <= maxK) {
      retain.add(FootprintStore.key(series, minK - 1));
      retain.add(FootprintStore.key(series, maxK + 1));
    }
    this.wantedFp = pinned;
    this.fpQueue.setWanted(wants, retain);
  }

  private onBarChunk(key: string, buf: ArrayBuffer): void {
    const [series, c] = key.split('#') as [string, string];
    if (series !== this.bars.series) return;
    this.bars.addEncoded(Number(c), buf);
    if (!this.gestureActive) this.ensureWindow();
  }

  private onFpTile(key: string, buf: ArrayBuffer): void {
    const series = key.slice(0, key.lastIndexOf('#'));
    if (!series.startsWith(`${this.sym.name}|`)) return;
    this.fpStore.addEncoded(series, buf);
    this.fpStore.evict(this.wantedFp);
    if (series === this.rc.series) {
      this.colorRefDirty = true;
      this.scheduleFrame();
      this.redraw();
    }
  }

  private onFpRejected(key: string): void {
    const i = key.lastIndexOf('#');
    this.fpStore.markRejected(key.slice(0, i), Number(key.slice(i + 1)));
  }

  /** P95 der |Werte| über die sichtbaren Bars (KONZEPT §6.1), nicht je Frame. */
  private scratch = new Float64Array(1 << 15);
  private recomputeColorRef(): void {
    const lr = this.chart.timeScale().getVisibleLogicalRange();
    const tiles = this.fpStore.tiles(this.rc.series);
    if (!lr || !tiles) return;
    const from = Math.max(0, Math.floor(lr.from));
    const to = Math.min(this.items.length - 1, Math.ceil(lr.to));
    const span = this.rc.n * this.tfSec;
    const bid = this.rc.type === 'bidask';
    let m = 0;
    const push = (v: number) => {
      if (m === this.scratch.length) {
        const b = new Float64Array(m * 2);
        b.set(this.scratch);
        this.scratch = b;
      }
      this.scratch[m++] = v;
    };
    for (let i = from; i <= to; i++) {
      const t = this.items[i]!.time;
      const st = tiles.get(Math.floor(t / span));
      if (!st || st === 'rejected') continue;
      const tile: PreparedTile = st;
      const bi = tile.slot[(t - tile.fromSec) / this.tfSec]!;
      if (bi < 0) continue;
      for (let j = tile.levelOffset[bi]!; j < tile.levelOffset[bi + 1]!; j++) {
        if (bid) {
          push(tile.buy[j]!);
          push(tile.sell[j]!);
        } else push(Math.abs(tile.buy[j]! - tile.sell[j]!));
      }
      if (m > 200_000) break;
    }
    if (m === 0) return;
    this.rc.colorRef = Math.max(1, quantileInPlace(this.scratch, m, COLOR_REF_PERCENTILE));
    this.counters.colorRefs++;
    this.redraw();
  }

  /** Neuzeichnen anstoßen, ohne Daten zu setzen (die Bibliothek zeichnet im nächsten Frame). */
  private redraw(): void {
    this.fp.applyOptions({});
  }
}
