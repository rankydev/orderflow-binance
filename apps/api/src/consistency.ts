// Konsistenzprüfung eines Lese-Snapshots (Review Pass 4): Bars und Level bzw. Profil-Level und Bars
// stammen aus verschiedenen Tabellen. Passen sie nicht zusammen (Bar ohne Level, Level ohne Bar,
// Summen ungleich), ist das entweder ein Übergangszustand eines Schreibers (nicht unveränderlicher Tag)
// oder ein echter Datenfehler (unveränderlicher Tag). Beides wird nie zu 500: DataInconsistency →
// readTx wiederholt mit neuem Snapshot → 503 + Retry-After; bei unveränderlichen Tagen zusätzlich
// laut protokolliert und in Health und /quality gemeldet (context.ts).
import { DataInconsistency } from './db.ts';
import type { BarRows, DaySnap, LevelRows, ProfileBarRow, ProfileLevelRow } from './queries.ts';

/** Alle überdeckten Tage vorhanden und unveränderlich? */
export function allImmutable(days: Map<number, DaySnap>, d0: number, d1: number): boolean {
  for (let d = d0; d <= d1; d++) if (!days.get(d)?.immutable) return false;
  return true;
}

/** Jede Bar hat Level, jedes Level eine Bar, Σ Level = Bar-Summen (buy, sell, buyA, sellA). */
export function checkTile(
  bars: BarRows,
  lv: LevelRows,
  immutable: boolean,
  where: Record<string, unknown>,
): void {
  const fail = (m: string) => {
    throw new DataInconsistency(m, immutable, where);
  };
  let j = 0;
  for (let i = 0; i < bars.time.length; i++) {
    const t = bars.time[i]!;
    if (j < lv.time.length && lv.time[j]! < t) fail(`Level bei t=${lv.time[j]} ohne Bar`);
    let b = 0;
    let s = 0;
    let ba = 0;
    let sa = 0;
    const j0 = j;
    while (j < lv.time.length && lv.time[j] === t) {
      b += lv.buy[j]!;
      s += lv.sell[j]!;
      ba += lv.buyA[j]!;
      sa += lv.sellA[j]!;
      j++;
    }
    if (j === j0) fail(`Bar t=${t} ohne Level`);
    if (b !== bars.buyQ[i] || s !== bars.sellQ[i] || ba !== bars.buyA[i] || sa !== bars.sellA[i])
      fail(`Bar t=${t}: Level-Summen ≠ Bar-Summen`);
  }
  if (j !== lv.time.length) fail(`Level bei t=${lv.time[j]} ohne Bar`);
}

/** Je Tag (bzw. Bereich, day = 0): Σ Level = Σ Bars, keine Level ohne Bars. */
export function checkProfile(
  bars: ProfileBarRow[],
  lv: ProfileLevelRow[],
  immutable: boolean,
  where: Record<string, unknown>,
): void {
  const sums = new Map<number, [number, number]>();
  for (const l of lv) {
    const e = sums.get(l.day) ?? [0, 0];
    e[0] += l.buy;
    e[1] += l.sell;
    sums.set(l.day, e);
  }
  for (const b of bars) {
    const e = sums.get(b.day) ?? [0, 0];
    if (e[0] !== b.buyQ || e[1] !== b.sellQ)
      throw new DataInconsistency(
        `Profil (Tag ${b.day}): Level-Summen ${e[0]}/${e[1]} ≠ Bar-Summen ${b.buyQ}/${b.sellQ}`,
        immutable,
        where,
      );
    sums.delete(b.day);
  }
  if (sums.size > 0)
    throw new DataInconsistency(
      `Profil: Level ohne Bars (Tag ${[...sums.keys()][0]})`,
      immutable,
      where,
    );
}
