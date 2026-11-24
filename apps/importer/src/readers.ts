// Streamende Leser für aggTrades- (Tages- und Monatsdateien) und 1m-Kline-ZIPs. Konstanter
// Speicher je Datei; Aggregation nur für angeforderte Tage, Manifest-Zähler für alle Tage.
// Monatsdateien werden beim Streamen nach UTC-Tag (floor(T / 86 400 000)) zerlegt (KONZEPT §3.1).
import {
  DayAggregator,
  DayStats,
  dayIndex,
  detectHeader,
  formatDay,
  ParseError,
  parseAggTradeRange,
  parseKlineRange,
  type AggTrade,
  type DayAggregate,
  type Kline,
  type SymbolSpec,
} from '@orderflow/core';
import { streamSingleEntry, textBlocks } from './zip.ts';

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** Vorzeitiges Ende des Lesens (alle angeforderten Tage fertig); kein Fehler. */
class StopReading extends Error {}

function lineError(path: string, lineNo: number, e: unknown): Error {
  if (e instanceof StopReading) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new InputError(`${path}:${lineNo}: ${msg}`);
}

export interface KlineDay {
  klines: Kline[];
  headerPresent: boolean;
  rows: number;
}

/** Liest eine 1m-Kline-Tagesdatei; jede Zeile muss im Tag liegen. */
export async function readKlineDay(path: string, spec: SymbolSpec, day: number): Promise<KlineDay> {
  const klines: Kline[] = [];
  const { headerPresent, rows } = await forEachRow(path, 'klines', (text, s, e) => {
    const k = parseKlineRange(text, s, e, spec);
    if (dayIndex(k.openTime) !== day) {
      throw new ParseError(`Kline open_time ${k.openTime} liegt nicht im Tag ${formatDay(day)}`);
    }
    if (klines.length > 0 && k.openTime <= klines[klines.length - 1]!.openTime) {
      throw new ParseError(`Klines nicht streng aufsteigend (open_time ${k.openTime})`);
    }
    klines.push(k);
  });
  return { klines, headerPresent, rows };
}

export interface AggDayChunk {
  day: number;
  stats: DayStats;
  /** Nur für angeforderte Tage. */
  agg?: DayAggregate;
}

export interface AggFileSummary {
  /** Nur bei vollständigem Lesen aussagekräftig. */
  headerPresent: boolean;
  rows: number;
  /** false, wenn per stopAfterDay vorzeitig beendet. */
  complete: boolean;
  days: { day: number; stats: DayStats }[];
}

export interface ReadAggOptions {
  /** Erster und letzter zulässiger Tag (Tagesdatei: beide gleich; Monatsdatei: der Monat). */
  firstDay: number;
  lastDay: number;
  /** Tage, für die aggregiert wird. */
  want: (day: number) => boolean;
  /** Lesen beenden, sobald ein Tag nach diesem beginnt (Nachbartag aus einer Monatsdatei). */
  stopAfterDay?: number;
  /** Sofort nach der ersten Zeile: Kopfzeile vorhanden? */
  onHeader?: (present: boolean) => void;
  /** Je fertigem Tag (in Zeitreihenfolge, sobald der Folgetag beginnt bzw. am Dateiende). */
  onDay: (chunk: AggDayChunk) => Promise<void> | void;
}

/**
 * Streamt eine aggTrades-Datei, zerlegt nach UTC-Tag. Strikte Prüfungen: Zeilen außerhalb des
 * Zeitraums, rückwärtslaufende Tage und doppelte aggIds sind Fehler; Löcher und rückwärtslaufende
 * Zeiten innerhalb einer Minute werden gezählt (Manifest).
 */
export async function readAggTrades(
  path: string,
  spec: SymbolSpec,
  opt: ReadAggOptions,
): Promise<AggFileSummary> {
  const t: AggTrade = { a: 0, px: 0, q: 0, f: 0, l: 0, T: 0, m: false };
  let curDay = -1;
  let stats: DayStats | null = null;
  let agg: DayAggregator | null = null;
  const days: { day: number; stats: DayStats }[] = [];
  const pending: AggDayChunk[] = [];
  const close = () => {
    if (stats === null) return;
    days.push({ day: curDay, stats });
    const chunk: AggDayChunk = { day: curDay, stats };
    if (agg) chunk.agg = agg.finish();
    pending.push(chunk);
  };
  // Zeilen werden synchron je Block verarbeitet; fertige Tage werden gesammelt und nach dem Block
  // an den (asynchronen) Verbraucher übergeben.
  let lastA = -1;
  const onRow = (text: string, s: number, e: number) => {
    parseAggTradeRange(text, s, e, spec, t);
    const d = dayIndex(t.T);
    if (d !== curDay) {
      if (d < opt.firstDay || d > opt.lastDay) {
        throw new ParseError(
          `transact_time ${t.T} (${formatDay(d)}) liegt außerhalb des Dateizeitraums ${formatDay(opt.firstDay)}…${formatDay(opt.lastDay)}`,
        );
      }
      if (d < curDay)
        throw new ParseError(`UTC-Tag läuft zurück: ${formatDay(d)} nach ${formatDay(curDay)}`);
      if (opt.stopAfterDay !== undefined && d > opt.stopAfterDay) throw new StopReading();
      close();
      curDay = d;
      stats = new DayStats();
      agg = opt.want(d) ? new DayAggregator(d) : null;
    }
    if (t.a <= lastA)
      throw new ParseError(`aggId ${t.a} nicht aufsteigend (vorher ${lastA}): Duplikat/Umordnung`);
    lastA = t.a;
    stats!.add(t.a, t.T, t.f, t.l);
    if (agg) agg.add(t);
  };
  let headerSeen = false;
  let summary = { headerPresent: false, rows: 0, complete: true };
  try {
    const r = await forEachRow(
      path,
      'aggTrades',
      onRow,
      async () => {
        while (pending.length > 0) await opt.onDay(pending.shift()!);
      },
      (h) => {
        headerSeen = h;
        opt.onHeader?.(h);
      },
    );
    summary = { ...r, complete: true };
  } catch (e) {
    if (!(e instanceof StopReading)) throw e;
    summary.complete = false;
    summary.headerPresent = headerSeen;
  }
  close();
  while (pending.length > 0) await opt.onDay(pending.shift()!);
  return {
    headerPresent: summary.headerPresent,
    rows: summary.rows,
    days,
    complete: summary.complete,
  };
}

/**
 * Iteriert die Datenzeilen eines CSV-ZIPs: `onRow(text, start, end, lineNo)` je Zeile (synchron,
 * ohne Teilstrings), `afterBlock` nach jedem Block (asynchron, Gegendruck zum Verbraucher).
 * Kopfzeile wird erkannt (alte Dumps ohne, neue mit), leere Zeilen nur am Dateiende.
 */
async function forEachRow(
  path: string,
  kind: 'aggTrades' | 'klines',
  onRow: (text: string, start: number, end: number, lineNo: number) => void,
  afterBlock?: () => Promise<void>,
  onHeader?: (present: boolean) => void,
): Promise<{ headerPresent: boolean; rows: number }> {
  let lineNo = 0;
  let headerPresent = false;
  let first = true;
  let rows = 0;
  let emptyAt = 0;
  for await (const { text, lineEnd } of textBlocks(streamSingleEntry(path))) {
    let p = 0;
    while (p < lineEnd) {
      const nl = text.indexOf('\n', p);
      let e = nl;
      if (e > p && text.charCodeAt(e - 1) === 13) e--;
      lineNo++;
      if (first) {
        first = false;
        let s = p;
        if (text.charCodeAt(s) === 0xef) s += 3;
        try {
          headerPresent = detectHeader(text.slice(s, e), kind);
        } catch (err) {
          throw lineError(path, lineNo, err);
        }
        onHeader?.(headerPresent);
        if (headerPresent) {
          p = nl + 1;
          continue;
        }
        p = s;
      }
      if (e === p) {
        if (emptyAt === 0) emptyAt = lineNo;
        p = nl + 1;
        continue;
      }
      if (emptyAt !== 0)
        throw new InputError(`${path}:${emptyAt}: leere Zeile mitten in der Datei`);
      try {
        onRow(text, p, e, lineNo);
      } catch (err) {
        throw lineError(path, lineNo, err);
      }
      rows++;
      p = nl + 1;
    }
    if (afterBlock) await afterBlock();
  }
  if (first) throw new InputError(`${path}: Datei ist leer`);
  return { headerPresent, rows };
}
