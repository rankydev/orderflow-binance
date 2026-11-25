// Volume-Profile-Schicht (KONZEPT §6.3, docs/PROFILE-API.md): Tagesprofile und ein Bereichsprofil als
// Pane-Primitive von lightweight-charts – gezeichnet im Zeichenzyklus der Bibliothek unter den Kerzen
// bzw. Footprint-Zellen, kein DOM-Overlay. Mausbewegungen zeichnen nur im Auswahlmodus neu (Vorschau).
// Daten wie bei den Kacheln: nur Sichtbares + 1 Tag Padding, Tagesprofile in Batches à 16 Tage über
// /profiles/daily, Abbruch bei Bedarfswechsel, LRU, Wiederholung/Backoff über die RequestQueue, Fehler
// sichtbar, 422 → einmal mit suggestR, finale Tage gegen die geladenen Bars geprüft.
import {
  checkDailyProfiles,
  checkRangeProfile,
  type DailyProfilesResponse,
  type RangeProfileResponse,
} from '@orderflow/core/browser';
import type {
  IChartApi,
  IPanePrimitive,
  IPanePrimitivePaneView,
  IPrimitivePaneRenderer,
  PaneAttachedParameter,
  Time,
} from 'lightweight-charts';
import { exactDecimal } from '../format.ts';
import { RequestQueue, type FetchFn, type Want } from '../request-queue.ts';
import type { BarItem, SymbolInfo } from '../types.ts';
import {
  batchOfDay,
  batchWindow,
  compareProfileWithBars,
  DAY_MS,
  DAY_PROFILE_SHARE,
  dailyKey,
  firstTouch,
  MIN_DAY_PX,
  Paint,
  PROFILE_DEFAULTS,
  prepareProfile,
  profileDayOf,
  profileDayWindow,
  profileLadder,
  profileRects,
  profileRowSize,
  rangeFromBars,
  RANGE_PROFILE_SHARE,
  rangeKey,
  rowMidY,
  wantedDayBatches,
  type PreparedProfile,
  type ProfileMode,
  type ProfileView,
  type Rect,
} from './model.ts';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
type Scope = Parameters<Parameters<Target['useBitmapCoordinateSpace']>[0]>[0];

/** Was die Schicht vom Chart-Controller braucht (bewusst schmal, in Tests ersetzbar). */
export interface ProfileHost {
  chart: IChartApi;
  apiBase: string;
  sym(): SymbolInfo | null;
  tfSec(): number;
  /** Items des aktuellen Datenfensters (Bars, aufsteigend). */
  items(): readonly BarItem[];
  /** Sichtbarer Zeitraum (s) oder null. */
  visibleTimeRange(): [number, number] | null;
  /** Preis → y (CSS-px) der gerade sichtbaren Serie. */
  priceToY(price: number): number | null;
  /** Liegen die Bars von [fromMs, toMs) vollständig, final und ohne Lücke im Fenster? */
  barsCoverFinal(fromMs: number, toMs: number): boolean;
}

/** Farben (Kerzenfarben, halbtransparent, damit Kerzen/Zellen davor lesbar bleiben). */
export const PROFILE_COLORS: Record<Paint, string> = {
  [Paint.Total]: 'rgba(120, 144, 180, 0.40)',
  [Paint.Buy]: 'rgba(38, 166, 154, 0.42)',
  [Paint.Sell]: 'rgba(239, 83, 80, 0.42)',
  [Paint.DeltaPos]: 'rgba(38, 166, 154, 0.55)',
  [Paint.DeltaNeg]: 'rgba(239, 83, 80, 0.55)',
};
const PAINT_ORDER = [Paint.Total, Paint.Sell, Paint.Buy, Paint.DeltaPos, Paint.DeltaNeg] as const;
const POC_COLOR = 'rgba(242, 201, 76, 0.95)';
const VA_LINE = 'rgba(190, 200, 220, 0.70)';
const VA_FILL = 'rgba(190, 200, 220, 0.06)';
const RANGE_FILL = 'rgba(100, 140, 220, 0.07)';
const RANGE_EDGE = 'rgba(100, 140, 220, 0.85)';

export const PROFILE_CACHE_ENTRIES = 96;
/** Nicht finale Antworten (laufender Tag) nach so vielen ms neu anfragen (Server: no-cache). */
export const PROFILE_NONFINAL_TTL_MS = 60_000;
/** Mindestbreite des Bereichsprofils (px), auch bei schmalem Bereich. */
const RANGE_MIN_W = 40;

interface Entry {
  final: boolean;
  loadedAt: number;
  /** Tagesprofile eines Batches nach Tagesbeginn (ms); Bereichsprofil unter 0. */
  profiles: Map<number, PreparedProfile>;
}

export interface ProfileReadout {
  mode: ProfileMode;
  view: ProfileView;
  R: number;
  rAuto: boolean;
  rLabel: string;
  daysDrawn: number;
  daysSkipped: number;
  /** Hinweise (ausgelassene Tage, Server-R-Vorschlag), sonst ''. */
  note: string;
  error: string;
  selecting: boolean;
  requests: number;
  inFlight: number;
  aborted: number;
}

export interface RangeSummary {
  range: string;
  loading: boolean;
  total: string;
  buy: string;
  sell: string;
  delta: string;
  poc: string;
  va: string;
}

/** Gezeichnete Fläche eines Profils (CSS-px) für den Hover. */
interface Hit {
  x0: number;
  x1: number;
  p: PreparedProfile;
  range: boolean;
}

export class ProfileLayer implements IPanePrimitive<Time> {
  mode: ProfileMode = PROFILE_DEFAULTS.mode;
  view: ProfileView = PROFILE_DEFAULTS.view;
  va = PROFILE_DEFAULTS.va;
  offsetH = PROFILE_DEFAULTS.offsetH;
  /** VA-Fläche + VAH/VAL-Linien zeigen */
  showVa = true;
  /** POC/VAH/VAL nach rechts verlängern, bis der Preis sie berührt (Naked Levels) */
  extend = false;
  /** manuelles Profil-R (Ticks) oder null = automatisch nach Pixelhöhe */
  manualR: number | null = null;
  /** Bereich [from, to) in ms (Minuten), höchstens einer */
  range: [number, number] | null = null;
  selecting = false;
  /** Nach Datenankunft/Zustandsänderung (UI aktualisiert Anzeige/Zusammenfassung). */
  onChange: (() => void) | null = null;

  private autoR: number | null = null;
  private readonly host: ProfileHost;
  private readonly queue: RequestQueue;
  private readonly cache = new Map<string, Entry>();
  private requestUpdate: (() => void) | null = null;
  private readonly views: IPanePrimitivePaneView[];
  private error = '';
  private daysDrawn = 0;
  private daysSkipped = 0;
  /** 422: R-Untergrenze je Anfrage-Bereich (Schlüssel ohne R), höchstens ein Versuch je Bereich. */
  private readonly rFloor = new Map<string, number>();
  private readonly crossFails = new Map<string, number>();
  private selectAnchor: number | null = null;
  private selectHover: number | null = null;
  private readonly rects: Rect[] = [];
  private hits: Hit[] = [];
  /** Zähler für Tests/Messung */
  readonly counters = { draws: 0, rectsDrawn: 0, crossChecks: 0, crossMismatches: 0 };
  /** Zeichenzeiten (ms) der letzten 512 Frames als Ring, Index = counters.draws mod 512 (Messung). */
  readonly drawMs = new Float64Array(512);

  constructor(host: ProfileHost, fetchFn?: FetchFn) {
    this.host = host;
    this.queue = new RequestQueue(
      (key, buf) => this.onLoaded(key, buf),
      (key, status, _err, body) => this.onRejected(key, status, body),
      fetchFn,
    );
    this.queue.label = (k) => (k.startsWith('pd|') ? 'Tagesprofile' : 'Bereichsprofil');
    const renderer: IPrimitivePaneRenderer = {
      draw: (target: Target) => target.useBitmapCoordinateSpace((s) => this.draw(s)),
    };
    this.views = [{ zOrder: () => 'bottom', renderer: () => renderer }];
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

  redraw(): void {
    this.requestUpdate?.();
  }

  destroy(): void {
    this.queue.cancelAll();
  }

  // ---------------------------------------------------------------- Einstellungen

  /** Profil-R, das angefragt wird (manuell, sonst automatisch); null = noch nicht vermessen. */
  get R(): number | null {
    return this.manualR ?? this.autoR;
  }

  ladder(): number[] {
    const s = this.host.sym();
    return s ? profileLadder(s.tickRefUnits, s.tickUnits) : [];
  }

  /** Symbolwechsel: R neu bestimmen, Bereich verwerfen (gehört zum alten Symbol). */
  resetForSymbol(): void {
    this.autoR = null;
    this.rFloor.clear();
    this.range = null;
    if (this.mode === 'range') this.mode = 'off';
    else if (this.mode === 'both') this.mode = 'daily';
    this.cancelSelect();
  }

  /** Gestenende: automatische Zeilengröße nach Pixelhöhe (px je price_unit der sichtbaren Skala). */
  evaluate(pxPerUnit: number): void {
    const s = this.host.sym();
    if (!s || !(pxPerUnit > 0)) return;
    this.autoR = profileRowSize(this.autoR, this.ladder(), pxPerUnit, s.tickRefUnits);
    this.frame();
    this.redraw();
  }

  /** Einstellungen geändert (UI): Bedarf neu, neu zeichnen. */
  changed(): void {
    this.frame();
    this.redraw();
    this.onChange?.();
  }

  private dailyScope(sym: string, batch: number): string {
    return `pd|${sym}|${this.va}|${this.offsetH}|${batch}`;
  }
  private rangeScope(sym: string, from: number, to: number): string {
    return `pr|${sym}|${this.va}|${from}|${to}`;
  }
  /** R eines Anfrage-Bereichs: gewähltes R, bei 422 mindestens der Server-Vorschlag. */
  private rFor(scope: string): number {
    return Math.max(this.R ?? 1, this.rFloor.get(scope) ?? 0);
  }
  private dailyKeyFor(sym: string, batch: number): string {
    const r = this.rFor(this.dailyScope(sym, batch));
    return dailyKey({ sym, R: r, va: this.va, offsetH: this.offsetH, batch });
  }
  private rangeKeyFor(sym: string, from: number, to: number): string {
    const r = this.rFor(this.rangeScope(sym, from, to));
    return rangeKey({ sym, R: r, va: this.va, from, to });
  }

  /** Bedarf bestimmen (billig: wenige Schlüssel; einmal je Frame vom Controller). */
  frame(): void {
    const s = this.host.sym();
    const vis = this.host.visibleTimeRange();
    if (!s || !vis || this.mode === 'off' || this.R === null) {
      this.queue.setWanted([], new Set());
      return;
    }
    const wants: Want[] = [];
    const retain = new Set<string>();
    const now = performance.now();
    const add = (key: string, url: string, priority: number) => {
      retain.add(key);
      const e = this.cache.get(key);
      if (e && (e.final || now - e.loadedAt < PROFILE_NONFINAL_TTL_MS)) {
        // LRU: Benutzung frischt auf
        this.cache.delete(key);
        this.cache.set(key, e);
        return;
      }
      if (e && this.queue.isFinal(key)) this.queue.forgetFailure(key);
      wants.push({ key, url, priority });
    };
    const base = `${this.host.apiBase}/api/v1`;
    const sym = encodeURIComponent(s.name);
    if (this.mode === 'daily' || this.mode === 'both') {
      // LOD: sind die Tage so schmal, dass kein Profil gezeichnet würde, gar nicht erst laden
      if (this.dayWidthPx() >= MIN_DAY_PX) {
        const batches = wantedDayBatches(vis[0], vis[1], this.offsetH, s.dataFrom, s.dataTo);
        batches.forEach((b, i) => {
          const key = this.dailyKeyFor(s.name, b);
          const r = Number(key.split('|')[2]);
          const [from, to] = clampBatch(batchWindow(b, this.offsetH), s, this.offsetH);
          add(
            key,
            `${base}/profiles/daily?sym=${sym}&from=${from}&to=${to}&R=${r}&offsetH=${this.offsetH}&va=${this.va}`,
            i + 1,
          );
        });
      }
    }
    if ((this.mode === 'range' || this.mode === 'both') && this.range) {
      const [from, to] = this.range;
      const key = this.rangeKeyFor(s.name, from, to);
      const r = Number(key.split('|')[2]);
      add(key, `${base}/profile?sym=${sym}&from=${from}&to=${to}&R=${r}&va=${this.va}`, 0);
    }
    this.queue.setWanted(wants, retain);
  }

  private dayWidthPx(): number {
    return (DAY_MS / 1000 / this.host.tfSec()) * this.host.chart.timeScale().options().barSpacing;
  }

  // ---------------------------------------------------------------- Antworten

  private onLoaded(key: string, buf: ArrayBuffer): void {
    const s = this.host.sym();
    if (!s) return;
    const json: unknown = JSON.parse(new TextDecoder().decode(buf));
    const R = Number(key.split('|')[2]);
    if (key.startsWith('pd|')) {
      const x = json as DailyProfilesResponse;
      const problems = checkDailyProfiles(x);
      if (problems.length > 0) throw new Error(problems.slice(0, 3).join('; '));
      if (x.R !== R || x.sym !== s.name || x.tickRefUnits !== s.tickRefUnits)
        throw new Error('Antwort passt nicht zur Anfrage');
      const profiles = new Map<number, PreparedProfile>();
      for (const d of x.days) {
        const k = `${key}#${d.from}`;
        profiles.set(d.from, prepareProfile(k, d, d.from, d.to, d.final, R, s.tickRefUnits));
      }
      this.put(key, { final: x.final, loadedAt: performance.now(), profiles });
    } else {
      const x = json as RangeProfileResponse;
      const problems = checkRangeProfile(x);
      if (problems.length > 0) throw new Error(problems.slice(0, 3).join('; '));
      if (x.R !== R || x.sym !== s.name || x.tickRefUnits !== s.tickRefUnits)
        throw new Error('Antwort passt nicht zur Anfrage');
      const p = prepareProfile(key, x.profile, x.from, x.to, x.final, R, s.tickRefUnits);
      this.put(key, { final: x.final, loadedAt: performance.now(), profiles: new Map([[0, p]]) });
    }
    this.error = '';
    this.crossCheck(key);
    this.onChange?.();
    this.redraw();
  }

  private onRejected(key: string, status: number, body?: string): void {
    const parts = key.split('|');
    const usedR = Number(parts[2]);
    const scope = [parts[0], parts[1], ...parts.slice(3)].join('|');
    if (status === 422) {
      let suggest: number | null = null;
      try {
        const j = JSON.parse(body ?? '') as { suggestR?: unknown };
        if (typeof j.suggestR === 'number' && Number.isSafeInteger(j.suggestR))
          suggest = j.suggestR;
      } catch {
        /* kein JSON */
      }
      // einmal mit dem Vorschlag wiederholen (gilt nur für den aktuellen Datenstand, daher kein Cache)
      if (suggest !== null && suggest > usedR && !this.rFloor.has(scope)) {
        this.rFloor.set(scope, suggest);
        this.frame();
        this.onChange?.();
        return;
      }
      this.error = `${this.queue.label(key)}: Zeitraum zu groß für R ${usedR}`;
    } else {
      this.error =
        status === 0
          ? `${this.queue.label(key)}: Antwort unbrauchbar`
          : `${this.queue.label(key)}: HTTP ${status}`;
    }
    this.onChange?.();
  }

  private put(key: string, e: Entry): void {
    this.cache.delete(key);
    this.cache.set(key, e);
    while (this.cache.size > PROFILE_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
  }

  /**
   * Auftrag 6: finale Tagesprofile (und ein finales Bereichsprofil) gegen die Summe der geladenen Bars
   * desselben Zeitraums – nur, wenn die Bars den Zeitraum vollständig und final abdecken. Erste
   * Abweichung → einmal neu laden; wiederholt → sichtbarer Fehler.
   */
  crossCheck(key: string): void {
    const e = this.cache.get(key);
    if (!e) return;
    const items = this.host.items();
    for (const p of e.profiles.values()) {
      if (!p.final || !this.host.barsCoverFinal(p.from, p.to)) continue;
      this.counters.crossChecks++;
      const ck = `${key}#${p.from}`;
      const diff = compareProfileWithBars(p, timesOf(items), volsOf(items));
      if (!diff) {
        this.crossFails.delete(ck);
        continue;
      }
      this.counters.crossMismatches++;
      const n = (this.crossFails.get(ck) ?? 0) + 1;
      this.crossFails.set(ck, n);
      const day = new Date(p.from).toISOString().slice(0, 16).replace('T', ' ');
      console.warn(`Profil ${day} UTC passt nicht zu den Bars: ${diff}`);
      if (n === 1) {
        this.cache.delete(key); // einmal neu laden
        this.frame();
      } else {
        this.error = `Profil ab ${day} UTC passt nicht zu den Bars (${diff})`;
      }
      return;
    }
  }

  /** Nach neuen Bars (Fensterwechsel) die geladenen Profile im Fenster prüfen. */
  crossCheckAll(): void {
    for (const k of [...this.cache.keys()]) this.crossCheck(k);
  }

  // ---------------------------------------------------------------- Bereichsauswahl (zwei Klicks)

  startSelect(): void {
    this.selecting = true;
    this.selectAnchor = null;
    this.selectHover = null;
    this.redraw();
    this.onChange?.();
  }

  cancelSelect(): void {
    if (!this.selecting) return;
    this.selecting = false;
    this.selectAnchor = null;
    this.selectHover = null;
    this.redraw();
    this.onChange?.();
  }

  /** Klick (Bar-Beginn in s) im Auswahlmodus; true = Klick verbraucht. */
  click(tSec: number): boolean {
    if (!this.selecting) return false;
    if (this.selectAnchor === null) {
      this.selectAnchor = tSec;
      this.selectHover = tSec;
      this.redraw();
      this.onChange?.();
      return true;
    }
    this.setRange(rangeFromBars(this.selectAnchor, tSec, this.host.tfSec()));
    return true;
  }

  /** Bereich setzen (Auswahl oder URL), Modus so erweitern, dass er sichtbar ist. */
  setRange(r: [number, number]): void {
    this.range = r;
    this.selecting = false;
    this.selectAnchor = null;
    this.selectHover = null;
    if (this.mode === 'off') this.mode = 'range';
    else if (this.mode === 'daily') this.mode = 'both';
    this.changed();
  }

  /** Zeigerzeit während der Auswahl (nur dann wird neu gezeichnet). */
  pointer(tSec: number | null): void {
    if (!this.selecting || this.selectAnchor === null || tSec === null) return;
    if (tSec !== this.selectHover) {
      this.selectHover = tSec;
      this.redraw();
    }
  }

  clearRange(): void {
    this.range = null;
    if (this.mode === 'range') this.mode = 'off';
    else if (this.mode === 'both') this.mode = 'daily';
    this.changed();
  }

  // ---------------------------------------------------------------- Anzeige

  readout(): ProfileReadout {
    const s = this.host.sym();
    const R = this.R ?? 0;
    const floors = [...new Set(this.rFloor.values())];
    const notes: string[] = [];
    if (floors.length > 0 && floors.some((f) => f > R))
      notes.push(
        `Server: Profil-R ${R} zu fein → ${floors.filter((f) => f > R).join('/')} (suggestR)`,
      );
    if (this.daysSkipped > 0)
      notes.push(`${this.daysSkipped} Tagesprofile ausgelassen (Tag < ${MIN_DAY_PX} px breit)`);
    if (this.selecting)
      notes.push(
        this.selectAnchor === null
          ? 'Bereich: Anfang anklicken'
          : 'Bereich: Ende anklicken (Esc bricht ab)',
      );
    return {
      mode: this.mode,
      view: this.view,
      R,
      rAuto: this.manualR === null,
      rLabel: s && R ? `${exactDecimal(R * s.tickRefUnits, s.priceDecimals)} USDT` : '',
      daysDrawn: this.daysDrawn,
      daysSkipped: this.daysSkipped,
      note: notes.join('; '),
      error: this.error || this.queue.lastError,
      selecting: this.selecting,
      requests: this.queue.stats.started,
      inFlight: this.queue.stats.inFlight,
      aborted: this.queue.stats.aborted,
    };
  }

  private rangeProfile(): PreparedProfile | null {
    const s = this.host.sym();
    if (!s || !this.range) return null;
    return (
      this.cache.get(this.rangeKeyFor(s.name, this.range[0], this.range[1]))?.profiles.get(0) ??
      null
    );
  }

  private dayProfileAt(dayFromMs: number): PreparedProfile | null {
    const s = this.host.sym();
    if (!s) return null;
    const d = profileDayOf(dayFromMs, this.offsetH);
    const key = this.dailyKeyFor(s.name, batchOfDay(d));
    return this.cache.get(key)?.profiles.get(profileDayWindow(d, this.offsetH)[0]) ?? null;
  }

  /** Zusammenfassung des Bereichsprofils (für die Leiste unter dem Chart), null ohne Bereich. */
  summary(): RangeSummary | null {
    const s = this.host.sym();
    if (!s || !this.range) return null;
    const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    const range = `${fmt(this.range[0])} – ${fmt(this.range[1])} UTC`;
    const p = this.rangeProfile();
    if (!p)
      return { range, loading: true, total: '', buy: '', sell: '', delta: '', poc: '', va: '' };
    const q = qtyFormatter(s);
    const px = (u: number) => exactDecimal(u, s.priceDecimals);
    const row = (r: number) => `${px(r * p.width)}–${px((r + 1) * p.width)}`;
    return {
      range,
      loading: false,
      total: q(p.buyQ + p.sellQ),
      buy: q(p.buyQ),
      sell: q(p.sellQ),
      delta: q(p.buyQ - p.sellQ),
      poc: p.poc === null ? '–' : row(p.poc),
      va:
        p.val === null || p.vah === null
          ? '–'
          : `${px(p.val * p.width)}–${px((p.vah + 1) * p.width)} (${this.va} %)`,
    };
  }

  /**
   * Hover über einem gezeichneten Profil (x in CSS-px, unit = Preis in price_unit): exakte Werte der
   * Zeile, sonst ''. Nur gezeichnete Flächen zählen (letzter Frame), Bereichsprofil vor Tagesprofil.
   */
  hoverText(x: number, unit: number): string {
    const s = this.host.sym();
    if (!s) return '';
    for (const h of this.hits) {
      if (x < h.x0 || x > h.x1) continue;
      const p = h.p;
      const r = Math.floor(unit / p.width);
      const i = r - p.rowLo;
      if (i < 0 || i >= p.buy.length) continue;
      const b = p.buy[i]!;
      const sl = p.sell[i]!;
      const q = qtyFormatter(s);
      const px = (u: number) => exactDecimal(u, s.priceDecimals);
      const which = h.range
        ? 'Bereichsprofil'
        : `Tagesprofil ${new Date(p.from).toISOString().slice(0, 10)}`;
      const marks = [r === p.poc ? 'POC' : '', r === p.vah ? 'VAH' : '', r === p.val ? 'VAL' : '']
        .filter(Boolean)
        .join('/');
      return (
        `${which} · Zeile [${px(r * p.width)}, ${px((r + 1) * p.width)})${marks ? ` ${marks}` : ''}` +
        ` · Bid (Verkäufer) ${q(sl)} · Ask (Käufer) ${q(b)} · gesamt ${q(b + sl)} · Delta ${q(b - sl)}`
      );
    }
    return '';
  }

  // ---------------------------------------------------------------- Zeichnen

  /**
   * x (CSS-px) des Beginns der Zeit t (ms) auf der indexbasierten Zeitachse: linke Kante des ersten
   * Bars ≥ t; außerhalb des Fensters linear mit tf fortgesetzt.
   */
  private xOfTime(
    tMs: number,
    items: readonly BarItem[],
    tfSec: number,
    bs: number,
  ): number | null {
    const n = items.length;
    const t = tMs / 1000;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (items[m]!.time < t) lo = m + 1;
      else hi = m;
    }
    let logical: number;
    if (lo >= n) logical = n - 1 + (t - items[n - 1]!.time) / tfSec;
    else if (lo === 0) logical = (t - items[0]!.time) / tfSec;
    else logical = lo;
    const x = this.host.chart.timeScale().logicalToCoordinate(logical as never);
    return x === null ? null : x - bs / 2;
  }

  private draw(scope: Scope): void {
    const t0 = performance.now();
    const n0 = this.counters.draws;
    this.drawInner(scope);
    if (this.counters.draws !== n0) this.drawMs[n0 % this.drawMs.length] = performance.now() - t0;
  }

  private drawInner(scope: Scope): void {
    this.daysDrawn = 0;
    this.daysSkipped = 0;
    this.hits = [];
    const s = this.host.sym();
    const items = this.host.items();
    const vis = this.host.visibleTimeRange();
    if (!s || !vis || items.length === 0) return;
    if (this.mode === 'off' && !this.selecting) return;
    const ctx = scope.context;
    const hpr = scope.horizontalPixelRatio;
    const vpr = scope.verticalPixelRatio;
    const tf = this.host.tfSec();
    const bs = this.host.chart.timeScale().options().barSpacing;
    // lineare Preisabbildung aus zwei Stützstellen (die Profile brauchen sonst je Zeile einen Aufruf)
    const ps = 10 ** s.priceDecimals;
    const ref = items[items.length >> 1]!.c;
    const yA = this.host.priceToY(ref / ps);
    const yB = this.host.priceToY((ref + 1000 * s.tickRefUnits) / ps);
    if (yA === null || yB === null || yA === yB) return;
    const A = (yB - yA) / (1000 * s.tickRefUnits);
    const yU = (u: number) => (yA + A * (u - ref)) * vpr;
    const H = scope.bitmapSize.height;
    const W = scope.bitmapSize.width / hpr;
    this.counters.draws++;

    // Auswahlvorschau
    if (this.selecting && this.selectAnchor !== null && this.selectHover !== null) {
      const a = Math.min(this.selectAnchor, this.selectHover);
      const b = Math.max(this.selectAnchor, this.selectHover) + tf;
      const xa = this.xOfTime(a * 1000, items, tf, bs);
      const xb = this.xOfTime(b * 1000, items, tf, bs);
      if (xa !== null && xb !== null) this.drawRangeBox(ctx, xa, xb, hpr, H);
    }
    if (this.mode === 'off') return;

    // Tagesprofile
    if (this.mode === 'daily' || this.mode === 'both') {
      const d0 = profileDayOf(vis[0] * 1000, this.offsetH) - 1;
      const d1 = profileDayOf(vis[1] * 1000, this.offsetH) + 1;
      const dMin = profileDayOf(s.dataFrom, this.offsetH);
      const dMax = profileDayOf(s.dataTo - 1, this.offsetH);
      for (let d = Math.max(d0, dMin); d <= Math.min(d1, dMax); d++) {
        const [from, to] = profileDayWindow(d, this.offsetH);
        const xa = this.xOfTime(from, items, tf, bs);
        const xb = this.xOfTime(to, items, tf, bs);
        if (xa === null || xb === null || xb < 0 || xa > W) continue;
        if (xb - xa < MIN_DAY_PX) {
          this.daysSkipped++;
          continue;
        }
        const p = this.dayProfileAt(from);
        if (!p) continue;
        this.drawProfile(
          ctx,
          p,
          xa,
          (xb - xa) * DAY_PROFILE_SHARE,
          hpr,
          vpr,
          A,
          yU,
          H,
          W,
          items,
          false,
        );
        this.daysDrawn++;
      }
    }
    // Bereichsprofil (über den Tagesprofilen)
    if ((this.mode === 'range' || this.mode === 'both') && this.range) {
      const xa = this.xOfTime(this.range[0], items, tf, bs);
      const xb = this.xOfTime(this.range[1], items, tf, bs);
      if (xa !== null && xb !== null && xb >= 0 && xa <= W) {
        this.drawRangeBox(ctx, xa, xb, hpr, H);
        const p = this.rangeProfile();
        const w = Math.max(RANGE_MIN_W, (xb - xa) * RANGE_PROFILE_SHARE);
        if (p) this.drawProfile(ctx, p, xa, w, hpr, vpr, A, yU, H, W, items, true);
      }
    }
  }

  private drawRangeBox(
    ctx: CanvasRenderingContext2D,
    xa: number,
    xb: number,
    hpr: number,
    H: number,
  ): void {
    ctx.fillStyle = RANGE_FILL;
    ctx.fillRect(Math.round(xa * hpr), 0, Math.round((xb - xa) * hpr), H);
    ctx.fillStyle = RANGE_EDGE;
    const lw = Math.max(1, Math.floor(hpr));
    ctx.fillRect(Math.round(xa * hpr), 0, lw, H);
    ctx.fillRect(Math.round(xb * hpr) - lw, 0, lw, H);
  }

  private drawProfile(
    ctx: CanvasRenderingContext2D,
    p: PreparedProfile,
    x0: number,
    maxW: number,
    hpr: number,
    vpr: number,
    A: number,
    yU: (u: number) => number,
    H: number,
    W: number,
    items: readonly BarItem[],
    isRange: boolean,
  ): void {
    if (p.buy.length === 0) return;
    // Hover nur über den Balken (Bereichsprofil zuerst geprüft)
    const hit = { x0, x1: x0 + maxW, p, range: isRange };
    if (isRange) this.hits.unshift(hit);
    else this.hits.push(hit);
    const rowPx = -A * p.width * vpr;
    const gap = rowPx >= 4 * vpr ? Math.max(1, Math.floor(vpr)) : 0;
    const bx = Math.round(x0 * hpr);
    const bw = maxW * hpr;
    if (this.showVa && p.val !== null && p.vah !== null) {
      const yt = Math.round(yU((p.vah + 1) * p.width));
      const yb = Math.round(yU(p.val * p.width));
      ctx.fillStyle = VA_FILL;
      ctx.fillRect(bx, yt, Math.round(bw), yb - yt);
    }
    this.rects.length = 0;
    profileRects(p, this.view, bx, bw, yU, 0, H, gap, this.rects);
    this.counters.rectsDrawn += this.rects.length;
    for (const paint of PAINT_ORDER) {
      let any = false;
      for (const r of this.rects) {
        if (r.paint !== paint) continue;
        if (!any) ctx.beginPath();
        ctx.rect(r.x, r.y, r.w, r.h);
        any = true;
      }
      if (any) {
        ctx.fillStyle = PROFILE_COLORS[paint];
        ctx.fill();
      }
    }
    const lw = Math.max(1, Math.floor(vpr));
    const line = (row: number | null, color: string) => {
      if (row === null) return;
      const y = Math.round(rowMidY(row, p.width, yU));
      if (y < 0 || y > H) return;
      const xEnd = this.extend ? this.nakedEnd(row, p, items, x0 + maxW, W) : x0 + maxW;
      ctx.fillStyle = color;
      ctx.fillRect(bx, y - (lw >> 1), Math.round(xEnd * hpr) - bx, lw);
    };
    if (this.showVa) {
      line(p.vah, VA_LINE);
      line(p.val, VA_LINE);
    }
    line(p.poc, POC_COLOR);
  }

  /** Naked Level: x des ersten Bars nach dem Profil, dessen Spanne die Zeilenmitte berührt. */
  private nakedEnd(
    row: number,
    p: PreparedProfile,
    items: readonly BarItem[],
    min: number,
    W: number,
  ): number {
    const price = (row + 0.5) * p.width;
    let lo = 0;
    let hi = items.length;
    const toSec = p.to / 1000;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (items[m]!.time < toSec) lo = m + 1;
      else hi = m;
    }
    const idx = firstTouch(items, lo, price);
    if (idx < 0) return Math.max(min, W); // bis zum Rand (im Fenster nicht berührt)
    const x = this.host.chart.timeScale().logicalToCoordinate(idx as never);
    return x === null ? min : Math.max(min, x);
  }
}

/** Batch auf den Datenbereich kürzen (ganze Profiltage; die API verlangt Tagesgrenzen mit Offset). */
export function clampBatch(
  [from, to]: [number, number],
  s: SymbolInfo,
  offsetH: number,
): [number, number] {
  const lo = Math.max(from, profileDayWindow(profileDayOf(s.dataFrom, offsetH), offsetH)[0]);
  const hi = Math.min(to, profileDayWindow(profileDayOf(s.dataTo - 1, offsetH), offsetH)[1]);
  return [lo, Math.max(lo + DAY_MS, hi)];
}

function qtyFormatter(s: SymbolInfo): (lots: number) => string {
  const base = s.name.replace(/USDT$/, '');
  return (l) => `${l} Lots = ${exactDecimal(l, s.qtyDecimals)} ${base}`;
}

function timesOf(items: readonly BarItem[]): Float64Array {
  return mapView(items, (it) => it.time);
}
function volsOf(items: readonly BarItem[]): Float64Array {
  return mapView(items, (it) => it.v);
}
function mapView(items: readonly BarItem[], f: (it: BarItem) => number): Float64Array {
  const out = new Float64Array(items.length);
  for (let i = 0; i < items.length; i++) out[i] = f(items[i]!);
  return out;
}
