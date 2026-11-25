// Volume-Profile-Schicht (KONZEPT §6.3, docs/PROFILE-API.md): Tagesprofile und ein Bereichsprofil als
// Pane-Primitive von lightweight-charts – gezeichnet im Zeichenzyklus der Bibliothek unter den Kerzen
// bzw. Footprint-Zellen, kein DOM-Overlay. Mausbewegungen zeichnen nur im Auswahlmodus neu (Vorschau).
// Daten wie bei den Kacheln: nur Sichtbares + 1 Tag Padding, Tagesprofile in Batches à 16 Tage über
// /profiles/daily (nicht finaler Rest eines Batches getrennt nachgeladen), Abbruch bei Bedarfswechsel,
// LRU, Wiederholung/Backoff über eine eigene RequestQueue mit 2 parallelen Anfragen, die zurücksteht,
// solange Kacheln/Bars laden (W-4), Fehler sichtbar, 422 → einmal mit suggestR, finale Tage gegen die
// geladenen Bars geprüft.
import { displayZone, fmtShown, sessionLabel, zoneLabel } from '../time-format.ts';
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
  commonScale,
  MIN_BAR_PX,
  compareProfileWithBars,
  DAY_MS,
  dailyKey,
  dayDetail,
  firstTouch,
  MIN_DAY_PX,
  MINUTE_MS,
  Paint,
  PROFILE_DEFAULTS,
  prepareProfile,
  profileDayOf,
  profileDayWindow,
  profileLadder,
  profilePlacement,
  profileRects,
  profileRowSize,
  profileScale,
  rangeFromBars,
  RANGE_PROFILE_SHARE,
  rangeKey,
  rowBarLength,
  rowMidY,
  wantedDayBatches,
  type DayDetail,
  type PreparedProfile,
  type ProfileMode,
  type ProfileScaleMode,
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
  /** Liegen die Bars von [fromMs, toMs) vollständig, unveränderlich und ohne Lücke im Fenster? */
  barsCoverFinal(fromMs: number, toMs: number): boolean;
  /** Zeichnet der Footprint gerade Zellen (Detailstufe ≥ 2)? Dann schmalere Profile (W-2c). */
  footprintActive(): boolean;
  /** Laden gerade Kacheln oder Bars (laufend oder wartend)? Dann stehen Profile zurück (W-4). */
  busy(): boolean;
  /** Läuft gerade eine Geste? Dann keine neuen Profilanfragen (Bedarf erst am Gestenende). */
  gestureActive(): boolean;
  /** Grenzen aus `/symbols` (falls die API sie liefert) */
  limits?(): ProfileLimits | null;
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
export const POC_COLOR = 'rgba(242, 201, 76, 0.95)';
const VA_LINE = 'rgba(190, 200, 220, 0.70)';
const VA_FILL = 'rgba(190, 200, 220, 0.06)';
const RANGE_FILL = 'rgba(100, 140, 220, 0.07)';
const RANGE_EDGE = 'rgba(100, 140, 220, 0.85)';

export const PROFILE_CACHE_ENTRIES = 96;
/** Nicht finale Antworten (laufender Tag) nach so vielen ms neu anfragen (Server: no-cache). */
export const PROFILE_NONFINAL_TTL_MS = 60_000;
/** Parallele Profilanfragen (die API hat 4 Datenbank-Slots; Kacheln und Bars haben Vorrang, W-4). */
export const PROFILE_MAX_PARALLEL = 2;
/** Wartezeit, bis zurückgestellter Profilbedarf erneut geprüft wird (ms). */
export const PROFILE_HOLD_MS = 150;
/** Längstes Zurückstehen hinter Kacheln/Bars (W-A); danach höchstens eine Profilanfrage gleichzeitig. */
export const PROFILE_MAX_HOLD_MS = 2_000;
/** Mindestbreite des Bereichsprofils (px), auch bei schmalem Bereich. */
const RANGE_MIN_W = 40;
/** Längster Bereich wie die API (3 660 Tage). */
const MAX_RANGE_MS = 3_660 * DAY_MS;

/** Grenzen der Profil-Endpunkte aus `/symbols` (`limits.profile`, PROFILE-API.md). */
export interface ProfileLimits {
  maxRows: number;
  maxR: number;
  maxRangeDays: number;
}

/** UTC-Datum „YYYY-MM-DD" (Bezeichnung eines Profiltags) → Tagesindex d. */
export function dayIndexOfLabel(label: string): number {
  return Math.floor(Date.parse(`${label}T00:00:00Z`) / DAY_MS);
}

/**
 * vwap gegen notional / Volumen nach der Regel der API: Ganzzahldivision auf 6 Nachkommastellen
 * (floor(notional · 10^6 / Volumen) / 10^6), mit BigInt; '' = stimmt.
 */
export function vwapProblem(p: {
  notional: string;
  buyQ: number;
  sellQ: number;
  vwap: number | null;
}): string {
  const vol = p.buyQ + p.sellQ;
  if (vol === 0) return p.vwap === null ? '' : 'vwap ohne Volumen';
  if (typeof p.vwap !== 'number') return 'vwap fehlt';
  const q = (BigInt(p.notional) * 1_000_000n) / BigInt(vol);
  // q ist exakt; die JSON-Zahl vwap trägt q / 10^6 bis auf die Gleitkomma-Darstellung (≤ ½ Einheit der
  // 6. Nachkommastelle bzw. relative Doppelgenauigkeit bei sehr großen Werten)
  const qn = Number(q);
  return Math.abs(p.vwap * 1e6 - qn) <= Math.max(0.5, qn * 1e-15)
    ? ''
    : `vwap ${p.vwap} ≠ ${qn / 1e6}`;
}
/** Länge des POC-Strichs der Silhouette (CSS-px). */
const POC_TICK_PX = 6;
/** Obergrenze der Hilfstabellen (422-Untergrenzen, Querprüfungszähler). */
const MAX_AUX_ENTRIES = 512;

interface Entry {
  final: boolean;
  loadedAt: number;
  /** Tagesprofile eines Batches nach Tagesbeginn (ms); Bereichsprofil unter 0. */
  profiles: Map<number, PreparedProfile>;
  /** Tagesprofile: Beginn des nicht finalen Rests (wird allein nachgeladen), sonst null. */
  openFrom: number | null;
  /** Ende des angefragten Zeitraums (ms) */
  to: number;
  /** Tagesprofile: Tage (Index d) mit Daten, aber ohne Trades bzw. ohne gespeicherte Daten */
  emptyDays: Set<number>;
  missingDays: Set<number>;
}

/** Angefragter Zeitraum je Schlüssel (Antwort wird dagegen geprüft). */
interface Request {
  from: number;
  to: number;
  offsetH: number;
  va: number;
  /** Rest-Anfrage: Schlüssel des Batches, in den die Tage übernommen werden */
  base: string | null;
}

export interface ProfileReadout {
  mode: ProfileMode;
  view: ProfileView;
  scale: ProfileScaleMode;
  R: number;
  rAuto: boolean;
  rLabel: string;
  daysDrawn: number;
  daysSkipped: number;
  /** Hinweise (ausgelassene Tage, Server-R-Vorschlag), sonst ''. */
  note: string;
  error: string;
  /** Fehler bleibt bis Symbolwechsel/Schließen stehen (Querprüfung) */
  sticky: boolean;
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
  vwap: string;
}

/** Gezeichnetes Profil (CSS-px) für den Hover: Balkenlängen aus Ansicht und Skala (W-1). */
export interface Hit {
  x0: number;
  maxW: number;
  p: PreparedProfile;
  range: boolean;
  view: ProfileView;
  scale: number;
}

export class ProfileLayer implements IPanePrimitive<Time> {
  mode: ProfileMode = PROFILE_DEFAULTS.mode;
  view: ProfileView = PROFILE_DEFAULTS.view;
  va = PROFILE_DEFAULTS.va;
  offsetH = PROFILE_DEFAULTS.offsetH;
  /** Skala der Tagesprofile: je Profil (Standard) oder gemeinsam über die sichtbaren Tage */
  scaleMode: ProfileScaleMode = 'profile';
  /** VA-Fläche + VAH/VAL-Linien zeigen */
  showVa = true;
  /** POC/VAH/VAL nach rechts verlängern, bis der Preis sie berührt (Naked Levels) */
  extend = false;
  /** manuelles Profil-R (Ticks) oder null = automatisch nach Pixelhöhe */
  manualR: number | null = null;
  /** Bereich [from, to) in ms (Minuten), höchstens einer */
  range: [number, number] | null = null;
  /** Hinweis zum Bereich (gekürzt, vertauscht, außerhalb der Daten) */
  rangeNote = '';
  selecting = false;
  /** Chart ruht (TPO-Ansicht): keine Anfragen (H-2) */
  suspended = false;
  /** Nach Datenankunft/Zustandsänderung (UI aktualisiert Anzeige/Zusammenfassung). */
  onChange: (() => void) | null = null;

  private autoR: number | null = null;
  private readonly host: ProfileHost;
  private readonly queue: RequestQueue;
  private readonly cache = new Map<string, Entry>();
  private readonly requests = new Map<string, Request>();
  private readonly reloadKeys = new Set<string>();
  private requestUpdate: (() => void) | null = null;
  private readonly views: IPanePrimitivePaneView[];
  private error = '';
  /** W-3: wiederholte Abweichung von den Bars – bleibt bis Symbolwechsel oder Schließen */
  private stickyError = '';
  private daysDrawn = 0;
  private daysSkipped = 0;
  private daysMissing = 0;
  private daysEmpty = 0;
  /** 422: R-Untergrenze je Anfrage-Bereich (Schlüssel ohne R), höchstens ein Versuch je Bereich. */
  private readonly rFloor = new Map<string, number>();
  private lastReason = '';
  private readonly crossFails = new Map<string, number>();
  private selectAnchor: number | null = null;
  private selectHover: number | null = null;
  private readonly rects: Rect[] = [];
  private hits: Hit[] = [];
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** Beginn des aktuellen Zurückstehens (performance.now) oder null */
  private holdSince: number | null = null;
  /** W-B: gemeinsame Skala, nur bei Datenankunft/Gestenende/Einstellung neu bestimmt */
  private common = { width: 0, total: 0, delta: 0 };
  /** Naked-Level-Ergebnisse je (Profil, Zeile) für das aktuelle Item-Array (nicht je Frame) */
  private nakedItems: readonly BarItem[] | null = null;
  private readonly naked = new Map<string, number>();
  /** Zähler für Tests/Messung */
  readonly counters = {
    draws: 0,
    rectsDrawn: 0,
    crossChecks: 0,
    crossMismatches: 0,
    held: 0,
    nakedScans: 0,
  };
  /** Zeichenzeiten (ms) der letzten 512 Frames als Ring, Index = counters.draws mod 512 (Messung). */
  readonly drawMs = new Float64Array(512);

  constructor(host: ProfileHost, fetchFn?: FetchFn) {
    this.host = host;
    this.queue = new RequestQueue(
      (key, buf) => this.onLoaded(key, buf),
      (key, status, _err, body) => this.onRejected(key, status, body),
      fetchFn ?? ((u, i) => fetch(u, i)),
      PROFILE_MAX_PARALLEL,
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
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.queue.cancelAll();
  }

  // ---------------------------------------------------------------- Einstellungen

  /** Profil-R, das angefragt wird (manuell, sonst automatisch); null = noch nicht vermessen. */
  get R(): number | null {
    return this.manualR ?? this.autoR;
  }

  ladder(): number[] {
    const s = this.host.sym();
    const maxR = this.host.limits?.()?.maxR ?? Infinity;
    return s ? profileLadder(s.tickRefUnits, s.tickUnits).filter((r) => r <= maxR) : [];
  }

  /** Symbolwechsel: R neu bestimmen, Bereich verwerfen (gehört zum alten Symbol). */
  resetForSymbol(): void {
    this.autoR = null;
    this.rFloor.clear();
    this.crossFails.clear();
    this.stickyError = '';
    this.error = '';
    this.range = null;
    this.rangeNote = '';
    if (this.mode === 'range') this.mode = 'off';
    else if (this.mode === 'both') this.mode = 'daily';
    this.cancelSelect();
  }

  /** Fehler schließen (auch den stehenbleibenden der Querprüfung). */
  dismissError(): void {
    this.stickyError = '';
    this.error = '';
    this.queue.lastError = ''; // H-2
    this.crossFails.clear(); // H-3: nächste Abweichung lädt wieder zuerst neu
    this.onChange?.();
  }

  /** Gestenende: automatische Zeilengröße nach Pixelhöhe (px je price_unit der sichtbaren Skala). */
  evaluate(pxPerUnit: number): void {
    const s = this.host.sym();
    if (!s || !(pxPerUnit > 0)) return;
    this.autoR = profileRowSize(this.autoR, this.ladder(), pxPerUnit, s.tickRefUnits);
    this.updateRowFloors();
    this.updateCommonScale();
    this.frame();
    this.redraw();
  }

  /** Einstellungen geändert (UI): Bedarf neu, neu zeichnen. */
  changed(): void {
    this.updateCommonScale();
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
    if (this.suspended || !s || !vis || this.mode === 'off' || this.R === null) {
      this.queue.setWanted([], new Set());
      return;
    }
    const wants: Want[] = [];
    const retain = new Set<string>();
    const now = performance.now();
    const want = (key: string, url: string, priority: number, req: Request) => {
      retain.add(key);
      if (this.queue.isFinal(key) && this.reloadKeys.has(key)) this.queue.forgetFailure(key);
      this.requests.set(key, req);
      wants.push({ key, url, priority, reload: this.reloadKeys.has(key) });
    };
    const fresh = (key: string, e: Entry | undefined): boolean => {
      if (!e) return false;
      // LRU: Benutzung frischt auf
      this.cache.delete(key);
      this.cache.set(key, e);
      return e.final || now - e.loadedAt < PROFILE_NONFINAL_TTL_MS;
    };
    const base = `${this.host.apiBase}/api/v1`;
    const sym = encodeURIComponent(s.name);
    const oh = this.offsetH;
    const va = this.va;
    if (this.mode === 'daily' || this.mode === 'both') {
      // LOD: sind die Tage so schmal, dass kein Profil gezeichnet würde, gar nicht erst laden
      if (this.dayWidthPx() >= MIN_DAY_PX) {
        const batches = wantedDayBatches(vis[0], vis[1], oh, s.dataFrom, s.dataTo);
        batches.forEach((b, i) => {
          const key = this.dailyKeyFor(s.name, b);
          const r = Number(key.split('|')[2]);
          const e = this.cache.get(key);
          if (fresh(key, e)) {
            retain.add(key);
            return;
          }
          // nicht finaler Batch: nur den offenen Rest neu laden (finale Tage bleiben im Cache)
          const [from, to] =
            e && e.openFrom !== null ? [e.openFrom, e.to] : clampBatch(batchWindow(b, oh), s, oh);
          const k = e && e.openFrom !== null ? `${key}|tail` : key;
          want(
            k,
            `${base}/profiles/daily?sym=${sym}&from=${from}&to=${to}&R=${r}&offsetH=${oh}&va=${va}`,
            i + 1,
            { from, to, offsetH: oh, va, base: k === key ? null : key },
          );
          if (k !== key) retain.add(key);
        });
      }
    }
    if ((this.mode === 'range' || this.mode === 'both') && this.range) {
      const [from, to] = this.range;
      const key = this.rangeKeyFor(s.name, from, to);
      const r = Number(key.split('|')[2]);
      if (fresh(key, this.cache.get(key))) retain.add(key);
      else
        want(key, `${base}/profile?sym=${sym}&from=${from}&to=${to}&R=${r}&va=${va}`, 0, {
          from,
          to,
          offsetH: oh,
          va,
          base: null,
        });
    }
    // W-4: Kacheln und Bars haben Vorrang – solange sie laden, keine neuen Profilanfragen; W-A: höchstens
    // PROFILE_MAX_HOLD_MS lang, danach eine Profilanfrage gleichzeitig (Profile verhungern nicht)
    if (wants.length > 0 && this.host.busy()) {
      this.holdSince ??= now;
      if (now - this.holdSince >= PROFILE_MAX_HOLD_MS) {
        const first = [...wants].sort((a, b) => a.priority - b.priority).slice(0, 1);
        this.queue.setWanted(this.queue.stats.inFlight > 0 ? [] : first, retain);
      } else {
        this.counters.held++;
        this.queue.setWanted([], retain);
      }
      if (!this.holdTimer)
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null;
          // während einer Geste nichts starten – der Controller bestimmt den Bedarf am Gestenende
          if (!this.host.gestureActive()) this.frame();
        }, PROFILE_HOLD_MS);
      return;
    }
    this.holdSince = null;
    this.queue.setWanted(wants, retain);
  }

  private dayWidthPx(): number {
    return (DAY_MS / 1000 / this.host.tfSec()) * this.host.chart.timeScale().options().barSpacing;
  }

  // ---------------------------------------------------------------- Antworten

  private onLoaded(key: string, buf: ArrayBuffer): void {
    const s = this.host.sym();
    const req = this.requests.get(key);
    this.requests.delete(key);
    this.reloadKeys.delete(key);
    if (!s || !req) return;
    const json: unknown = JSON.parse(new TextDecoder().decode(buf));
    const R = Number(key.split('|')[2]);
    const bad = (x: {
      R: number;
      sym: string;
      tickRefUnits: number;
      va: number;
      from: number;
      to: number;
    }) =>
      x.R !== R ||
      x.sym !== s.name ||
      x.tickRefUnits !== s.tickRefUnits ||
      x.va !== req.va ||
      x.from !== req.from ||
      x.to !== req.to;
    if (key.startsWith('pd|')) {
      const x = json as DailyProfilesResponse;
      const problems = checkDailyProfiles(x);
      if (problems.length > 0) throw new Error(problems.slice(0, 3).join('; '));
      if (bad(x) || x.offsetH !== req.offsetH) throw new Error('Antwort passt nicht zur Anfrage');
      const target = req.base ? this.cache.get(req.base) : undefined;
      const profiles = target ? target.profiles : new Map<number, PreparedProfile>();
      const baseKey = req.base ?? key;
      let openFrom: number | null = null;
      for (const d of x.days) {
        if (d.from < req.from || d.to > req.to) throw new Error('Tag außerhalb der Anfrage');
        const vw = vwapProblem(d);
        if (vw) throw new Error(`Tag ${d.day}: ${vw}`);
        const k = `${baseKey}#${d.from}`;
        // gleiche Tagesversion → vorbereitetes Profil behalten (finale Tage bleiben, PROFILE-API.md)
        const old = profiles.get(d.from);
        if (!old || old.dataVersion !== d.dataVersion)
          profiles.set(d.from, {
            ...prepareProfile(k, d, d.from, d.to, d.final, R, s.tickRefUnits),
            dataVersion: d.dataVersion,
            vwap: d.vwap,
          });
        // H-5: ein Tag kann bei gleicher Version final werden (z. B. nach der Prüfung) – Flag übernehmen,
        // damit die Querprüfung ihn erfasst
        else if (old.final !== d.final) old.final = d.final;
        if (!d.final && openFrom === null) openFrom = d.from;
      }
      // Tage ohne Trades bzw. ohne gespeicherte Daten (Anzeige unterscheidet beide)
      const empty = target?.emptyDays ?? new Set<number>();
      const missing = target?.missingDays ?? new Set<number>();
      for (const label of x.emptyDays ?? []) empty.add(dayIndexOfLabel(label));
      for (const label of x.missingDays ?? []) missing.add(dayIndexOfLabel(label));
      for (const d of x.days) {
        const di = profileDayOf(d.from, req.offsetH);
        empty.delete(di);
        missing.delete(di);
      }
      // Antwort nicht final, aber alle gelieferten Tage final (z. B. offener Tag ohne Trades)
      if (!x.final && openFrom === null) openFrom = Math.max(req.from, req.to - DAY_MS);
      if (req.base && !target) return; // Batch inzwischen verdrängt: beim nächsten Bedarf ganz laden
      this.put(baseKey, {
        final: x.final,
        loadedAt: performance.now(),
        profiles,
        openFrom: x.final ? null : openFrom,
        to: target ? target.to : req.to,
        emptyDays: empty,
        missingDays: missing,
      });
      this.error = '';
      this.crossCheck(baseKey);
    } else {
      const x = json as RangeProfileResponse;
      const problems = checkRangeProfile(x);
      if (problems.length > 0) throw new Error(problems.slice(0, 3).join('; '));
      if (bad(x)) throw new Error('Antwort passt nicht zur Anfrage');
      const vw = vwapProblem(x.profile);
      if (vw) throw new Error(vw);
      const p = prepareProfile(key, x.profile, x.from, x.to, x.final, R, s.tickRefUnits);
      this.put(key, {
        final: x.final,
        loadedAt: performance.now(),
        profiles: new Map([[0, { ...p, vwap: x.profile.vwap }]]),
        openFrom: null,
        to: x.to,
        emptyDays: new Set(),
        missingDays: new Set(),
      });
      this.error = '';
      this.crossCheck(key);
    }
    this.updateCommonScale();
    this.onChange?.();
    this.redraw();
  }

  /**
   * W-B: gemeinsame Skala = größte Zeile über alle geladenen Tagesprofile mit der Zeilenbreite des
   * aktuellen R in den sichtbaren Batches ± 1 – nur bei Datenankunft, Gestenende und Einstellungen neu
   * bestimmt, nicht je Frame (sonst springen die Balken, wenn ein großer Tag hereinscrollt).
   */
  updateCommonScale(): void {
    const s = this.host.sym();
    const vis = this.host.visibleTimeRange();
    if (!s || !vis || this.R === null) return;
    const b0 = batchOfDay(profileDayOf(vis[0] * 1000, this.offsetH)) - 1;
    const b1 = batchOfDay(profileDayOf(vis[1] * 1000, this.offsetH)) + 1;
    const profiles: PreparedProfile[] = [];
    for (let b = b0; b <= b1; b++) {
      const e = this.cache.get(this.dailyKeyFor(s.name, b));
      if (e) for (const p of e.profiles.values()) profiles.push(p);
    }
    this.common = commonScale(profiles, this.R * s.tickRefUnits);
  }

  private onRejected(key: string, status: number, body?: string): void {
    this.requests.delete(key);
    const parts = key.replace(/\|tail$/, '').split('|');
    const usedR = Number(parts[2]);
    const scope = [parts[0], parts[1], ...parts.slice(3)].join('|');
    if (status === 422) {
      let suggest: number | null = null;
      let reason = '';
      try {
        const j = JSON.parse(body ?? '') as { suggestR?: unknown; reason?: unknown };
        if (typeof j.suggestR === 'number' && Number.isSafeInteger(j.suggestR))
          suggest = j.suggestR;
        if (typeof j.reason === 'string') reason = j.reason;
      } catch {
        /* kein JSON */
      }
      this.lastReason =
        reason === 'profile_rows'
          ? 'zu viele Zeilen'
          : reason === 'profile_source_rows'
            ? 'zu viele Quellzeilen'
            : '';
      // einmal mit dem Vorschlag wiederholen (gilt nur für den aktuellen Datenstand, daher kein Cache)
      if (suggest !== null && suggest > usedR && !this.rFloor.has(scope)) {
        if (this.rFloor.size >= MAX_AUX_ENTRIES) this.rFloor.clear();
        this.rFloor.set(scope, suggest);
        this.frame();
        this.onChange?.();
        return;
      }
      this.error = `${this.queue.label(key)}: ${this.lastReason || 'Zeitraum zu groß'} für R ${usedR}`;
    } else if (status === 400 && key.startsWith('pr|')) {
      this.error = 'Bereichsprofil: Bereich zu groß oder außerhalb der Daten';
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
   * desselben Zeitraums – nur, wenn die Bars den Zeitraum vollständig und unveränderlich abdecken.
   * Erste Abweichung → einmal am Browser-Cache vorbei neu laden; wiederholt → Fehler, der stehen bleibt.
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
      if (this.crossFails.size >= MAX_AUX_ENTRIES) this.crossFails.clear();
      const n = (this.crossFails.get(ck) ?? 0) + 1;
      this.crossFails.set(ck, n);
      const day = new Date(p.from).toISOString().slice(0, 16).replace('T', ' ');
      console.warn(`Profil ${day} UTC passt nicht zu den Bars: ${diff}`);
      if (n === 1) {
        this.cache.delete(key); // einmal neu laden, am Browser-Cache vorbei (final = max-age 1 Woche)
        this.reloadKeys.add(key);
        this.frame();
      } else {
        this.stickyError = `Profil ab ${day} UTC passt nicht zu den Bars (${diff})`;
        this.crossFails.delete(ck); // H-3: eine spätere Abweichung lädt wieder zuerst neu
      }
      return;
    }
  }

  /** Nach neuen Bars (Fensterwechsel) die geladenen Profile im Fenster prüfen. */
  crossCheckAll(): void {
    for (const k of [...this.cache.keys()]) this.crossCheck(k);
    this.updateRowFloors();
  }

  /**
   * Zeilengrenze vorab (statt 422-Umweg): je sichtbarem Batch die Zeilen aus den Hoch/Tief der geladenen
   * Bars schätzen (Σ je Tag floor(high/w) − floor(low/w) + 1, genau die Zählung der API) und, wenn sie
   * `limits.maxRows` überschreiten, das kleinste passende R der Leiter als Untergrenze setzen. Tage ohne
   * geladene Bars zählen nicht (dann bleibt der 422-Weg). Nur am Gestenende/Fensterwechsel.
   */
  updateRowFloors(): void {
    const s = this.host.sym();
    const vis = this.host.visibleTimeRange();
    const lim = this.host.limits?.();
    const R = this.R;
    if (!s || !vis || !lim || R === null || (this.mode !== 'daily' && this.mode !== 'both')) return;
    const items = this.host.items();
    if (items.length === 0) return;
    const ladder = this.ladder();
    for (const b of wantedDayBatches(vis[0], vis[1], this.offsetH, s.dataFrom, s.dataTo)) {
      const [from, to] = batchWindow(b, this.offsetH);
      const ranges = dayRanges(items, from, to, this.offsetH);
      if (ranges.length === 0) continue;
      const r = minRowsR(ranges, s.tickRefUnits, ladder, lim.maxRows, R);
      const scope = this.dailyScope(s.name, b);
      if (r > R && r > (this.rFloor.get(scope) ?? 0)) {
        if (this.rFloor.size >= MAX_AUX_ENTRIES) this.rFloor.clear();
        this.rFloor.set(scope, r);
      }
    }
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

  /**
   * Bereich setzen (Auswahl oder URL): auf den Datenbereich (Minuten) und höchstens 3 660 Tage gekürzt,
   * mit sichtbarem Hinweis; außerhalb der Daten nicht übernommen. Modus so erweitern, dass er sichtbar
   * ist. Liefert false, wenn kein Bereich gesetzt wurde.
   */
  setRange(r: [number, number], note = ''): boolean {
    const s = this.host.sym();
    this.selecting = false;
    this.selectAnchor = null;
    this.selectHover = null;
    let [from, to] = r;
    const notes = note ? [note] : [];
    if (s) {
      const lo = Math.floor(s.dataFrom / MINUTE_MS) * MINUTE_MS;
      const hi = Math.ceil(s.dataTo / MINUTE_MS) * MINUTE_MS;
      if (to <= lo || from >= hi) {
        this.rangeNote = 'Bereich außerhalb der Daten – nicht übernommen';
        this.changed();
        return false;
      }
      if (from < lo || to > hi) notes.push('Bereich auf den Datenbereich gekürzt');
      from = Math.max(from, lo);
      to = Math.min(to, hi);
    }
    const maxMs = (this.host.limits?.()?.maxRangeDays ?? MAX_RANGE_MS / DAY_MS) * DAY_MS;
    if (to - from > maxMs) {
      from = to - maxMs;
      notes.push(`Bereich auf ${maxMs / DAY_MS} Tage gekürzt`);
    }
    this.range = [from, to];
    this.rangeNote = notes.join('; ');
    if (this.mode === 'off') this.mode = 'range';
    else if (this.mode === 'daily') this.mode = 'both';
    this.changed();
    return true;
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
    this.rangeNote = '';
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
        `Profil-R ${R} zu fein → ${floors.filter((f) => f > R).join('/')} (Zeilengrenze/suggestR)`,
      );
    if (this.daysMissing > 0) notes.push(`${this.daysMissing} Tage ohne Daten`);
    if (this.daysEmpty > 0) notes.push(`${this.daysEmpty} Tage ohne Trades`);
    if (this.daysSkipped > 0)
      notes.push(`${this.daysSkipped} Tagesprofile ausgelassen (Tag < ${MIN_DAY_PX} px breit)`);
    if (this.rangeNote) notes.push(this.rangeNote);
    if (this.selecting)
      notes.push(
        this.selectAnchor === null
          ? 'Bereich: Anfang anklicken'
          : 'Bereich: Ende anklicken (Esc bricht ab)',
      );
    return {
      mode: this.mode,
      view: this.view,
      scale: this.scaleMode,
      R,
      rAuto: this.manualR === null,
      rLabel: s && R ? `${exactDecimal(R * s.tickRefUnits, s.priceDecimals)} USDT` : '',
      daysDrawn: this.daysDrawn,
      daysSkipped: this.daysSkipped,
      note: notes.join('; '),
      error: this.stickyError || this.error || this.queue.lastError,
      sticky: this.stickyError !== '',
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
    const [a, b] = this.range;
    const za = zoneLabel(a, displayZone());
    const zb = zoneLabel(b, displayZone());
    // Zonenangabe einmal; nur wenn sie dazwischen wechselt (Sommerzeit), an beiden Enden
    const range =
      za === zb
        ? `${fmtShown(a)} – ${fmtShown(b)} ${za}`
        : `${fmtShown(a)} ${za} – ${fmtShown(b)} ${zb}`;
    const p = this.rangeProfile();
    if (!p)
      return {
        range,
        loading: true,
        total: '',
        buy: '',
        sell: '',
        delta: '',
        poc: '',
        va: '',
        vwap: '',
      };
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
      vwap:
        p.vwap === null || p.vwap === undefined
          ? '–'
          : (p.vwap / 10 ** s.priceDecimals).toFixed(s.priceDecimals),
    };
  }

  /** Gezeichnete Profile des letzten Frames (Hover, Tests). */
  get drawnHits(): readonly Hit[] {
    return this.hits;
  }

  /**
   * Hover über einem gezeichneten Profilbalken (x in CSS-px, unit = Preis in price_unit): exakte Werte
   * der Zeile, sonst '' (dann zeigt der Controller Footprint/Kerze). Getroffen ist nur der gezeichnete
   * Balken dieser Zeile, nicht die ganze Profilbreite (W-1). Bereichsprofil vor Tagesprofil.
   */
  hoverText(x: number, unit: number): string {
    const s = this.host.sym();
    if (!s) return '';
    const hit = hitAt(this.hits, x, unit);
    if (!hit) return '';
    const { h, i } = hit;
    const p = h.p;
    const r = p.rowLo + i;
    const b = p.buy[i]!;
    const sl = p.sell[i]!;
    const q = qtyFormatter(s);
    const px = (u: number) => exactDecimal(u, s.priceDecimals);
    const which = h.range ? 'Bereichsprofil' : `Tagesprofil ${sessionLabel(p.from, displayZone())}`;
    const marks = [r === p.poc ? 'POC' : '', r === p.vah ? 'VAH' : '', r === p.val ? 'VAL' : '']
      .filter(Boolean)
      .join('/');
    const scaleTxt = `längster Balken = ${h.view === 'delta' ? '|Delta| ' : ''}${q(h.scale)}${
      !h.range && this.scaleMode === 'common' ? ' (gemeinsame Skala)' : ''
    }`;
    return (
      `${which} · Zeile [${px(r * p.width)}, ${px((r + 1) * p.width)})${marks ? ` ${marks}` : ''}` +
      ` · Bid (Verkäufer) ${q(sl)} · Ask (Käufer) ${q(b)} · gesamt ${q(b + sl)} · Delta ${q(b - sl)}` +
      ` · ${scaleTxt}`
    );
  }

  // ---------------------------------------------------------------- Zeichnen

  /**
   * x (CSS-px) des Beginns der Zeit t (ms) auf der indexbasierten Zeitachse: linke Kante des ersten
   * Bars ≥ t; außerhalb des Fensters linear mit tf fortgesetzt.
   */
  xOfTime(tMs: number, items: readonly BarItem[], tfSec: number, bs: number): number | null {
    const n = items.length;
    if (n === 0) return null;
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
    this.daysMissing = 0;
    this.daysEmpty = 0;
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
    const uAt = (yCss: number) => ref + (yCss - yA) / A;
    const H = scope.bitmapSize.height;
    const W = scope.bitmapSize.width / hpr;
    const g: DrawGeom = { ctx, hpr, vpr, A, yU, uAt, H, W, items, bs };
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
    const footprint = this.host.footprintActive();

    // Tagesprofile: erst Lage und Detailstufe, dann (bei gemeinsamer Skala) das Maximum, dann zeichnen
    if (this.mode === 'daily' || this.mode === 'both') {
      const d0 = profileDayOf(vis[0] * 1000, this.offsetH) - 1;
      const d1 = profileDayOf(vis[1] * 1000, this.offsetH) + 1;
      const dMin = profileDayOf(s.dataFrom, this.offsetH);
      const dMax = profileDayOf(s.dataTo - 1, this.offsetH);
      const list: { p: PreparedProfile; x0: number; maxW: number; detail: DayDetail }[] = [];
      for (let d = Math.max(d0, dMin); d <= Math.min(d1, dMax); d++) {
        const [from, to] = profileDayWindow(d, this.offsetH);
        const xa = this.xOfTime(from, items, tf, bs);
        const xb = this.xOfTime(to, items, tf, bs);
        if (xa === null || xb === null || xb <= 0 || xa >= W) continue;
        const detail = dayDetail(xb - xa);
        if (detail === 'skip') {
          this.daysSkipped++;
          continue;
        }
        const place = profilePlacement(xa, xb, W, footprint);
        const p = this.dayProfileAt(from);
        if (!p) {
          // Tag ohne Profil: ohne gespeicherte Daten oder ohne Trades (laut Antwort)
          const st = dayStatus(this.cache.get(this.dailyKeyFor(s.name, batchOfDay(d))), d);
          if (st === 'missing') this.daysMissing++;
          else if (st === 'empty') this.daysEmpty++;
        }
        if (!place || !p || p.buy.length === 0) continue;
        list.push({ p, ...place, detail });
      }
      // gemeinsame Skala: festgehalten (W-B); Profile anderer Zeilenbreite (422-Vorschlag) eigene Skala
      const common = this.common;
      for (const x of list) {
        const view: ProfileView = x.detail === 'silhouette' ? 'total' : this.view;
        const c =
          this.scaleMode === 'common' && x.p.width === common.width
            ? Math.max(view === 'delta' ? common.delta : common.total, profileScale(x.p, view))
            : 0;
        this.drawProfile(g, x.p, x.x0, x.maxW, x.detail, view, c || profileScale(x.p, view), false);
        this.daysDrawn++;
      }
    }
    // Bereichsprofil (über den Tagesprofilen, eigene Skala, gleiche klebende Lage)
    if ((this.mode === 'range' || this.mode === 'both') && this.range) {
      const xa = this.xOfTime(this.range[0], items, tf, bs);
      const xb = this.xOfTime(this.range[1], items, tf, bs);
      if (xa !== null && xb !== null && xb > 0 && xa < W) {
        this.drawRangeBox(ctx, xa, xb, hpr, H);
        const p = this.rangeProfile();
        const place = profilePlacement(xa, xb, W, footprint, RANGE_PROFILE_SHARE, RANGE_MIN_W);
        if (p && place && p.buy.length > 0)
          this.drawProfile(
            g,
            p,
            place.x0,
            place.maxW,
            'full',
            this.view,
            profileScale(p, this.view),
            true,
          );
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
    g: DrawGeom,
    p: PreparedProfile,
    x0: number,
    maxW: number,
    detail: DayDetail,
    view: ProfileView,
    scale: number,
    isRange: boolean,
  ): void {
    const { ctx, hpr, vpr, A, yU, uAt, H } = g;
    const hit: Hit = { x0, maxW, p, range: isRange, view, scale };
    if (isRange) this.hits.unshift(hit);
    else this.hits.push(hit);
    const full = detail === 'full';
    const rowPx = -A * p.width * vpr;
    const gap = rowPx >= 4 * vpr ? Math.max(1, Math.floor(vpr)) : 0;
    const bx = Math.round(x0 * hpr);
    const bw = maxW * hpr;
    if (full && this.showVa && p.val !== null && p.vah !== null) {
      const yt = Math.round(yU((p.vah + 1) * p.width));
      const yb = Math.round(yU(p.val * p.width));
      ctx.fillStyle = VA_FILL;
      ctx.fillRect(bx, yt, Math.round(bw), yb - yt);
    }
    // sichtbare Zeilen analytisch (oben/unten der Pane), statt alle Zeilen umzurechnen
    const rTop = Math.floor(uAt(0) / p.width);
    const rBot = Math.floor(uAt(H / vpr) / p.width);
    this.rects.length = 0;
    profileRects(p, view, bx, bw, yU, 0, H, gap, this.rects, MIN_BAR_PX * hpr, scale, [rBot, rTop]);
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
    if (!full) {
      // Silhouette: nur ein kurzer POC-Strich
      if (p.poc !== null) {
        const y = Math.round(rowMidY(p.poc, p.width, yU));
        ctx.fillStyle = POC_COLOR;
        ctx.fillRect(bx, y - (lw >> 1), Math.round(Math.min(maxW, POC_TICK_PX) * hpr), lw);
      }
      return;
    }
    const line = (row: number | null, color: string) => {
      if (row === null) return;
      const y = Math.round(rowMidY(row, p.width, yU));
      if (y < 0 || y > H) return;
      ctx.fillStyle = color;
      const end = x0 + maxW;
      ctx.fillRect(bx, y - (lw >> 1), Math.round(end * hpr) - bx, lw);
      if (!this.extend) return;
      const ext = this.nakedEnd(row, p, g);
      if (!ext || ext.x <= end) return;
      const xa = Math.round(end * hpr);
      const xb = Math.round(Math.min(ext.x, g.W) * hpr);
      if (ext.touched) ctx.fillRect(xa, y - (lw >> 1), xb - xa, lw);
      else {
        // im geladenen Fenster nicht berührt: gestrichelt bis zum letzten geladenen Bar (C)
        const on = Math.round(4 * hpr);
        const off = Math.round(3 * hpr);
        for (let x = xa; x < xb; x += on + off)
          ctx.fillRect(x, y - (lw >> 1), Math.min(on, xb - x), lw);
      }
    };
    if (this.showVa) {
      line(p.vah, VA_LINE);
      line(p.val, VA_LINE);
    }
    line(p.poc, POC_COLOR);
  }

  /**
   * Naked Level der Zeile `row`: erster Bar nach dem Profil, dessen Spanne das Zeilenintervall schneidet
   * (touched, x = linke Kante dieses Bars), sonst bis zur rechten Kante des letzten geladenen Bars
   * (touched = false). Ergebnis je (Profil, Zeile) zwischengespeichert, solange das Item-Array gleich
   * bleibt (nicht je Frame). null: keine Bars nach dem Profil geladen.
   */
  nakedEnd(
    row: number,
    p: PreparedProfile,
    g: Pick<DrawGeom, 'items' | 'bs'>,
  ): { x: number; touched: boolean } | null {
    const items = g.items;
    if (items !== this.nakedItems) {
      this.nakedItems = items;
      this.naked.clear();
    }
    const ck = `${p.key}|${row}`;
    let idx = this.naked.get(ck);
    if (idx === undefined) {
      this.counters.nakedScans++;
      let lo = 0;
      let hi = items.length;
      const toSec = p.to / 1000;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (items[m]!.time < toSec) lo = m + 1;
        else hi = m;
      }
      idx = lo >= items.length ? -2 : firstTouch(items, lo, row * p.width, (row + 1) * p.width);
      this.naked.set(ck, idx);
    }
    if (idx === -2) return null;
    const ts = this.host.chart.timeScale();
    if (idx >= 0) {
      const x = ts.logicalToCoordinate(idx as never);
      return x === null ? null : { x: x - g.bs / 2, touched: true };
    }
    const x = ts.logicalToCoordinate((items.length - 1) as never);
    return x === null ? null : { x: x + g.bs / 2, touched: false };
  }
}

interface DrawGeom {
  ctx: CanvasRenderingContext2D;
  hpr: number;
  vpr: number;
  A: number;
  yU: (u: number) => number;
  uAt: (yCss: number) => number;
  H: number;
  W: number;
  items: readonly BarItem[];
  bs: number;
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

/**
 * Hover-Treffer (W-1): erstes gezeichnetes Profil, dessen Balken der Zeile unter `unit` bis `x` reicht
 * (x0 ≤ x ≤ x0 + Balkenlänge, Balken ≥ MIN_BAR_PX wie beim Zeichnen, H-4). Rand rechts vom Balken = kein Treffer → Footprint/Kerze.
 */
export function hitAt(hits: readonly Hit[], x: number, unit: number): { h: Hit; i: number } | null {
  for (const h of hits) {
    const i = Math.floor(unit / h.p.width) - h.p.rowLo;
    const len = rowBarLength(h.p, h.view, i, h.maxW, h.scale);
    if (len >= MIN_BAR_PX && x >= h.x0 && x <= h.x0 + len) return { h, i };
  }
  return null;
}

/** Hoch/Tief (price_unit) je Profiltag aus den Bars in [fromMs, toMs). */
export function dayRanges(
  items: readonly { t: number; h: number; l: number }[],
  fromMs: number,
  toMs: number,
  offsetH: number,
): [number, number][] {
  const out: [number, number][] = [];
  let day = Number.NaN;
  for (const it of items) {
    const ms = it.t * 1000;
    if (ms < fromMs || ms >= toMs) continue;
    const d = profileDayOf(ms, offsetH);
    if (d !== day) {
      day = d;
      out.push([it.l, it.h]);
    } else {
      const r = out[out.length - 1]!;
      r[0] = Math.min(r[0], it.l);
      r[1] = Math.max(r[1], it.h);
    }
  }
  return out;
}

/** Kleinstes R der Leiter (≥ R), bei dem Σ Zeilen je Tag ≤ maxRows; sonst das größte. */
export function minRowsR(
  ranges: readonly [number, number][],
  tickRefUnits: number,
  ladder: readonly number[],
  maxRows: number,
  R: number,
): number {
  const rows = (r: number) => {
    const w = r * tickRefUnits;
    let n = 0;
    for (const [lo, hi] of ranges) n += Math.floor(hi / w) - Math.floor(lo / w) + 1;
    return n;
  };
  for (const r of ladder) if (r >= R && rows(r) <= maxRows) return r;
  return ladder[ladder.length - 1] ?? R;
}

/** Tag ohne Profil: laut Antwort ohne gespeicherte Daten ('missing'), ohne Trades ('empty') oder unbekannt. */
export function dayStatus(
  e: { emptyDays: Set<number>; missingDays: Set<number> } | undefined,
  d: number,
): 'missing' | 'empty' | 'unknown' {
  return e?.missingDays.has(d) ? 'missing' : e?.emptyDays.has(d) ? 'empty' : 'unknown';
}
