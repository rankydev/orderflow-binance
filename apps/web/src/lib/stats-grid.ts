// Stats-Grid unter dem Chart (KONZEPT §6.2, Phase P4): eine Zeile je Kennzahl, eine Spalte je Bar, an den
// Bars ausgerichtet. Umsetzung als Custom Series in einer zweiten Pane von lightweight-charts: die
// Bibliothek liefert je Frame die x-Position jedes sichtbaren Bars, Pannen/Zoomen bleibt dadurch exakt
// synchron, gezeichnet wird im Zeichenzyklus der Bibliothek (kein DOM-Tabellengitter, nichts je
// Mausbewegung). Die Werte je Bar entstehen einmal je Datenfenster (Typed Arrays, nicht reaktiv); je Frame
// werden nur Mittelwert/Streuung der sichtbaren Bars (Schattierung) und Texte gebildet.
import {
  customSeriesDefaultOptions,
  type CustomData,
  type CustomSeriesOptions,
  type CustomSeriesPricePlotValues,
  type CustomSeriesWhitespaceData,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type PaneRendererCustomData,
  type Time,
} from 'lightweight-charts';
import type { BarItem } from './types.ts';

type Target = Parameters<ICustomSeriesPaneRenderer['draw']>[0];
type Scope = Parameters<Parameters<Target['useBitmapCoordinateSpace']>[0]>[0];

export type StatRow =
  | 'vol'
  | 'buy'
  | 'sell'
  | 'delta'
  | 'deltaPct'
  | 'cvd'
  | 'aggN'
  | 'aggDelta'
  | 'volSec'
  | 'hiRatio'
  | 'loRatio'
  | 'trades'
  | 'maxDelta'
  | 'minDelta'
  | 'cotHigh'
  | 'cotLow';

type Unit = 'qty' | 'pct' | 'count' | 'ratio' | 'qtyPerSec';

export interface StatRowDef {
  id: StatRow;
  label: string;
  unit: Unit;
  /** Vorzeichen trägt Bedeutung (grün/rot) */
  signed: boolean;
  /** Zusatzspalte der Bar-Kachel, ohne die die Zeile nicht berechnet werden kann (API-Erweiterung) */
  column?: string;
  title: string;
}

/**
 * Zeilen (Reihenfolge = Anzeige). Ohne `column` aus den heutigen Bar-Spalten (buyQ, sellQ, buyA, sellA)
 * bzw. aus den Footprint-Leveln (High/Low Ratio); mit `column` erst, wenn /bars die `x.`-Spalte liefert –
 * bis dahin „API fehlt", nie geschätzt.
 */
export const STAT_ROWS: readonly StatRowDef[] = [
  { id: 'vol', label: 'Volume', unit: 'qty', signed: false, title: 'b + s' },
  { id: 'buy', label: 'Ask', unit: 'qty', signed: false, title: 'Käufer-Aggressor b' },
  { id: 'sell', label: 'Bid', unit: 'qty', signed: false, title: 'Verkäufer-Aggressor s' },
  { id: 'delta', label: 'Delta', unit: 'qty', signed: true, title: 'b − s' },
  { id: 'deltaPct', label: 'Delta %', unit: 'pct', signed: true, title: '(b − s) / (b + s)' },
  {
    id: 'cvd',
    label: 'CVD Tag',
    unit: 'qty',
    signed: true,
    title: 'Σ Delta seit Tagesbeginn (UTC + offsetH)',
  },
  { id: 'aggN', label: 'aggTrades', unit: 'count', signed: false, title: 'Anzahl aggTrades' },
  { id: 'aggDelta', label: 'aggT-Δ', unit: 'count', signed: true, title: 'buy_a − sell_a' },
  { id: 'volSec', label: 'Vol/s', unit: 'qtyPerSec', signed: false, title: 'Volumen / Bar-Dauer' },
  {
    id: 'hiRatio',
    label: 'High Ratio',
    unit: 'ratio',
    signed: false,
    title: 'b(oberste−1) / b(oberste), Footprint-Zeilen',
  },
  {
    id: 'loRatio',
    label: 'Low Ratio',
    unit: 'ratio',
    signed: false,
    title: 's(unterste+1) / s(unterste), Footprint-Zeilen',
  },
  {
    id: 'trades',
    label: 'Trades Bin.',
    unit: 'count',
    signed: false,
    column: 'x.trades',
    title:
      'Binance-Trade-Anzahl (Σ Kline-Trades der Minuten), nicht die aggTrades-Zahl; an Tagen mit Lücken in den Binance-Daten kann sie größer sein als die Summe der 1m-Bars',
  },
  {
    id: 'maxDelta',
    label: 'Max Δ',
    unit: 'qty',
    signed: true,
    column: 'x.maxDelta',
    title: 'Maximum des laufenden Deltas (§3.5)',
  },
  {
    id: 'minDelta',
    label: 'Min Δ',
    unit: 'qty',
    signed: true,
    column: 'x.minDelta',
    title: 'Minimum des laufenden Deltas (§3.5)',
  },
  {
    id: 'cotHigh',
    label: 'COT High',
    unit: 'qty',
    signed: true,
    column: 'x.cotHigh',
    title: 'Delta seit Bildung des Lows (§3.5)',
  },
  {
    id: 'cotLow',
    label: 'COT Low',
    unit: 'qty',
    signed: true,
    column: 'x.cotLow',
    title: 'Delta seit Bildung des Highs (§3.5)',
  },
];

/** Standard: Volume, Delta, Delta %, CVD (ruhig; weitere Zeilen per Schalter). */
export const STATS_DEFAULT_ROWS: readonly StatRow[] = ['vol', 'delta', 'deltaPct', 'cvd'];

/** Detailstufe (§6.2): Text ab bs ≥ 30 px, darunter nur Schattierung, unter 4 px ausgeblendet. */
export const STATS_TEXT_MIN_BS = 30;
export const STATS_SHADE_MIN_BS = 4;
export const STATS_ROW_PX = 16;
export const STATS_LABEL_PX = 112;
/** Freiraum unter der letzten Zeile: dort sitzt das Logo der Bibliothek (Attribution, H-5). */
export const STATS_BOTTOM_PX = 30;

export interface StatsInput {
  offsetH: number;
  tfSec: number;
  /** Datenende (ms, exklusiv): Dauer des letzten, noch laufenden Bars */
  dataTo: number;
  /** Beginn des Datenfensters (s): CVD nur, wenn der Tagesbeginn im Fenster liegt */
  windowStartSec: number;
  /** Bar-Abschnitte im Fenster ohne Daten (Lücken, markEmpty) als [von, bis) in s */
  gaps?: readonly [number, number][];
}

/** F-1: Tages-CVD nur, wenn die Tagesgrenze (UTC + offsetH) auf einer Bar-Grenze liegt. */
export const CVD_UNALIGNED_NOTE = 'CVD: Tagesgrenze liegt nicht auf der Bar-Grenze';

export function cvdAligned(offsetH: number, tfSec: number): boolean {
  return (((offsetH * 3600) % tfSec) + tfSec) % tfSec === 0;
}

/** Spalten je Zeile, Index = Item-Index des Fensters; NaN = nicht berechenbar („–"). */
export type StatsColumns = Partial<Record<StatRow, Float64Array>>;

/**
 * Werte je Bar aus den Items des Fensters (einmal je Fensterwechsel). Mengen in Lots, Delta % in Prozent,
 * Vol/s in Lots je Sekunde. CVD setzt an jeder Tagesgrenze (UTC + offsetH) zurück und ist NaN
 *  - solange der Tagesbeginn vor dem Fenster liegt (sonst fehlte der Anfang des Tages),
 *  - ab einer Lücke (Abschnitt ohne Daten) bis zur nächsten Tagesgrenze (F-2),
 *  - immer, wenn die Tagesgrenze nicht auf einer Bar-Grenze liegt (F-1; dann fehlt die Spalte ganz).
 * Minuten ohne Trades fehlen in den Daten der API grundsätzlich (z. B. das Loch am 2026-10-27): der CVD
 * summiert die vorhandenen Bars – das ist der Datenstand, kein Rechenfehler.
 */
export function computeStats(items: readonly BarItem[], x: StatsInput): StatsColumns {
  const n = items.length;
  const col = () => new Float64Array(n);
  const out: StatsColumns = {
    vol: col(),
    buy: col(),
    sell: col(),
    delta: col(),
    deltaPct: col(),
    ...(cvdAligned(x.offsetH, x.tfSec) ? { cvd: col() } : {}),
    aggN: col(),
    aggDelta: col(),
    volSec: col(),
  };
  const off = x.offsetH * 3600;
  const gaps = x.gaps ?? [];
  let day = Number.NaN;
  let dayStart = 0;
  let cvd = Number.NaN;
  for (let i = 0; i < n; i++) {
    const it = items[i]!;
    const b = it.b;
    const s = it.s;
    const v = b + s;
    out.vol![i] = v;
    out.buy![i] = b;
    out.sell![i] = s;
    out.delta![i] = b - s;
    out.deltaPct![i] = v > 0 ? ((b - s) / v) * 100 : Number.NaN;
    if (out.cvd) {
      const d = Math.floor((it.t - off) / 86_400);
      if (d !== day) {
        day = d;
        dayStart = d * 86_400 + off;
        // Tagesbeginn im Fenster? Sonst fehlt der Anfang → unbekannt bis zur nächsten Grenze
        cvd = dayStart >= x.windowStartSec ? 0 : Number.NaN;
      }
      // Lücke zwischen Tagesbeginn und diesem Bar → unbekannt bis zur nächsten Grenze
      for (const [gs, ge] of gaps) if (gs < it.t && ge > dayStart) cvd = Number.NaN;
      cvd += b - s;
      out.cvd[i] = cvd;
    }
    out.aggN![i] = it.ba + it.sa;
    out.aggDelta![i] = it.ba - it.sa;
    const dur = Math.min(x.tfSec, x.dataTo / 1000 - it.t);
    out.volSec![i] = dur > 0 ? v / dur : Number.NaN;
  }
  // Zusatzspalten der API (falls geliefert)
  for (const def of STAT_ROWS) {
    if (!def.column) continue;
    if (!items.some((it) => it.x?.[def.column!] !== undefined)) continue;
    const c = col();
    for (let i = 0; i < n; i++) c[i] = items[i]!.x?.[def.column] ?? Number.NaN;
    out[def.id] = c;
  }
  return out;
}

/**
 * High/Low Ratio (§6.1) aus den dünn besetzten Leveln eines Bars: High = b(oberste−1) / b(oberste),
 * Low = s(unterste+1) / s(unterste); nur bei ≥ 3 Zeilen im Bar-Range und Nenner > 0, sonst NaN.
 */
export function highLowRatio(
  row: ArrayLike<number>,
  buy: ArrayLike<number>,
  sell: ArrayLike<number>,
  s: number,
  e: number,
  rowLow: number,
  rowHigh: number,
): [number, number] {
  if (rowHigh - rowLow + 1 < 3 || e <= s) return [Number.NaN, Number.NaN];
  const at = (r: number, side: ArrayLike<number>) => {
    for (let j = s; j < e; j++) if (row[j] === r) return side[j]!;
    return 0;
  };
  const top = at(rowHigh, buy);
  const bot = at(rowLow, sell);
  return [
    top > 0 ? at(rowHigh - 1, buy) / top : Number.NaN,
    bot > 0 ? at(rowLow + 1, sell) / bot : Number.NaN,
  ];
}

/** K-/M-Formatierung (§6.2): Menge in Lots → Basiswährung, kurz. */
export function formatStat(v: number, unit: Unit, qtyDecimals: number): string {
  if (!Number.isFinite(v)) return '–';
  if (unit === 'pct') return `${v.toFixed(1)}%`;
  if (unit === 'ratio') return v.toFixed(2);
  const q = unit === 'count' ? v : v / 10 ** qtyDecimals;
  const a = Math.abs(q);
  const sign = q < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(1)}K`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(2)}K`;
  if (unit === 'count') return `${sign}${Math.round(a)}`;
  return `${sign}${a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a.toFixed(2)}`;
}

/** Schattierung (§6.2): z = (x − μ)/σ über die sichtbaren Bars, Intensität min(1, |z|/3). */
export function shadeIntensity(v: number, mean: number, sd: number): number {
  if (!Number.isFinite(v) || !(sd > 0)) return 0;
  return Math.min(1, Math.abs((v - mean) / sd) / 3);
}

export function meanSd(values: Float64Array, from: number, to: number): [number, number] {
  let n = 0;
  let sum = 0;
  let sq = 0;
  for (let i = from; i < to; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    n++;
    sum += v;
    sq += v * v;
  }
  if (n === 0) return [0, 0];
  const m = sum / n;
  return [m, Math.sqrt(Math.max(0, sq / n - m * m))];
}

export const STATS_STEPS = 8;
const POS = [38, 166, 154];
const NEG = [239, 83, 80];
const NEU = [86, 132, 214];
const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
/** Farbtabelle: [positiv | negativ | ohne Vorzeichen] × STATS_STEPS Stufen. */
export const STATS_PALETTE: readonly string[] = [POS, NEG, NEU].flatMap((c) =>
  Array.from({ length: STATS_STEPS }, (_, s) => rgba(c, 0.06 + (0.5 * (s + 1)) / STATS_STEPS)),
);

/** Farbindex einer Zelle oder −1 (keine Füllung). */
export function statColor(v: number, signed: boolean, mean: number, sd: number): number {
  const t = shadeIntensity(v, mean, sd);
  if (t <= 0) return -1;
  const step = Math.min(STATS_STEPS - 1, Math.floor(t * STATS_STEPS));
  if (signed) return (v >= 0 ? 0 : 1) * STATS_STEPS + step;
  return v > mean ? 2 * STATS_STEPS + step : -1;
}

export type StatsItem = BarItem & CustomData<Time>;

/** Vom Controller gesetzter Zustand des Grids (nicht reaktiv). */
export class StatsContext {
  rows: StatRow[] = [...STATS_DEFAULT_ROWS];
  cols: StatsColumns = {};
  qtyDecimals = 3;
  /** High/Low Ratio eines Bars (Footprint-Level der gezeichneten Zeilengröße) oder null */
  hlRatio: ((t: number) => [number, number] | null) | null = null;
  /** Hinweis statt Werten je Zeile (z. B. CVD bei nicht ausgerichteter Tagesgrenze) */
  notes: Partial<Record<StatRow, string>> = {};
  /** Zeilengröße, mit der Ratios (und Imbalances) gerechnet sind, z. B. „20 USDT" (H-4) */
  rowSize = '';

  /** Hinweise für Zeilen, deren API-Spalte im Fenster fehlt (nicht geliefert ≠ 0). */
  missingNotes(
    statsRequested: boolean,
    bad: ReadonlyMap<string, string> = new Map(),
  ): Partial<Record<StatRow, string>> {
    const out: Partial<Record<StatRow, string>> = {};
    for (const def of STAT_ROWS)
      if (def.column && bad.has(def.column))
        out[def.id] = `${def.column} unbrauchbar (${bad.get(def.column)}) – verworfen`;
      else if (def.column && !this.cols[def.id])
        out[def.id] = statsRequested
          ? `– (${def.column} für diesen Zeitrahmen nicht geliefert)`
          : `– (${def.column} fehlt)`;
    return out;
  }

  /** Serie gewechselt (Symbol/tf): Werte der alten Serie verwerfen (H-1). */
  reset(): void {
    this.cols = {};
    this.notes = {};
    this.rowSize = '';
  }
  /** Letzter Frame: Stufe ('text' | 'shade' | 'hidden'), gezeichnete Zellen, Zeit */
  stats = {
    lod: 'hidden' as 'text' | 'shade' | 'hidden',
    cells: 0,
    lastMs: 0,
    frames: 0,
    maxMs: 0,
  };
}

class StatsRenderer implements ICustomSeriesPaneRenderer {
  data: PaneRendererCustomData<Time, StatsItem> | null = null;
  readonly sc: StatsContext;
  constructor(sc: StatsContext) {
    this.sc = sc;
  }

  draw(target: Target): void {
    const t0 = performance.now();
    target.useBitmapCoordinateSpace((s) => this.drawImpl(s));
    const ms = performance.now() - t0;
    const st = this.sc.stats;
    st.lastMs = ms;
    st.maxMs = Math.max(st.maxMs, ms);
    st.frames++;
  }

  private drawImpl(scope: Scope): void {
    const d = this.data;
    const sc = this.sc;
    const ctx = scope.context;
    const hpr = scope.horizontalPixelRatio;
    const vpr = scope.verticalPixelRatio;
    sc.stats.cells = 0;
    if (!d || !d.visibleRange || d.bars.length === 0) return;
    const from = Math.max(0, d.visibleRange.from);
    const to = Math.min(d.bars.length, d.visibleRange.to);
    const bs = d.barSpacing;
    const rows = sc.rows.map((id) => STAT_ROWS.find((r) => r.id === id)!).filter(Boolean);
    const rh = Math.round(STATS_ROW_PX * vpr);
    const lod = bs >= STATS_TEXT_MIN_BS ? 'text' : bs >= STATS_SHADE_MIN_BS ? 'shade' : 'hidden';
    sc.stats.lod = lod;
    const fontPx = Math.round(10 * vpr);
    ctx.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textBaseline = 'middle';
    if (lod !== 'hidden' && to > from) {
      // High/Low Ratio je Frame aus den Kacheln (nur sichtbare Bars, billig)
      const needHl = rows.some((r) => r.id === 'hiRatio' || r.id === 'loRatio');
      let hiCol: Float64Array | null = null;
      let loCol: Float64Array | null = null;
      if (needHl) {
        hiCol = new Float64Array(to - from).fill(Number.NaN);
        loCol = new Float64Array(to - from).fill(Number.NaN);
        for (let i = from; i < to; i++) {
          const r = sc.hlRatio?.(d.bars[i]!.originalData.t);
          if (r) {
            hiCol[i - from] = r[0];
            loCol[i - from] = r[1];
          }
        }
      }
      const colW = Math.max(1, Math.round(bs * 0.94 * hpr));
      ctx.textAlign = 'center';
      rows.forEach((def, ri) => {
        const y = ri * rh;
        const col =
          def.id === 'hiRatio' ? hiCol : def.id === 'loRatio' ? loCol : (sc.cols[def.id] ?? null);
        if (!col) return; // API-Spalte fehlt: nur das Etikett (unten)
        const off = def.id === 'hiRatio' || def.id === 'loRatio' ? from : 0;
        const [mean, sd] = meanSd(col, from - off, to - off);
        // Füllungen je Farbe gebündelt
        const buckets: number[][] = Array.from({ length: STATS_PALETTE.length }, () => []);
        for (let i = from; i < to; i++) {
          const c = statColor(col[i - off]!, def.signed, mean, sd);
          if (c >= 0) buckets[c]!.push(Math.round(d.bars[i]!.x * hpr - colW / 2));
        }
        buckets.forEach((xs, c) => {
          if (xs.length === 0) return;
          ctx.fillStyle = STATS_PALETTE[c]!;
          ctx.beginPath();
          for (const x of xs) ctx.rect(x, y + 1, colW, rh - 2);
          ctx.fill();
        });
        if (lod === 'text') {
          ctx.fillStyle = '#d7dde6';
          const charW = ctx.measureText('0').width;
          for (let i = from; i < to; i++) {
            const str = formatStat(col[i - off]!, def.unit, sc.qtyDecimals);
            if (str.length * charW > colW - 2 * hpr) continue;
            ctx.fillText(str, Math.round(d.bars[i]!.x * hpr), y + rh / 2);
            sc.stats.cells++;
          }
        }
      });
    }
    // Etiketten links (über den Zellen, mit Hintergrund)
    const lw = Math.round(STATS_LABEL_PX * hpr);
    ctx.fillStyle = 'rgba(15, 18, 23, 0.92)';
    ctx.fillRect(0, 0, lw, rows.length * rh);
    ctx.textAlign = 'left';
    rows.forEach((def, ri) => {
      const y = ri * rh;
      const missing = !!def.column && !sc.cols[def.id];
      ctx.fillStyle = missing ? '#6b7380' : '#9aa4b2';
      // H-5: unten links sitzt das Logo der Bibliothek (Attribution) – Etiketten dort eingerückt
      const logoZone = y + rh > scope.bitmapSize.height - Math.round(30 * vpr);
      ctx.fillText(def.label, Math.round((logoZone ? 40 : 4) * hpr), y + rh / 2);
      const note =
        sc.notes[def.id] ??
        ((def.id === 'hiRatio' || def.id === 'loRatio') && sc.rowSize ? `Zeile ${sc.rowSize}` : '');
      if (note) {
        // Hinweis rechts (Ratios: Zeilengröße der Footprint-Level) bzw. statt Werten
        const w = ctx.measureText(note).width;
        const x = sc.notes[def.id]
          ? lw + Math.round(8 * hpr)
          : scope.bitmapSize.width - w - 6 * hpr;
        ctx.fillStyle = 'rgba(15, 18, 23, 0.92)';
        ctx.fillRect(x - 3 * hpr, y + 1, w + 6 * hpr, rh - 2);
        ctx.fillStyle = '#c9a74a';
        ctx.fillText(note, x, y + rh / 2);
      }
      ctx.fillStyle = '#1f2630';
      ctx.fillRect(0, y + rh - 1, scope.bitmapSize.width, 1);
    });
    if (lod === 'hidden') {
      ctx.fillStyle = '#6b7380';
      ctx.fillText('Stats: Bars zu schmal (< 4 px)', lw + Math.round(8 * hpr), rh / 2);
    }
  }
}

export class StatsSeriesView implements ICustomSeriesPaneView<
  Time,
  StatsItem,
  CustomSeriesOptions
> {
  private readonly r: StatsRenderer;
  constructor(sc: StatsContext) {
    this.r = new StatsRenderer(sc);
  }
  renderer(): StatsRenderer {
    return this.r;
  }
  update(data: PaneRendererCustomData<Time, StatsItem>): void {
    this.r.data = data;
  }
  priceValueBuilder(): CustomSeriesPricePlotValues {
    return [0];
  }
  isWhitespace(
    item: StatsItem | CustomSeriesWhitespaceData<Time>,
  ): item is CustomSeriesWhitespaceData<Time> {
    return (item as Partial<StatsItem>).close === undefined;
  }
  defaultOptions(): CustomSeriesOptions {
    return { ...customSeriesDefaultOptions, lastValueVisible: false, priceLineVisible: false };
  }
}
