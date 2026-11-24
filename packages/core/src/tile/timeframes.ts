// Zeitrahmen v1 (KONZEPT §5.2) und Kachelgeometrie (§5.3). Rein, ohne I/O; gemeinsam für API und Web.

export const TIMEFRAMES = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14_400,
  '1d': 86_400,
} as const;

export type Timeframe = keyof typeof TIMEFRAMES;

export function isTimeframe(s: string): s is Timeframe {
  return Object.prototype.hasOwnProperty.call(TIMEFRAMES, s);
}

/** Sekunden eines Zeitrahmens; wirft bei unbekanntem Kürzel. */
export function tfSeconds(tf: string): number {
  if (!isTimeframe(tf)) throw new Error(`Unbekannter Zeitrahmen "${tf}"`);
  return TIMEFRAMES[tf];
}

/** Zielgröße und harte Grenze einer Kachel in Zellen (KONZEPT §1.4). */
export const TILE_TARGET_CELLS = 30_000;
export const TILE_MAX_CELLS = 60_000;
export const TILE_MIN_BARS = 32;
export const TILE_MAX_BARS = 1024;

/**
 * Kachellänge n in Bars (KONZEPT §5.3): clamp(2^floor(log2(30 000 / Zeilen_pro_Bar)), 32, 1024).
 * `rowsPerBar` ist der Median der Zeilen je Bar bei Zeilengröße R (> 0).
 */
export function tileBarsFor(rowsPerBar: number): number {
  if (!(rowsPerBar > 0)) return TILE_MAX_BARS;
  const raw = TILE_TARGET_CELLS / rowsPerBar;
  if (raw >= TILE_MAX_BARS) return TILE_MAX_BARS;
  if (raw <= TILE_MIN_BARS) return TILE_MIN_BARS;
  // Ganzzahlige Zweierpotenz ≤ raw (ohne Rundungsprobleme von Math.log2 an Zweierpotenzen).
  let n = TILE_MIN_BARS;
  while (n * 2 <= raw) n *= 2;
  return n;
}

/** Zeitspanne einer Kachel in Sekunden. */
export function tileSpanSec(n: number, tfSec: number): number {
  return n * tfSec;
}

/** Kachelindex k, der den Zeitpunkt t (Sekunden) enthält; Kacheln sind an Vielfachen von n·tf seit Epoch ausgerichtet. */
export function tileIndexAt(tSec: number, n: number, tfSec: number): number {
  return Math.floor(tSec / (n * tfSec));
}

/** [from, to) der Kachel k in Sekunden. */
export function tileBoundsSec(k: number, n: number, tfSec: number): [number, number] {
  const span = n * tfSec;
  return [k * span, (k + 1) * span];
}

/**
 * Kachellänge mit Garantie (Abweichung von §5.3, Nutzerentscheid 2026-11-24): Grundlage ist das
 * **Maximum** der Zeilen je Bar im Referenzzeitraum, nicht der Median. Da eine Kachel höchstens n Bars
 * hat, gilt Zellen ≤ n · max ≤ 30 000 (bzw. ≤ 32 · max, wenn n auf 32 begrenzt ist). Liefert null, wenn
 * selbst 32 Bars die harte Grenze überschreiten könnten (32 · max > 60 000): dann wird die Kombination
 * (tf, R) nicht angeboten (fehlt in /symbols.tiles) statt zur Laufzeit mit 422 abgelehnt.
 */
export function tileBarsForMax(maxRowsPerBar: number, margin = TILE_ROWS_MARGIN): number | null {
  const m = Math.ceil(maxRowsPerBar * margin);
  if (m * TILE_MIN_BARS > TILE_MAX_CELLS) return null;
  return tileBarsFor(m);
}

/**
 * Sicherheitszuschlag auf das Maximum der Zeilen je Bar (Review E): ein späterer Tag darf um bis zu 50 %
 * breitere Bars haben, ohne dass eine Kachel 30 000 (bzw. bei n = 32 60 000) Zellen überschreitet.
 */
export const TILE_ROWS_MARGIN = 1.5;

/** Größte Zeilenzahl eines Bars: max(floor(high/w) − floor(low/w) + 1). */
export function maxRowsPerBar(
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  width: number,
): number {
  let m = 0;
  const n = Math.min(high.length, low.length);
  for (let i = 0; i < n; i++) {
    const h = high[i]!;
    const l = low[i]!;
    const rows = (h - (h % width)) / width - (l - (l % width)) / width + 1;
    if (rows > m) m = rows;
  }
  return m;
}

/** Median der Zeilenzahl je Bar: (floor(high/w) − floor(low/w) + 1) für Bars mit Preisen in price_unit. */
export function medianRowsPerBar(
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  width: number,
): number {
  const n = Math.min(high.length, low.length);
  if (n === 0) return 0;
  const rows = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = high[i]!;
    const l = low[i]!;
    rows[i] = (h - (h % width)) / width - (l - (l % width)) / width + 1;
  }
  rows.sort();
  return n % 2 === 1 ? rows[(n - 1) / 2]! : (rows[n / 2 - 1]! + rows[n / 2]!) / 2;
}
