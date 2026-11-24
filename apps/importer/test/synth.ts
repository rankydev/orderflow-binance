// Synthetisches Rohdatenarchiv (tmp, Vision-Layout) für Ende-zu-Ende-Tests: ein Monat mit je
// einem Einzel-Fill-Trade pro Minute und Straddlern (Mehrfach-Fill nahe der Minutengrenze) in
// Minute 100, 1439 und an jedem 5. Tag in Minute 0. Klines entstehen aus den Fills nach eigener
// Zeit (wie bei Binance), aggTrades-Tages- und Monatsdateien aus denselben Zeilen.
import { DAY_MS, formatDay, formatDecimal, MINUTE_MS, monthDays, parseDay } from '@orderflow/core';
import { putVisionFile, tmpDir } from './helpers.ts';

const HEAD =
  'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker';
const KHEAD =
  'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore';

interface Row {
  a: number;
  px: number;
  q: number;
  f: number;
  l: number;
  T: number;
  m: boolean;
  fills: [number, number][]; // [Zeit, Menge]
}

/** Synthetischer Monat: je Minute ein Einzel-Fill-Trade; Straddler in Minute 100 und 1439 jedes Tages. */
function synthMonth(
  month: string,
  holeOnDay?: number,
  straddleAllDay?: number,
  nearBoundary = false,
): { rows: Row[]; first: number; last: number } {
  const [first, last] = monthDays(month);
  const rows: Row[] = [];
  let a = 1_000_000;
  let tid = 5_000_000;
  for (let d = first; d <= last; d++) {
    for (let m = 0; m < 1440; m++) {
      const t0 = d * DAY_MS + m * MINUTE_MS;
      const px = 6_000_000 + ((m * 7) % 50) * 10;
      const q = 1 + (m % 7);
      rows.push({
        a: a++,
        px,
        q,
        f: tid,
        l: tid,
        T: t0 + 30_000,
        m: m % 3 === 0,
        fills: [[t0 + 30_000, q]],
      });
      tid++;
      if (nearBoundary && m === 200) {
        // Mehrfach-Fill mit T mod 60 000 = 59 850 (unter der Kandidatengrenze 59 900, beide Fills in m)
        const T = t0 + 59_850;
        rows.push({
          a: a++,
          px,
          q: 6,
          f: tid,
          l: tid + 1,
          T,
          m: true,
          fills: [
            [T, 2],
            [T + 40, 4],
          ],
        });
        tid += 2;
      }
      if (m === 100 || m === 1439 || (m === 0 && d % 5 === 0) || d === straddleAllDay) {
        // Mehrfach-Fill nahe der Grenze: 4 Lots in m, 9 Lots in m+1 (über Mitternacht bei m = 1439)
        const T = t0 + 59_950;
        rows.push({
          a: a++,
          px: px + 10,
          q: 13,
          f: tid,
          l: tid + 1,
          T,
          m: false,
          fills: [
            [T, 4],
            [T + 70, 9],
          ],
        });
        tid += 2;
      }
    }
    if (holeOnDay === d) a += 3; // aggId-Loch am Tagesende
  }
  return { rows, first, last };
}

const csvRow = (r: Row) =>
  `${r.a},${formatDecimal(r.px, 2)},${formatDecimal(r.q, 3)},${r.f},${r.l},${r.T},${r.m}`;

function klineCsv(rows: Row[], day: number): string {
  const per = new Map<
    number,
    {
      o: number;
      h: number;
      l: number;
      c: number;
      v: number;
      tb: number;
      n: number;
      qv: number;
      tq: number;
    }
  >();
  for (const r of rows) {
    for (const [ft, fq] of r.fills) {
      if (Math.floor(ft / DAY_MS) !== day) continue;
      const m = ft - (ft % MINUTE_MS);
      const k = per.get(m) ?? {
        o: r.px,
        h: r.px,
        l: r.px,
        c: r.px,
        v: 0,
        tb: 0,
        n: 0,
        qv: 0,
        tq: 0,
      };
      k.h = Math.max(k.h, r.px);
      k.l = Math.min(k.l, r.px);
      k.c = r.px;
      k.v += fq;
      k.n++;
      k.qv += r.px * fq;
      if (!r.m) {
        k.tb += fq;
        k.tq += r.px * fq;
      }
      per.set(m, k);
    }
  }
  const lines = [KHEAD];
  for (const [m, k] of [...per].sort((x, y) => x[0] - y[0])) {
    lines.push(
      [
        m,
        formatDecimal(k.o, 2),
        formatDecimal(k.h, 2),
        formatDecimal(k.l, 2),
        formatDecimal(k.c, 2),
        formatDecimal(k.v, 3),
        m + 59_999,
        formatDecimal(k.qv, 5),
        k.n,
        formatDecimal(k.tb, 3),
        formatDecimal(k.tq, 5),
        0,
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export interface ArchiveOptions {
  dailyDays?: string[];
  monthly?: boolean;
  holeOnDay?: number;
  /** Tag, der in der Monatsdatei fehlt. */
  dropFromMonthly?: string;
  /** Tagesdatei nur mit Kopfzeile. */
  emptyDaily?: string;
  /** aggTrades dieser Minute fehlen (Klines behalten ihr Volumen) → missing. */
  dropAggMinute?: { day: string; minute: number };
  /** Straddler in jeder Minute dieses Tages: keine kandidatenfreie Minute, s(−1) nicht schätzbar. */
  straddleAllDay?: string;
  /** Mehrfach-Fill knapp unter der Kandidatengrenze in Minute 200 jedes Tages. */
  nearBoundary?: boolean;
}

export function archive(opts: ArchiveOptions = {}) {
  const dir = tmpDir('arch-');
  const {
    rows: all,
    first,
    last,
  } = synthMonth(
    '2026-09',
    opts.holeOnDay,
    opts.straddleAllDay ? parseDay(opts.straddleAllDay) : undefined,
    opts.nearBoundary ?? false,
  );
  const drop = opts.dropAggMinute;
  const dropStart = drop ? parseDay(drop.day) * DAY_MS + drop.minute * MINUTE_MS : -1;
  const rows = all.filter((r) => !(r.T >= dropStart && r.T < dropStart + MINUTE_MS));
  const byDay = new Map<number, Row[]>();
  for (const r of rows) {
    const d = Math.floor(r.T / DAY_MS);
    byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  for (let d = first; d <= last; d++) {
    putVisionFile(
      dir,
      `futures/um/daily/klines/BTCUSDT/1m/BTCUSDT-1m-${formatDay(d)}.zip`,
      klineCsv(all, d),
    );
  }
  for (const ds of opts.dailyDays ?? []) {
    const d = parseDay(ds);
    putVisionFile(
      dir,
      `futures/um/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-${ds}.zip`,
      [HEAD, ...byDay.get(d)!.map(csvRow)].join('\n') + '\n',
    );
  }
  if (opts.emptyDaily) {
    putVisionFile(
      dir,
      `futures/um/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-${opts.emptyDaily}.zip`,
      HEAD + '\n',
    );
  }
  if (opts.monthly !== false) {
    const skip = opts.dropFromMonthly ? parseDay(opts.dropFromMonthly) : -1;
    putVisionFile(
      dir,
      'futures/um/monthly/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2026-09.zip',
      [HEAD, ...rows.filter((r) => Math.floor(r.T / DAY_MS) !== skip).map(csvRow)].join('\n') +
        '\n',
    );
  }
  return dir;
}
