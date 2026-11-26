// Big-Trades-Schicht (KONZEPT §6.4, docs/BIGTRADES-API.md): Marker je Order als Pane-Primitive auf der
// Hauptpane, in Kerzen- und Footprint-Modus, gezeichnet im Zeichenzyklus der Bibliothek (kein DOM je
// Marker). Laden wie Bars/Profile: Abschnitte zu 1 000 Bars (dieselben wie /bars) für den sichtbaren
// Bereich ± 1, Bedarf erst am Gestenende, Abbruch bei Bedarfswechsel, zurückstehend hinter Kacheln und
// Bars, LRU-Cache je (Symbol, tf, Abschnitt, Schwelle). Wird die Schwelle über eine geladene,
// nicht ausgedünnte Antwort gehoben, filtert der Client ohne neue Anfrage. Abdeckung (`coverage`) wird
// immer gezeigt: wo keine Order-Daten liegen, heißt „kein Marker" nicht „kein Big Trade".
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
  coverageBands,
  coverageNote,
  coverageSummary,
  decimateByCell,
  fmtNotionalShort,
  fmtNotionalUsdt,
  fmtUsdtCompact,
  fmtVwap,
  HitGrid,
  mergeBands,
  radiusPx,
  TIER_ALPHA,
  tierOf,
  vwapPrice,
  wantedChunks,
  type Band,
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
/** Größen-Label ab Stufe 1 (2,5×), nur wenn höchstens so viele Marker gezeichnet werden. */
const LABEL_MAX_MARKERS = 300;

const BAND_STYLE: Record<Band['kind'], { fill: string; line: string; text: string }> = {
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

interface Entry {
  key: string;
  sym: string;
  tf: string;
  c: number;
  minUsdt: number;
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

export interface BigTradesReadout {
  /** Symbol hat Big Trades (`/symbols` bigTrades ≠ null) */
  available: boolean;
  enabled: boolean;
  minUsdt: number | null;
  floorUsdt: number | null;
  /** Marker ≥ Schwelle im sichtbaren Bereich (vor der Pixel-Ausdünnung) bzw. gezeichnet */
  markers: number;
  drawn: number;
  /** Vom Server ausgedünnt (Σ omitted der sichtbaren Abschnitte), größtes k */
  omitted: number;
  k: number | null;
  /** sichtbare Abschnitte noch ohne Antwort */
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
  private requestUpdate: (() => void) | null = null;
  private readonly views: IPanePrimitivePaneView[];
  private error = '';
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdSince: number | null = null;
  private readonly grid = new HitGrid(32);
  private drawnRefs: Drawn[] = [];
  private hovered: Drawn | null = null;
  private dirty = true;
  private bands: Band[] = [];
  private frameEntries: Entry[] = [];
  private stats = {
    markers: 0,
    drawn: 0,
    omitted: 0,
    k: null as number | null,
    loading: 0,
    coverage: null as CoverageSummary | null,
    suggest: null as number | null,
    tooManyNoSuggest: false,
  };
  readonly counters = { draws: 0, filteredFromCache: 0 };

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
  updateAllViews(): void {
    this.dirty = true;
  }
  paneViews(): readonly IPanePrimitivePaneView[] {
    return this.views;
  }
  redraw(): void {
    this.dirty = true;
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

  private key(sym: string, tf: string, c: number, min: number): string {
    return `bt|${sym}|${tf}|${c}|${min}`;
  }

  /**
   * Antwort, aus der Abschnitt c bei Schwelle min gezeichnet werden kann: genau diese Schwelle, sonst
   * eine niedrigere, nicht ausgedünnte (Filtern im Client ist dann exakt).
   */
  private lookup(sym: string, tf: string, c: number, min: number): Entry | null {
    const exact = this.cache.get(this.key(sym, tf, c, min));
    if (exact) return exact;
    let best: Entry | null = null;
    for (const e of this.cache.values()) {
      if (e.sym !== sym || e.tf !== tf || e.c !== c || e.minUsdt > min || e.meta.omitted > 0)
        continue;
      if (!best || e.minUsdt > best.minUsdt) best = e;
    }
    return best;
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
    const tfMs = this.host.tfSec() * 1000;
    const spanMs = chunkSpanSec(this.host.tfSec()) * 1000;
    const min = this.minUsdt;
    const now = performance.now();
    const wants: Want[] = [];
    const retain = new Set<string>();
    for (const { c, priority } of this.visibleChunks()) {
      const key = this.key(s.name, tf, c, min);
      const rj = this.rejected.get(key);
      if (rj) {
        if (now - rj.at < BIGTRADES_REJECT_TTL_MS) continue;
        this.rejected.delete(key);
        this.queue.forgetFailure(key);
      }
      const e = this.lookup(s.name, tf, c, min);
      if (e) {
        // LRU: Benutzung frischt auf
        this.cache.delete(e.key);
        this.cache.set(e.key, e);
        if (e.key !== key) this.counters.filteredFromCache++;
        const stale = !e.meta.final && now - e.loadedAt >= BIGTRADES_NONFINAL_TTL_MS;
        if (!stale) {
          retain.add(key);
          continue;
        }
        if (this.queue.isFinal(key)) this.queue.forgetFailure(key);
      }
      retain.add(key);
      const from = c * spanMs;
      const to = from + spanMs;
      if (from % tfMs !== 0) continue; // nicht ausgerichtet (gibt es mit 1 000-Bar-Abschnitten nicht)
      wants.push({
        key,
        url: `${this.host.apiBase}/api/v1/bigtrades?sym=${encodeURIComponent(s.name)}&tf=${tf}&from=${from}&to=${to}&min=${min}`,
        priority,
        // nicht finale Antwort erneuern: am Browser-Cache vorbei (Server: no-cache, ETag)
        reload: e !== null,
      });
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

  /** frame() nach BIGTRADES_HOLD_MS erneut (zurückgestellt hinter Kacheln/Bars oder einer Geste). */
  private armRetry(): void {
    if (this.holdTimer) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.frame();
    }, BIGTRADES_HOLD_MS);
  }

  // ---------------------------------------------------------------- Antworten

  private parseKey(key: string): { sym: string; tf: string; c: number; min: number } {
    const [, sym = '', tf = '', c = '', min = ''] = key.split('|');
    return { sym, tf, c: Number(c), min: Number(min) };
  }

  private onLoaded(key: string, buf: ArrayBuffer): void {
    const k = this.parseKey(key);
    const s = this.host.sym();
    if (!s || s.name !== k.sym) return; // Antwort des alten Symbols
    const d = decodeBigTrades(buf);
    const m = d.meta;
    const spanMs = chunkSpanSec(m.tfSec) * 1000;
    // K2: Antwort gegen die Anfrage prüfen (wirft → sichtbar, endgültig für diesen Schlüssel)
    if (m.sym !== k.sym || m.tf !== k.tf || m.minUsdt !== k.min)
      throw new Error(`Antwort ${m.sym} ${m.tf} ≥ ${m.minUsdt} passt nicht zur Anfrage`);
    if (m.from !== k.c * spanMs || m.to !== (k.c + 1) * spanMs)
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
      meta: m,
      rows: d.rows,
      price,
      loadedAt: performance.now(),
    };
    this.cache.delete(key);
    this.cache.set(key, e);
    this.rejected.delete(key);
    while (this.cache.size > BIGTRADES_CACHE_ENTRIES) {
      const first = this.cache.keys().next().value as string;
      this.cache.delete(first);
    }
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

  // ---------------------------------------------------------------- Sichtbarer Zustand

  /** Sichtbare Abschnitte → Antworten, Bänder, Legendenwerte (einmal je Zeichnen). */
  private collect(): void {
    this.dirty = false;
    this.bands = [];
    this.frameEntries = [];
    const st = this.stats;
    st.omitted = 0;
    st.k = null;
    st.loading = 0;
    st.coverage = null;
    st.suggest = null;
    st.tooManyNoSuggest = false;
    const s = this.host.sym();
    const vis = this.host.visibleTimeRange();
    if (!this.enabled || !s?.bigTrades || this.minUsdt === null || !vis) return;
    const minN = this.thresholdN(s)!;
    const tf = this.host.tf();
    const spanMs = chunkSpanSec(this.host.tfSec()) * 1000;
    const visFrom = Math.max(vis[0] * 1000, s.dataFrom);
    const visTo = Math.min((vis[1] + this.host.tfSec()) * 1000, s.dataTo);
    const raw: Band[] = [];
    for (const { c, priority } of this.visibleChunks()) {
      if (priority !== 0) continue;
      const e = this.lookup(s.name, tf, c, this.minUsdt);
      const rj = this.rejected.get(this.key(s.name, tf, c, this.minUsdt));
      const from = Math.max(c * spanMs, s.dataFrom);
      const to = Math.min((c + 1) * spanMs, s.dataTo);
      if (e) {
        this.frameEntries.push(e);
        if (e.minUsdt === this.minUsdt) {
          st.omitted += e.meta.omitted;
          if (e.meta.k !== null) st.k = Math.max(st.k ?? 0, e.meta.k);
        }
        // erst auf den Datenbereich kürzen, dann zusammenfassen (sonst trüge ein Band die Gründe der
        // Spannen vor dem Datenbeginn bzw. nach dem Datenende mit, z. B. no_day)
        raw.push(...coverageBands(clipSpans(e.meta.coverage, from, to), minN));
      } else if (rj) {
        if (to > from) raw.push({ from, to, kind: rj.kind, reasons: [], floorN: null });
        if (rj.kind === 'toomany') {
          if (rj.suggestMinUsdt === null) st.tooManyNoSuggest = true;
          else st.suggest = Math.max(st.suggest ?? 0, rj.suggestMinUsdt);
        }
      } else st.loading++;
    }
    this.bands = mergeBands(raw);
    if (visTo > visFrom) st.coverage = coverageSummary(this.bands, visFrom, visTo);
  }

  readout(): BigTradesReadout {
    const s = this.host.sym();
    if (this.dirty) this.collect();
    const st = this.stats;
    const bt = s?.bigTrades ?? null;
    return {
      available: !!bt,
      enabled: this.enabled,
      minUsdt: this.minUsdt,
      floorUsdt: bt?.minUsdt ?? null,
      markers: this.enabled ? st.markers : 0,
      drawn: this.enabled ? st.drawn : 0,
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

  // ---------------------------------------------------------------- Zeichnen

  /** Lineare Abbildung logischer Index → x (CSS-px) aus zwei Stützstellen; null ohne Zeitachse. */
  private xMap(): { x0: number; bs: number } | null {
    const ts = this.host.chart.timeScale();
    const a = ts.logicalToCoordinate(0 as never);
    const b = ts.logicalToCoordinate(1 as never);
    if (a === null || b === null) return null;
    return { x0: a, bs: b - a };
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

  private drawBands(scope: Scope): void {
    if (this.dirty) this.collect();
    if (!this.enabled || this.bands.length === 0) return;
    const items = this.host.items();
    const xm = this.xMap();
    if (!xm || items.length === 0) return;
    const tfSec = this.host.tfSec();
    const ctx = scope.context;
    const hpr = scope.horizontalPixelRatio;
    const vpr = scope.verticalPixelRatio;
    const W = scope.bitmapSize.width;
    const H = scope.bitmapSize.height;
    const s = this.host.sym();
    const nd = s?.bigTrades?.notionalDecimals ?? 0;
    ctx.save();
    ctx.font = `${Math.round(10 * vpr)}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    for (const b of this.bands) {
      const xa = (xm.x0 + logicalOfSec(items, b.from / 1000, tfSec) * xm.bs - xm.bs / 2) * hpr;
      const xb = (xm.x0 + logicalOfSec(items, b.to / 1000, tfSec) * xm.bs - xm.bs / 2) * hpr;
      const a = Math.max(0, Math.round(xa));
      const z = Math.min(W, Math.round(xb));
      if (z <= a) continue;
      const style = BAND_STYLE[b.kind];
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
        b.kind === 'none'
          ? 'keine Big-Trade-Daten'
          : b.kind === 'partial'
            ? `Big Trades erst ab ${fmtUsdtCompact(Math.ceil((b.floorN ?? 0) / 10 ** nd))}`
            : b.kind === 'toomany'
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
    ctx.restore();
  }

  private drawMarkers(scope: Scope): void {
    if (this.dirty) this.collect();
    this.counters.draws++;
    this.grid.clear();
    this.drawnRefs = [];
    this.stats.markers = 0;
    this.stats.drawn = 0;
    const s = this.host.sym();
    const vis = this.host.visibleTimeRange();
    const items = this.host.items();
    if (!this.enabled || !s?.bigTrades || this.minUsdt === null || !vis || items.length === 0)
      return;
    const xm = this.xMap();
    if (!xm) return;
    const minN = this.thresholdN(s)!;
    const tfSec = this.host.tfSec();
    const W = scope.mediaSize.width;
    const H = scope.mediaSize.height;
    const fromMs = vis[0] * 1000;
    const toMs = (vis[1] + tfSec) * 1000;
    // sichtbare Orders ≥ Schwelle sammeln (je Antwort aufsteigend nach ts → Bar-Zeiger läuft mit)
    const xs: number[] = [];
    const ys: number[] = [];
    const sides: number[] = [];
    const nots: number[] = [];
    const refs: Drawn[] = [];
    let pMin = Infinity;
    let pMax = -Infinity;
    for (const e of this.frameEntries) {
      const r = e.rows;
      for (let i = lowerBound(r.ts, fromMs); i < r.ts.length && r.ts[i]! < toMs; i++) {
        if (r.notional[i]! < minN) continue;
        const p = e.price[i]!;
        if (p < pMin) pMin = p;
        if (p > pMax) pMax = p;
        refs.push({ e, i });
      }
    }
    this.stats.markers = refs.length;
    if (refs.length === 0) return;
    const ym = this.yMap(pMin, pMax > pMin ? pMax : pMin + 1);
    let ptr = 0;
    let last: Entry | null = null;
    for (const d of refs) {
      if (d.e !== last) {
        last = d.e;
        ptr = 0;
      }
      const bar = d.e.rows.bar[d.i]!;
      // Bar-Zeiger: Items aufsteigend, Orders aufsteigend → amortisiert O(1)
      while (ptr < items.length && items[ptr]!.time < bar) ptr++;
      const L =
        ptr < items.length && items[ptr]!.time === bar ? ptr : logicalOfSec(items, bar, tfSec);
      const y = ym(d.e.price[d.i]!);
      xs.push(xm.x0 + L * xm.bs);
      ys.push(y ?? Number.NaN);
      sides.push(d.e.rows.side[d.i]!);
      nots.push(d.e.rows.notional[d.i]!);
    }
    const keep = decimateByCell(refs.length, xs, ys, sides, nots).filter((j) => {
      const x = xs[j]!;
      const y = ys[j]!;
      return Number.isFinite(y) && x >= -R_PAD && x <= W + R_PAD && y >= -R_PAD && y <= H + R_PAD;
    });
    this.stats.drawn = keep.length;
    const ctx = scope.context;
    const hpr = scope.horizontalPixelRatio;
    const vpr = scope.verticalPixelRatio;
    const nd = s.bigTrades.notionalDecimals;
    const pd = s.priceDecimals;
    ctx.save();
    // Sweep-Spanne px_first..px_last nur im Footprint-Modus (Entscheidung 2026-11-26)
    const fpMode = this.host.footprintActive();
    if (fpMode) {
      for (const j of keep) {
        const d = refs[j]!;
        const a = d.e.rows.pxFirst[d.i]!;
        const b = d.e.rows.pxLast[d.i]!;
        if (a === b) continue;
        const ya = ym(a / 10 ** pd);
        const yb = ym(b / 10 ** pd);
        if (ya === null || yb === null) continue;
        const x = Math.round(xs[j]! * hpr) + 0.5;
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
        ctx.strokeStyle = sides[j] === 1 ? UP_COLOR : DOWN_COLOR;
        ctx.lineWidth = Math.max(1, Math.round(2 * hpr));
        path();
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // Kreise: größte Stufe zuerst, kleinere darüber (bleiben sichtbar)
    // Größen-Label nicht über Footprint-Zahlen (der Hover zeigt den exakten Wert)
    const labels = !fpMode && keep.length <= LABEL_MAX_MARKERS;
    const placed: (Box & { text: string; y0: number })[] = [];
    ctx.font = `${Math.round(10 * vpr)}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const tier of [2, 1, 0] as const) {
      for (const j of keep) {
        const n = nots[j]!;
        if (tierOf(n, minN) !== tier) continue;
        const r = radiusPx(n, minN);
        const x = xs[j]!;
        const y = ys[j]!;
        const color = sides[j] === 1 ? UP_COLOR : DOWN_COLOR;
        ctx.beginPath();
        ctx.arc(x * hpr, y * vpr, r * hpr, 0, 2 * Math.PI);
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
          if (labels) {
            // nur ohne Überlappung mit bereits gesetzten Labels (gierig, größte Stufe zuerst)
            const text = fmtNotionalShort(n, nd);
            const box = { x: x + r + 3, y: y - 6, w: ctx.measureText(text).width / hpr, h: 12 };
            if (!placed.some((p) => overlaps(p, box))) placed.push({ ...box, text, y0: y });
          }
        }
        this.grid.add(this.drawnRefs.length, x, y, r);
        this.drawnRefs.push(refs[j]!);
      }
    }
    ctx.globalAlpha = 1;
    // Labels zuletzt, damit kein späterer Kreis sie verdeckt
    ctx.fillStyle = 'rgba(230, 237, 243, 0.9)';
    for (const p of placed) ctx.fillText(p.text, p.x * hpr, p.y0 * vpr);
    // hervorgehobener Marker (Hover)
    const hv = this.hovered;
    if (hv) {
      const k = this.drawnRefs.findIndex((d) => d.e === hv.e && d.i === hv.i);
      if (k >= 0) {
        const j = keep.find((jj) => refs[jj]!.e === hv.e && refs[jj]!.i === hv.i)!;
        const r = radiusPx(nots[j]!, minN);
        ctx.strokeStyle = '#f2c94c';
        ctx.lineWidth = 2 * hpr;
        ctx.beginPath();
        ctx.arc(xs[j]! * hpr, ys[j]! * vpr, (r + 2) * hpr, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Hover: Text des Markers unter (x, y) (CSS-px der Hauptpane) oder ''. */
  hoverText(x: number, y: number): string {
    if (!this.enabled) return this.setHover(null);
    const id = this.grid.query(x, y);
    const d = id === null ? null : (this.drawnRefs[id] ?? null);
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
