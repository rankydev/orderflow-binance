// Abdeckung und Quellzeilen von GET /api/v1/bigtrades (docs/BIGTRADES-API.md). Rein, ohne I/O.
//
// Tagesebene – ein Tag hat big-order-Daten ab der Schwelle minN nur, wenn (Migration 0017):
//   - er gespeicherte Daten hat (data_day-Zeile, nicht erstmals im Import),
//   - er nicht in Digest-Version 1 geschrieben wurde (vor den Order-Daten; Neuimport ausstehend),
//   - seine Ordersummen bekannt sind (orders_n NOT NULL; ein Live-Tag, dessen Speicher nicht genau
//     die bar_1m-Zeilen deckt, hat NULL),
//   - seine Untergrenze bekannt ist (big_floor_n NOT NULL; sonst wurden keine big orders gebildet).
// Dann `ok` (big_floor_n ≤ minN) bzw. `partial` (nur Orders ≥ big_floor_n), sonst `none`.
//
// Minutenebene (Review: „keine Daten" darf nie wie „keine Big Trades" aussehen) – innerhalb eines
// Tages mit Daten werden ausgenommen (`none`):
//   - Live-Tage (source ≠ 'vision'): orders_n NOT NULL heißt nur „Speicher = bar_1m", nicht „Tag
//     lückenlos". Aufgezeichnet ist [recordedFrom, recordedTo): recordedTo = live_until; recordedFrom =
//     Tagesbeginn, wenn die erste aggId des Tages an die letzte des Vortags anschließt, sonst das Ende
//     der ersten gespeicherten Minute (die erste Minute kann angeschnitten sein). Davor `not_recorded`,
//     danach `pending` (noch nicht geschrieben – auch die Zukunft).
//   - Minuten aus data_minute_issue: `gap` (nicht füllbare Lücke des Recorders), `missing`
//     (→ `source_missing`: Klines zeigen Trades, die aggTrades-Datei hat keine) und `mismatch`
//     (Volumen weicht von der Kline ab, nicht durch Randverschiebung erklärt; final_bad-Tage).
//     Mehr als BIG_HOLES_PER_DAY solche Minuten an einem Tag (oder über BIG_HOLES_TOTAL je Anfrage):
//     der ganze Tag `too_many_holes` (Grenze der Abschnittszahl, nie Informationsverlust).
// Zeilen gibt es nur in ok/partial-Abschnitten.
import type { CoverageReason, CoverageSpan, CoverageStatus } from '@orderflow/core';
import { DAY_MS, MINUTE_MS } from './params.ts';

/** Order-Felder eines Tages (Katalog oder Lese-Snapshot). */
export interface OrderDay {
  hasData: boolean;
  immutable: boolean;
  digestVersion: number | null;
  ordersKnown: boolean;
  floorN: number | null;
  /** Anzahl Minuten mit gap/missing/mismatch (data_minute_issue); Teil von Version und `final`. */
  holes?: number;
  /** Nur im Lese-Snapshot: mehr Lückenminuten als die Grenze → ganzer Tag none too_many_holes. */
  tooManyHoles?: boolean;
  /**
   * Nur im Lese-Snapshot: Live-Tag (source ≠ 'vision') mit aufgezeichnetem Bereich
   * [recordedFrom, recordedTo) in ms. Fehlt = Tag aus einer Binance-Datei (ganzer Tag).
   */
  live?: { recordedFrom: number; recordedTo: number } | null;
}

/** Minute (Beginn, ms) ohne Order-Daten aus data_minute_issue. */
export interface HoleMinute {
  ts: number;
  reason: 'gap' | 'source_missing' | 'mismatch';
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
  if (d.tooManyHoles) return none('too_many_holes');
  return d.floorN > minN
    ? { status: 'partial', reason: 'floor_above', floorN: d.floorN, final: d.immutable }
    : { status: 'ok', reason: null, floorN: d.floorN, final: d.immutable };
}

export interface CoveragePlan {
  spans: CoverageSpan[];
  /** Zeitbereiche mit Order-Daten (ok/partial), zusammengefasst; nur diese werden gelesen. */
  ranges: { from: number; to: number }[];
  /**
   * Antwort ändert sich nicht mehr: alle Tage unveränderlich, alles `ok` (kein none, kein partial –
   * ein Neuimport mit anderer Untergrenze oder ein reparierter Tag kann beide noch ändern) und ohne
   * gap/missing-Minuten.
   */
  final: boolean;
}

/** Abschnitte eines Tages [a, b) (ms) mit ihrer Abdeckung, aufsteigend, lückenlos. */
function daySegments(
  d: number,
  info: OrderDay | null | undefined,
  minN: number,
  holes: HoleMinute[],
): { from: number; to: number; c: DayCoverage }[] {
  const d0 = d * DAY_MS;
  const d1 = d0 + DAY_MS;
  const base = dayCoverage(info, minN);
  if (base.status === 'none') return [{ from: d0, to: d1, c: base }];
  const none = (reason: CoverageReason): DayCoverage => ({
    status: 'none',
    reason,
    floorN: null,
    final: base.final,
  });
  const out: { from: number; to: number; c: DayCoverage }[] = [];
  const push = (a: number, b: number, c: DayCoverage) => {
    if (b > a) out.push({ from: a, to: b, c });
  };
  let a = d0;
  let b = d1;
  if (info?.live) {
    // auf Minuten und den Tag begrenzt (Abschnittsgrenzen sind Minutengrenzen)
    const clamp = (t: number) => Math.min(d1, Math.max(d0, t - (t % MINUTE_MS)));
    b = clamp(info.live.recordedTo);
    a = Math.min(b, clamp(info.live.recordedFrom));
    push(d0, a, none('not_recorded'));
  }
  let t = a;
  for (const h of holes) {
    if (h.ts < a || h.ts >= b) continue;
    push(t, h.ts, base);
    push(h.ts, h.ts + MINUTE_MS, none(h.reason));
    t = h.ts + MINUTE_MS;
  }
  push(t, b, base);
  push(b, d1, none('pending'));
  return out;
}

/**
 * Abdeckung von [from, to): je UTC-Tag, darin minutengenau (Live-Bereich, gap/missing-Minuten),
 * gleiche Nachbarabschnitte zusammengefasst. `holes` aufsteigend nach ts.
 */
export function coveragePlan(
  from: number,
  to: number,
  minN: number,
  day: (d: number) => OrderDay | null | undefined,
  holes: HoleMinute[] = [],
): CoveragePlan {
  const spans: CoverageSpan[] = [];
  const ranges: { from: number; to: number }[] = [];
  let final = true;
  let hi = 0;
  for (let d = Math.floor(from / DAY_MS); d * DAY_MS < to; d++) {
    const info = day(d);
    if (info?.holes) final = false;
    const dh: HoleMinute[] = [];
    while (hi < holes.length && holes[hi]!.ts < (d + 1) * DAY_MS) {
      if (holes[hi]!.ts >= d * DAY_MS) dh.push(holes[hi]!);
      hi++;
    }
    for (const seg of daySegments(d, info, minN, dh)) {
      const a = Math.max(from, seg.from);
      const b = Math.min(to, seg.to);
      if (b <= a) continue;
      const c = seg.c;
      if (!c.final || c.status !== 'ok') final = false;
      const last = spans[spans.length - 1];
      if (
        last &&
        last.to === a &&
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
    }
  }
  return { spans, ranges, final };
}

/** Stufen je Dekade (× 10^k): benachbarte Stufen höchstens Faktor 1,17 auseinander. */
const STEPS = [
  1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8, 9,
];

/**
 * Notional-Stufen der Katalogstatistik in USDT, 100 000 … 10⁹ (22 je Dekade, Faktor ≤ 1,17): je Tag
 * wird gezählt, wie viele big_order-Zeilen zwischen zwei Stufen liegen (catalog.ts DayStats.bigHist).
 * Auf einer Stufe ist die Schätzung exakt, dazwischen eine obere Schranke, die höchstens die Orders
 * eines Stufenintervalls zu viel zählt (Pareto α ≈ 1,8: ≤ 1,17^1,8 ≈ 1,33 × tatsächlich).
 */
export const BIG_LADDER_USDT: readonly number[] = [
  ...[100_000, 1_000_000, 10_000_000, 100_000_000].flatMap((p) =>
    STEPS.map((m) => Math.round(m * p)),
  ),
  1_000_000_000,
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
