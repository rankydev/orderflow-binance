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
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts';
import {
  ApiClient,
  IncompatibleServerError,
  SERVER_MISMATCH,
  SymbolsHttpError,
  timeoutSignal,
} from './api.ts';
import { exactDecimal } from './format.ts';
import { GestureTracker } from './gesture.ts';
import { MismatchRecovery, REFETCH_TIMEOUT_MS, RETRY_MS, tileConfigChanged } from './mismatch.ts';
import {
  BarStore,
  CANDLE_WINDOW_BARS,
  FOOTPRINT_WINDOW_BARS,
  indexAtOrBefore,
  logicalIndexOfTime,
  chunksReadyInWindow,
  rangeAfterRebuild,
  tfSwitchAnchorTime,
  timeAtLogical,
} from './bar-store.ts';
import { palette, quantileInPlace, COLOR_REF_PERCENTILE } from './color.ts';
import { FootprintStore, TileMismatchError, type PreparedTile } from './footprint-store.ts';
import {
  nextFallback,
  DOWN_COLOR,
  FootprintSeriesView,
  RenderContext,
  UP_COLOR,
  type FpItem,
} from './footprint-series.ts';
import {
  chooseRowSize,
  initialRowSize,
  L2_MIN_BAR_SPACING,
  L3_MIN_BAR_SPACING,
  L3_MIN_ROW_HEIGHT,
  MANUAL_R_NO_TEXT,
  MANUAL_R_TOO_FINE,
  rowClassFor,
  rowHeightPx,
  selectLod,
  visibleCells,
  wantsFootprintMode,
  type RowClass,
  type ViewGeometry,
} from './lod.ts';
import { ProfileLayer } from './profile/layer.ts';
import { isTransient, RequestQueue, type Want } from './request-queue.ts';
import { BAR_CHUNK_BARS, chunkIndexAt, chunkSpanSec, wantedTiles, windowChunks } from './tiles.ts';
import type { BarItem, ColorMode, ColorScope, FootprintType, Lod, SymbolInfo } from './types.ts';
import { isTimeframe, tfSeconds } from '@orderflow/core/browser';

export type Mode = 'footprint' | 'candle';

/** Höchstzahl sichtbarer Footprint-Kacheln, die gleichzeitig angefordert werden (W1). */
// N6: an die tatsächliche Sichtbarkeit gekoppelt – bei n = 32 und bs ≥ 6 px deckt 24 bis ≈ 4 600 px
// Breite; darüber sagt die Anzeige, dass Randkacheln fehlen (statt still Kerzen zu zeichnen).
export const MAX_VISIBLE_TILES = 24;
/** K1: Abstand der Abschnittsanforderungen während einer Geste. */
export const CHUNK_REQUEST_THROTTLE_MS = 250;
/** Profil-Querprüfung mit vorläufigen Bar-Abschnitten erst für Tage, die so lange vor dem Laden endeten. */
export const PROFILE_SETTLE_MS = 86_400_000;

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
  /** Zeilenklasse der automatischen Wahl (text = Zahlen, cells = Blöcke). */
  rowClass: string;
  /** Zeilengröße in Preiseinheiten (z. B. "5 USDT"). */
  rLabel: string;
  /** Letzter Frame: Bars mit Zellen bzw. mit Zahlen, sichtbare Zeilen je Bar (Median/Max). */
  barsWithCells: number;
  textBars: number;
  rowsMedian: number;
  rowsMax: number;
  textsShortened: number;
  textsSkipped: number;
  /** Sichtbarer Fehler (z. B. unbrauchbare Kachel), sonst ''. */
  error: string;
  /** Echte Sperre (Server unverträglich) – Banner; sonst ''. */
  blocked: string;
  /** Nicht zoombedingter, aber erwarteter/vorübergehender Grund ohne Footprint – normale Zeile. */
  notice: string;
}

interface Anchor {
  centerSec: number;
  logicalWidth: number;
  /** Startansicht: rechter Datenrand, ≤ 200 Bars bei Bar-Abstand ≥ 7 px. */
  initial?: boolean;
  /** Startansicht um eine Zeit (URL-Parameter at): Start-Bar-Abstand, Bildmitte = centerSec. */
  at?: boolean;
}

export class ChartController {
  readonly chart: IChartApi;
  private readonly candle: ISeriesApi<'Candlestick'>;
  private readonly fp: ISeriesApi<'Custom', Time, FpItem | WhitespaceData<Time>>;
  readonly rc = new RenderContext();
  /** Volume-Profile (Tages- und Bereichsprofil), als Pane-Primitive unter den Serien. */
  readonly profile: ProfileLayer;
  private readonly api: ApiClient;
  symbols: SymbolInfo[] = [];
  private sym!: SymbolInfo;
  private tf = '1m';
  private tfSec = 60;
  private R = 1;
  private rAuto = true;
  private rInit = false;
  /** Zeilenklasse der letzten automatischen Wahl (Hysterese text/cells). */
  private rowClass: RowClass | null = null;
  private mode: Mode = 'candle';
  private items: BarItem[] = [];
  private win: [number, number] | null = null;
  private anchor: Anchor | null = null;
  private bars!: BarStore;
  private fpStore!: FootprintStore;
  private readonly barQueue: RequestQueue;
  private readonly fpQueue: RequestQueue;
  private readonly gesture = new GestureTracker({
    onBegin: () => {
      this.initialView = false;
    },
    onEnd: () => {
      this.counters.gestureEnds++;
      this.evaluate();
    },
    onResize: () => {
      if (!this.destroyed) this.evaluate();
    },
  });
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
  readonly counters = {
    setData: 0,
    gestureEnds: 0,
    rChanges: 0,
    modeChanges: 0,
    colorRefs: 0,
    /** Längste Dekodier- + Vorbereitungszeit einer Kachel (ms, W4). */
    maxPrepareMs: 0,
  };

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
        rightOffset: 2,
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
      (key) => this.onBarRejected(key),
    );
    this.barQueue.label = (k) => `Bars ${tileLabel(k)}`;
    this.fpQueue = new RequestQueue(
      (key, buf) => this.onFpTile(key, buf),
      (key, status, err, body) => this.onFpRejected(key, status, err, body),
    );
    this.fpQueue.label = (k) => `Kachel ${tileLabel(k)}`;

    this.profile = new ProfileLayer({
      chart: this.chart,
      apiBase: api.base,
      sym: () => this.sym ?? null,
      tfSec: () => this.tfSec,
      items: () => this.items,
      visibleTimeRange: () => this.visibleTimeRange(),
      priceToY: (price) =>
        (this.mode === 'footprint' ? this.fp : this.candle).priceToCoordinate(price),
      barsCoverFinal: (fromMs, toMs) => this.barsCoverFinal(fromMs, toMs),
      footprintActive: () => this.mode === 'footprint' && this.rc.stats.lod >= 2,
      // W-4: Kacheln und Bars zuerst (die API hat 4 Datenbank-Slots)
      busy: () => {
        const f = this.fpQueue.stats;
        const b = this.barQueue.stats;
        return f.inFlight + f.queued + b.inFlight + b.queued > 0;
      },
    });
    this.chart.panes()[0]!.attachPrimitive(this.profile);
    // Bereichsauswahl (zwei Klicks, Bar-genau); außerhalb des Auswahlmodus ohne Wirkung
    this.chart.subscribeClick((p) => {
      if (p.time !== undefined && this.profile.click(p.time as number)) this.onProfile?.();
    });

    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onRangeChange);
    // Hover-Anzeige (W10): exakte Werte der Zelle unter dem Zeiger, als DOM-Text, höchstens einmal
    // je Animation-Frame berechnet (O(log Zeilen)); kein Neuzeichnen des Charts.
    this.chart.subscribeCrosshairMove((p) => {
      this.hoverParam =
        p.point && p.time !== undefined
          ? { t: p.time as number, x: p.point.x, y: p.point.y }
          : null;
      // Auswahlvorschau: nur im Auswahlmodus mit gesetztem Anfang wird neu gezeichnet
      if (this.profile.selecting)
        this.profile.pointer(p.time === undefined ? null : (p.time as number));
      if (this.hoverReq || !this.onHover) return;
      this.hoverReq = requestAnimationFrame(() => {
        this.hoverReq = 0;
        this.onHover?.(this.hoverText());
      });
    });
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement | Window,
      ev: K,
      f: (e: HTMLElementEventMap[K]) => void,
    ) => {
      el.addEventListener(ev, f as EventListener, { passive: true });
      this.listeners.push(() => el.removeEventListener(ev, f as EventListener));
    };
    // Gesten (N1/K3/W7): Regeln in gesture.ts
    const g = this.gesture;
    on(container, 'pointerdown', () => g.pointerDown());
    // auch außerhalb des Charts weiterziehen (z. B. Preisachse bis in die Werkzeugleiste)
    on(window, 'pointermove', (e) => {
      if (g.active || g.held) g.pointerMove(e.buttons);
    });
    on(window, 'pointerup', () => g.pointerUp());
    on(window, 'pointercancel', () => g.pointerUp());
    on(window, 'blur', () => g.pointerUp());
    on(container, 'contextmenu', () => g.pointerUp());
    on(container, 'lostpointercapture', () => g.pointerUp());
    on(container, 'wheel', () => g.wheel());
    const onVis = () => {
      if (document.visibilityState !== 'visible') g.pointerUp();
    };
    document.addEventListener('visibilitychange', onVis);
    this.listeners.push(() => document.removeEventListener('visibilitychange', onVis));
    const ro = new ResizeObserver(() => g.resize());
    ro.observe(container);
    this.listeners.push(() => ro.disconnect());
  }

  /** Rückruf für die Hover-Anzeige (Text oder ''), gesetzt vom UI. */
  onHover: ((text: string) => void) | null = null;
  private hoverParam: { t: number; x: number; y: number } | null = null;
  /** Rückruf nach Änderungen am Profilzustand durch Chart-Eingaben (Bereich gewählt). */
  onProfile: (() => void) | null = null;
  private hoverReq = 0;

  /** Text der Zelle unter dem Zeiger: Zeit, Zeilenintervall, Bid/Ask/Delta in Lots und Basiswährung. */
  hoverText(): string {
    const p = this.hoverParam;
    if (!p || !this.sym) return '';
    const s = this.mode === 'footprint' ? this.fp : this.candle;
    const price = s.coordinateToPrice(p.y);
    if (price === null) return '';
    const unit = Math.round(price * this.rc.priceScale);
    const time = new Date(p.t * 1000).toISOString().slice(0, 16).replace('T', ' ');
    // über einem gezeichneten Profil: dessen Zeile (exakte Werte)
    const prof = this.profile.hoverText(p.x, unit);
    if (prof) return `${time} UTC · ${prof}`;
    // N8: wo Kerzen gezeichnet werden, Kerzenwerte zeigen (keine Footprint-Werte aus dem Cache)
    const candles = this.mode === 'candle' || this.rc.stats.lod === 1;
    const hit = candles ? null : this.lookupBar(p.t);
    if (candles) {
      const it = this.items[indexAtOrBefore(this.items, p.t)];
      if (!it || it.time !== p.t) return `${time} UTC`;
      const px2 = (u: number) => exactDecimal(u, this.sym.priceDecimals);
      return `${time} UTC · O ${px2(it.o)} · H ${px2(it.h)} · L ${px2(it.l)} · C ${px2(it.c)}`;
    }
    if (!hit) return `${time} UTC`;
    const [tile, bi, width] = hit;
    const row = Math.floor(unit / width);
    let lo = tile.levelOffset[bi]!;
    let hi = tile.levelOffset[bi + 1]!;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (tile.row[m]! < row) lo = m + 1;
      else hi = m;
    }
    const pd = this.sym.priceDecimals;
    const qd = this.sym.qtyDecimals;
    const base = this.sym.name.replace(/USDT$/, '');
    const px = (u: number) => exactDecimal(u, pd);
    const q = (lots: number) => `${lots} Lots = ${exactDecimal(lots, qd)} ${base}`;
    const iv = `[${px(row * width)}, ${px((row + 1) * width)})`;
    if (lo >= tile.levelOffset[bi + 1]! || tile.row[lo] !== row)
      return `${time} UTC · Zeile ${iv}: keine Trades`;
    const b = tile.buy[lo]!;
    const sl = tile.sell[lo]!;
    return `${time} UTC · Zeile ${iv} · Bid (Verkäufer) ${q(sl)} · Ask (Käufer) ${q(b)} · Delta ${q(b - sl)}`;
  }

  /** Kachel und Bar-Index zur Zeit t (aktuelle Zeilengröße, sonst die vorige), mit Zeilenbreite. */
  private lookupBar(t: number): [PreparedTile, number, number] | null {
    const cands: [string, number, number][] = [[this.rc.series, this.rc.n, this.rc.width]];
    if (this.rc.prev) cands.push([this.rc.prev.series, this.rc.prev.n, this.rc.prev.width]);
    for (const [series, n, width] of cands) {
      const st = this.fpStore?.get(series, Math.floor(t / (n * this.tfSec)));
      if (!st || st === 'rejected') continue;
      const bi = st.slot[(t - st.fromSec) / this.tfSec];
      if (bi !== undefined && bi >= 0) return [st, bi, width];
    }
    return null;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.hoverReq) cancelAnimationFrame(this.hoverReq);
    this.barQueue.cancelAll();
    this.fpQueue.cancelAll();
    this.profile.destroy();
    for (const f of this.listeners) f();
    this.gesture.dispose();
    this.cancelRetry?.();
    this.cancelSymbolsRefresh?.();
    if (this.frameReq) cancelAnimationFrame(this.frameReq);
    this.chart.remove();
  }

  /**
   * Start: /symbols laden, Symbol/tf wählen (tf nur aus dem Angebot des Servers), optional Ansicht um
   * `atSec` (URL-Parameter at) statt am rechten Datenrand. Danach /symbols alle SYMBOLS_REFRESH_MS
   * neu laden (neue Symbole, dataTo, geänderte Kachelkonfiguration).
   */
  async init(
    sym?: string,
    tf = '1m',
    rowMode: 'auto' | number = 'auto',
    atSec?: number,
  ): Promise<void> {
    if (rowMode !== 'auto') {
      this.rAuto = false;
      this.manualR = rowMode;
    }
    let r;
    try {
      r = await this.api.symbols(timeoutSignal(REFETCH_TIMEOUT_MS * 3));
    } catch (e) {
      this.blocked = e instanceof Error ? e.message : String(e);
      throw e;
    }
    this.blocked = ''; // erneuter Start nach einem Fehler (App wiederholt init)
    if (this.destroyed) return;
    this.symbols = r.symbols;
    const s = this.symbols.find((x) => x.name === sym) ?? this.symbols[0];
    if (!s) throw new Error('keine Symbole');
    const tfs = offeredTimeframes(s);
    const tf0 = tfs.includes(tf) ? tf : (tfs.find((x) => x === '1m') ?? tfs[0] ?? '1m');
    let anchor: Anchor | null = null;
    atSec = parseAt(atSec, s.dataFrom, s.dataTo);
    if (atSec !== undefined) {
      const paneW = this.chart.paneSize(0).width || 1200;
      anchor = {
        centerSec: atSec,
        logicalWidth: paneW / startBarSpacing(this.rc.type, paneW),
        at: true,
      };
    }
    this.setSeries(s.name, tf0, anchor);
    this.scheduleSymbolsRefresh();
  }

  /**
   * Zuletzt gesetzter Bereich bis zum nächsten Frame: die Bibliothek übernimmt setVisibleLogicalRange
   * erst beim Zeichnen; mehrere Fensterwechsel im selben Frame lasen sonst einen veralteten Bereich.
   */
  private pendingRange: { from: number; to: number } | null = null;

  private logicalRange(): { from: number; to: number } | null {
    return this.pendingRange ?? this.chart.timeScale().getVisibleLogicalRange();
  }

  /**
   * Mitte des Ausschnitts auf die Mitte von r legen, Bar-Abstand exakt behalten (scrollToPosition =
   * Abstand des letzten Bars zum rechten Rand). setVisibleLogicalRange verkleinerte den Bar-Abstand
   * bei jedem Fensterwechsel leicht (gemessen 46 → 42,9 px).
   */
  private setRange(r: { from: number; to: number }, spacing?: number): void {
    const ts = this.chart.timeScale();
    const bs = spacing ?? this.pendingSpacing ?? ts.options().barSpacing;
    if (spacing !== undefined) ts.applyOptions({ barSpacing: spacing });
    const w = ts.width() || this.chart.paneSize(0).width || 1200;
    const W = w / bs;
    const c = (r.from + r.to) / 2;
    ts.scrollToPosition(c + W / 2 - (this.items.length - 1), false);
    if (!this.pendingRange) {
      requestAnimationFrame(() => {
        this.pendingRange = null;
        this.pendingSpacing = null;
      });
    }
    this.pendingRange = { from: c - W / 2, to: c + W / 2 };
    if (spacing !== undefined) this.pendingSpacing = spacing;
  }

  private pendingSpacing: number | null = null;

  /** Bildmitte auf die Zeit t legen, sobald die Pane eine Breite hat (höchstens 60 Frames warten). */
  private centerAt(t: number, tries: number, spacing: number): void {
    const w = this.chart.timeScale().width();
    if (!w && tries < 60) {
      requestAnimationFrame(() => {
        if (!this.destroyed) this.centerAt(t, tries + 1, spacing);
      });
      return;
    }
    // Bar-Abstand explizit (options() liefert direkt nach applyOptions noch den alten Wert)
    const width = (w || 1200) / spacing;
    const c = logicalIndexOfTime(this.items, t, this.tfSec);
    this.setRange({ from: c - width / 2, to: c + width / 2 }, spacing);
    if (this.anchor?.at) this.anchor = null;
  }

  /** Rückruf, wenn sich die Symbolliste oder ihre Daten (dataTo) geändert haben. */
  onSymbols: (() => void) | null = null;
  private cancelSymbolsRefresh: (() => void) | null = null;

  private scheduleSymbolsRefresh(delayMs = SYMBOLS_REFRESH_MS): void {
    this.cancelSymbolsRefresh?.();
    let next = SYMBOLS_REFRESH_MS;
    const id = setTimeout(() => {
      this.cancelSymbolsRefresh = null;
      if (this.destroyed) return;
      this.api
        .symbols(timeoutSignal(REFETCH_TIMEOUT_MS))
        .then((r) => {
          if (this.destroyed) return;
          const s = r.symbols.find((x) => x.name === this.sym.name);
          if (s && tileConfigChanged(this.sym, s)) this.applyNewSymbols(r.symbols);
          else {
            // gleiche Kachelkonfiguration: nur Liste und Datenbereich übernehmen
            this.symbols = r.symbols;
            if (s) this.sym = s;
          }
          this.onSymbols?.();
        })
        .catch((e: unknown) => {
          // 5: neuere API nach einem Deployment → sichtbar „Seite neu laden"; Netzfehler still (nächster
          // Versuch in SYMBOLS_REFRESH_MS)
          if (!this.destroyed && e instanceof IncompatibleServerError)
            this.blocked = SERVER_MISMATCH;
          // 503/429 (+ Retry-After), z. B. veralteter Katalog: wie jede vorübergehende Antwort früher
          // erneut, Retry-After beachtet (begrenzt)
          if (e instanceof SymbolsHttpError && isTransient(e.status))
            next = Math.min(SYMBOLS_REFRESH_MS, Math.max(2_000, e.retryAfterMs ?? 10_000));
        })
        .finally(() => this.scheduleSymbolsRefresh(next));
    }, delayMs);
    this.cancelSymbolsRefresh = () => clearTimeout(id);
  }

  /** Zeitrahmen, die der Server für das aktuelle Symbol anbietet (aufsteigend). */
  timeframes(): string[] {
    return this.sym ? offeredTimeframes(this.sym) : [];
  }

  /** Ende der Daten (ms, exklusiv) des aktuellen Symbols. */
  dataTo(): number {
    return this.sym?.dataTo ?? 0;
  }

  // ---------------------------------------------------------------- Einstellungen (vom UI)

  setSymbol(name: string): void {
    if (name === this.sym?.name) return;
    this.setSeries(name, this.tf, null);
  }

  setTimeframe(tf: string): void {
    if (!this.sym || tf === this.tf) return;
    const a = this.currentAnchor();
    // W8: beim Wechsel auf einen feineren tf die Mitte des alten Bars verankern, nicht seinen Beginn
    if (a) a.centerSec = tfSwitchAnchorTime(a.centerSec, this.tfSec, tfSeconds(tf));
    this.profile.cancelSelect(); // der Anfang einer laufenden Auswahl ist ein Bar des alten tf
    this.setSeries(this.sym.name, tf, a);
  }

  setType(t: FootprintType): void {
    this.rc.type = t;
    this.colorRefDirty = true;
    // Unberührte Startansicht: Bar-Abstand passend zum Typ (Bid×Ask braucht ≥ 80 px für Zahlen)
    if (this.initialView && this.items.length > 0) {
      const ts = this.chart.timeScale();
      ts.applyOptions({ barSpacing: startBarSpacing(t, this.chart.paneSize(0).width || 1200) });
      ts.scrollToRealTime();
      requestAnimationFrame(() => {
        if (!this.destroyed) this.evaluate();
      });
    }
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
    this.manualNote = '';
    if (r === 'auto') {
      this.rAuto = true;
      this.manualR = null;
    } else {
      this.rAuto = false;
      this.manualR = r;
      const rs = this.availableR();
      if (rs.includes(r)) this.applyR(r);
      else if (rs.length > 0) {
        // N7: nicht angebotenes R nicht still ignorieren – nächstes nehmen und sagen
        const near = nearestR(rs, r);
        this.applyR(near);
        this.manualNote = `R ${r} für ${this.tf} nicht verfügbar → ${near}`;
      }
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
      hint: [this.hint, this.tileNote].filter(Boolean).join('; '),
      requests: this.fpQueue.stats.started + this.barQueue.stats.started,
      inFlight: this.fpQueue.stats.inFlight + this.barQueue.stats.inFlight,
      aborted: this.fpQueue.stats.aborted + this.barQueue.stats.aborted,
      fpTiles: this.fpStore?.tileCount ?? 0,
      fpCells: this.fpStore?.cells ?? 0,
      barChunks: this.bars?.size ?? 0,
      rowClass: this.rowClass ?? '',
      rLabel: this.sym ? rowLabel(this.R, this.sym) : '',
      barsWithCells: fpMode ? st.barsWithCells : 0,
      textBars: fpMode ? st.textBars : 0,
      rowsMedian: fpMode ? median(st.rowsPerBar) : 0,
      rowsMax: fpMode ? Math.max(0, ...st.rowsPerBar) : 0,
      textsShortened: fpMode ? st.textsShortened : 0,
      textsSkipped: fpMode ? st.textsSkipped : 0,
      error: this.blocked || this.windowError || this.fpQueue.lastError || this.barQueue.lastError,
      blocked: this.blocked,
      notice: this.noFootprint && this.noFootprint !== this.blocked ? this.noFootprint : '',
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
      watchdogReleases: this.gesture.watchdogReleases,
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
    if (symChanged) this.profile.resetForSymbol();
    this.rc.store = this.fpStore;
    this.rc.priceScale = 10 ** s.priceDecimals;
    const minMove = s.tickRefUnits / 10 ** s.priceDecimals;
    const precision = pricePrecision(s.tickRefUnits, s.priceDecimals); // H3: auch für Ticks ≠ 10^k
    const priceFormat = { type: 'price' as const, precision, minMove };
    this.candle.applyOptions({ priceFormat });
    this.fp.applyOptions({ priceFormat });
    this.items = [];
    this.win = null;
    this.rInit = false;
    this.rowClass = null;
    this.manualNote = '';
    // Preisskala wieder an die sichtbaren Bars anpassen (eine gestreckte Skala gilt nicht für den neuen tf).
    this.chart.priceScale('right').applyOptions({ autoScale: true });
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
    // W8: ohne Daten (Fenster noch leer) den noch ausstehenden Anker behalten statt zum Datenende zu springen
    if (this.items.length === 0) return this.anchor ? { ...this.anchor, initial: false } : null;
    const lr = this.logicalRange();
    if (!lr) return null;
    const mid = (lr.from + lr.to) / 2;
    return { centerSec: this.timeAtLogical(mid), logicalWidth: lr.to - lr.from };
  }

  /** Zeit (s) an einer logischen Position; außerhalb des Fensters linear mit tf fortgesetzt. */
  private timeAtLogical(x: number): number {
    return timeAtLogical(this.items, x, this.tfSec, this.anchor?.centerSec ?? 0);
  }

  private visibleTimeRange(): [number, number] | null {
    const lr = this.logicalRange();
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

  /**
   * Lädt fehlende Abschnitte und wechselt das Fenster, wenn das aktuelle den Bedarf nicht deckt.
   * `rebuild = false`: nur anfordern (während einer Geste, K1). Liefert true bei neuem Fenster.
   */
  private ensureWindow(force = false, rebuild = true): boolean {
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
    if (!rebuild) return false;
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
    const lr = this.logicalRange();
    const oldItems = this.items;
    const items = this.bars.items(run[0], run[1]);
    // K1: neuer Ausschnitt aus der Zeit der Bildmitte (auch weit außerhalb des alten Fensters),
    // begrenzt auf das neue Fenster (rangeAfterRebuild, getestet)
    let range: { from: number; to: number };
    if (this.anchor || !lr || oldItems.length === 0) {
      const a = this.anchor ?? { centerSec: this.dataRangeSec()[1], logicalWidth: 200 };
      const c = logicalIndexOfTime(items, a.centerSec, this.tfSec);
      range = { from: c - a.logicalWidth / 2, to: c + a.logicalWidth / 2 };
    } else {
      range = rangeAfterRebuild(oldItems, lr, items, this.tfSec);
    }
    const idx = Math.round((range.from + range.to) / 2);
    this.items = items;
    this.win = run;
    this.candle.setData(items);
    this.fp.setData(this.mode === 'footprint' ? items : []);
    this.counters.setData++;
    // neue Bars im Fenster: geladene finale Profile gegen sie prüfen (Auftrag 6)
    this.profile.crossCheckAll();
    if (this.anchor?.initial) this.initialView = true;
    if (this.anchor?.at) {
      // Start um eine Zeit: Bar-Abstand setzen und die Mitte erst platzieren, wenn das Chart eine
      // Breite hat (vor dem ersten Layout ist die Pane 0 px breit und der Bereich ginge verloren)
      const spacing = startBarSpacing(this.rc.type, this.chart.paneSize(0).width || 1200);
      ts.applyOptions({ barSpacing: spacing });
      this.centerAt(this.anchor.centerSec, 0, spacing);
    } else if (this.initialView) {
      // Startansicht (Nutzerentscheid, statt §1.4 „~200 Bars"): lesbarer Footprint mit Zahlen, d. h.
      // Bar-Abstand über der L3-Schwelle des Typs, rechter Rand, Preisskala auf die sichtbaren Bars
      // angepasst (autoScale). Siehe START_CANDLES.
      ts.applyOptions({
        barSpacing: startBarSpacing(this.rc.type, this.chart.paneSize(0).width || 1200),
      });
      ts.scrollToRealTime();
    } else {
      this.setRange(range);
    }
    const hadAnchor = this.anchor !== null;
    // at-Anker bleibt bestehen, bis centerAt ihn angewendet hat (sonst zentriert ein weiterer
    // Fensterwechsel auf die Standardansicht der Bibliothek)
    if (!this.anchor?.at) this.anchor = null;
    if (!this.firstCandles && items.length > 0) {
      this.firstCandles = true;
      requestAnimationFrame(() => performance.mark('of:first-candles'));
    }
    if (!this.rInit && items.length > 0) {
      this.rInit = true;
      const rs = this.availableR();
      if (rs.length === 0) {
        // N3: kein Wurf mehr – ohne angebotene Zeilengröße nur Kerzen, sichtbar begründet
      } else if (this.rAuto) {
        const r0 = this.initialR(idx); // vorläufig; die erste Bewertung wählt nach Lesbarkeit
        if (r0 !== null) this.applyR(r0);
      } else if (rs.includes(this.manualR ?? -1)) {
        this.applyR(this.manualR!);
      } else {
        // manuelles R gibt es für diesen tf nicht: nächstes zulässiges, sichtbar im Hinweis
        const want = this.manualR ?? this.R;
        const near = nearestR(rs, want);
        this.applyR(near);
        this.manualNote = `R ${want} für ${this.tf} nicht verfügbar → ${near}`;
      }
    }
    // Erstes Fenster einer Serie: Detailstufe sofort bewerten (wie ein Gestenende).
    // Nach dem ersten Zeichnen (Preisskala steht erst dann fest) wie ein Gestenende bewerten.
    if (hadAnchor)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!this.destroyed) this.evaluate(); // H3: nach destroy() nichts mehr
        }),
      );
    this.scheduleFrame();
  }

  private manualNote = '';
  /** Nicht zoombedingter Grund, warum kein Footprint gezeigt wird ('' = keiner). */
  private noFootprint = '';
  private tileNote = '';
  private evalRetries = 0;
  /** A: dauerhafte Sperre (Server unverträglich) – sichtbar in der Anzeige. */
  private blocked = '';
  private readonly recovery = new MismatchRecovery();
  /** Kachelkonfiguration je laufender Anfrage (W-1) */
  private readonly requestCfg = new Map<string, number>();
  /** b: Kacheln, die erst nach dem Neuladen ihrer Bar-Abschnitte wieder angefordert werden */
  private readonly deferredTiles = new Map<string, [number, number]>();
  private cancelRetry: (() => void) | null = null;
  /** Querprüfungs-Abweichungen je Kachel (W-3) */
  private readonly crossFails = new Map<string, number>();
  /** N3: Fehler beim Fensterwechsel (sichtbar). */
  private windowError = '';
  private destroyed = false;

  private lastChunkRequest = 0;
  /** Vom Nutzer gewähltes R (Ticks) oder null bei Auto. */
  private manualR: number | null = null;

  private initialR(atIndex = this.items.length - 1): number | null {
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
    const series = `${this.sym.name}|${this.tf}|${r}`;
    if (r !== this.R) this.counters.rChanges++;
    // W6: bis die sichtbaren Kacheln der neuen Größe da sind, zeichnet der Renderer fehlende Bars mit
    // der bisherigen Größe (gleicher tf) statt als Kerzen.
    if (this.rc.series !== series && this.rc.series.startsWith(`${this.sym.name}|${this.tf}|`)) {
      // N2: die bisherige Größe nur dann als Rückfall nehmen, wenn sie sichtbar vollständig geladen
      // ist; sonst die ältere (geladene) behalten
      this.rc.prev = nextFallback(
        this.rc.prev,
        { series: this.rc.series, n: this.rc.n, width: this.rc.width },
        this.visibleComplete(this.rc.series, this.rc.n),
        series,
      );
    } else if (this.rc.series !== series) {
      this.rc.prev = null;
    }
    this.R = r;
    this.rc.series = series;
    this.rc.n = n;
    this.rc.tfSec = this.tfSec;
    this.rc.width = r * this.sym.tickRefUnits;
    this.colorRefDirty = true;
    this.scheduleFrame();
    this.redraw();
  }

  /** Sind alle sichtbaren Kacheln dieser Serie geladen? (ohne sichtbaren Bereich: ja) */
  private visibleComplete(series: string, n: number): boolean {
    const vis = this.items.length > 0 ? this.visibleTimeRange() : null;
    if (!vis) return true;
    const [df, dt] = this.dataRangeSec();
    const span = n * this.tfSec;
    const a = Math.floor(Math.max(vis[0], df) / span);
    const b = Math.floor(Math.min(vis[1], dt - 1) / span);
    for (let k = a; k <= b; k++) if (!this.fpStore.has(series, k)) return false;
    return true;
  }

  private setMode(m: Mode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.counters.modeChanges++;
    this.candle.applyOptions({ visible: m === 'candle' });
    // Zu großes Fenster für den Footprint-Modus: aus den (geladenen) Abschnitten neu zuschneiden.
    if (this.win && this.win[1] - this.win[0] + 1 > this.capChunks() && this.ensureWindow(true))
      return;
    const lr = this.logicalRange();
    this.fp.setData(m === 'footprint' ? this.items : []);
    if (lr) this.setRange(lr);
    this.colorRefDirty = true;
    this.scheduleFrame();
  }

  // ---------------------------------------------------------------- Gesten

  // Gesten beginnen nur mit Nutzereingaben (Zeiger, Rad, Tasten); Bereichsänderungen verlängern eine
  // laufende Geste (z. B. Touch-Kinetik), programmatische Änderungen (setData, Fensterwechsel) nicht.
  private readonly onRangeChange = (): void => {
    this.gesture.rangeChange();
    this.scheduleFrame();
  };

  private get gestureActive(): boolean {
    return this.gesture.active;
  }

  /** Sichtbare Geometrie aus der Bibliothek (nur am Gestenende/bei Bedarf, nicht je Frame). */
  private measure(): ViewGeometry | null {
    const lr = this.logicalRange();
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
    this.evaluateProfile();
    const rs = this.availableR();
    // Gründe, warum kein Footprint möglich ist (nicht zoombedingt) – sichtbar in der Anzeige (A)
    const scaleMode = this.chart.priceScale('right').options().mode;
    this.noFootprint =
      rs.length === 0
        ? `kein Footprint für ${this.tf} (keine Zeilengröße angeboten)`
        : scaleMode !== PriceScaleMode.Normal
          ? 'Preisskala nicht linear – nur Kerzen'
          : this.blocked;
    if (this.noFootprint) {
      this.setMode('candle');
      this.ensureWindow();
      return;
    }
    const g = this.measure();
    if (!g) {
      // Preisskala noch nicht vermessen (vor dem ersten Zeichnen): nicht still aufgeben, im
      // nächsten Frame erneut (begrenzt); sichtbar als Grund
      this.noFootprint = 'Ansicht wird vermessen …';
      if (this.evalRetries++ < 60) {
        requestAnimationFrame(() => {
          if (!this.destroyed) this.evaluate();
        });
      } else this.noFootprint = 'Ansicht nicht vermessbar (Preisskala leer)';
    }
    if (g) {
      this.evalRetries = 0;
      const bs = this.chart.timeScale().options().barSpacing;
      const cls = rowClassFor(bs, this.rc.type, this.rowClass);
      this.rowClass = cls;
      if (this.rAuto) {
        const cur = rs.includes(this.R) ? this.R : null;
        const r = chooseRowSize(cur, rs, g, this.sym.tickRefUnits, cls);
        if (r !== this.R) this.applyR(r);
      }
      const w = this.R * this.sym.tickRefUnits;
      const rh = rowHeightPx(g, w);
      const vc = visibleCells(g, w);
      this.estVc = vc;
      this.estRh = rh;
      const lod = selectLod({ bs, rh, vc, type: this.rc.type });
      // Manuelles R wird respektiert; ist es hier nicht darstellbar, sagt die Anzeige es.
      this.hint = this.rAuto
        ? ''
        : lod === 1 && bs >= L2_MIN_BAR_SPACING
          ? MANUAL_R_TOO_FINE
          : bs >= L3_MIN_BAR_SPACING[this.rc.type] && rh < L3_MIN_ROW_HEIGHT
            ? MANUAL_R_NO_TEXT
            : '';
      if (this.manualNote)
        this.hint = this.hint ? `${this.manualNote}; ${this.hint}` : this.manualNote;
      // K1/§7.3: mehr sichtbare Bars als das Kerzen-Fenster fasst → Hinweis statt leerer Fläche
      const lr = this.logicalRange();
      if (lr && lr.to - lr.from > CANDLE_WINDOW_BARS)
        this.hint = `Mehr als ${CANDLE_WINDOW_BARS} Bars sichtbar – größeren Zeitrahmen wählen`;
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
    // K1: während einer Geste, die den Bereich des Fensters verlässt, Abschnitte schon anfordern
    // (gedrosselt, ohne Fensterwechsel); am Gestenende wird das Fenster dann aus dem Cache gebaut.
    if (
      this.gestureActive &&
      this.win &&
      performance.now() - this.lastChunkRequest > CHUNK_REQUEST_THROTTLE_MS
    ) {
      const span = chunkSpanSec(this.tfSec);
      if (vis[0] < this.win[0] * span || vis[1] >= (this.win[1] + 1) * span) {
        this.lastChunkRequest = performance.now();
        this.ensureWindow(false, false);
      }
    }
    if (!Number.isNaN(this.lastCenter) && center !== this.lastCenter)
      this.panDir = center > this.lastCenter ? 1 : -1;
    this.lastCenter = center;
    // Profile: Bedarf erst am Gestenende (die Profil-Zeilengröße wird dort neu bestimmt; sonst würde
    // während des Zoomens mit der alten Zeilengröße geladen)
    if (!this.gestureActive) this.profile.frame();
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
    // W1: solange der Renderer in einer laufenden Geste nur Kerzen zeichnet, keine Kacheln anfordern
    // (der Bedarf wird am Gestenende neu bestimmt); höchstens MAX_VISIBLE_TILES sichtbare Kacheln.
    if (this.gestureActive && this.rc.stats.lod < 2) return;
    let vis0 = 0;
    const capped = list.filter((w) =>
      w.priority === 0 ? ++vis0 <= MAX_VISIBLE_TILES : vis0 <= MAX_VISIBLE_TILES,
    );
    this.tileNote =
      vis0 > MAX_VISIBLE_TILES
        ? `${vis0} Kacheln sichtbar, ${MAX_VISIBLE_TILES} geladen – Ränder als Kerzen`
        : '';
    const series = this.rc.series;
    const wants: Want[] = [];
    const retain = new Set<string>();
    const pinned = new Set<string>();
    let minK = Infinity;
    let maxK = -Infinity;
    let visibleMissing = 0;
    for (const w of capped) {
      const key = FootprintStore.key(series, w.k);
      pinned.add(key);
      retain.add(key);
      minK = Math.min(minK, w.k);
      maxK = Math.max(maxK, w.k);
      if (this.fpStore.has(series, w.k)) continue;
      const def = this.deferredTiles.get(key);
      if (def) {
        if (!this.deferredReady(def)) continue;
        this.deferredTiles.delete(key);
      }
      if (this.fpQueue.isFinal(key)) this.fpQueue.forgetFailure(key); // abgelaufene Ablehnung (W-3)
      this.requestCfg.set(key, this.sym.tileConfigVersion);
      if (w.priority === 0) visibleMissing++;
      wants.push({
        key,
        url: this.api.footprintUrl(this.sym.name, this.tf, this.R, w.k, this.sym.tileConfigVersion),
        priority: w.priority * 1000 + wants.length,
      });
    }
    // Rückhaltezone: eine weitere Kachel je Seite wird nicht abgebrochen (kein Hin-und-her beim Pannen).
    if (minK <= maxK) {
      retain.add(FootprintStore.key(series, minK - 1));
      retain.add(FootprintStore.key(series, maxK + 1));
    }
    const prev = this.rc.prev;
    if (prev) {
      if (visibleMissing === 0) {
        this.rc.prev = null; // neue Größe vollständig sichtbar → alte nicht mehr zeichnen
        this.colorRefDirty = true;
        this.redraw();
      } else {
        // sichtbare Kacheln der alten Größe nicht verdrängen, solange sie gezeichnet werden
        const a = Math.floor(vis[0] / (prev.n * this.tfSec));
        const b = Math.floor(vis[1] / (prev.n * this.tfSec));
        for (let k = a; k <= b; k++) pinned.add(FootprintStore.key(prev.series, k));
      }
    }
    this.wantedFp = pinned;
    this.fpQueue.setWanted(wants, retain);
    // d: Einträge abgebrochener/nie geladener Anfragen entfernen
    for (const k of this.requestCfg.keys()) if (!retain.has(k)) this.requestCfg.delete(k);
  }

  private onBarChunk(key: string, buf: ArrayBuffer): void {
    if (this.destroyed) return;
    const [series, c] = key.split('#') as [string, string];
    if (series !== this.bars.series) return;
    const span = chunkSpanSec(this.tfSec) * 1000;
    // K2: Abschnitt gegen die Anfrage prüfen (wirft → als unbrauchbar gezählt, nicht wiederholt)
    this.bars.addEncoded(
      Number(c),
      buf,
      {
        sym: this.sym.name,
        tf: this.tf,
        from: Number(c) * span,
        to: (Number(c) + 1) * span,
      },
      this.sym.dataTo,
    );
    // N3: Fehler beim Fensterwechsel gehören nicht zur Antwort (sonst würde der gültige Abschnitt
    // als Lücke überschrieben) – eigene, sichtbare Meldung
    // b: gehört der Abschnitt zu einer zurückgestellten Kachel, Fenster sofort aus den neuen Daten bauen
    const reloaded = [...this.deferredTiles.values()].some(
      ([a, b]) => Number(c) >= a && Number(c) <= b,
    );
    if (reloaded) this.safely('Fensterwechsel', () => this.ensureWindow(true));
    else if (!this.gestureActive) this.safely('Fensterwechsel', () => this.ensureWindow());
  }

  /** b: Sind die neu geladenen Abschnitte einer zurückgestellten Kachel im aktuellen Fenster? */
  private deferredReady(range: [number, number]): boolean {
    return chunksReadyInWindow(range, (c) => this.bars.has(c), this.win);
  }

  /** Führt fn aus; ein Fehler wird sichtbar (Anzeige + Konsole), statt die Ursache zu verschleiern. */
  private safely(what: string, fn: () => unknown): void {
    try {
      fn();
      this.windowError = '';
    } catch (e) {
      this.windowError = `${what}: ${e instanceof Error ? e.message : String(e)}`;
      console.error(this.windowError, e);
    }
  }

  /** H3: ein endgültig fehlender Abschnitt wird als Lücke geführt, damit das Fenster darüber wachsen kann. */
  private onBarRejected(key: string): void {
    if (this.destroyed) return; // d: nach destroy() keine Verarbeitung mehr
    const [series, c] = key.split('#') as [string, string];
    if (series !== this.bars.series) return;
    // N3: einen bereits geladenen Abschnitt nie durch eine Lücke ersetzen
    if (!this.bars.has(Number(c))) this.bars.markEmpty(Number(c));
    this.hint = `Bar-Abschnitt ${c} nicht ladbar – Lücke`;
    if (!this.gestureActive) this.safely('Fensterwechsel', () => this.ensureWindow());
  }

  private onFpTile(key: string, buf: ArrayBuffer): void {
    if (this.destroyed) return; // d: nach destroy() keine Verarbeitung mehr
    const i = key.lastIndexOf('#');
    const series = key.slice(0, i);
    if (!series.startsWith(`${this.sym.name}|`)) return;
    const reqCfg = this.takeRequestCfg(key);
    if (reqCfg !== this.sym.tileConfigVersion) return; // W-1: Antwort der alten Konfiguration verwerfen
    const [sym, tf, R] = series.split('|') as [string, string, string];
    const n = this.sym.tiles[tf]?.[R];
    // K2: Header gegen die Anfrage prüfen; Abweichung wirft (→ endgültig, sichtbar, keine Schleife)
    const t0 = performance.now();
    this.fpStore.addEncoded(series, buf, {
      sym,
      tf,
      R: Number(R),
      k: Number(key.slice(i + 1)),
      n: n ?? -1,
    });
    const ms = performance.now() - t0;
    if (ms > this.counters.maxPrepareMs) this.counters.maxPrepareMs = ms;
    // A/W-3/H-1: Querprüfung gegen die Bars desselben Zeitraums (gleiche Bars, gleiche Mengen). Nur auf
    // finalen Daten ohne Lücken (sonst sind Unterschiede legitim). Erste Abweichung: Bar-Abschnitte und
    // Kachel neu laden; erst eine wiederholte Abweichung gilt als Server/Seite-Abweichung.
    const tile = this.fpStore.get(series, Number(key.slice(i + 1)));
    if (tile && tile !== 'rejected' && tile.final && tf === this.tf && this.items.length > 0) {
      const a = Math.max(tile.fromSec, this.items[0]!.time);
      const b = Math.min(
        tile.fromSec + tile.n * this.tfSec,
        this.items[this.items.length - 1]!.time + 1,
      );
      const c0 = chunkIndexAt(a, this.tfSec);
      const c1 = chunkIndexAt(b - 1, this.tfSec);
      if (b > a && this.bars.allFinal(c0, c1)) {
        const diff = compareTileWithBars(this.items, tile.time, tile.vol, tile.nBars, a, b);
        if (diff) {
          const n = (this.crossFails.get(key) ?? 0) + 1;
          this.crossFails.set(key, n);
          console.warn(`Kachel ${key}: ${diff}`);
          this.fpQueue.lastError = `Kachel ${tileLabel(key)}: passt nicht zu /bars`;
          if (n === 1) {
            // b: Abschnitte neu laden; die Kachel erst wieder anfordern, wenn die neuen Abschnitte im
            // Fenster sind (sonst prüfte sie gegen die alten Items und zählte als zweite Abweichung)
            for (let c = c0; c <= c1; c++) this.bars.drop(c);
            this.fpStore.forget(series, tile.k);
            this.deferredTiles.set(key, [c0, c1]);
            this.safely('Neuladen', () => this.ensureWindow());
          } else {
            this.fpStore.markRejected(series, tile.k);
            this.onServerMismatch(reqCfg);
          }
          return;
        }
        this.crossFails.delete(key);
      }
    }
    this.fpStore.evict(this.wantedFp);
    if (series === this.rc.series) {
      this.colorRefDirty = true;
      this.scheduleFrame();
      this.redraw();
    }
  }

  private onFpRejected(key: string, status: number, err?: unknown, body?: string): void {
    if (this.destroyed) return; // d: nach destroy() keine Verarbeitung mehr
    const i = key.lastIndexOf('#');
    const cfg = this.takeRequestCfg(key);
    if (cfg !== this.sym.tileConfigVersion) return; // Antwort der alten Konfiguration (W-1)
    // TILE-FORMAT.md: 422 mit `reason` (tile_cells_exceeded / tile_source_rows_exceeded) gilt nur für
    // diese Kachel und den Datenstand → nach REJECT_TTL_MS erneut (Kerzen bis dahin); 422 ohne `reason`
    // = (tf, R) nicht angeboten → für diese Konfiguration endgültig.
    this.fpStore.markRejected(
      key.slice(0, i),
      Number(key.slice(i + 1)),
      status === 422 && !tileRejectReason(body),
    );
    // A: Kachel passt nicht zur Anfrage (n/R/…) oder 409 (Kachelkonfiguration veraltet) → Server und
    // Seite sind nicht auf demselben Stand
    if (status === 409 || err instanceof TileMismatchError) this.onServerMismatch(cfg);
  }

  /** Kachelkonfiguration, mit der eine Anfrage gestellt wurde (W-1: späte Antworten erkennen). */
  private takeRequestCfg(key: string): number {
    const c = this.requestCfg.get(key);
    this.requestCfg.delete(key);
    return c ?? this.sym.tileConfigVersion;
  }

  /**
   * A/W-1: Server und Seite nicht auf demselben Stand. Zustandsautomat (mismatch.ts): ein Neuladen von
   * /symbols je Welle; weitere Abweichungen währenddessen und Antworten der alten Konfiguration werden
   * ignoriert; gesperrt nur, wenn das Neuladen nichts geändert hat (nach RETRY_MS neuer Versuch).
   */
  private onServerMismatch(responseCfg: number): void {
    const act = this.recovery.onMismatch(responseCfg, this.sym.tileConfigVersion, Date.now());
    if (act !== 'refetch') return;
    const before = this.sym;
    this.api
      .symbols(timeoutSignal(REFETCH_TIMEOUT_MS)) // d: nie ewig „refetching"
      .then((r) => {
        if (this.destroyed) return;
        const s = r.symbols.find((x) => x.name === before.name);
        // c: nur Kachelkonfiguration zählt (dataTo ändert sich auf einem Live-Server laufend)
        const changed = !!s && tileConfigChanged(before, s);
        this.recovery.onRefetched(changed, Date.now());
        if (!changed || !s) {
          this.block();
          return;
        }
        this.applyNewSymbols(r.symbols);
      })
      .catch((e: unknown) => {
        if (this.destroyed) return;
        this.recovery.onRefetchFailed(Date.now());
        this.block(` (${e instanceof Error ? e.message : String(e)})`);
      });
  }

  /** Sperre setzen; nach RETRY_MS von selbst wieder versuchen (Review a). */
  private block(detail = ''): void {
    this.blocked = SERVER_MISMATCH + detail;
    this.fpQueue.cancelAll();
    this.requestCfg.clear();
    this.cancelRetry?.();
    const id = setTimeout(() => {
      this.cancelRetry = null;
      if (this.destroyed) return;
      if (this.recovery.expire(Date.now())) {
        this.blocked = '';
        this.evaluate(); // Footprint-Modus wieder möglich → neue Anfragen → ggf. neue Prüfung
      }
    }, RETRY_MS);
    this.cancelRetry = () => clearTimeout(id);
  }

  /** Neue /symbols übernehmen (Konfiguration geändert): Kachel-Caches neu, Serie neu aufsetzen. */
  private applyNewSymbols(symbols: SymbolInfo[]): void {
    const s = symbols.find((x) => x.name === this.sym.name);
    if (!s) return;
    this.blocked = '';
    this.symbols = symbols;
    this.fpStore = new FootprintStore(s.qtyDecimals);
    this.crossFails.clear();
    this.deferredTiles.clear();
    this.requestCfg.clear();
    this.fpQueue.clearFailures();
    this.setSeries(s.name, this.tf, this.currentAnchor());
  }

  /** P95 der |Werte| über die sichtbaren Bars (KONZEPT §6.1), nicht je Frame. */
  private scratch = new Float64Array(1 << 15);
  private recomputeColorRef(): void {
    const lr = this.logicalRange();
    const tiles = this.fpStore.tiles(this.rc.series);
    if (!lr || !tiles) return;
    const from = Math.max(0, Math.floor(lr.from));
    const to = Math.min(this.items.length - 1, Math.ceil(lr.to));
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
    const prev = this.rc.prev;
    const prevTiles = prev ? this.fpStore.tiles(prev.series) : undefined;
    const lookup = (t: number): [PreparedTile, number] | null => {
      for (const [m, n] of [
        [tiles, this.rc.n],
        [prevTiles, prev?.n ?? 1],
      ] as const) {
        const st = m?.get(Math.floor(t / (n * this.tfSec)));
        if (!st || st === 'rejected') continue;
        const bi = st.slot[(t - st.fromSec) / this.tfSec];
        if (bi !== undefined && bi >= 0) return [st, bi];
      }
      return null;
    };
    for (let i = from; i <= to; i++) {
      const t = this.items[i]!.time;
      const hit = lookup(t);
      if (!hit) continue;
      const [tile, bi] = hit;
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

  /** Profil-Zeilengröße nach der Pixelhöhe der Preisskala (Gestenende, unabhängig vom Footprint-R). */
  private evaluateProfile(): void {
    const h = this.chart.paneSize(0).height;
    const s = this.mode === 'footprint' ? this.fp : this.candle;
    const pTop = s.coordinateToPrice(0);
    const pBot = s.coordinateToPrice(h);
    if (pTop === null || pBot === null || h <= 0 || pTop <= pBot) return;
    this.profile.evaluate(h / ((pTop - pBot) * this.rc.priceScale));
  }

  /** Bars von [fromMs, toMs) vollständig, unveränderlich und lückenlos im aktuellen Fenster? */
  private barsCoverFinal(fromMs: number, toMs: number): boolean {
    if (!this.win || !this.bars) return false;
    // nur bei an den Bars ausgerichteten Grenzen vergleichbar (z. B. offsetH 1 bei 4h nicht)
    if ((fromMs / 1000) % this.tfSec !== 0 || (toMs / 1000) % this.tfSec !== 0) return false;
    const c0 = chunkIndexAt(fromMs / 1000, this.tfSec);
    const c1 = chunkIndexAt((toMs - 1) / 1000, this.tfSec);
    return (
      c0 >= this.win[0] && c1 <= this.win[1] && this.bars.settled(c0, c1, toMs, PROFILE_SETTLE_MS)
    );
  }
}

/** Start-Bar-Abstand: L3-Schwelle des Typs + 5 % (Delta 46 px, Bid×Ask 84 px). */
export function initialBarSpacing(type: FootprintType): number {
  return Math.round(L3_MIN_BAR_SPACING[type] * 1.05);
}

/**
 * Anzahl Delta-Kerzen in der Startansicht. null = so viele, wie bei 46 px Bar-Abstand passen (heute
 * ≈ 32 auf 1600 px, Median ≈ 5–7 Zeilen je Kerze). Eine Zahl (z. B. 20) ergibt weniger, breitere Kerzen
 * mit mehr Zeilen (≈ 7 Zeilen auf 15m/1h). Bid×Ask skaliert entsprechend (Verhältnis der L3-Schwellen).
 * Umschalten = diese eine Zeile ändern.
 */
export const START_CANDLES: number | null = null;

/** Bar-Abstand der Startansicht (nie unter der Zahlenschwelle des Typs). */
export function startBarSpacing(type: FootprintType, paneWidth: number): number {
  const min = initialBarSpacing(type);
  if (START_CANDLES === null) return min;
  const scale = L3_MIN_BAR_SPACING[type] / L3_MIN_BAR_SPACING.delta;
  return Math.max(min, (paneWidth / START_CANDLES) * scale);
}

/** Zeitrahmen mit Footprint-Angebot des Symbols, aufsteigend nach Dauer (nur bekannte Kürzel). */
export function offeredTimeframes(s: Pick<SymbolInfo, 'tiles'>): string[] {
  return Object.keys(s.tiles)
    .filter((tf) => isTimeframe(tf) && Object.keys(s.tiles[tf] ?? {}).length > 0)
    .sort((a, b) => tfSeconds(a) - tfSeconds(b));
}

/** Abstand der /symbols-Aktualisierung (neue Symbole, dataTo; Konfigurationswechsel). */
export const SYMBOLS_REFRESH_MS = 5 * 60_000;

/** Nächstes R (logarithmisch) aus einer aufsteigenden Liste. */
export function nearestR(rs: readonly number[], r: number): number {
  let best = rs[0] ?? r;
  for (const x of rs) if (Math.abs(Math.log(x / r)) < Math.abs(Math.log(best / r))) best = x;
  return best;
}

/** Zeilengröße R (Ticks) in Preiseinheiten, z. B. BTC R=50 → "5 USDT". */
export function rowLabel(
  R: number,
  sym: Pick<SymbolInfo, 'tickRefUnits' | 'priceDecimals' | 'name'>,
): string {
  const v = (R * sym.tickRefUnits) / 10 ** sym.priceDecimals;
  const quote = sym.name.includes('USDT') ? 'USDT' : '';
  return `${Number(v.toPrecision(6))} ${quote}`.trim();
}

function median(a: readonly number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export { exactDecimal };

/** Nachkommastellen von minMove = tickRefUnits / 10^priceDecimals (z. B. 25 / 100 = 0.25 → 2). */
export function pricePrecision(tickRefUnits: number, priceDecimals: number): number {
  let d = priceDecimals;
  let t = tickRefUnits;
  while (d > 0 && t % 10 === 0) {
    t /= 10;
    d--;
  }
  return d;
}

/** Anzahl Items mit time in [a, b). */
export function countItemsIn(items: readonly BarItem[], a: number, b: number): number {
  return Math.max(0, indexAtOrBefore(items, b - 1) - indexAtOrBefore(items, a - 1));
}

/**
 * Vergleicht Bars einer Footprint-Kachel mit den Items aus /bars im Zeitraum [a, b): gleiche Zeiten und
 * gleiche Mengen je Bar (H-1). Liefert eine Beschreibung der ersten Abweichung oder ''.
 */
export function compareTileWithBars(
  items: readonly BarItem[],
  time: ArrayLike<number>,
  vol: ArrayLike<number>,
  nBars: number,
  a: number,
  b: number,
): string {
  let i = indexAtOrBefore(items, a - 1) + 1;
  let j = 0;
  while (j < nBars && time[j]! < a) j++;
  let n = 0;
  for (;;) {
    const ti = i < items.length && items[i]!.time < b ? items[i]!.time : Infinity;
    const tj = j < nBars && time[j]! < b ? time[j]! : Infinity;
    if (ti === Infinity && tj === Infinity) return '';
    if (ti !== tj)
      return `Bar ${Math.min(ti, tj)} nur in ${ti < tj ? '/bars' : 'Kachel'} (nach ${n} gleichen)`;
    if (items[i]!.v !== vol[j]) return `Bar ${ti}: Menge ${vol[j]} ≠ ${items[i]!.v} aus /bars`;
    i++;
    j++;
    n++;
  }
}

/** Kurzform eines Anfrageschlüssels für die Anzeige: "BTCUSDT|1m|20#29219" → "1m R20 #29219". */
export function tileLabel(key: string): string {
  const [series = '', k = ''] = key.split('#');
  const [, tf = '', R] = series.split('|');
  return R ? `${tf} R${R} #${k}` : `${tf} #${k}`;
}

/**
 * 6: URL-Parameter at → Sekunden im Datenbereich. Werte > 1e11 gelten als Millisekunden; plausible
 * Zeiten (2001…2286) werden in [dataFrom, dataTo) geklemmt, alles andere ignoriert.
 */
export function parseAt(
  raw: number | undefined,
  dataFromMs: number,
  dataToMs: number,
): number | undefined {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined;
  const sec = raw > 1e11 ? Math.floor(raw / 1000) : Math.floor(raw);
  if (sec < 1e9 || sec >= 1e10) return undefined;
  const lo = Math.ceil(dataFromMs / 1000);
  const hi = Math.floor(dataToMs / 1000) - 1;
  if (hi < lo) return undefined;
  return Math.min(hi, Math.max(lo, sec));
}

/** `reason` einer 422-Kachelantwort (TILE-FORMAT.md) oder '' (kein JSON / ohne reason). */
export function tileRejectReason(body: string | undefined): string {
  try {
    const j = JSON.parse(body ?? '') as { reason?: unknown };
    return typeof j.reason === 'string' ? j.reason : '';
  } catch {
    return '';
  }
}
