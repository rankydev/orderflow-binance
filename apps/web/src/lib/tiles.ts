// Sichtbarer Bereich → benötigte Kacheln (KONZEPT §5.4): sichtbare Kacheln + 1 Kachel Padding je
// Seite + Prefetch in Panrichtung; Bar-Abschnitte (bars-Endpunkt) in festen, ausgerichteten Blöcken.
import { tileIndexAt } from '@orderflow/core/browser';

export interface WantedTile {
  k: number;
  /** 0 = sichtbar, 1 = Padding, 2 = Prefetch. */
  priority: 0 | 1 | 2;
}

export interface TileRangeInput {
  /** Sichtbarer Zeitbereich [fromSec, toSec] (inklusive Bar-Beginne). */
  fromSec: number;
  toSec: number;
  n: number;
  tfSec: number;
  /** Datenbereich [dataFromSec, dataToSec). */
  dataFromSec: number;
  dataToSec: number;
  /** −1 links, +1 rechts, 0 keine Richtung. */
  panDir: -1 | 0 | 1;
  padding?: number;
}

/** Benötigte Footprint-Kacheln, sortiert: sichtbar (von der Mitte nach außen), Padding, Prefetch. */
export function wantedTiles(x: TileRangeInput): WantedTile[] {
  const pad = x.padding ?? 1;
  if (x.dataToSec <= x.dataFromSec) return [];
  const kMin = tileIndexAt(x.dataFromSec, x.n, x.tfSec);
  const kMax = tileIndexAt(x.dataToSec - 1, x.n, x.tfSec);
  const a = Math.max(tileIndexAt(Math.min(x.fromSec, x.toSec), x.n, x.tfSec), kMin);
  const b = Math.min(tileIndexAt(Math.max(x.fromSec, x.toSec), x.n, x.tfSec), kMax);
  const out: WantedTile[] = [];
  if (a > b) {
    // Sichtbarer Bereich liegt außerhalb der Daten: nur die nächste Randkachel vorhalten.
    const k = b < kMin ? kMin : a > kMax ? kMax : a;
    return [{ k, priority: 1 }];
  }
  const mid = (a + b) / 2;
  const vis: number[] = [];
  for (let k = a; k <= b; k++) vis.push(k);
  vis.sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid) || p - q);
  for (const k of vis) out.push({ k, priority: 0 });
  for (let d = 1; d <= pad; d++) {
    if (a - d >= kMin) out.push({ k: a - d, priority: 1 });
    if (b + d <= kMax) out.push({ k: b + d, priority: 1 });
  }
  if (x.panDir !== 0) {
    const k = x.panDir > 0 ? b + pad + 1 : a - pad - 1;
    if (k >= kMin && k <= kMax) out.push({ k, priority: 2 });
  }
  return out;
}

/** Bars je Abschnitt des bars-Endpunkts (Client-Cache-Einheit). */
export const BAR_CHUNK_BARS = 1000;

export function chunkSpanSec(tfSec: number): number {
  return BAR_CHUNK_BARS * tfSec;
}

export function chunkIndexAt(tSec: number, tfSec: number): number {
  return Math.floor(tSec / chunkSpanSec(tfSec));
}

/**
 * Abschnitte für das Datenfenster: `cap` Abschnitte um den Abschnitt der Mitte, am Datenrand
 * verschoben statt abgeschnitten. Liefert [c0, c1] inklusive.
 */
export function windowChunks(
  centerSec: number,
  tfSec: number,
  cap: number,
  dataFromSec: number,
  dataToSec: number,
): [number, number] {
  const first = chunkIndexAt(dataFromSec, tfSec);
  const last = chunkIndexAt(dataToSec - 1, tfSec);
  const total = last - first + 1;
  if (total <= cap) return [first, last];
  const c = Math.min(Math.max(chunkIndexAt(centerSec, tfSec), first), last);
  let c0 = c - Math.floor((cap - 1) / 2);
  let c1 = c0 + cap - 1;
  if (c0 < first) {
    c1 += first - c0;
    c0 = first;
  }
  if (c1 > last) {
    c0 -= c1 - last;
    c1 = last;
  }
  return [c0, c1];
}
