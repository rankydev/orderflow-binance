// TPO-Ansicht (KONZEPT §7.4): eigenes Canvas neben dem Chart – x = Tage (Spalten fester Breite, gepannt
// über die Tage), y = Preis (gemeinsame lineare Skala, Zoom/Pan), je Tag Buchstabenmatrix mit POC, VA,
// IB, Single Prints, Open/Close und optional dem Volumenprofil rechts. Kein Overlay auf der Kerzenachse:
// die Breite eines TPO-Profils ist seine TPO-Anzahl, nicht die Bar-Anzahl.
//  - Daten: nur die sichtbaren Tage ± 1 als Bars des Quell-Zeitrahmens (chooseSourceTf), je Tag eine
//    Anfrage über eine eigene RequestQueue (Abbruch, Backoff, Retry-After), LRU; nicht finale Tage nach
//    60 s neu. Volumenprofil über /profiles/daily (gleiche Zeilengröße wie die TPOs).
//  - Zeichnen nur in requestAnimationFrame, nur sichtbare Tage und Zeilen; Mausbewegung ohne Taste
//    berechnet nur die Hover-Zeile (einmal je Frame), Zeilengröße/Bedarf erst am Gestenende.
import {
  checkDailyProfiles,
  decodeTile,
  tfSeconds,
  type DailyProfilesResponse,
} from '@orderflow/core/browser';
import type { ApiClient } from '../api.ts';
import { exactDecimal } from '../format.ts';
import {
  batchWindow,
  dailyKey,
  prepareProfile,
  profileLadder,
  profileRects,
  Paint,
  wantedDayBatches,
  type PreparedProfile,
  type Rect,
} from '../profile/model.ts';
import { clampBatch, PROFILE_COLORS, vwapProblem } from '../profile/layer.ts';
import { RequestQueue, type Want } from '../request-queue.ts';
import type { SymbolInfo } from '../types.ts';
import {
  blockShade,
  chooseSourceTf,
  computeTpo,
  DAY_MS,
  letterOf,
  rowLetters,
  TPO_DEFAULTS,
  TPO_ROW,
  tpoColumns,
  tpoDayOf,
  tpoDayStart,
  tpoRowSize,
  type TpoBars,
  type TpoDay,
  type TpoOptions,
} from './model.ts';

export interface TpoHost {
  api: ApiClient;
  sym(): SymbolInfo | null;
  /** Tagesgrenze (Stunden) wie die Volumenprofile */
  offsetH(): number;
}

export const TPO_CACHE_DAYS = 150;
export const TPO_NONFINAL_TTL_MS = 60_000;
const AXIS_W = 70;
const HEADER_H = 18;
const FOOTER_H = 82;
const PAD = 6;
const LETTER_W = 10;
const SHADES = 12;
const GESTURE_END_MS = 150;

interface Raw {
  bars: TpoBars;
  final: boolean;
  loadedAt: number;
}

/** Farbverlauf über den Tag (früh blau → spät orange), innerhalb und außerhalb der VA. */
function shadePalette(alpha: number): string[] {
  const a = [80, 140, 230];
  const b = [245, 160, 60];
  return Array.from({ length: SHADES }, (_, i) => {
    const t = i / (SHADES - 1);
    const c = a.map((v, k) => Math.round(v + (b[k]! - v) * t));
    return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  });
}
const IN_VA = shadePalette(0.9);
const OUT_VA = shadePalette(0.38);
const POC_COLOR = '#f2c94c';
const VA_LINE = 'rgba(200, 208, 225, 0.8)';
const IB_COLOR = '#5ee7f0';
const SINGLE_COLOR = '#ff9a5c';
const OPEN_COLOR = '#e6edf3';
const CLOSE_COLOR = '#ff5c7a';

export interface TpoReadout {
  R: number;
  rLabel: string;
  rAuto: boolean;
  tf: string;
  daysVisible: number;
  daysLoaded: number;
  lod: 'letters' | 'blocks';
  requests: number;
  inFlight: number;
  error: string;
  note: string;
  lastDrawMs: number;
}

export class TpoView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly host: TpoHost;
  opts: TpoOptions = { ...TPO_DEFAULTS };
  /** Spaltenbreite je Tag (px) und Verschiebung nach rechts (px, 0 = letzter Tag am rechten Rand) */
  colW = 260;
  scrollPx = 0;
  /** sichtbarer Preisbereich (price_unit) */
  private pTop = 0;
  private pBot = 0;
  private fitted = false;
  /** Preisbereich folgt den geladenen Tagen, bis der Nutzer ihn verschiebt oder zoomt */
  private autoFit = true;
  private autoR: number | null = null;
  private readonly raw = new Map<string, Raw>();
  private days = new Map<number, TpoDay>();
  private daysKey = '';
  private readonly vp = new Map<number, PreparedProfile>();
  private readonly vpBatches = new Set<string>();
  private readonly queue: RequestQueue;
  private readonly vpQueue: RequestQueue;
  private frameReq = 0;
  private gestureTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private drag: { x: number; y: number } | null = null;
  private hoverPos: { x: number; y: number } | null = null;
  private hoverReq = 0;
  private readonly ro: ResizeObserver;
  private readonly listeners: (() => void)[] = [];
  private W = 0;
  private H = 0;
  private error = '';
  private lod: 'letters' | 'blocks' = 'blocks';
  private visibleCount = 0;
  private readonly rects: Rect[] = [];
  onHover: ((text: string) => void) | null = null;
  onChange: (() => void) | null = null;
  readonly stats = { frames: 0, lastMs: 0, maxMs: 0, drawMs: new Float64Array(512), cells: 0 };

  constructor(container: HTMLElement, host: TpoHost) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'tpo-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.queue = new RequestQueue(
      (k, b) => this.onBars(k, b),
      (_k, status) => {
        this.error = `TPO-Bars: HTTP ${status}`;
        this.onChange?.();
      },
    );
    this.queue.label = () => 'TPO-Bars';
    this.vpQueue = new RequestQueue(
      (k, b) => this.onProfiles(k, b),
      () => {},
      undefined,
      2,
    );
    this.vpQueue.label = () => 'TPO-Volumenprofil';
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    const on = <K extends keyof HTMLElementEventMap>(
      ev: K,
      f: (e: HTMLElementEventMap[K]) => void,
      passive = true,
    ) => {
      this.canvas.addEventListener(ev, f as EventListener, { passive });
      this.listeners.push(() => this.canvas.removeEventListener(ev, f as EventListener));
    };
    on('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
    });
    on('pointermove', (e) => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        this.drag = { x: e.clientX, y: e.clientY };
        this.pan(dx, dy);
        this.gesture();
        return;
      }
      const r = this.canvas.getBoundingClientRect();
      this.hoverPos = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (!this.hoverReq)
        this.hoverReq = requestAnimationFrame(() => {
          this.hoverReq = 0;
          this.onHover?.(this.hoverText());
        });
    });
    const up = () => {
      this.drag = null;
    };
    on('pointerup', up);
    on('pointercancel', up);
    on('pointerleave', () => {
      this.hoverPos = null;
      this.onHover?.('');
    });
    on(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = this.canvas.getBoundingClientRect();
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          const d = e.shiftKey ? e.deltaY : e.deltaX;
          this.zoomColumns(Math.exp(-d * 0.002));
        } else this.zoomPrice(Math.exp(e.deltaY * 0.002), e.clientY - r.top);
        this.gesture();
      },
      false,
    );
    this.refreshTimer = setInterval(() => this.wants(), 15_000);
    this.resize();
  }

  destroy(): void {
    this.queue.cancelAll();
    this.vpQueue.cancelAll();
    for (const f of this.listeners) f();
    this.ro.disconnect();
    if (this.frameReq) cancelAnimationFrame(this.frameReq);
    if (this.hoverReq) cancelAnimationFrame(this.hoverReq);
    if (this.gestureTimer) clearTimeout(this.gestureTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.canvas.remove();
  }

  // ---------------------------------------------------------------- Einstellungen und Geometrie

  setOptions(o: TpoOptions): void {
    this.opts = { ...o };
    this.evaluate();
  }

  /** Tag mit dem Zeitpunkt tMs in die Mitte der Zeichenfläche (URL-Parameter at). */
  centerOn(tMs: number): void {
    const b = this.dayBounds();
    if (!b) return;
    const d = Math.min(b[1], Math.max(b[0], tpoDayOf(tMs, this.host.offsetH())));
    const max = Math.max(0, (b[1] - b[0]) * this.colW);
    this.scrollPx = Math.min(max, Math.max(0, (b[1] - d + 0.5) * this.colW - this.plotW() / 2));
    this.fitted = false;
    this.autoFit = true;
    this.evaluate();
  }

  /** Symbol gewechselt: Ansicht neu einpassen. */
  reset(): void {
    this.fitted = false;
    this.autoFit = true;
    this.autoR = null;
    this.scrollPx = 0;
    this.days.clear();
    this.daysKey = '';
    this.vp.clear();
    this.vpBatches.clear();
    this.evaluate();
  }

  get R(): number {
    return this.opts.R ?? this.autoR ?? 100;
  }

  ladder(): number[] {
    const s = this.host.sym();
    return s ? profileLadder(s.tickRefUnits, s.tickUnits) : [];
  }

  private plotH(): number {
    return Math.max(1, this.H - HEADER_H - FOOTER_H);
  }
  private plotW(): number {
    return Math.max(1, this.W - AXIS_W);
  }
  private yOf = (u: number): number =>
    HEADER_H + ((this.pTop - u) / (this.pTop - this.pBot)) * this.plotH();

  /** Quell-Zeitrahmen nach der Regel aus model.ts (unter den angebotenen). */
  sourceTf(): string {
    const s = this.host.sym();
    const offered = s
      ? Object.keys(s.tiles)
          .map((tf) => ({ tf, sec: safeTfSec(tf) }))
          .filter((x) => x.sec > 0)
      : [];
    if (s && !offered.some((x) => x.tf === '1m')) offered.push({ tf: '1m', sec: 60 });
    return chooseSourceTf(offered, this.opts.blockMin, this.opts.ibMin, this.host.offsetH());
  }

  /** Letzter und erster Profiltag mit Daten. */
  private dayBounds(): [number, number] | null {
    const s = this.host.sym();
    if (!s) return null;
    const off = this.host.offsetH();
    return [tpoDayOf(s.dataFrom, off), tpoDayOf(s.dataTo - 1, off)];
  }

  /** Sichtbare Tage [d0, d1] (Spalten, die die Zeichenfläche schneiden). */
  visibleDays(): [number, number] | null {
    const b = this.dayBounds();
    if (!b) return null;
    const pw = this.plotW();
    // Tag d: x0 = pw − (dLast − d + 1)·colW + scrollPx
    const d1 = Math.min(b[1], b[1] - Math.floor(this.scrollPx / this.colW));
    const d0 = Math.max(b[0], b[1] - Math.ceil((pw + this.scrollPx) / this.colW) + 1);
    return d0 <= d1 ? [d0, d1] : null;
  }

  private dayX(d: number): number {
    const b = this.dayBounds()!;
    return this.plotW() - (b[1] - d + 1) * this.colW + this.scrollPx;
  }

  private resize(): void {
    const r = this.canvas.parentElement?.getBoundingClientRect();
    if (!r) return;
    const dpr = window.devicePixelRatio || 1;
    this.W = r.width;
    this.H = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.evaluate();
  }

  private pan(dx: number, dy: number): void {
    if (dy !== 0) this.autoFit = false;
    const b = this.dayBounds();
    if (!b) return;
    const max = Math.max(0, (b[1] - b[0]) * this.colW);
    this.scrollPx = Math.min(max, Math.max(0, this.scrollPx + dx));
    const upp = (this.pTop - this.pBot) / this.plotH();
    this.pTop += dy * upp;
    this.pBot += dy * upp;
    this.schedule();
  }

  zoomPrice(f: number, yCss: number): void {
    this.autoFit = false;
    const u = this.pTop - ((yCss - HEADER_H) / this.plotH()) * (this.pTop - this.pBot);
    this.pTop = u + (this.pTop - u) * f;
    this.pBot = u + (this.pBot - u) * f;
    this.schedule();
  }

  zoomColumns(f: number): void {
    const old = this.colW;
    this.colW = Math.min(1600, Math.max(60, this.colW * f));
    this.scrollPx *= this.colW / old;
    this.schedule();
  }

  /** Laufende Geste: Bewertung erst GESTURE_END_MS nach der letzten Eingabe. */
  private gesture(): void {
    if (this.gestureTimer) clearTimeout(this.gestureTimer);
    this.gestureTimer = setTimeout(() => {
      this.gestureTimer = null;
      this.evaluate();
    }, GESTURE_END_MS);
  }

  /** Gestenende/Einstellungen: Zeilengröße (Hysterese), Neuberechnung, Bedarf, Zeichnen. */
  evaluate(): void {
    const s = this.host.sym();
    if (s && this.fitted && this.opts.R === null) {
      const pxPerUnit = this.plotH() / (this.pTop - this.pBot);
      this.autoR = tpoRowSize(this.autoR, this.ladder(), pxPerUnit, s.tickRefUnits);
    }
    this.recomputeDays();
    this.wants();
    this.schedule();
    this.onChange?.();
  }

  // ---------------------------------------------------------------- Daten

  private rawKey(sym: string, tf: string, d: number): string {
    return `${sym}|${tf}|${this.host.offsetH()}|${d}`;
  }

  /** Bedarf: sichtbare Tage ± 1 (Bars) und ihre Volumenprofil-Batches. */
  wants(): void {
    const s = this.host.sym();
    const vis = this.visibleDays();
    const bounds = this.dayBounds();
    if (!s || !vis || !bounds) {
      this.queue.setWanted([], new Set());
      return;
    }
    const tf = this.sourceTf();
    const off = this.host.offsetH();
    const now = performance.now();
    const wants: Want[] = [];
    const retain = new Set<string>();
    const mid = (vis[0] + vis[1]) / 2;
    for (let d = Math.max(bounds[0], vis[0] - 1); d <= Math.min(bounds[1], vis[1] + 1); d++) {
      const key = this.rawKey(s.name, tf, d);
      retain.add(key);
      const r = this.raw.get(key);
      if (r) {
        this.raw.delete(key); // LRU
        this.raw.set(key, r);
        if (r.final || now - r.loadedAt < TPO_NONFINAL_TTL_MS) continue;
      }
      const from = tpoDayStart(d, off);
      wants.push({
        key,
        url: this.host.api.barsUrl(s.name, tf, from, from + DAY_MS),
        priority: Math.abs(d - mid),
      });
    }
    this.queue.setWanted(wants, retain);
    // Volumenprofil (gleiche Zeilengröße wie die TPOs)
    if (!this.opts.volume || !this.fitted) {
      this.vpQueue.setWanted([], new Set());
      return;
    }
    const R = this.R;
    const vw: Want[] = [];
    const vr = new Set<string>();
    const batches = wantedDayBatches(
      tpoDayStart(vis[0], off) / 1000,
      tpoDayStart(vis[1] + 1, off) / 1000 - 1,
      off,
      s.dataFrom,
      s.dataTo,
    );
    batches.forEach((b, i) => {
      const key = dailyKey({ sym: s.name, R, va: this.opts.vaPct, offsetH: off, batch: b });
      vr.add(key);
      if (this.vpBatches.has(key)) return;
      const [from, to] = clampBatch(batchWindow(b, off), s, off);
      vw.push({
        key,
        url: `${this.host.api.base}/api/v1/profiles/daily?sym=${encodeURIComponent(s.name)}&from=${from}&to=${to}&R=${R}&offsetH=${off}&va=${this.opts.vaPct}`,
        priority: i,
      });
    });
    this.vpQueue.setWanted(vw, vr);
  }

  private onBars(key: string, buf: ArrayBuffer): void {
    const s = this.host.sym();
    if (!s || !key.startsWith(`${s.name}|`)) return;
    const dec = decodeTile(buf);
    const [, tf, , dStr] = key.split('|');
    if (dec.header.kind !== 'bars' || dec.header.sym !== s.name || dec.header.tf !== tf)
      throw new Error('Bars passen nicht zur Anfrage');
    this.raw.set(key, { bars: dec.bars, final: dec.header.final, loadedAt: performance.now() });
    while (this.raw.size > TPO_CACHE_DAYS) this.raw.delete(this.raw.keys().next().value as string);
    this.error = '';
    this.days.delete(Number(dStr));
    this.recomputeDays();
    if (!this.fitted || this.autoFit) this.fit();
    this.schedule();
    this.onChange?.();
  }

  private onProfiles(key: string, buf: ArrayBuffer): void {
    const s = this.host.sym();
    if (!s) return;
    const x = JSON.parse(new TextDecoder().decode(buf)) as DailyProfilesResponse;
    const problems = checkDailyProfiles(x);
    if (problems.length > 0) throw new Error(problems.slice(0, 2).join('; '));
    const R = Number(key.split('|')[2]);
    if (x.R !== R || x.sym !== s.name) throw new Error('Profil passt nicht zur Anfrage');
    for (const d of x.days) {
      const vw = vwapProblem(d);
      if (vw) throw new Error(vw);
      this.vp.set(
        d.from,
        prepareProfile(`${key}#${d.from}`, d, d.from, d.to, d.final, R, s.tickRefUnits),
      );
    }
    this.vpBatches.add(key);
    this.schedule();
  }

  /** TPO-Tage für die aktuellen Parameter (bei Änderung alle neu; sonst nur fehlende). */
  private recomputeDays(): void {
    const s = this.host.sym();
    if (!s) return;
    const tf = this.sourceTf();
    const off = this.host.offsetH();
    const w = this.R * s.tickRefUnits;
    const k = `${s.name}|${tf}|${off}|${w}|${this.opts.blockMin}|${this.opts.ibMin}|${this.opts.vaPct}`;
    if (k !== this.daysKey) {
      this.daysKey = k;
      this.days = new Map();
      // Volumenprofile hängen an R: bei neuer Zeilengröße neu
      this.vp.clear();
      this.vpBatches.clear();
    }
    const vis = this.visibleDays();
    if (!vis) return;
    for (let d = vis[0] - 1; d <= vis[1] + 1; d++) {
      if (this.days.has(d)) continue;
      const r = this.raw.get(this.rawKey(s.name, tf, d));
      if (!r) continue;
      this.days.set(d, computeTpo(r.bars, tpoDayStart(d, off), this.opts, w, s.dataTo));
    }
    // begrenzt halten (nur sichtbare Umgebung)
    if (this.days.size > 3 * TPO_CACHE_DAYS)
      for (const d of [...this.days.keys()])
        if (d < vis[0] - 60 || d > vis[1] + 60) this.days.delete(d);
  }

  /** Preisbereich auf die sichtbaren Tage einpassen (erste Daten, Symbolwechsel). */
  private fit(): void {
    const s = this.host.sym();
    const vis = this.visibleDays();
    if (!s || !vis) return;
    const tf = this.sourceTf();
    let lo = Infinity;
    let hi = -Infinity;
    for (let d = vis[0]; d <= vis[1]; d++) {
      const r = this.raw.get(this.rawKey(s.name, tf, d));
      if (!r) continue;
      for (let i = 0; i < r.bars.time.length; i++) {
        lo = Math.min(lo, r.bars.low[i]!);
        hi = Math.max(hi, r.bars.high[i]!);
      }
    }
    if (lo === Infinity) return;
    const m = (hi - lo) * 0.06 + s.tickRefUnits;
    this.pTop = hi + m;
    this.pBot = lo - m;
    this.fitted = true;
    this.autoR = null;
    this.evaluate();
  }

  // ---------------------------------------------------------------- Anzeige

  readout(): TpoReadout {
    const s = this.host.sym();
    const vis = this.visibleDays();
    let missing = 0;
    if (vis) for (let d = vis[0]; d <= vis[1]; d++) missing += this.days.get(d)?.missingBlocks ?? 0;
    return {
      R: this.R,
      rLabel: s ? `${exactDecimal(this.R * s.tickRefUnits, s.priceDecimals)} USDT` : '',
      rAuto: this.opts.R === null,
      tf: this.sourceTf(),
      daysVisible: this.visibleCount,
      daysLoaded: this.raw.size,
      lod: this.lod,
      requests: this.queue.stats.started + this.vpQueue.stats.started,
      inFlight: this.queue.stats.inFlight + this.vpQueue.stats.inFlight,
      error: this.error || this.queue.lastError,
      note: missing > 0 ? `${missing} Blöcke ohne Daten in den sichtbaren Tagen (Löcher)` : '',
      lastDrawMs: this.stats.lastMs,
    };
  }

  /** Hover: Tag, Preiszeile, Buchstaben in der Zeile, TPO-Anzahl (keine Neuzeichnung). */
  hoverText(): string {
    const s = this.host.sym();
    const p = this.hoverPos;
    const vis = this.visibleDays();
    if (!s || !p || !vis || p.x > this.plotW()) return '';
    const b = this.dayBounds()!;
    const d = b[1] - Math.floor((this.plotW() + this.scrollPx - p.x) / this.colW);
    const day = this.days.get(d);
    if (!day || day.counts.length === 0) return '';
    const u = this.pTop - ((p.y - HEADER_H) / this.plotH()) * (this.pTop - this.pBot);
    const row = Math.floor(u / day.width);
    const i = row - day.rowLo;
    if (i < 0 || i >= day.counts.length) return '';
    const px = (v: number) => exactDecimal(v, s.priceDecimals);
    const { letters } = rowLetters(day, row);
    const marks = [
      row === day.poc ? 'POC' : '',
      row === day.vah ? 'VAH' : '',
      row === day.val ? 'VAL' : '',
    ]
      .filter(Boolean)
      .join('/');
    return `TPO ${dayLabel(day.dayStart)} · Zeile [${px(row * day.width)}, ${px((row + 1) * day.width)})${marks ? ` ${marks}` : ''} · ${day.counts[i]} TPO · ${letters}`;
  }

  schedule(): void {
    if (this.frameReq) return;
    this.frameReq = requestAnimationFrame(() => {
      this.frameReq = 0;
      const t0 = performance.now();
      this.draw();
      const ms = performance.now() - t0;
      const st = this.stats;
      st.drawMs[st.frames % st.drawMs.length] = ms;
      st.frames++;
      st.lastMs = ms;
      st.maxMs = Math.max(st.maxMs, ms);
    });
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = this.canvas.width / Math.max(1, this.W);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f1217';
    ctx.fillRect(0, 0, this.W, this.H);
    const s = this.host.sym();
    const vis = this.visibleDays();
    this.stats.cells = 0;
    this.visibleCount = 0;
    if (!s || !vis || !this.fitted) {
      ctx.fillStyle = '#8b949e';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('TPO: Daten werden geladen …', 12, 30);
      return;
    }
    const pw = this.plotW();
    const ph = this.plotH();
    // Preisachse rechts, Gitter
    this.drawAxis(ctx, s, pw, ph);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, pw, this.H);
    ctx.clip();
    const rowH = (this.R * s.tickRefUnits * ph) / (this.pTop - this.pBot);
    this.lod = rowH >= TPO_ROW.letterMin ? 'letters' : 'blocks';
    for (let d = vis[0]; d <= vis[1]; d++) {
      const x0 = this.dayX(d);
      this.visibleCount++;
      // Tagestrenner und Kopf
      ctx.fillStyle = '#1f2630';
      ctx.fillRect(Math.round(x0), 0, 1, this.H);
      ctx.fillStyle = '#9aa4b2';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(dayLabel(tpoDayStart(d, this.host.offsetH())), x0 + PAD, HEADER_H / 2);
      const day = this.days.get(d);
      if (!day) continue;
      this.drawDay(ctx, s, day, x0, rowH);
    }
    ctx.restore();
  }

  private drawAxis(ctx: CanvasRenderingContext2D, s: SymbolInfo, pw: number, ph: number): void {
    const ps = 10 ** s.priceDecimals;
    const span = (this.pTop - this.pBot) / ps;
    const step = niceStep(span / Math.max(2, ph / 50));
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(this.pBot / ps / step) * step; v <= this.pTop / ps; v += step) {
      const y = Math.round(this.yOf(v * ps));
      ctx.fillStyle = '#1a1f27';
      ctx.fillRect(0, y, pw, 1);
      ctx.fillStyle = '#c9d1d9';
      ctx.fillText(v.toFixed(step < 1 ? 2 : 1), pw + 6, y);
    }
    ctx.fillStyle = '#2a313c';
    ctx.fillRect(pw, 0, 1, this.H);
  }

  private drawDay(
    ctx: CanvasRenderingContext2D,
    s: SymbolInfo,
    day: TpoDay,
    x0: number,
    rowH: number,
  ): void {
    const vpW = this.opts.volume ? Math.min(70, this.colW * 0.25) : 0;
    const left = x0 + PAD + 6; // Platz für den IB-Balken
    const area = this.colW - 2 * PAD - 6 - vpW - (vpW > 0 ? 4 : 0);
    const cols = Math.max(1, tpoColumns(day, this.opts.split));
    const cellW = Math.max(1, Math.min(LETTER_W, area / cols));
    const letters = this.lod === 'letters' && cellW >= 7;
    const w = day.width;
    const ph = this.plotH();
    const rowTop = Math.floor(this.pTop / w); // oberste sichtbare Zeile
    const rowBot = Math.floor(this.pBot / w);
    // Zellen und Marken nur im Preisbereich (Kopf und Zusammenfassung bleiben frei)
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, HEADER_H, this.colW, ph);
    ctx.clip();
    const inVa = (r: number) =>
      day.val !== null && day.vah !== null && r >= day.val && r <= day.vah;
    // Zellen je Farbe gebündelt (Blöcke) bzw. Buchstaben
    const buckets: number[][] = Array.from({ length: 2 * SHADES }, () => []);
    const n = day.cellBlock.length;
    const gap = rowH >= 5 ? 1 : 0;
    for (let k = 0; k < n; k++) {
      const r = day.cellRow[k]!;
      if (r > rowTop || r < rowBot) continue;
      const b = day.cellBlock[k]!;
      const c = this.opts.split ? b : day.cellCol[k]!;
      const x = left + c * cellW;
      const y = this.yOf((r + 1) * w);
      const sh = blockShade(b, day.nBlocks, SHADES) + (inVa(r) ? 0 : SHADES);
      const bk = buckets[sh]!;
      bk.push(x, y);
    }
    const h = Math.max(1, rowH - gap);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (letters)
      ctx.font = `${Math.min(12, Math.floor(rowH * 0.85))}px ui-monospace, Menlo, monospace`;
    for (let sh = 0; sh < buckets.length; sh++) {
      const xs = buckets[sh]!;
      if (xs.length === 0) continue;
      ctx.fillStyle = sh < SHADES ? IN_VA[sh]! : OUT_VA[sh - SHADES]!;
      if (!letters) {
        ctx.beginPath();
        for (let i = 0; i < xs.length; i += 2)
          ctx.rect(xs[i]!, xs[i + 1]!, Math.max(1, cellW - (cellW >= 3 ? 1 : 0)), h);
        ctx.fill();
      }
      this.stats.cells += xs.length / 2;
    }
    if (letters) {
      // Buchstaben: Block-Index aus der Zellreihenfolge (Farbe = Verlauf, VA kräftiger)
      for (let k = 0; k < n; k++) {
        const r = day.cellRow[k]!;
        if (r > rowTop || r < rowBot) continue;
        const b = day.cellBlock[k]!;
        const c = this.opts.split ? b : day.cellCol[k]!;
        const sh = blockShade(b, day.nBlocks, SHADES);
        ctx.fillStyle = inVa(r) ? IN_VA[sh]! : OUT_VA[sh]!;
        ctx.fillText(letterOf(b), left + c * cellW + cellW / 2, this.yOf((r + 0.5) * w));
      }
    }
    const usedW = cols * cellW;
    // POC (Rahmen), VAH/VAL (Linien), Single Prints (rechts), IB (links), Open/Close
    const rowY = (r: number) => this.yOf((r + 1) * w);
    if (day.poc !== null) {
      ctx.strokeStyle = POC_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(left - 1.5, Math.round(rowY(day.poc)) + 0.5, usedW + 2, Math.max(1, rowH - 1));
    }
    ctx.fillStyle = VA_LINE;
    if (day.vah !== null) ctx.fillRect(left, Math.round(rowY(day.vah)), usedW, 1);
    if (day.val !== null) ctx.fillRect(left, Math.round(rowY(day.val - 1)), usedW, 1);
    ctx.fillStyle = SINGLE_COLOR;
    for (const r of day.singles) ctx.fillRect(left + usedW + 2, rowY(r), 3, h);
    if (day.ibPrice) {
      ctx.fillStyle = IB_COLOR;
      const yt = this.yOf(day.ibPrice[1]);
      const yb = this.yOf(day.ibPrice[0]);
      ctx.fillRect(x0 + PAD, yt, 3, Math.max(1, yb - yt));
    }
    if (day.open !== null) {
      ctx.fillStyle = OPEN_COLOR;
      ctx.fillRect(x0 + PAD - 3, Math.round(this.yOf(day.open)) - 1, 8, 2);
    }
    if (day.close !== null) {
      ctx.fillStyle = CLOSE_COLOR;
      ctx.fillRect(left + usedW + 6, Math.round(this.yOf(day.close)) - 1, 8, 2);
    }
    // Volumenprofil rechts (gleiche Zeilen)
    const p = this.opts.volume ? this.vp.get(day.dayStart) : undefined;
    if (p && vpW > 0) {
      this.rects.length = 0;
      const vx = x0 + this.colW - PAD - vpW;
      profileRects(p, 'buysell', vx, vpW, this.yOf, HEADER_H, HEADER_H + ph, gap, this.rects);
      for (const paint of [Paint.Sell, Paint.Buy]) {
        ctx.fillStyle = PROFILE_COLORS[paint];
        ctx.beginPath();
        for (const r of this.rects) if (r.paint === paint) ctx.rect(r.x, r.y, r.w, r.h);
        ctx.fill();
      }
    }
    ctx.restore();
    this.drawSummary(ctx, s, day, x0);
  }

  private drawSummary(ctx: CanvasRenderingContext2D, s: SymbolInfo, day: TpoDay, x0: number): void {
    const px = (u: number) => exactDecimal(u, s.priceDecimals);
    const row = (r: number) => px(r * day.width);
    const y0 = this.H - FOOTER_H + 4;
    ctx.fillStyle = '#0f1217';
    ctx.fillRect(x0 + 1, this.H - FOOTER_H, this.colW - 2, FOOTER_H);
    ctx.fillStyle = '#9aa4b2';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const lines: string[] = [];
    if (day.counts.length > 0) {
      const hi = day.rowLo + day.counts.length;
      lines.push(`Range ${row(day.rowLo)}–${row(hi)}`);
      if (day.val !== null && day.vah !== null)
        lines.push(`VA ${row(day.val)}–${row(day.vah + 1)}`);
      if (day.poc !== null) lines.push(`POC ${row(day.poc)}`);
      lines.push(`TPO ${day.total} (↑${day.above} ↓${day.below})`);
      if (day.ibPrice) lines.push(`IB ${px(day.ibPrice[0])}–${px(day.ibPrice[1])}`);
    }
    if (day.missingBlocks > 0) lines.push(`${day.missingBlocks} Blöcke ohne Daten`);
    lines
      .slice(0, 6)
      .forEach((l, i) => ctx.fillText(l, x0 + PAD, y0 + i * 12, this.colW - 2 * PAD));
  }
}

function safeTfSec(tf: string): number {
  try {
    return tfSeconds(tf);
  } catch {
    return 0;
  }
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ab ${iso.slice(11, 16)}`;
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
