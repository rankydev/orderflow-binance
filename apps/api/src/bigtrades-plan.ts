// Abdeckung und Quellzeilen von GET /api/v1/bigtrades (docs/BIGTRADES-API.md). Rein, ohne I/O.
//
// Ein Tag hat big-order-Daten ab der Schwelle minN genau dann, wenn (Migration 0017):
//   - er gespeicherte Daten hat (data_day-Zeile, nicht erstmals im Import),
//   - er nicht in Digest-Version 1 geschrieben wurde (vor den Order-Daten; Neuimport ausstehend),
//   - seine Ordersummen bekannt sind (orders_n NOT NULL; ein Live-Tag, dessen Vollständigkeit der
//     Recorder nicht nachweisen konnte, hat NULL),
//   - seine Untergrenze bekannt ist (big_floor_n NOT NULL; sonst wurden keine big orders gebildet).
// Dann ist er `ok`, wenn big_floor_n ≤ minN (alle Orders ≥ minN gespeichert), sonst `partial`
// (nur Orders ≥ big_floor_n gespeichert). Alle anderen Tage sind `none`: dort liefert die API keine
// Zeilen und der Client zeigt „keine Daten", nie „keine Big Trades".
import type { CoverageReason, CoverageSpan, CoverageStatus } from '@orderflow/core';
import { DAY_MS } from './params.ts';

/** Order-Felder eines Tages (Katalog oder Lese-Snapshot). */
export interface OrderDay {
  hasData: boolean;
  immutable: boolean;
  digestVersion: number | null;
  ordersKnown: boolean;
  floorN: number | null;
}

export interface DayCoverage {
  status: CoverageStatus;
  reason: CoverageReason | null;
  floorN: number | null;
  final: boolean;
}

export function dayCoverage(d: OrderDay | null | undefined, minN: number): DayCoverage {
  const none = (reason: CoverageReason): DayCoverage => ({
    status: 'none',
    reason,
    floorN: null,
    final: d?.immutable === true,
  });
  if (!d || !d.hasData) return none('no_day');
  if (d.digestVersion === 1) return none('digest_v1');
  if (!d.ordersKnown) return none('unknown_totals');
  if (d.floorN === null) return none('no_floor');
  return d.floorN > minN
    ? { status: 'partial', reason: 'floor_above', floorN: d.floorN, final: d.immutable }
    : { status: 'ok', reason: null, floorN: d.floorN, final: d.immutable };
}

export interface CoveragePlan {
  spans: CoverageSpan[];
  /** Zeitbereiche mit Order-Daten (ok/partial), zusammengefasst; nur diese werden gelesen. */
  ranges: { from: number; to: number }[];
  /** Alle Tage unveränderlich und mit Order-Daten: die Antwort ändert sich nicht mehr. */
  final: boolean;
}

/** Abdeckung von [from, to) je UTC-Tag, gleiche aufeinanderfolgende Tage zusammengefasst. */
export function coveragePlan(
  from: number,
  to: number,
  minN: number,
  day: (d: number) => OrderDay | null | undefined,
): CoveragePlan {
  const spans: CoverageSpan[] = [];
  const ranges: { from: number; to: number }[] = [];
  let final = true;
  for (let a = from; a < to;) {
    const d = Math.floor(a / DAY_MS);
    const b = Math.min(to, (d + 1) * DAY_MS);
    const c = dayCoverage(day(d), minN);
    if (!c.final || c.status === 'none') final = false;
    const last = spans[spans.length - 1];
    if (
      last &&
      last.status === c.status &&
      last.reason === c.reason &&
      last.floorN === c.floorN &&
      last.final === c.final
    )
      last.to = b;
    else spans.push({ from: a, to: b, ...c });
    if (c.status !== 'none') {
      const r = ranges[ranges.length - 1];
      if (r && r.to === a) r.to = b;
      else ranges.push({ from: a, to: b });
    }
    a = b;
  }
  return { spans, ranges, final };
}

/**
 * Notional-Stufen der Katalogstatistik in USDT (1-2-5 je Dekade): je Tag wird gezählt, wie viele
 * big_order-Zeilen zwischen zwei Stufen liegen (catalog.ts DayStats.bigHist).
 */
export const BIG_LADDER_USDT: readonly number[] = [
  100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000, 50_000_000,
  100_000_000, 200_000_000, 500_000_000, 1_000_000_000,
];

/**
 * Obere Schranke der Orders ≥ minUsdt eines Tages aus seiner Stufenstatistik: Orders ab der größten
 * Stufe ≤ minUsdt (exakt, wenn minUsdt eine Stufe ist).
 */
export function matchedAtLeast(hist: Int32Array, minUsdt: number): number {
  let j = -1;
  for (let i = 0; i < BIG_LADDER_USDT.length; i++) if (BIG_LADDER_USDT[i]! <= minUsdt) j = i;
  let n = 0;
  for (let i = j + 1; i < hist.length; i++) n += hist[i]!;
  return n;
}

/** Je Tag: Anzahl (mit Stufenstatistik) oder undefined (keine Zeilen bzw. keine Statistik). */
export type BigHistOn = (day: number) => Int32Array | undefined;

/**
 * Geschätzte Zeilen über die gelesenen Bereiche (Tageszahl × überdeckter Anteil): `scanned` = alle
 * big_order-Zeilen (entpackt und gefiltert), `matched` = Orders ≥ minUsdt (obere Schranke; sie werden
 * sortiert und ausgedünnt – der teure Teil, gemessen in docs/BIGTRADES-API.md).
 */
export function estimateBig(
  ranges: { from: number; to: number }[],
  histOn: BigHistOn,
  minUsdt: number,
): { scanned: number; matched: number } {
  let scanned = 0;
  let matched = 0;
  for (const r of ranges) {
    for (let d = Math.floor(r.from / DAY_MS); d * DAY_MS < r.to; d++) {
      const h = histOn(d);
      if (!h) continue;
      const f = (Math.min(r.to, (d + 1) * DAY_MS) - Math.max(r.from, d * DAY_MS)) / DAY_MS;
      scanned += h.reduce((a, b) => a + b, 0) * f;
      matched += matchedAtLeast(h, minUsdt) * f;
    }
  }
  return { scanned: Math.ceil(scanned), matched: Math.ceil(matched) };
}
