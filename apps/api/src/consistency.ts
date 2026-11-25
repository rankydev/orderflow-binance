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

/**
 * Verteidigung in der Tiefe (Review Pass 5/6): Ein Snapshot, in dem ein Chunk leer erscheint, sieht in
 * sich konsistent aus (keine Bars UND keine Level). Maßstab ist, was für genau diese Stunden gespeichert
 * ist: die Katalogstatistik zählt je Tag und UTC-Stunde die Minuten mit Trades (bar_1m), im gesperrten
 * Snapshot ihrer Tagesversion, und wird nur verwendet, wenn diese Version der des Lese-Snapshots
 * gleicht. Ein Ausschnitt (je UTC-Tag; bei `whole` der ganze Zeitraum) ist unmöglich leer, wenn er eine
 * VOLL überdeckte Stunde mit ≥ 1 gespeicherten Minute enthält, aber keine einzige Bar. Echte Lücken
 * (Ausfälle, der unfertige Live-Tag, unvollständige Tage) haben 0 Minuten in ihren Stunden und lösen
 * nichts aus – exakt, ohne Schwelle und ohne Tagesdurchschnitt.
 */
export function checkCoverage(
  barStartsMs: ArrayLike<number>,
  from: number,
  to: number,
  hoursOn: (day: number) => Int16Array | undefined,
  immutable: boolean,
  where: Record<string, unknown>,
  /** true: der ganze Zeitraum als ein Ausschnitt (Profile); sonst je UTC-Tag. */
  whole = false,
): void {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  const pieces: { a: number; b: number; evidence: number | null }[] = [];
  for (let d = Math.floor(from / DAY); d * DAY < to; d++) {
    const a = Math.max(from, d * DAY);
    const b = Math.min(to, (d + 1) * DAY);
    // erste voll überdeckte Stunde mit gespeicherten Minuten in [a, b)
    let evidence: number | null = null;
    const hours = hoursOn(d);
    if (hours) {
      for (let h = Math.ceil(a / HOUR) * HOUR; h + HOUR <= b && evidence === null; h += HOUR)
        if (hours[(h - d * DAY) / HOUR]! > 0) evidence = h;
    }
    if (whole && pieces.length > 0) {
      pieces[0]!.b = b;
      pieces[0]!.evidence ??= evidence;
    } else pieces.push({ a, b, evidence });
  }
  for (const { a, b, evidence } of pieces) {
    if (evidence === null) continue;
    let any = false;
    for (let i = 0; i < barStartsMs.length && !any; i++) {
      const t = barStartsMs[i]!;
      if (t >= a && t < b) any = true;
    }
    if (!any)
      throw new DataInconsistency(
        `Ausschnitt ${new Date(a).toISOString()}…${new Date(b).toISOString()} leer, gespeichert sind Minuten in der Stunde ab ${new Date(evidence).toISOString()}`,
        immutable,
        where,
      );
  }
}
