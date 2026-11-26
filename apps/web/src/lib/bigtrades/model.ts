// Big Trades (KONZEPT §6.4, docs/BIGTRADES-API.md): reine Funktionen der Anzeige – Schwellenstufen,
// URL-/Speicherzustand, Radius und Stufe je Marker, Ausdünnung je Pixelspalte, Abdeckung → Bänder und
// Legende, Trefferprüfung über ein Eimerraster, exakte Texte. Kein DOM, kein Chart (testbar).
import type { CoverageReason, CoverageSpan } from '@orderflow/core/browser';
import { exactDecimal } from '../format.ts';

export const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- Schwelle

/** Größte Schwelle wie die API (`limits.bigtrades.maxMinUsdt`, Standard 10⁹ USDT). */
export const MAX_MIN_USDT = 1_000_000_000;

/**
 * Wählbare Schwellen in ganzen USDT, logarithmisch: die Untergrenze des Symbols, dann die Stufen
 * 1-2-5 · 10^k über ihr bis `max`. Die API schlägt bei 422 `suggestMinUsdt` aus einer feineren Leiter
 * vor (22 Stufen je Dekade); ein solcher Wert erscheint über `stepsWith` als zusätzliche Stufe.
 */
export function thresholdSteps(floorUsdt: number, max = MAX_MIN_USDT): number[] {
  const out = [floorUsdt];
  for (let p = 1; p <= max * 10; p *= 10)
    for (const m of [1, 2, 5]) {
      const v = m * p;
      if (v > floorUsdt && v <= max) out.push(v);
    }
  return out;
}

/** Stufen-Leiter plus ein Wert, der nicht auf ihr liegt (z. B. aus der URL), aufsteigend. */
export function stepsWith(steps: readonly number[], v: number): number[] {
  return steps.includes(v) ? [...steps] : [...steps, v].sort((a, b) => a - b);
}

/** Nächsthöhere bzw. nächstniedrigere Stufe (am Rand die Randstufe). */
export function stepAfter(steps: readonly number[], v: number, dir: 1 | -1): number {
  if (dir > 0) return steps.find((s) => s > v) ?? steps[steps.length - 1] ?? v;
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]! < v) return steps[i]!;
  return steps[0] ?? v;
}

/**
 * Wirksame Schwelle: gewünschter Wert (URL oder gespeichert) als ganze USDT, nie unter der
 * Untergrenze und nie über max; ohne gültigen Wunsch die Untergrenze.
 */
export function resolveThreshold(
  raw: number | null | undefined,
  floorUsdt: number,
  max = MAX_MIN_USDT,
): number {
  if (raw === null || raw === undefined || !Number.isSafeInteger(raw) || raw <= 0) return floorUsdt;
  return Math.min(Math.max(raw, floorUsdt), Math.max(floorUsdt, max));
}

export interface BigTradesParams {
  /** Marker an (URL bt=1); Standard aus */
  on: boolean;
  /** Schwelle in ganzen USDT aus der URL (btmin) oder null */
  min: number | null;
}

/** URL: bt=1 (an), btmin=<ganze USDT>. Ungültiges → aus bzw. null. */
export function parseBigTradesParams(q: URLSearchParams): BigTradesParams {
  const raw = q.get('btmin');
  const min = raw !== null && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null;
  return { on: q.get('bt') === '1', min };
}

/**
 * Query-Teil (mit führendem &): bt=1 wenn an, dann immer auch btmin (ein geteilter Link zeigt dieselbe
 * Schwelle, auch wenn der Empfänger eine andere gespeichert hat); aus: btmin nur abweichend von der
 * Untergrenze.
 */
export function bigTradesParamsQuery(p: BigTradesParams, floorUsdt: number | null): string {
  let q = p.on ? '&bt=1' : '';
  if (p.min !== null && (p.on || p.min !== floorUsdt)) q += `&btmin=${p.min}`;
  return q;
}

/** Schlüssel der gespeicherten Schwelle je Symbol (localStorage). */
export const storageKey = (sym: string) => `ofb.bigtrades.min.${sym}`;

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Gespeicherte Schwelle des Symbols (ganze USDT) oder null (nichts/ungültig/kein Speicher). */
export function loadStoredMin(sym: string, store: KV | null = defaultStorage()): number | null {
  try {
    const v = store?.getItem(storageKey(sym)) ?? null;
    return v !== null && /^[1-9]\d{0,9}$/.test(v) ? Number(v) : null;
  } catch {
    return null;
  }
}

export function storeMin(sym: string, v: number, store: KV | null = defaultStorage()): void {
  try {
    store?.setItem(storageKey(sym), String(v));
  } catch {
    // privater Modus / voller Speicher: die URL trägt den Wert weiter
  }
}

// ---------------------------------------------------------------- Marker

export const R_MIN = 3;
export const R_MAX = 18;

/** Radius (CSS-px): r = clamp(3 · √(N / S), 3, 18), N = Notional der Order, S = Schwelle (§6.4). */
export function radiusPx(notional: number, thresholdN: number): number {
  const r = R_MIN * Math.sqrt(notional / thresholdN);
  return r < R_MIN ? R_MIN : r > R_MAX ? R_MAX : r;
}

/** Stufenfaktoren (Entscheidung 2026-11-26): 1× / 2,5× / 10× der gewählten Schwelle. */
export const TIER_FACTORS = [1, 2.5, 10] as const;
/** Deckkraft je Stufe (KONZEPT §6.4). */
export const TIER_ALPHA = [0.45, 0.7, 0.95] as const;

/**
 * Stufe 0/1/2 für N ≥ S, ≥ 2,5 S, ≥ 10 S. Exakt: N / S ist korrekt gerundet und monoton, 2,5 und 10
 * sind darstellbar – der Vergleich des Quotienten entscheidet wie der exakte Bruch.
 */
export function tierOf(notional: number, thresholdN: number): 0 | 1 | 2 {
  const q = notional / thresholdN;
  return q >= TIER_FACTORS[2] ? 2 : q >= TIER_FACTORS[1] ? 1 : 0;
}

/**
 * Ausdünnung je Pixelzelle: je (Spalte cellW px, Zeile cellH px, Seite) nur der Marker mit dem
 * größten Notional (bei Gleichstand der erste). Liefert die Indizes der behaltenen Marker in
 * Eingabereihenfolge. O(n) mit einer Map, kein DOM.
 */
export function decimateByCell(
  n: number,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  side: ArrayLike<number>,
  notional: ArrayLike<number>,
  cellW = 2,
  cellH = 6,
): number[] {
  // Zellbereich bestimmen: klein genug → Raster als Typed Array (schnell), sonst Map
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(x[i]! / cellW);
    const cy = Math.floor(y[i]! / cellH);
    if (cx < x0) x0 = cx;
    if (cx > x1) x1 = cx;
    if (cy < y0) y0 = cy;
    if (cy > y1) y1 = cy;
  }
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  if (n > 0 && Number.isFinite(cols * rows) && cols * rows * 2 <= 4_000_000) {
    const best = new Int32Array(cols * rows * 2).fill(-1);
    for (let i = 0; i < n; i++) {
      const c =
        ((Math.floor(y[i]! / cellH) - y0) * cols + (Math.floor(x[i]! / cellW) - x0)) * 2 +
        (side[i] === 1 ? 0 : 1);
      const j = best[c]!;
      if (j < 0 || notional[i]! > notional[j]!) best[c] = i;
    }
    const out: number[] = [];
    for (const j of best) if (j >= 0) out.push(j);
    return out.sort((a, b) => a - b);
  }
  const best = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(x[i]! / cellW);
    const cy = Math.floor(y[i]! / cellH);
    // eindeutiger Schlüssel; Koordinaten weit außerhalb (±2^20 Zellen) gibt es auf keiner Pane
    const key = ((cx + 1_048_576) * 2_097_152 + (cy + 1_048_576)) * 2 + (side[i] === 1 ? 0 : 1);
    const j = best.get(key);
    if (j === undefined || notional[i]! > notional[j]!) best.set(key, i);
  }
  return [...best.values()].sort((a, b) => a - b);
}

/** Spielraum der Trefferprüfung über den Radius (px). */
export const HIT_SLACK = 2;

/** Eimerraster für die Trefferprüfung (CSS-px): jeder Kreis in allen Zellen seiner Hülle. */
export class HitGrid {
  readonly cell: number;
  private readonly cells = new Map<number, number[]>();
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly rs: number[] = [];
  readonly ids: number[] = [];

  constructor(cell = 32) {
    this.cell = cell;
  }

  get size(): number {
    return this.ids.length;
  }

  clear(): void {
    this.cells.clear();
    this.xs.length = 0;
    this.ys.length = 0;
    this.rs.length = 0;
    this.ids.length = 0;
  }

  private static key(cx: number, cy: number): number {
    return (cx + 65_536) * 131_072 + (cy + 65_536);
  }

  add(id: number, x: number, y: number, r: number): void {
    const k = this.ids.length;
    this.ids.push(id);
    this.xs.push(x);
    this.ys.push(y);
    this.rs.push(r);
    const c = this.cell;
    const R = r + HIT_SLACK; // Zellen inkl. Spielraum der Abfrage
    for (let cx = Math.floor((x - R) / c); cx <= Math.floor((x + R) / c); cx++)
      for (let cy = Math.floor((y - R) / c); cy <= Math.floor((y + R) / c); cy++) {
        const key = HitGrid.key(cx, cy);
        const l = this.cells.get(key);
        if (l) l.push(k);
        else this.cells.set(key, [k]);
      }
  }

  /**
   * Marker unter (x, y) mit `slack` px Spielraum über den Radius: der mit dem nächsten Mittelpunkt,
   * bei Gleichstand der zuletzt gezeichnete (oben liegende). id oder null.
   */
  query(x: number, y: number, slack = HIT_SLACK): number | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const l = this.cells.get(HitGrid.key(Math.floor(x / this.cell), Math.floor(y / this.cell)));
    if (!l) return null;
    let best = -1;
    let bestD = Infinity;
    for (const k of l) {
      const d = Math.hypot(x - this.xs[k]!, y - this.ys[k]!);
      if (d <= this.rs[k]! + slack && d <= bestD) {
        best = k;
        bestD = d;
      }
    }
    return best < 0 ? null : this.ids[best]!;
  }
}

// ---------------------------------------------------------------- Abdeckung

/**
 * none/partial aus der Abdeckung; pending = Live-Rand (noch nicht geschrieben, neutral: weder Band
 * noch Warnung, nur im Hover); toomany/failed = Abschnitt nicht geladen (422 bzw. Fehler).
 */
export type BandKind = 'none' | 'partial' | 'pending' | 'toomany' | 'failed';

export interface Band {
  /** [from, to) in ms UTC */
  from: number;
  to: number;
  kind: BandKind;
  /** none: Gründe; partial: höchste Tagesuntergrenze (Notional) */
  reasons: string[];
  floorN: number | null;
}

/** Status einer Spanne für die wirksame Schwelle minN (partial wird ok, sobald minN ≥ floorN). */
export function effectiveStatus(c: CoverageSpan, minN: number): 'ok' | 'partial' | 'none' {
  if (c.status === 'none') return 'none';
  return c.floorN !== null && c.floorN > minN ? 'partial' : 'ok';
}

/**
 * Abdeckung (aufsteigend, je geladenem Abschnitt) → Bänder für none/partial/pending bei der wirksamen
 * Schwelle; angrenzende gleiche Bänder (gleiche Art, bei partial gleiche Untergrenze) zusammengefasst.
 */
export function coverageBands(spans: readonly CoverageSpan[], minN: number): Band[] {
  const out: Band[] = [];
  for (const c of spans) {
    const st = effectiveStatus(c, minN);
    if (st === 'ok') continue;
    const kind: BandKind = st === 'none' && c.reason === 'pending' ? 'pending' : st;
    const floorN = st === 'partial' ? c.floorN : null;
    const reasons = kind === 'none' && c.reason ? [c.reason] : [];
    const last = out[out.length - 1];
    if (
      last &&
      last.to === c.from &&
      last.kind === kind &&
      last.floorN === floorN &&
      sameReasons(last.reasons, reasons)
    ) {
      last.to = c.to;
    } else {
      out.push({
        from: c.from,
        to: c.to,
        kind,
        reasons,
        floorN,
      });
    }
  }
  return out;
}

/** Gleiche Gründe (Reihenfolge egal)? Nur dann werden Bänder verbunden – Gründe bleiben je Zeit genau. */
function sameReasons(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((r) => b.includes(r));
}

/** Bänder zusammenführen (aufsteigend nach from), angrenzende gleiche verbinden. */
export function mergeBands(bands: readonly Band[]): Band[] {
  const s = [...bands].sort((a, b) => a.from - b.from);
  const out: Band[] = [];
  for (const b of s) {
    const last = out[out.length - 1];
    if (
      last &&
      last.to >= b.from &&
      last.kind === b.kind &&
      last.floorN === b.floorN &&
      sameReasons(last.reasons, b.reasons)
    )
      last.to = Math.max(last.to, b.to);
    else out.push({ ...b, reasons: [...b.reasons] });
  }
  return out;
}

/** Bar mit kurzen Lücken: dünne Markierung statt Fläche. */
export interface BarTick {
  /** Beginn des Bars (ms) */
  bar: number;
  kind: BandKind;
  /** fehlende Zeit im Bar (ms) */
  ms: number;
}

/** Anteil eines Bars ohne Daten, ab dem er ganz als Fläche (Band) gezeichnet wird. */
export const FULL_BAR_SHARE = 0.5;

/**
 * Minutengenaue Bänder → Darstellung je Bar: ein Bar, der überwiegend (≥ fullShare seiner Datenzeit
 * in [dataFrom, dataTo)) ohne Daten ist, gehört zu einer Fläche (an Bar-Grenzen); ein Bar mit kurzen
 * Lücken bekommt nur eine dünne Markierung (Tick), damit eine fehlende Minute nicht wie ein fehlender Tag
 * aussieht. Nichts Fehlendes entfällt: jeder Bar mit einer Lücke ist Fläche oder Tick. pending (Live-Rand)
 * bleibt neutral und erscheint hier nicht.
 */
export function barSegments(
  bands: readonly Band[],
  tfMs: number,
  dataFrom: number,
  dataTo: number,
  fullShare = FULL_BAR_SHARE,
): { full: Band[]; ticks: BarTick[] } {
  const full: Band[] = [];
  const edge = new Map<number, { ms: Map<BandKind, number>; band: Map<BandKind, Band> }>();
  const addEdge = (bar: number, b: Band, ms: number) => {
    let e = edge.get(bar);
    if (!e) edge.set(bar, (e = { ms: new Map(), band: new Map() }));
    e.ms.set(b.kind, (e.ms.get(b.kind) ?? 0) + ms);
    if (!e.band.has(b.kind)) e.band.set(b.kind, b);
  };
  for (const b of bands) {
    if (b.kind === 'pending' || b.to <= b.from) continue;
    const fb = Math.floor(b.from / tfMs) * tfMs;
    const lb = Math.floor((b.to - 1) / tfMs) * tfMs;
    if (fb === lb) {
      addEdge(fb, b, b.to - b.from);
      continue;
    }
    let a = fb;
    if (b.from > fb) {
      addEdge(fb, b, fb + tfMs - b.from);
      a = fb + tfMs;
    }
    let z = lb + tfMs;
    if (b.to < z) {
      addEdge(lb, b, b.to - lb);
      z = lb;
    }
    if (z > a) full.push({ ...b, reasons: [...b.reasons], from: a, to: z });
  }
  const ticks: BarTick[] = [];
  for (const [bar, e] of edge) {
    const denom = Math.min(bar + tfMs, dataTo) - Math.max(bar, dataFrom);
    let total = 0;
    let kind: BandKind = 'none';
    let best = -1;
    for (const [k, ms] of e.ms) {
      total += ms;
      if (ms > best) {
        best = ms;
        kind = k;
      }
    }
    if (denom > 0 && total >= fullShare * denom) {
      const b = e.band.get(kind)!;
      full.push({ ...b, reasons: [...b.reasons], from: bar, to: bar + tfMs });
    } else ticks.push({ bar, kind, ms: total });
  }
  ticks.sort((x, y) => x.bar - y.bar);
  return { full: mergeBands(full), ticks };
}

export interface CoverageSummary {
  /** UTC-Tage, die den sichtbaren Bereich schneiden */
  visibleDays: number;
  /** Tage (im sichtbaren Teil) ganz ohne Order-Daten, und Tage mit Lücken samt Lückenzeit (ms) */
  noneDays: number;
  noneReasons: string[];
  holeDays: number;
  holeMs: number;
  holeReasons: string[];
  /** Tage mit partial-Abschnitten, höchste Untergrenze (Notional) */
  partialDays: number;
  partialFloorN: number | null;
  /** Tage mit nicht geladenen Abschnitten (422 bzw. Fehler) */
  toomanyDays: number;
  failedDays: number;
  /** sichtbare Zeit (ms) je Bandart bzw. insgesamt („ganz" vs. „in Teilen") */
  ms: Record<BandKind, number>;
  visibleMs: number;
}

/**
 * Abdeckung im sichtbaren Bereich [visFrom, visTo) (ms) je UTC-Tag: ein Tag, dessen sichtbarer Teil
 * ganz ohne Daten ist, zählt als „ohne Daten"; sonst zählen seine fehlenden Minuten als Lücken.
 * pending (Live-Rand) zählt nicht.
 */
export function coverageSummary(
  bands: readonly Band[],
  visFrom: number,
  visTo: number,
): CoverageSummary {
  const day = (t: number) => Math.floor(t / DAY_MS);
  const sets: Record<BandKind, Set<number>> = {
    none: new Set(),
    partial: new Set(),
    pending: new Set(),
    toomany: new Set(),
    failed: new Set(),
  };
  const noneMs = new Map<number, number>();
  const noneR = new Map<number, Set<string>>();
  let partialFloorN: number | null = null;
  const ms: Record<BandKind, number> = { none: 0, partial: 0, pending: 0, toomany: 0, failed: 0 };
  for (const b of bands) {
    const a = Math.max(b.from, visFrom);
    const e = Math.min(b.to, visTo);
    if (e <= a) continue;
    ms[b.kind] += e - a;
    for (let d = day(a); d <= day(e - 1); d++) {
      sets[b.kind].add(d);
      if (b.kind !== 'none') continue;
      const o = Math.min(e, (d + 1) * DAY_MS) - Math.max(a, d * DAY_MS);
      noneMs.set(d, (noneMs.get(d) ?? 0) + o);
      let r = noneR.get(d);
      if (!r) noneR.set(d, (r = new Set()));
      for (const x of b.reasons) r.add(x);
    }
    if (b.kind === 'partial' && b.floorN !== null)
      partialFloorN = Math.max(partialFloorN ?? 0, b.floorN);
  }
  let noneDays = 0;
  let holeDays = 0;
  let holeMs = 0;
  const noneReasons: string[] = [];
  const holeReasons: string[] = [];
  const add = (l: string[], r: Iterable<string>) => {
    for (const x of r) if (!l.includes(x)) l.push(x);
  };
  for (const [d, m] of noneMs) {
    const len = Math.min(visTo, (d + 1) * DAY_MS) - Math.max(visFrom, d * DAY_MS);
    if (m >= len) {
      noneDays++;
      add(noneReasons, noneR.get(d) ?? []);
    } else {
      holeDays++;
      holeMs += m;
      add(holeReasons, noneR.get(d) ?? []);
    }
  }
  return {
    visibleDays: visTo > visFrom ? day(visTo - 1) - day(visFrom) + 1 : 0,
    noneDays,
    noneReasons,
    holeDays,
    holeMs,
    holeReasons,
    partialDays: sets.partial.size,
    partialFloorN,
    toomanyDays: sets.toomany.size,
    failedDays: sets.failed.size,
    ms,
    visibleMs: Math.max(0, visTo - visFrom),
  };
}

// Gründe aus docs/BIGTRADES-API.md; unbekannte (künftige) Gründe nimmt der Decoder bei `none` an –
// sie zählen als „keine Daten" und erscheinen mit ihrem Kürzel.
const REASON_TEXT: Readonly<Record<string, string>> = {
  digest_v1: 'Neuimport ausstehend',
  no_day: 'keine gespeicherten Daten',
  no_floor: 'ohne Untergrenze geschrieben',
  unknown_totals: 'laufender Tag noch nicht bestätigt',
  floor_above: 'höhere Untergrenze',
  not_recorded: 'vor Beginn der Aufzeichnung',
  pending: 'noch nicht geschrieben',
  gap: 'Lücke der Aufzeichnung',
  source_missing: 'Minuten ohne Quelldaten',
  mismatch: 'Abweichung zur Kline',
  too_many_holes: 'zu viele Lückenminuten am Tag',
};

export function reasonText(r: CoverageReason | string): string {
  return REASON_TEXT[r] ?? `anderer Grund (${r})`;
}

const days = (n: number) => `${n} ${n === 1 ? 'Tag' : 'Tage'}`;
const minutes = (ms: number) => `${Math.ceil(ms / 60_000)} min`;
const why = (r: readonly string[]) => (r.length ? ` (${r.map(reasonText).join(', ')})` : '');

/** Legenden-Hinweis zur Abdeckung ('' = alles sichtbare abgedeckt; der Live-Rand zählt nicht). */
export function coverageNote(s: CoverageSummary, notionalDecimals: number): string {
  const parts: string[] = [];
  const where = (k: BandKind, n: number, pre = 'in') =>
    s.ms[k] >= s.visibleMs
      ? 'im sichtbaren Bereich'
      : n >= s.visibleDays
        ? 'in Teilen des sichtbaren Bereichs'
        : `${pre} ${n} von ${s.visibleDays} Tagen`;
  if (s.noneDays > 0)
    parts.push(
      s.noneDays >= s.visibleDays
        ? `keine Big-Trade-Daten im sichtbaren Bereich${why(s.noneReasons)}`
        : `${days(s.noneDays)} ohne Big-Trade-Daten${why(s.noneReasons)}`,
    );
  if (s.holeDays > 0)
    parts.push(
      s.visibleDays === 1
        ? `Lücken: ${minutes(s.holeMs)} ohne Big-Trade-Daten${why(s.holeReasons)}`
        : `${days(s.holeDays)} mit Lücken (${minutes(s.holeMs)} ohne Big-Trade-Daten${s.holeReasons.length ? `: ${s.holeReasons.map(reasonText).join(', ')}` : ''})`,
    );
  if (s.partialDays > 0) {
    const floor = fmtUsdtCompact(Math.ceil((s.partialFloorN ?? 0) / 10 ** notionalDecimals), true);
    parts.push(`${where('partial', s.partialDays, 'an')} Big Trades erst ab ${floor} gespeichert`);
  }
  if (s.toomanyDays > 0)
    parts.push(`zu viele Orders ${where('toomany', s.toomanyDays)} – nicht geladen`);
  if (s.failedDays > 0) parts.push(`nicht ladbar ${where('failed', s.failedDays)}`);
  return parts.join(' · ');
}

/**
 * Hover-Zusatz für einen Bar [barMs, barMs + tfMs): fehlende Zeit je Art mit Gründen ('' = abgedeckt).
 * Bänder aufsteigend und überschneidungsfrei.
 */
export function barCoverageText(
  bands: readonly Band[],
  barMs: number,
  tfMs: number,
  notionalDecimals: number,
): string {
  const end = barMs + tfMs;
  const acc = new Map<BandKind, { ms: number; reasons: string[]; floorN: number }>();
  for (const b of bands) {
    if (b.to <= barMs) continue;
    if (b.from >= end) break;
    const o = Math.min(b.to, end) - Math.max(b.from, barMs);
    const a = acc.get(b.kind) ?? { ms: 0, reasons: [], floorN: 0 };
    a.ms += o;
    for (const r of b.reasons) if (!a.reasons.includes(r)) a.reasons.push(r);
    a.floorN = Math.max(a.floorN, b.floorN ?? 0);
    acc.set(b.kind, a);
  }
  const out: string[] = [];
  const whole = (ms: number) => ms >= tfMs;
  for (const [k, a] of acc) {
    const t = whole(a.ms) ? 'im ganzen Bar' : minutes(a.ms);
    if (k === 'none') out.push(`${t} ohne Daten${why(a.reasons)}`);
    else if (k === 'pending') out.push(`${t} noch nicht geschrieben`);
    else if (k === 'partial')
      out.push(
        `${t} erst ab ${fmtUsdtCompact(Math.ceil(a.floorN / 10 ** notionalDecimals), true)} gespeichert`,
      );
    else if (k === 'toomany') out.push(`${t} nicht geladen (zu viele Orders)`);
    else out.push(`${t} nicht ladbar`);
  }
  return out.length ? `Big Trades: ${out.join(', ')}` : '';
}

/**
 * Ausdünnung mit Obergrenze: je (2 px, 6 px, Seite) der größte Marker; bleiben mehr als `max`, Zellen
 * verdoppeln, bis es passt (große Spannen: Kreise überlappen dort ohnehin). Mit bekannter Fläche W × H
 * beginnt die Suche bei der Zellgröße, deren Zellzahl `max` nicht weit übersteigt (spart Durchläufe).
 */
export function decimateAdaptive(
  n: number,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  side: ArrayLike<number>,
  notional: ArrayLike<number>,
  max = 4000,
  W = 0,
  H = 0,
): { keep: number[]; cellW: number; cellH: number } {
  let cw = 2;
  let ch = 6;
  // nur bei sehr vielen Markern grob beginnen (sonst die feinste Zelle, die passt)
  if (n > 4 * max && W > 0 && H > 0)
    while ((W / cw) * (H / ch) * 2 > 4 * max && cw < 256) {
      cw *= 2;
      ch *= 2;
    }
  for (;;) {
    const keep = decimateByCell(n, x, y, side, notional, cw, ch);
    if (keep.length <= max || cw >= 256) return { keep, cellW: cw, cellH: ch };
    cw *= 2;
    ch *= 2;
  }
}

// ---------------------------------------------------------------- Texte (exakt, ohne Gleitkomma)

const nf = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });

/**
 * Kurzform einer Schwelle in USDT: „500 k $", „1 Mio. $", „2,5 Mio. $", „1 Mrd. $". exact: verlöre die
 * Kurzform Stellen (z. B. 1 234 567), stattdessen der volle Wert („1 234 567 $").
 */
export function fmtUsdtCompact(usdt: number, exact = false): string {
  const [u, name] =
    usdt >= 1e9
      ? [1e9, 'Mrd. ']
      : usdt >= 1e6
        ? [1e6, 'Mio. ']
        : usdt >= 1e3
          ? [1e3, 'k ']
          : [1, ''];
  if (exact && Math.round((usdt / u) * 100) * (u / 100) !== usdt)
    return `${groupThousands(String(usdt))} $`;
  return `${nf.format(usdt / u)} ${name}$`.replace('  ', ' ');
}

/** Ganzzahl mit schmalen Leerzeichen als Tausendertrennung: 1234567 → „1 234 567". */
export function groupThousands(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Notional (price_unit·qty_unit, ganzzahlig) auf ganze USDT gerundet (half-up), gruppiert. */
export function fmtNotionalUsdt(notional: number, notionalDecimals: number): string {
  const p = 10n ** BigInt(notionalDecimals);
  const v = (BigInt(notional) * 2n + p) / (2n * p);
  return `${groupThousands(v.toString())} USDT`;
}

/** Kurzlabel am Marker: „2,4 M", „850 k". */
export function fmtNotionalShort(notional: number, notionalDecimals: number): string {
  const usdt = notional / 10 ** notionalDecimals;
  // erst runden, dann die Einheit wählen (999 960 → „1 M", nicht „1000 k")
  if (Math.round(usdt / 1e8) >= 10) return `${nf.format(Math.round(usdt / 1e8) / 10)} Mrd`;
  if (Math.round(usdt / 1e5) >= 10) return `${nf.format(Math.round(usdt / 1e5) / 10)} M`;
  return `${Math.round(usdt / 1e3)} k`;
}

/**
 * VWAP = notional / qty (price_unit, ein Bruch) als Preis mit priceDecimals + 1 Nachkommastellen,
 * half-up gerundet, exakt mit BigInt.
 */
export function fmtVwap(notional: number, qty: number, priceDecimals: number): string {
  const v = (BigInt(notional) * 20n + BigInt(qty)) / (2n * BigInt(qty));
  return exactDecimal(Number(v), priceDecimals + 1);
}

/** VWAP als Zahl (Preis) für die Position auf der Preisachse. */
export function vwapPrice(notional: number, qty: number, priceDecimals: number): number {
  return notional / qty / 10 ** priceDecimals;
}

// ---------------------------------------------------------------- Abschnitte (wie /bars)

/**
 * Benötigte Abschnitte (Index wie die Bar-Abschnitte, `span` s je Abschnitt) für den sichtbaren
 * Bereich [fromSec, toSec], begrenzt auf den Datenbereich; sichtbare zuerst (Mitte nach außen),
 * dann `pad` je Seite. Höchstens `max` Abschnitte.
 */
export function wantedChunks(
  fromSec: number,
  toSec: number,
  span: number,
  dataFromSec: number,
  dataToSec: number,
  pad = 1,
  max = 24,
): { c: number; priority: number }[] {
  if (dataToSec <= dataFromSec || toSec < fromSec) return [];
  const cMin = Math.floor(dataFromSec / span);
  const cMax = Math.floor((dataToSec - 1) / span);
  const a = Math.max(Math.floor(fromSec / span), cMin);
  const b = Math.min(Math.floor(toSec / span), cMax);
  if (a > b) return [];
  const mid = (a + b) / 2;
  const vis: number[] = [];
  for (let c = a; c <= b; c++) vis.push(c);
  vis.sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid) || x - y);
  const out = vis.slice(0, max).map((c) => ({ c, priority: 0 }));
  for (let k = 1; k <= pad && out.length < max; k++) {
    if (a - k >= cMin) out.push({ c: a - k, priority: k });
    if (b + k <= cMax && out.length < max) out.push({ c: b + k, priority: k });
  }
  return out;
}
