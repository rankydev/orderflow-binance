// Big-Trades-Schicht (KONZEPT §6.4, docs/BIGTRADES-API.md): Marker je Order als Pane-Primitive auf der
// Hauptpane, in Kerzen- und Footprint-Modus, gezeichnet im Zeichenzyklus der Bibliothek (kein DOM je
// Marker). Laden wie Bars/Profile: Abschnitte zu 1 000 Bars (dieselben wie /bars) für den sichtbaren
// Bereich ± 1, Bedarf erst am Gestenende, Abbruch bei Bedarfswechsel, zurückstehend hinter Kacheln und
// Bars, LRU-Cache je (Symbol, tf, Abschnitt, Schwelle, Teilstück). Ein Abschnitt, den die API wegen zu
// vieler gelesener Zeilen ablehnt (422 source_rows_exceeded), wird an `suggestTo` geteilt (begrenzt).
// Wird die Schwelle über eine geladene, nicht ausgedünnte Antwort gehoben, filtert der Client ohne neue
// Anfrage. Abdeckung (`coverage`) wird immer gezeigt: wo keine Order-Daten liegen, heißt „kein Marker"
// nicht „kein Big Trade". Zeichnen: Zustand (collect) und Anordnung (layout) werden nur neu berechnet,
// wenn sich Daten, Bereich, Größe oder Schwelle ändern – ein Hover zeichnet nur neu.
import {
  decodeBigTrades,
  type BigTradeColumns,
  type BigTradesMeta,
  type CoverageSpan,
} from '@orderflow/core/browser';
import type {
  IChartApi,
  IPanePrimitive,
  IPanePrimitivePaneView,
  IPrimitivePaneRenderer,
  PaneAttachedParameter,
  Time,
} from 'lightweight-charts';
import { DOWN_COLOR, UP_COLOR } from '../footprint-series.ts';
import { exactDecimal } from '../format.ts';
import { RequestQueue, type FetchFn, type Want } from '../request-queue.ts';
import { chunkSpanSec } from '../tiles.ts';
import { displayZone, fmtShown, zoneLabel } from '../time-format.ts';
import type { BarItem, SymbolInfo } from '../types.ts';
import {
  barCoverageText,
  barSegments,
  coverageBands,
  coverageNote,
  coverageSummary,
  decimateAdaptive,
  fmtNotionalShort,
  fmtNotionalUsdt,
  fmtUsdtCompact,
  fmtVwap,
  HitGrid,
  markStalePending,
  mergeBands,
  radiusPx,
  TIER_ALPHA,
  tierOf,
  vwapPrice,
  wantedChunks,
  type Band,
  type BarTick,
  type CoverageSummary,
} from './model.ts';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
type Scope = Parameters<Parameters<Target['useBitmapCoordinateSpace']>[0]>[0];

/** Was die Schicht vom Chart-Controller braucht (schmal, in Tests ersetzbar). */
export interface BigTradesHost {
  chart: IChartApi;
  apiBase: string;
  sym(): SymbolInfo | null;
  tf(): string;
  tfSec(): number;
  items(): readonly BarItem[];
  visibleTimeRange(): [number, number] | null;
  /** Preis → y (CSS-px) der gerade sichtbaren Serie. */
  priceToY(price: number): number | null;
  /** Footprint-Modus (Zellen statt Kerzen): dann Sweep-Linie px_first..px_last. */
  footprintActive(): boolean;
  /** Laden gerade Kacheln oder Bars? Dann stehen Big Trades zurück (wie Profile, W-4). */
  busy(): boolean;
  gestureActive(): boolean;
}

export const BIGTRADES_CACHE_ENTRIES = 64;
/** Nicht finale Antworten (laufender Tag, ausstehender Neuimport) nach so vielen ms neu anfragen. */
export const BIGTRADES_NONFINAL_TTL_MS = 60_000;
/** 422 gilt für URL und Datenstand; nach dieser Zeit erneut versuchen. */
export const BIGTRADES_REJECT_TTL_MS = 5 * 60_000;
export const BIGTRADES_MAX_PARALLEL = 2;
export const BIGTRADES_HOLD_MS = 150;
export const BIGTRADES_MAX_HOLD_MS = 2_000;
/** Höchstzahl gleichzeitig benötigter Abschnitte (Kerzenfenster: 20 Abschnitte). */
export const BIGTRADES_MAX_CHUNKS = 24;
/** Höchstzahl Teilstücke je Abschnitt nach source_rows_exceeded (begrenzte Teilung). */
export const BIGTRADES_MAX_PIECES = 16;
/** Obergrenzen der Hilfstabellen (Ablehnungen, Teilungen). */
const MAX_AUX = 512;
/** Größen-Label ab Stufe 1 (2,5×), nur wenn höchstens so viele Marker gezeichnet werden. */
const LABEL_MAX_MARKERS = 300;
/** Höchstzahl gezeichneter Kreise (Ausdünnung vergröbert ihre Zellen darüber). */
export const MAX_DRAWN = 4000;

type DrawKind = Exclude<Band['kind'], 'pending'>;
const BAND_STYLE: Record<DrawKind, { fill: string; line: string; text: string }> = {
  none: {
    fill: 'rgba(139, 148, 158, 0.07)',
    line: 'rgba(139, 148, 158, 0.16)',
    text: 'rgba(139, 148, 158, 0.9)',
  },
  partial: {
    fill: 'rgba(242, 201, 76, 0.05)',
    line: 'rgba(242, 201, 76, 0.14)',
    text: 'rgba(242, 201, 76, 0.85)',
  },
  stale: {
    fill: 'rgba(240, 136, 62, 0.07)',
    line: 'rgba(240, 136, 62, 0.2)',
    text: 'rgba(240, 136, 62, 0.95)',
  },
  toomany: {
    fill: 'rgba(239, 83, 80, 0.06)',
    line: 'rgba(239, 83, 80, 0.16)',
    text: 'rgba(239, 83, 80, 0.9)',
  },
  failed: {
    fill: 'rgba(239, 83, 80, 0.06)',
    line: 'rgba(239, 83, 80, 0.16)',
    text: 'rgba(239, 83, 80, 0.9)',
  },
};
/** Farbe der dünnen Lücken-Markierung je Art (am unteren Rand des Bars). */
const TICK_COLOR: Record<DrawKind, string> = {
  none: 'rgba(160, 168, 178, 0.75)',
  partial: 'rgba(242, 201, 76, 0.7)',
  stale: 'rgba(240, 136, 62, 0.85)',
  toomany: 'rgba(239, 83, 80, 0.8)',
  failed: 'rgba(239, 83, 80, 0.8)',
};

interface Entry {
  key: string;
  sym: string;
  tf: string;
  c: number;
  minUsdt: number;
  /** angefragtes Teilstück [from, to) (ms) */
  from: number;
  to: number;
  meta: BigTradesMeta;
  rows: BigTradeColumns;
  /** VWAP als Preis (Gleitkomma, nur für die Position) */
  price: Float64Array;
  loadedAt: number;
}

interface Rejection {
  kind: 'toomany' | 'failed';
  suggestMinUsdt: number | null;
  message: string;
  at: number;
}

interface Piece {
  from: number;
  to: number;
  key: string;
  entry: Entry | null;
  rej: Rejection | null;
}

export interface BigTradesReadout {
  /** Symbol hat Big Trades (`/symbols` bigTrades ≠ null) */
  available: boolean;
  enabled: boolean;
  minUsdt: number | null;
  floorUsdt: number | null;
  /** Marker ≥ Schwelle im sichtbaren Bereich (vor der Pixel-Ausdünnung) bzw. gezeichnet */
  markers: number;
  drawn: number;
  /** Zelle der Pixel-Ausdünnung (CSS-px), je Zelle und Seite der größte Marker */
  cellW: number;
  cellH: number;
  /** Vom Server ausgedünnt (Σ omitted der sichtbaren Abschnitte), größtes k */
  omitted: number;
  k: number | null;
  /** sichtbare Teilstücke noch ohne Antwort */
  loading: number;
  coverage: CoverageSummary | null;
  /** Legenden-Hinweis zur Abdeckung ('' = vollständig) */
  coverageNote: string;
  /** 422 matched_rows_exceeded: kleinste Schwelle, die alle sichtbaren abgelehnten Abschnitte lädt */
  suggestMinUsdt: number | null;
  /** abgelehnte sichtbare Abschnitte ohne Vorschlag */
  tooManyNoSuggest: boolean;
  error: string;
  requests: number;
  inFlight: number;
}

/** Ein gezeichneter Marker (für Hover). */
interface Drawn {
  e: Entry;
  i: number;
}

/** Sichtbarer Zustand (ohne Pixel): Antworten, Bänder, Legendenwerte. */
interface State {
  key: string;
  entries: Entry[];
  /** minutengenau, aufsteigend (für Legende und Hover) */
  bands: Band[];
  /** je Bar: Flächen (überwiegend ohne Daten) und dünne Markierungen (kurze Lücken) */
  full: Band[];
  ticks: BarTick[];
  minN: number;
  /** Preisbereich der sichtbaren Orders (Stützstellen der y-Abbildung) */
  pMin: number;
  pMax: number;
  markers: number;
  omitted: number;
  k: number | null;
  loading: number;
  coverage: CoverageSummary | null;
  suggest: number | null;
  tooManyNoSuggest: boolean;
  /** Zeitpunkt (performance.now), ab dem eine benutzte nicht finale Antwort veraltet ist */
  validUntil: number;
}

/** Anordnung in Pixeln (CSS-px), gültig bis sich Zustand, Achsen, Größe oder Modus ändern. */
interface Layout {
  key: string;
  /** gezeichnete Marker in Zeichenreihenfolge (größte Stufe zuerst) */
  refs: Drawn[];
  x: Float64Array;
  y: Float64Array;
  r: Float64Array;
  tier: Uint8Array;
  buy: Uint8Array;
  /** Sweep: y von px_first / px_last (NaN = keine Spanne) */
  ya: Float64Array;
  yb: Float64Array;
  labels: { x: number; y: number; text: string }[];
  /** Flächen [x0, x1) und Lücken-Markierungen [x0, x1) in CSS-px */
  full: { a: number; z: number; band: Band }[];
  ticks: { a: number; z: number; kind: DrawKind }[];
  /** Lücken ohne eigene Bars (a = z): Grenzmarke an x */
  marks: { x: number; kind: DrawKind }[];
  cellW: number;
  cellH: number;
  grid: HitGrid;
}

const EMPTY_STATE = (key: string): State => ({
  key,
  entries: [],
  bands: [],
  full: [],
  ticks: [],
  minN: 0,
  pMin: 0,
  pMax: 0,
  markers: 0,
  omitted: 0,
  k: null,
  loading: 0,
  coverage: null,
  suggest: null,
  tooManyNoSuggest: false,
  validUntil: Infinity,
});

export class BigTradesLayer implements IPanePrimitive<Time> {
  enabled = false;
  /** gewählte Schwelle in ganzen USDT (App klemmt auf ≥ Untergrenze) */
  minUsdt: number | null = null;
  suspended = false;
  /** Nach Datenankunft (UI aktualisiert die Legende). */
  onChange: (() => void) | null = null;

  private readonly host: BigTradesHost;
  private readonly queue: RequestQueue;
  private readonly cache = new Map<string, Entry>();
  private readonly rejected = new Map<string, Rejection>();
  /** Teilung eines Abschnitts (sym|tf|c|min) nach source_rows_exceeded: Grenzen inkl. from und to */
  private readonly plans = new Map<string, number[]>();
  private requestUpdate: (() => void) | null = null;
  private readonly views: IPanePrimitivePaneView[];
  private error = '';
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdSince: number | null = null;
  private hovered: Drawn | null = null;
  /** erhöht bei jeder Änderung von Cache/Ablehnungen/Teilungen/Einstellungen */
  private version = 0;
  private state: State = EMPTY_STATE('');
  private layout: Layout | null = null;
  readonly counters = { draws: 0, layouts: 0, collects: 0, filteredFromCache: 0, splits: 0 };

  constructor(host: BigTradesHost, fetchFn?: FetchFn) {
    this.host = host;
    this.queue = new RequestQueue(
      (key, buf) => this.onLoaded(key, buf),
      (key, status, err, body) => this.onRejected(key, status, err, body),
      fetchFn ?? ((u, i) => fetch(u, i)),
      BIGTRADES_MAX_PARALLEL,
    );
    this.queue.label = () => 'Big Trades';
    const bottom: IPrimitivePaneRenderer = {
      draw: (t: Target) => t.useBitmapCoordinateSpace((s) => this.drawBands(s)),
    };
    const top: IPrimitivePaneRenderer = {
      draw: (t: Target) => t.useBitmapCoordinateSpace((s) => this.drawMarkers(s)),
    };
    this.views = [
      { zOrder: () => 'bottom', renderer: () => bottom },
      { zOrder: () => 'top', renderer: () => top },
    ];
  }

  // ---------------------------------------------------------------- Primitive

  attached(p: PaneAttachedParameter<Time>): void {
    this.requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this.requestUpdate = null;
  }
  paneViews(): readonly IPanePrimitivePaneView[] {
    return this.views;
  }
  /** Daten/Einstellung geändert: Zustand neu bestimmen und neu zeichnen. */
  redraw(): void {
    this.version++;
    this.requestUpdate?.();
  }

  destroy(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.queue.cancelAll();
  }

  /** Symbolwechsel: Hover/Fehler zurücksetzen (Cache-Schlüssel tragen das Symbol). */
  resetForSymbol(): void {
    this.hovered = null;
    this.error = '';
    this.queue.cancelAll();
    this.redraw();
  }

  /** Einstellung geändert (an/aus, Schwelle): Bedarf neu, neu zeichnen. */
  changed(): void {
    this.error = '';
    this.hovered = null;
    this.frame();
    this.redraw();
  }

  private thresholdN(s: SymbolInfo): number | null {
    const bt = s.bigTrades;
    if (!bt || this.minUsdt === null) return null;
    return this.minUsdt * 10 ** bt.notionalDecimals;
  }

  /** Teilung gilt für jede Schwelle (die gelesenen Quellzeilen hängen nicht von ihr ab). */
  private planKey(sym: string, tf: string, c: number): string {
    return `${sym}|${tf}|${c}`;
  }

  private pieceKey(sym: string, tf: string, c: number, min: number, a: number, b: number): string {
    return `bt|${sym}|${tf}|${c}|${min}|${a}|${b}`;
  }

  /** Teilstücke eines Abschnitts bei Schwelle min (ohne Teilung: der ganze Abschnitt). */
  private pieces(sym: string, tf: string, c: number, min: number, spanMs: number): Piece[] {
    const bounds = this.plans.get(this.planKey(sym, tf, c)) ?? [c * spanMs, (c + 1) * spanMs];
    const out: Piece[] = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const key = this.pieceKey(sym, tf, c, min, bounds[i]!, bounds[i + 1]!);
      out.push({
        from: bounds[i]!,
        to: bounds[i + 1]!,
        key,
        entry: this.cache.get(key) ?? null,
        rej: this.rejected.get(key) ?? null,
      });
    }
    return out;
  }

  private fresh(e: Entry, now: number): boolean {
    return e.meta.final || now - e.loadedAt < BIGTRADES_NONFINAL_TTL_MS;
  }

  /**
   * Teilstücke, aus denen Abschnitt c bei Schwelle min gezeichnet wird: genau diese Schwelle, wenn
   * vollständig geladen; sonst eine niedrigere, vollständig geladene, frische und nicht ausgedünnte
   * (Filtern im Client ist dann exakt); sonst die (teilweise geladene) genaue Schwelle.
   */
  private resolve(
    sym: string,
    tf: string,
    c: number,
    min: number,
    spanMs: number,
    now: number,
  ): { pieces: Piece[]; exact: boolean } {
    const exact = this.pieces(sym, tf, c, min, spanMs);
    if (exact.every((p) => p.entry)) return { pieces: exact, exact: true };
    const mins = new Set<number>();
    for (const e of this.cache.values())
      if (e.sym === sym && e.tf === tf && e.c === c && e.minUsdt < min) mins.add(e.minUsdt);
    for (const m of [...mins].sort((a, b) => b - a)) {
      const ps = this.pieces(sym, tf, c, m, spanMs);
      if (ps.every((p) => p.entry && p.entry.meta.omitted === 0 && this.fresh(p.entry, now)))
        return { pieces: ps, exact: false };
    }
    return { pieces: exact, exact: true };
  }

  private visibleChunks(): { c: number; priority: number }[] {
    const s = this.host.sym();
    const vis = this.host.visibleTimeRange();
    if (!s || !vis) return [];
    const span = chunkSpanSec(this.host.tfSec());
    return wantedChunks(
      vis[0],
      vis[1],
      span,
      s.dataFrom / 1000,
      s.dataTo / 1000,
      1,
      BIGTRADES_MAX_CHUNKS,
    );
  }

  /** Bedarf bestimmen (billig; vom Controller einmal je Frame außerhalb einer Geste). */
  frame(): void {
    const s = this.host.sym();
    if (this.suspended || !this.enabled || !s?.bigTrades || this.minUsdt === null) {
      this.queue.setWanted([], new Set());
      return;
    }
    // Bedarf erst am Gestenende (Entprellen wie Profile). Der Controller ruft frame() am Gestenende
    // nicht in jedem Pfad (z. B. „nur Kerzen"); daher selbst nachprüfen, bis die Geste vorbei ist.
    if (this.host.gestureActive()) {
      this.armRetry();
      return;
    }
    const tf = this.host.tf();
    const spanMs = chunkSpanSec(this.host.tfSec()) * 1000;
    const min = this.minUsdt;
    const now = performance.now();
    this.prune(now);
    const wants: Want[] = [];
    const retain = new Set<string>();
    for (const { c, priority } of this.visibleChunks()) {
      const view = this.resolve(s.name, tf, c, min, spanMs, now);
      if (!view.exact) {
        this.counters.filteredFromCache++;
        for (const p of view.pieces) this.touch(p.entry!);
        continue;
      }
      for (const p of view.pieces) {
        if (p.rej) {
          if (now - p.rej.at < BIGTRADES_REJECT_TTL_MS) continue;
          this.rejected.delete(p.key);
          this.queue.forgetFailure(p.key);
        }
        retain.add(p.key);
        if (p.entry) {
          this.touch(p.entry);
          if (this.fresh(p.entry, now)) continue;
          if (this.queue.isFinal(p.key)) this.queue.forgetFailure(p.key);
        }
        wants.push({
          key: p.key,
          url: `${this.host.apiBase}/api/v1/bigtrades?sym=${encodeURIComponent(s.name)}&tf=${tf}&from=${p.from}&to=${p.to}&min=${min}`,
          priority,
          // nicht finale Antwort erneuern: am Browser-Cache vorbei (Server: no-cache, ETag)
          reload: p.entry !== null,
        });
      }
    }
    if (wants.length > 0 && this.host.busy()) {
      this.holdSince ??= now;
      if (now - this.holdSince >= BIGTRADES_MAX_HOLD_MS) {
        const first = [...wants].sort((a, b) => a.priority - b.priority).slice(0, 1);
        this.queue.setWanted(this.queue.stats.inFlight > 0 ? [] : first, retain);
      } else this.queue.setWanted([], retain);
      this.armRetry();
      return;
    }
    this.holdSince = null;
    this.queue.setWanted(wants, retain);
  }

  /** LRU: Benutzung frischt auf. */
  private touch(e: Entry): void {
    this.cache.delete(e.key);
    this.cache.set(e.key, e);
  }

  /** Abgelaufene Ablehnungen entfernen; Hilfstabellen begrenzen (älteste zuerst). */
  private prune(now: number): void {
    for (const [k, r] of this.rejected)
      if (now - r.at >= BIGTRADES_REJECT_TTL_MS) {
        this.rejected.delete(k);
        this.version++;
      }
    while (this.rejected.size > MAX_AUX) this.rejected.delete(this.rejected.keys().next().value!);
    while (this.plans.size > MAX_AUX) this.plans.delete(this.plans.keys().next().value!);
  }

  /** frame() nach BIGTRADES_HOLD_MS erneut (zurückgestellt hinter Kacheln/Bars oder einer Geste). */
  private armRetry(): void {
    if (this.holdTimer) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.frame();
    }, BIGTRADES_HOLD_MS);
  }

  // ---------------------------------------------------------------- Antworten

  private parseKey(key: string) {
    const [, sym = '', tf = '', c = '', min = '', a = '', b = ''] = key.split('|');
    return { sym, tf, c: Number(c), min: Number(min), from: Number(a), to: Number(b) };
  }

  private onLoaded(key: string, buf: ArrayBuffer): void {
    const k = this.parseKey(key);
    const s = this.host.sym();
    if (!s || s.name !== k.sym) return; // Antwort des alten Symbols
    const d = decodeBigTrades(buf);
    const m = d.meta;
    // K2: Antwort gegen die Anfrage prüfen (wirft → sichtbar, endgültig für diesen Schlüssel)
    if (m.sym !== k.sym || m.tf !== k.tf || m.minUsdt !== k.min)
      throw new Error(`Antwort ${m.sym} ${m.tf} ≥ ${m.minUsdt} passt nicht zur Anfrage`);
    if (m.from !== k.from || m.to !== k.to)
      throw new Error('Antwort: Zeitraum passt nicht zur Anfrage');
    if (s.bigTrades && m.notionalDecimals !== s.bigTrades.notionalDecimals)
      throw new Error('Antwort: notionalDecimals passt nicht zu /symbols');
    const n = d.rows.ts.length;
    const price = new Float64Array(n);
    for (let i = 0; i < n; i++)
      price[i] = vwapPrice(d.rows.notional[i]!, d.rows.qty[i]!, m.priceDecimals);
    const e: Entry = {
      key,
      sym: k.sym,
      tf: k.tf,
      c: k.c,
      minUsdt: k.min,
      from: k.from,
      to: k.to,
      meta: m,
      rows: d.rows,
      price,
      loadedAt: performance.now(),
    };
    this.cache.delete(key);
    this.cache.set(key, e);
    this.rejected.delete(key);
    // eine frühere Meldung gilt nicht mehr, sobald keine Ablehnung „failed" übrig ist
    if (![...this.rejected.values()].some((r) => r.kind === 'failed')) this.error = '';
    while (this.cache.size > BIGTRADES_CACHE_ENTRIES)
      this.cache.delete(this.cache.keys().next().value!);
    this.redraw();
    this.onChange?.();
  }

  private onRejected(key: string, status: number, err?: unknown, body?: string): void {
    const k = this.parseKey(key);
    const s = this.host.sym();
    if (!s || s.name !== k.sym) return;
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(body ?? '') as Record<string, unknown>;
    } catch {
      // kein JSON (z. B. Proxy-Fehlerseite)
    }
    const reason = typeof j.reason === 'string' ? j.reason : '';
    const at = performance.now();
    if (status === 422 && reason === 'matched_rows_exceeded') {
      const sug = j.suggestMinUsdt;
      this.rejected.set(key, {
        kind: 'toomany',
        suggestMinUsdt: typeof sug === 'number' && Number.isSafeInteger(sug) ? sug : null,
        message: 'zu viele Orders',
        at,
      });
    } else if (status === 422 && reason === 'source_rows_exceeded') {
      if (!this.split(k, j.suggestTo))
        this.rejected.set(key, {
          kind: 'failed',
          suggestMinUsdt: null,
          message: 'Bereich zu groß',
          at,
        });
    } else if (status === 422 && reason === 'below_floor') {
      // Untergrenze hat sich geändert (neue /symbols folgen); nicht still anheben
      const m =
        typeof j.minUsdt === 'number'
          ? ` (Untergrenze laut Server ${fmtUsdtCompact(j.minUsdt)})`
          : '';
      this.error = `Big Trades: Schwelle unter der Untergrenze${m}`;
      this.rejected.set(key, { kind: 'failed', suggestMinUsdt: null, message: 'Schwelle', at });
    } else {
      const what =
        status === 0
          ? `Antwort unbrauchbar (${err instanceof Error ? err.message : String(err)})`
          : `HTTP ${status}${reason ? ` ${reason}` : ''}`;
      this.error = `Big Trades: ${what}`;
      this.rejected.set(key, { kind: 'failed', suggestMinUsdt: null, message: what, at });
    }
    this.redraw();
    this.onChange?.();
  }

  /**
   * source_rows_exceeded: Teilstück [from, to) an suggestTo teilen (ausgerichtet, strikt innen) und die
   * Teile anfragen; höchstens BIGTRADES_MAX_PIECES Teile je Abschnitt. false = nicht teilbar.
   */
  private split(k: ReturnType<BigTradesLayer['parseKey']>, suggestTo: unknown): boolean {
    const tfMs = this.host.tfSec() * 1000;
    if (
      typeof suggestTo !== 'number' ||
      !Number.isSafeInteger(suggestTo) ||
      suggestTo <= k.from ||
      suggestTo >= k.to ||
      suggestTo % tfMs !== 0
    )
      return false;
    const pk = this.planKey(k.sym, k.tf, k.c);
    const spanMs = chunkSpanSec(this.host.tfSec()) * 1000;
    const bounds = this.plans.get(pk) ?? [k.c * spanMs, (k.c + 1) * spanMs];
    if (bounds.length - 1 >= BIGTRADES_MAX_PIECES || !bounds.includes(k.from)) return false;
    if (!bounds.includes(suggestTo)) bounds.push(suggestTo);
    bounds.sort((a, b) => a - b);
    this.plans.delete(pk);
    this.plans.set(pk, bounds);
    this.counters.splits++;
    // erst nach dem Rückruf der Warteschlange neu anfragen
    queueMicrotask(() => this.frame());
    return true;
  }

  // ---------------------------------------------------------------- Sichtbarer Zustand

  /** Sichtbarer Zustand; neu nur, wenn sich Bereich, Einstellung oder Daten geändert haben. */
  private collect(): State {
    const s = this.host.sym();
    const vis = this.host.visibleTimeRange();
    const key = `${this.version}|${s?.name}|${s?.dataFrom}|${s?.dataTo}|${this.host.tf()}|${this.enabled}|${this.minUsdt}|${vis?.[0]}|${vis?.[1]}|${this.queue.stats.failed}|${this.queue.stats.completed}`;
    if (this.state.key === key && performance.now() < this.state.validUntil) return this.state;
    this.counters.collects++;
    const st = EMPTY_STATE(key);
    this.state = st;
    if (!this.enabled || !s?.bigTrades || this.minUsdt === null || !vis) return st;
    st.minN = this.thresholdN(s)!;
    const tf = this.host.tf();
    const tfSec = this.host.tfSec();
    const spanMs = chunkSpanSec(tfSec) * 1000;
    const now = performance.now();
    const visFrom = Math.max(vis[0] * 1000, s.dataFrom);
    const visTo = Math.min((vis[1] + tfSec) * 1000, s.dataTo);
    const raw: Band[] = [];
    for (const { c, priority } of this.visibleChunks()) {
      if (priority !== 0) continue;
      const view = this.resolve(s.name, tf, c, this.minUsdt, spanMs, now);
      for (const p of view.pieces) {
        const from = Math.max(p.from, s.dataFrom);
        const to = Math.min(p.to, s.dataTo);
        if (p.entry) {
          const e = p.entry;
          st.entries.push(e);
          if (view.exact) {
            st.omitted += e.meta.omitted;
            if (e.meta.k !== null) st.k = Math.max(st.k ?? 0, e.meta.k);
          }
          // erst auf den Datenbereich kürzen, dann zusammenfassen (sonst trüge ein Band die Gründe
          // der Spannen vor dem Datenbeginn bzw. nach dem Datenende mit, z. B. no_day)
          raw.push(...coverageBands(clipSpans(e.meta.coverage, from, to), st.minN));
        } else if (p.rej) {
          if (to > from) raw.push({ from, to, kind: p.rej.kind, reasons: [], floorN: null });
          if (p.rej.kind === 'toomany') {
            if (p.rej.suggestMinUsdt === null) st.tooManyNoSuggest = true;
            else st.suggest = Math.max(st.suggest ?? 0, p.rej.suggestMinUsdt);
          }
        } else if (this.queue.failing(p.key)) {
          // vorübergehender Fehler (Netz, 5xx): rot markieren, Wiederholung läuft
          if (to > from) raw.push({ from, to, kind: 'failed', reasons: [], floorN: null });
        } else st.loading++;
      }
    }
    // Live-Rand: neutral, solange er kurz ist; steht die Aufzeichnung, Warnung (stale)
    st.bands = markStalePending(mergeBands(raw), s.dataTo);
    // gültig, bis eine benutzte oder ersetzbare nicht finale Antwort veraltet (resolve() hängt daran)
    for (const e of this.cache.values())
      if (e.sym === s.name && e.tf === tf && !e.meta.final)
        st.validUntil = Math.min(st.validUntil, e.loadedAt + BIGTRADES_NONFINAL_TTL_MS);
    const seg = barSegments(st.bands, tfSec * 1000, s.dataFrom, s.dataTo);
    st.full = seg.full;
    st.ticks = seg.ticks;
    if (visTo > visFrom) st.coverage = coverageSummary(st.bands, visFrom, visTo);
    // sichtbare Orders zählen, Preisbereich für die y-Abbildung
    const fromMs = vis[0] * 1000;
    const toMs = (vis[1] + tfSec) * 1000;
    let pMin = Infinity;
    let pMax = -Infinity;
    for (const e of st.entries) {
      const r = e.rows;
      for (let i = lowerBound(r.ts, fromMs); i < r.ts.length && r.ts[i]! < toMs; i++) {
        if (r.notional[i]! < st.minN) continue;
        st.markers++;
        const p = e.price[i]!;
        if (p < pMin) pMin = p;
        if (p > pMax) pMax = p;
      }
    }
    st.pMin = pMin;
    st.pMax = pMax > pMin ? pMax : pMin + 1;
    return st;
  }

  readout(): BigTradesReadout {
    const s = this.host.sym();
    const st = this.collect();
    const bt = s?.bigTrades ?? null;
    return {
      available: !!bt,
      enabled: this.enabled,
      minUsdt: this.minUsdt,
      floorUsdt: bt?.minUsdt ?? null,
      markers: this.enabled ? st.markers : 0,
      drawn: this.enabled
        ? this.layout?.key.startsWith(`${st.key}#`)
          ? this.layout.refs.length
          : st.markers
        : 0,
      cellW: this.layout?.cellW ?? 2,
      cellH: this.layout?.cellH ?? 6,
      omitted: st.omitted,
      k: st.k,
      loading: st.loading,
      coverage: st.coverage,
      coverageNote: st.coverage && bt ? coverageNote(st.coverage, bt.notionalDecimals) : '',
      suggestMinUsdt: st.suggest,
      tooManyNoSuggest: st.tooManyNoSuggest,
      error: this.error || (this.enabled ? this.queue.lastError : ''),
      requests: this.queue.stats.started,
      inFlight: this.queue.stats.inFlight,
    };
  }

  /** Hover-Zusatz für den Bar zur Zeit tSec: fehlende Daten im Bar ('' = abgedeckt). */
  barNote(tSec: number): string {
    const s = this.host.sym();
    if (!this.enabled || !s?.bigTrades) return '';
    const st = this.collect();
    return barCoverageText(
      st.bands,
      tSec * 1000,
      this.host.tfSec() * 1000,
      s.bigTrades.notionalDecimals,
    );
  }

  // ---------------------------------------------------------------- Anordnung

  /** Anordnung in Pixeln; neu nur, wenn sich Zustand, Achsen, Größe oder Modus geändert haben. */
  private arrange(W: number, H: number): Layout | null {
    const st = this.collect();
    const items = this.host.items();
    const s = this.host.sym();
    if (!this.enabled || !s?.bigTrades || items.length === 0) return null;
    const ts = this.host.chart.timeScale();
    const x0 = ts.logicalToCoordinate(0 as never);
    const x1 = ts.logicalToCoordinate(1 as never);
    if (x0 === null || x1 === null) return null;
    const bs = x1 - x0;
    const fp = this.host.footprintActive();
    const yA = this.host.priceToY(st.pMin);
    const yB = this.host.priceToY(st.pMax);
    const key = `${st.key}#${x0}|${bs}|${yA}|${yB}|${W}|${H}|${fp}|${items.length}|${items[0]!.time}`;
    if (this.layout?.key === key) return this.layout;
    this.counters.layouts++;
    const tfSec = this.host.tfSec();
    const ym = this.yMap(st.pMin, st.pMax);
    const geo = bandGeometry(items, st.full, st.ticks, x0, bs, tfSec, W);
    // Marker: sichtbare Orders ≥ Schwelle → Pixel (Bar-Zeiger läuft mit, Orders je Antwort aufsteigend)
    const vis = this.host.visibleTimeRange()!;
    const fromMs = vis[0] * 1000;
    const toMs = (vis[1] + tfSec) * 1000;
    const n = st.markers;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const sides = new Int32Array(n);
    const nots = new Float64Array(n);
    const all: Drawn[] = new Array<Drawn>(n);
    let m = 0;
    for (const e of st.entries) {
      const r = e.rows;
      let ptr = 0;
      for (let i = lowerBound(r.ts, fromMs); i < r.ts.length && r.ts[i]! < toMs; i++) {
        if (r.notional[i]! < st.minN) continue;
        const bar = r.bar[i]!;
        while (ptr < items.length && items[ptr]!.time < bar) ptr++;
        const L =
          ptr < items.length && items[ptr]!.time === bar ? ptr : logicalOfSec(items, bar, tfSec);
        xs[m] = x0 + L * bs;
        ys[m] = ym(e.price[i]!) ?? Number.NaN;
        sides[m] = r.side[i]!;
        nots[m] = r.notional[i]!;
        all[m] = { e, i };
        m++;
      }
    }
    // erst auf die Pane beschränken, dann ausdünnen: Marker außerhalb vergröbern die Zellen nicht
    const on: number[] = [];
    for (let j = 0; j < m; j++) {
      const x = xs[j]!;
      const y = ys[j]!;
      if (Number.isFinite(y) && x >= -R_PAD && x <= W + R_PAD && y >= -R_PAD && y <= H + R_PAD)
        on.push(j);
    }
    const all1 = on.length === m; // alles in der Pane: ohne Kopie
    const pick = <T extends Float64Array | Int32Array>(a: T, mk: (n: number) => T): T => {
      if (all1) return a;
      const o = mk(on.length);
      on.forEach((j, q) => (o[q] = a[j]!));
      return o;
    };
    const dec = decimateAdaptive(
      on.length,
      pick(xs, (n) => new Float64Array(n)),
      pick(ys, (n) => new Float64Array(n)),
      pick(sides, (n) => new Int32Array(n)),
      pick(nots, (n) => new Float64Array(n)),
      MAX_DRAWN,
      W,
      H,
    );
    const vis2 = all1 ? dec.keep : dec.keep.map((q) => on[q]!);
    // Zeichenreihenfolge: größte Stufe zuerst, kleinere darüber (bleiben sichtbar)
    const order: number[] = [];
    for (const tier of [2, 1, 0])
      for (const j of vis2) if (tierOf(nots[j]!, st.minN) === tier) order.push(j);
    const k = order.length;
    const L: Layout = {
      key,
      refs: new Array<Drawn>(k),
      x: new Float64Array(k),
      y: new Float64Array(k),
      r: new Float64Array(k),
      tier: new Uint8Array(k),
      buy: new Uint8Array(k),
      ya: new Float64Array(k),
      yb: new Float64Array(k),
      labels: [],
      full: geo.full,
      ticks: geo.ticks,
      marks: geo.marks,
      cellW: dec.cellW,
      cellH: dec.cellH,
      grid: new HitGrid(32),
    };
    const pd = s.priceDecimals;
    const nd = s.bigTrades.notionalDecimals;
    const labels = !fp && k <= LABEL_MAX_MARKERS;
    const placed: Box[] = [];
    order.forEach((j, q) => {
      const d = all[j]!;
      const r = radiusPx(nots[j]!, st.minN);
      L.refs[q] = d;
      L.x[q] = xs[j]!;
      L.y[q] = ys[j]!;
      L.r[q] = r;
      L.tier[q] = tierOf(nots[j]!, st.minN);
      L.buy[q] = sides[j] === 1 ? 1 : 0;
      const a = d.e.rows.pxFirst[d.i]!;
      const b = d.e.rows.pxLast[d.i]!;
      L.ya[q] = fp && a !== b ? (ym(a / 10 ** pd) ?? Number.NaN) : Number.NaN;
      L.yb[q] = fp && a !== b ? (ym(b / 10 ** pd) ?? Number.NaN) : Number.NaN;
      L.grid.add(q, xs[j]!, ys[j]!, r);
      if (labels && L.tier[q]! >= 1) {
        // nur ohne Überlappung mit bereits gesetzten Labels (gierig, größte Stufe zuerst)
        const text = fmtNotionalShort(nots[j]!, nd);
        const box = { x: xs[j]! + r + 3, y: ys[j]! - 6, w: text.length * 5.5, h: 12 };
        if (!placed.some((p) => overlaps(p, box))) {
          placed.push(box);
          L.labels.push({ x: box.x, y: ys[j]!, text });
        }
      }
    });
    this.layout = L;
    return L;
  }

  /** Preis → y: linear aus zwei Stützstellen, wenn die Skala linear ist (Probe in der Mitte). */
  private yMap(lo: number, hi: number): (p: number) => number | null {
    const h = this.host;
    const y0 = h.priceToY(lo);
    const y1 = h.priceToY(hi);
    const ym = h.priceToY((lo + hi) / 2);
    if (
      y0 !== null &&
      y1 !== null &&
      ym !== null &&
      hi > lo &&
      Math.abs((y0 + y1) / 2 - ym) < 0.5
    ) {
      const k = (y1 - y0) / (hi - lo);
      return (p) => y0 + (p - lo) * k;
    }
    return (p) => h.priceToY(p);
  }

  // ---------------------------------------------------------------- Zeichnen

  private drawBands(scope: Scope): void {
    const L = this.arrange(scope.mediaSize.width, scope.mediaSize.height);
    if (!L || (L.full.length === 0 && L.ticks.length === 0 && L.marks.length === 0)) return;
    const ctx = scope.context;
    const hpr = scope.horizontalPixelRatio;
    const vpr = scope.verticalPixelRatio;
    const W = scope.bitmapSize.width;
    const H = scope.bitmapSize.height;
    const nd = this.host.sym()?.bigTrades?.notionalDecimals ?? 0;
    ctx.save();
    ctx.font = `${Math.round(10 * vpr)}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    for (const f of L.full) {
      const b = f.band;
      const kind = b.kind as DrawKind;
      const a = Math.max(0, Math.round(f.a * hpr));
      const z = Math.min(W, Math.round(f.z * hpr));
      if (z <= a) continue;
      const style = BAND_STYLE[kind];
      ctx.fillStyle = style.fill;
      ctx.fillRect(a, 0, z - a, H);
      // Schraffur (diagonal, 10 px Abstand): „keine Daten" ist sichtbar etwas anderes als leere Fläche
      ctx.save();
      ctx.beginPath();
      ctx.rect(a, 0, z - a, H);
      ctx.clip();
      ctx.strokeStyle = style.line;
      ctx.lineWidth = Math.max(1, Math.round(hpr));
      ctx.beginPath();
      const step = Math.round(10 * hpr);
      for (let x = a - H - (a % step); x < z; x += step) {
        ctx.moveTo(x, H);
        ctx.lineTo(x + H, 0);
      }
      ctx.stroke();
      ctx.restore();
      const label =
        kind === 'none'
          ? 'keine Big-Trade-Daten'
          : kind === 'stale'
            ? `Big Trades seit ${fmtShown(b.from)} ${zoneLabel(b.from, displayZone())} nicht aktualisiert`
            : kind === 'partial'
              ? `Big Trades erst ab ${fmtUsdtCompact(Math.ceil((b.floorN ?? 0) / 10 ** nd), true)}`
              : kind === 'toomany'
                ? 'zu viele Orders – Schwelle erhöhen'
                : 'Big Trades nicht ladbar';
      const tw = ctx.measureText(label).width;
      // unten in der Pane (oben liegt die Legende), rechts neben dem Logo der Bibliothek
      const lx = Math.max(a + 4 * hpr, LOGO_PX * hpr);
      if (z - lx >= tw + 4 * hpr) {
        ctx.fillStyle = style.text;
        ctx.fillText(label, lx, H - Math.round(4 * vpr));
      }
    }
    // kurze Lücken: dünne Markierung am unteren Rand des Bars (Hover nennt Minuten und Grund)
    const th = Math.max(2, Math.round(TICK_PX * vpr));
    for (const t of L.ticks) {
      const a = Math.round(t.a * hpr) + 1;
      const w = Math.max(Math.round(2 * hpr), Math.round((t.z - t.a) * hpr) - 2);
      ctx.fillStyle = TICK_COLOR[t.kind];
      ctx.fillRect(a, H - th, w, th);
    }
    // Lücken ohne eigene Bars (Spanne fällt auf der Index-Achse auf eine Bar-Grenze): gestrichelte
    // Grenzmarke über die ganze Höhe, damit auch eine fehlende Stunde ohne Bars sichtbar bleibt
    ctx.lineWidth = Math.max(1, Math.round(hpr));
    ctx.setLineDash([Math.round(3 * vpr), Math.round(3 * vpr)]);
    for (const mk of L.marks) {
      const x = Math.round(mk.x * hpr) + 0.5;
      ctx.strokeStyle = TICK_COLOR[mk.kind];
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillStyle = TICK_COLOR[mk.kind];
      ctx.fillRect(x - Math.round(2 * hpr), H - th, Math.round(4 * hpr), th);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawMarkers(scope: Scope): void {
    this.counters.draws++;
    const L = this.arrange(scope.mediaSize.width, scope.mediaSize.height);
    if (!L || L.refs.length === 0) return;
    const ctx = scope.context;
    const hpr = scope.horizontalPixelRatio;
    const vpr = scope.verticalPixelRatio;
    const k = L.refs.length;
    ctx.save();
    // Sweep-Spanne px_first..px_last nur im Footprint-Modus (Entscheidung 2026-11-26; ya NaN sonst)
    for (let q = 0; q < k; q++) {
      const ya = L.ya[q]!;
      const yb = L.yb[q]!;
      if (!Number.isFinite(ya) || !Number.isFinite(yb)) continue;
      const x = Math.round(L.x[q]! * hpr) + 0.5;
      const w = 4 * hpr;
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(x, ya * vpr);
        ctx.lineTo(x, yb * vpr);
        // kurze Querstriche an den Enden (erster / letzter Fill)
        ctx.moveTo(x - w, ya * vpr);
        ctx.lineTo(x + w, ya * vpr);
        ctx.moveTo(x - w, yb * vpr);
        ctx.lineTo(x + w, yb * vpr);
      };
      // dunkler Rand, damit die Linie über farbigen Zellen lesbar bleibt
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = HALO;
      ctx.lineWidth = Math.max(2, Math.round(4 * hpr));
      path();
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = L.buy[q] ? UP_COLOR : DOWN_COLOR;
      ctx.lineWidth = Math.max(1, Math.round(2 * hpr));
      path();
      ctx.stroke();
    }
    for (let q = 0; q < k; q++) {
      const tier = L.tier[q]! as 0 | 1 | 2;
      const x = L.x[q]! * hpr;
      const y = L.y[q]! * vpr;
      const color = L.buy[q] ? UP_COLOR : DOWN_COLOR;
      ctx.beginPath();
      ctx.arc(x, y, L.r[q]! * hpr, 0, 2 * Math.PI);
      // dunkler Ring unter jedem Kreis: Kontrast zu Kerzen und Footprint-Zellen gleicher Farbe
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = HALO;
      ctx.lineWidth = 2 * hpr;
      ctx.stroke();
      ctx.globalAlpha = TIER_ALPHA[tier];
      ctx.fillStyle = color;
      ctx.fill();
      if (tier >= 1) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = tier === 2 ? 1.5 * hpr : 1 * hpr;
        ctx.strokeStyle = tier === 2 ? 'rgba(230, 237, 243, 0.9)' : color;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // Labels zuletzt, damit kein späterer Kreis sie verdeckt
    if (L.labels.length > 0) {
      ctx.font = `${Math.round(10 * vpr)}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(230, 237, 243, 0.9)';
      for (const p of L.labels) ctx.fillText(p.text, p.x * hpr, p.y * vpr);
    }
    // hervorgehobener Marker (Hover)
    const hv = this.hovered;
    if (hv) {
      const q = L.refs.findIndex((d) => d.e === hv.e && d.i === hv.i);
      if (q >= 0) {
        ctx.strokeStyle = '#f2c94c';
        ctx.lineWidth = 2 * hpr;
        ctx.beginPath();
        ctx.arc(L.x[q]! * hpr, L.y[q]! * vpr, (L.r[q]! + 2) * hpr, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Hover: Text des Markers unter (x, y) (CSS-px der Hauptpane) oder ''. */
  hoverText(x: number, y: number): string {
    const L = this.layout;
    if (!this.enabled || !L) return this.setHover(null);
    const id = L.grid.query(x, y);
    const d = id === null ? null : (L.refs[id] ?? null);
    this.setHover(d);
    if (!d) return '';
    const s = this.host.sym();
    if (!s?.bigTrades) return '';
    const r = d.e.rows;
    const m = d.e.meta;
    const i = d.i;
    const ts = r.ts[i]!;
    const sec = String(Math.floor(ts / 1000) % 60).padStart(2, '0');
    const ms = String(ts % 1000).padStart(3, '0');
    const time = `${fmtShown(ts)}:${sec}.${ms} ${zoneLabel(ts, displayZone())}`;
    const base = s.name.replace(/USDT$/, '');
    const px = (u: number) => exactDecimal(u, m.priceDecimals);
    const side = r.side[i] === 1 ? 'Kauf (Käufer-Aggressor)' : 'Verkauf (Verkäufer-Aggressor)';
    const span =
      r.pxFirst[i] === r.pxLast[i]
        ? `Preis ${px(r.pxFirst[i]!)}`
        : `Spanne ${px(r.pxFirst[i]!)} → ${px(r.pxLast[i]!)}`;
    return [
      `Big Trade ${time}`,
      side,
      fmtNotionalUsdt(r.notional[i]!, m.notionalDecimals),
      `${exactDecimal(r.qty[i]!, m.qtyDecimals)} ${base}`,
      `VWAP ${fmtVwap(r.notional[i]!, r.qty[i]!, m.priceDecimals)}`,
      span,
      `≈ ${r.aggN[i]} Fills`,
    ].join(' · ');
  }

  /** Hervorhebung setzen; nur neu zeichnen (die Anordnung bleibt), wenn sie sich ändert. */
  private setHover(d: Drawn | null): string {
    const h = this.hovered;
    if (h?.e !== d?.e || h?.i !== d?.i) {
      this.hovered = d;
      this.requestUpdate?.();
    }
    return '';
  }
}

/** Breite des Logos der Bibliothek unten links (CSS-px), Bandbeschriftung beginnt rechts davon. */
const LOGO_PX = 52;
/** Höhe der Lücken-Markierung (CSS-px). */
const TICK_PX = 3;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Überlappen sich zwei Rechtecke (Kanten berühren zählt nicht)? */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Hintergrundfarbe des Charts als Kontrastrand. */
const HALO = '#0f1217';
/** Rand außerhalb der Pane, in dem Marker noch gezeichnet werden (größter Radius). */
const R_PAD = 18;

/** Mindestbreite einer Fläche (CSS-px), damit ein einzelner Bar bei starkem Herauszoomen bleibt. */
export const MIN_BAND_PX = 2;

/**
 * Bänder → Pixel (CSS-px) auf der indexbasierten Zeitachse: Flächen [a, z) an Bar-Grenzen, mindestens
 * MIN_BAND_PX breit; Markierungen je Bar mit kurzer Lücke. Liegt eine Spanne nur über Zeit ohne Bars
 * (z. B. eine Lückenminute ohne Trades auf 1m, eine Stunde ohne Bars), fiele sie auf a = z: dafür eine
 * Grenzmarke an x. Nur was in [0, W] liegt.
 */
export function bandGeometry(
  items: readonly BarItem[],
  full: readonly Band[],
  ticks: readonly BarTick[],
  x0: number,
  bs: number,
  tfSec: number,
  W: number,
): {
  full: { a: number; z: number; band: Band }[];
  ticks: { a: number; z: number; kind: DrawKind }[];
  marks: { x: number; kind: DrawKind }[];
} {
  const xOf = (sec: number) => x0 + logicalOfSec(items, sec, tfSec) * bs - bs / 2;
  const out = {
    full: [] as { a: number; z: number; band: Band }[],
    ticks: [] as { a: number; z: number; kind: DrawKind }[],
    marks: [] as { x: number; kind: DrawKind }[],
  };
  const inView = (a: number, z: number) => z >= 0 && a <= W;
  for (const b of full) {
    if (b.kind === 'pending') continue;
    const kind = b.kind as DrawKind;
    const a = xOf(b.from / 1000);
    let z = xOf(b.to / 1000);
    if (z - a < 1e-9) {
      if (inView(a, a)) out.marks.push({ x: a, kind });
      continue;
    }
    if (z - a < MIN_BAND_PX) z = a + MIN_BAND_PX;
    if (inView(a, z)) out.full.push({ a, z, band: b });
  }
  for (const t of ticks) {
    if (t.kind === 'pending') continue;
    const kind = t.kind as DrawKind;
    const sec = t.bar / 1000;
    const i = indexOfTime(items, sec);
    const a = xOf(sec);
    if (i < 0) {
      if (inView(a, a)) out.marks.push({ x: a, kind });
      continue;
    }
    if (inView(a, a + bs)) out.ticks.push({ a, z: a + bs, kind });
  }
  return out;
}

/** Index des Bars mit genau dieser Zeit (s) oder −1. */
function indexOfTime(items: readonly BarItem[], t: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (items[m]!.time < t) lo = m + 1;
    else hi = m;
  }
  return lo < items.length && items[lo]!.time === t ? lo : -1;
}

/** Abdeckungsspannen auf [from, to) gekürzt (leere entfallen). */
export function clipSpans(
  spans: readonly CoverageSpan[],
  from: number,
  to: number,
): CoverageSpan[] {
  const out: CoverageSpan[] = [];
  for (const c of spans) {
    const a = Math.max(c.from, from);
    const z = Math.min(c.to, to);
    if (z > a) out.push({ ...c, from: a, to: z });
  }
  return out;
}

/** Erster Index mit a[i] ≥ v (a aufsteigend). */
export function lowerBound(a: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m]! < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/**
 * Logische Position der Zeit t (s) auf der indexbasierten Zeitachse: Index des ersten Bars ≥ t,
 * außerhalb der Items linear mit tf fortgesetzt (vor dem ersten Bar negativ, nach dem letzten > n − 1).
 */
export function logicalOfSec(items: readonly BarItem[], t: number, tfSec: number): number {
  const n = items.length;
  if (n === 0) return 0;
  if (t <= items[0]!.time) return (t - items[0]!.time) / tfSec;
  const last = items[n - 1]!.time;
  if (t > last) return n - 1 + (t - last) / tfSec;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (items[m]!.time < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}
