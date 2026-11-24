// Zeilenbildung (KONZEPT §3.2, §3.6, §4.4): ausschließlich per Ganzzahl-Rest, nie per Gleitkomma-
// Division. Zeilengröße R in Ticks; Breite in price_unit = R · tick_ref_units.

/** Untere Zeilenkante: px − (px mod w) = floor(px / w) · w für px ≥ 0, w > 0 (beide ganzzahlig). */
export function rowPx(px: number, width: number): number {
  return px - (px % width);
}

/** Zeilenindex floor(px / w) per Ganzzahl-Rest (exakt, da px − px mod w ein Vielfaches von w ist). */
export function rowIndex(px: number, width: number): number {
  return (px - (px % width)) / width;
}

/** Leiter der UI-Zeilengrößen {1, 2, 5}·10^k Ticks, aufsteigend, bis einschließlich `max`. */
export function ladder(max: number): number[] {
  const out: number[] = [];
  for (let p = 1; p <= max; p *= 10) {
    for (const m of [1, 2, 5]) if (m * p <= max) out.push(m * p);
  }
  return out;
}

/** Bins der gespeicherten Tabellen in Ticks (KONZEPT §3.6). */
export const STORED_BINS = [1, 10, 100, 1000] as const;

/** Größter gespeicherter Bin, der R teilt (jede Leiterstufe ist Vielfaches eines gespeicherten Bins). */
export function storedBinFor(r: number): number {
  let best = 1;
  for (const b of STORED_BINS) if (r % b === 0) best = b;
  return best;
}
