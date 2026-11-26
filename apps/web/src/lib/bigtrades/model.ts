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
 * 1-2-5 · 10^k über ihr (dieselbe Leiter wie `suggestMinUsdt` der API, damit ein Vorschlag immer eine
 * Stufe ist) bis `max`.
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

/** Query-Teil (mit führendem &): bt=1 wenn an; btmin, wenn die Schwelle nicht die Untergrenze ist. */
export function bigTradesParamsQuery(p: BigTradesParams, floorUsdt: number | null): string {
  let q = p.on ? '&bt=1' : '';
  if (p.min !== null && p.min !== floorUsdt) q += `&btmin=${p.min}`;
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

export type BandKind = 'none' | 'partial' | 'toomany' | 'failed';

export interface Band {
  /** [from, to) in ms UTC */
  from: number;
  to: number;
  kind: BandKind;
  /** none: Gründe; partial: höchste Tagesuntergrenze (Notional) */
  reasons: CoverageReason[];
  floorN: number | null;
}

/** Status einer Spanne für die wirksame Schwelle minN (partial wird ok, sobald minN ≥ floorN). */
export function effectiveStatus(c: CoverageSpan, minN: number): 'ok' | 'partial' | 'none' {
  if (c.status === 'none') return 'none';
  return c.floorN !== null && c.floorN > minN ? 'partial' : 'ok';
}

/**
 * Abdeckung (aufsteigend, je geladenem Abschnitt) → Bänder für none/partial bei der wirksamen
 * Schwelle; angrenzende gleiche Bänder (gleiche Art, bei partial gleiche Untergrenze) zusammengefasst.
 */
export function coverageBands(spans: readonly CoverageSpan[], minN: number): Band[] {
  const out: Band[] = [];
  for (const c of spans) {
    const st = effectiveStatus(c, minN);
    if (st === 'ok') continue;
    const floorN = st === 'partial' ? c.floorN : null;
    const last = out[out.length - 1];
    if (last && last.to === c.from && last.kind === st && last.floorN === floorN) {
      last.to = c.to;
      if (c.reason && st === 'none' && !last.reasons.includes(c.reason))
        last.reasons.push(c.reason);
    } else {
      out.push({
        from: c.from,
        to: c.to,
        kind: st,
        reasons: st === 'none' && c.reason ? [c.reason] : [],
        floorN,
      });
    }
  }
  return out;
}

/** Bänder zusammenführen (aufsteigend nach from), angrenzende gleiche verbinden. */
export function mergeBands(bands: readonly Band[]): Band[] {
  const s = [...bands].sort((a, b) => a.from - b.from);
  const out: Band[] = [];
  for (const b of s) {
    const last = out[out.length - 1];
    if (last && last.to >= b.from && last.kind === b.kind && last.floorN === b.floorN) {
      last.to = Math.max(last.to, b.to);
      for (const r of b.reasons) if (!last.reasons.includes(r)) last.reasons.push(r);
    } else out.push({ ...b, reasons: [...b.reasons] });
  }
  return out;
}

export interface CoverageSummary {
  /** UTC-Tage, die den sichtbaren Bereich schneiden */
  visibleDays: number;
  /** davon mit Abschnitten ohne Order-Daten (none) bzw. nur ab höherer Untergrenze (partial) */
  noneDays: number;
  partialDays: number;
  /** Tage mit zu vielen Orders (422) bzw. nicht ladbar */
  toomanyDays: number;
  failedDays: number;
  /** none-Gründe im sichtbaren Bereich */
  reasons: CoverageReason[];
  /** höchste Untergrenze der partial-Tage (Notional) */
  partialFloorN: number | null;
  /** sichtbare Zeit (ms) je Bandart bzw. insgesamt: „ganz" vs. „in Teilen" */
  ms: Record<BandKind, number>;
  visibleMs: number;
}

/** Wie viele UTC-Tage im sichtbaren Bereich [visFrom, visTo) (ms) welche Bandart haben. */
export function coverageSummary(
  bands: readonly Band[],
  visFrom: number,
  visTo: number,
): CoverageSummary {
  const day = (t: number) => Math.floor(t / DAY_MS);
  const sets: Record<BandKind, Set<number>> = {
    none: new Set(),
    partial: new Set(),
    toomany: new Set(),
    failed: new Set(),
  };
  const reasons: CoverageReason[] = [];
  let partialFloorN: number | null = null;
  const ms: Record<BandKind, number> = { none: 0, partial: 0, toomany: 0, failed: 0 };
  for (const b of bands) {
    const a = Math.max(b.from, visFrom);
    const e = Math.min(b.to, visTo);
    if (e <= a) continue;
    for (let d = day(a); d <= day(e - 1); d++) sets[b.kind].add(d);
    ms[b.kind] += e - a;
    if (b.kind === 'none') for (const r of b.reasons) if (!reasons.includes(r)) reasons.push(r);
    if (b.kind === 'partial' && b.floorN !== null)
      partialFloorN = Math.max(partialFloorN ?? 0, b.floorN);
  }
  return {
    visibleDays: visTo > visFrom ? day(visTo - 1) - day(visFrom) + 1 : 0,
    noneDays: sets.none.size,
    partialDays: sets.partial.size,
    toomanyDays: sets.toomany.size,
    failedDays: sets.failed.size,
    reasons,
    partialFloorN,
    ms,
    visibleMs: Math.max(0, visTo - visFrom),
  };
}

// Gründe aus docs/BIGTRADES-API.md; unbekannte (künftige) Gründe nimmt der Decoder bei `none` an –
// sie erscheinen roh, die Spanne zählt trotzdem als „keine Daten".
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
};

export function reasonText(r: CoverageReason | string): string {
  return REASON_TEXT[r] ?? r;
}

/** Legenden-Hinweis zur Abdeckung ('' = alles sichtbare abgedeckt). */
export function coverageNote(s: CoverageSummary, notionalDecimals: number): string {
  const parts: string[] = [];
  // ganz (Zeitanteil) → „im sichtbaren Bereich"; sonst Tage mit Anteil, bei allen Tagen „in Teilen"
  const where = (k: BandKind, n: number, pre = 'in') =>
    s.ms[k] >= s.visibleMs
      ? 'im sichtbaren Bereich'
      : n >= s.visibleDays
        ? 'in Teilen des sichtbaren Bereichs'
        : `${pre} ${n} von ${s.visibleDays} Tagen`;
  const of = (n: number, k: BandKind = 'none') => where(k, n);
  if (s.noneDays > 0)
    parts.push(
      `keine Big-Trade-Daten ${of(s.noneDays)}${s.reasons.length ? ` (${s.reasons.map(reasonText).join(', ')})` : ''}`,
    );
  if (s.partialDays > 0) {
    const floor = fmtUsdtCompact(Math.ceil((s.partialFloorN ?? 0) / 10 ** notionalDecimals), true);
    parts.push(`${where('partial', s.partialDays, 'an')} Big Trades erst ab ${floor} gespeichert`);
  }
  if (s.toomanyDays > 0)
    parts.push(`zu viele Orders ${of(s.toomanyDays, 'toomany')} – nicht geladen`);
  if (s.failedDays > 0) parts.push(`nicht ladbar ${of(s.failedDays, 'failed')}`);
  return parts.join(' · ');
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
