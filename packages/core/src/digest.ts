// Tages-Digests (KONZEPT §4.8): je (Tabelle, Symbol, Tag) SHA256 über die nach Primärschlüssel
// sortierten Zeilen in kanonischer Textform. Die Textform ist exakt die Postgres-Zeilentextform
// `ROW(<Spalten>)::text` bei timezone = UTC, datestyle = ISO (siehe Migration 0005, `day_digest`):
//   (1,"2026-11-20 00:00:00+00",6195920,1516,0,1,0)
// Zeilen werden mit '\n' verbunden (ohne abschließendes '\n'); leerer Tag = SHA256 des Leerstrings.
// Damit ist der TS-Digest ohne Datenbank berechenbar und der Postgres-Writer kann ihn in der
// Import-Transaktion gegen `day_digest_all` prüfen.
//
// Nicht im Digest: bar_1m.check_state. Die Klassifikation ist eine Prüfaussage über die Daten,
// keine Daten; sie ändert sich, wenn ein Nachbartag abgeglichen wird (edge_pending → exact/shift),
// ohne dass die Daten sich ändern. Sie hat einen eigenen Digest (`qualityDigest`).
import { createHash, type Hash } from 'node:crypto';
import type { Bar } from './aggregation/bar.ts';
import type { FpTable } from './aggregation/fp.ts';
import type { FpTableName } from './aggregation/rollup.ts';
import type { Kline } from './parser/csv.ts';
import type { ReconcileResult } from './classifier/reconcile.ts';
import { pgTimestamptz } from './time.ts';

export type DigestTable = FpTableName | 'bar_1m' | 'bar_1h' | 'bar_1d' | 'kline_1m';

/** Reihenfolge der Tabellen im kombinierten Tages-Digest (identisch in SQL `day_digest_all`). */
export const DIGEST_TABLES: readonly DigestTable[] = [
  'fp_1m',
  'fp_1m_b10',
  'fp_5m_b10',
  'fp_15m_b100',
  'fp_1h_b10',
  'fp_1h_b100',
  'fp_1d_b100',
  'fp_1d_b1000',
  'bar_1m',
  'bar_1h',
  'bar_1d',
  'kline_1m',
];

const FP_COLUMNS = 'sym_id, ts, px, buy_q, sell_q, buy_a, sell_a';
const BAR_COLUMNS =
  'sym_id, ts, open_px, high_px, low_px, close_px, buy_q, sell_q, buy_a, sell_a, notional, ' +
  'first_agg_id, last_agg_id, first_trade_ms, last_trade_ms, run_max, run_min, d_from_low, d_from_high';

/** Spalten je Tabelle in Digest-Reihenfolge (muss mit `day_digest` in Migration 0005 übereinstimmen). */
export const DIGEST_COLUMNS: Record<DigestTable, string> = {
  fp_1m: FP_COLUMNS,
  fp_1m_b10: FP_COLUMNS,
  fp_5m_b10: FP_COLUMNS,
  fp_15m_b100: FP_COLUMNS,
  fp_1h_b10: FP_COLUMNS,
  fp_1h_b100: FP_COLUMNS,
  fp_1d_b100: FP_COLUMNS,
  fp_1d_b1000: FP_COLUMNS,
  bar_1m: `${BAR_COLUMNS}, source`,
  bar_1h: BAR_COLUMNS,
  bar_1d: BAR_COLUMNS,
  kline_1m: 'sym_id, ts, open_px, high_px, low_px, close_px, vol, taker_buy, trades, quote_vol_n',
};

/** Quelle in bar_1m.source (KONZEPT §3.5). */
export const SOURCE_VISION = 3;

class LineHasher {
  private readonly h: Hash = createHash('sha256');
  private buf: string[] = [];
  private first = true;
  line(s: string): void {
    if (!this.first) this.buf.push('\n');
    this.first = false;
    this.buf.push(s);
    if (this.buf.length >= 8192) {
      this.h.update(this.buf.join(''), 'utf8');
      this.buf = [];
    }
  }
  hex(): string {
    if (this.buf.length) this.h.update(this.buf.join(''), 'utf8');
    return this.h.digest('hex');
  }
}

export function fpDigest(symId: number, t: FpTable): string {
  const h = new LineHasher();
  let lastTs = -1;
  let lastPx = -1;
  for (let i = 0; i < t.n; i++) {
    const ts = t.ts[i]!;
    const px = t.px[i]!;
    if (ts < lastTs || (ts === lastTs && px <= lastPx))
      throw new Error('fpDigest: Zeilen nicht nach (ts, px) sortiert');
    lastTs = ts;
    lastPx = px;
    h.line(
      `(${symId},"${pgTimestamptz(ts)}",${px},${t.buyQ[i]},${t.sellQ[i]},${t.buyA[i]},${t.sellA[i]})`,
    );
  }
  return h.hex();
}

function barCols(b: Bar): string {
  return (
    `${b.open},${b.high},${b.low},${b.close},${b.buyQ},${b.sellQ},${b.buyA},${b.sellA},` +
    `${b.notional},${b.firstAggId},${b.lastAggId},${b.firstTradeMs},${b.lastTradeMs},` +
    `${b.runMax},${b.runMin},${b.dFromLow},${b.dFromHigh}`
  );
}

/** bar_1m (mit `source`, ohne `check_state`) bzw. bar_1h/bar_1d (ohne beide), nach ts sortiert. */
export function barDigest(symId: number, bars: readonly Bar[], source?: number): string {
  const h = new LineHasher();
  let last = -1;
  for (const b of bars) {
    if (b.ts <= last) throw new Error('barDigest: Bars nicht nach ts sortiert');
    last = b.ts;
    const tail = source === undefined ? '' : `,${source}`;
    h.line(`(${symId},"${pgTimestamptz(b.ts)}",${barCols(b)}${tail})`);
  }
  return h.hex();
}

export function klineDigest(symId: number, klines: readonly Kline[]): string {
  const h = new LineHasher();
  let last = -1;
  for (const k of klines) {
    if (k.openTime <= last) throw new Error('klineDigest: Klines nicht nach ts sortiert');
    last = k.openTime;
    h.line(
      `(${symId},"${pgTimestamptz(k.openTime)}",${k.open},${k.high},${k.low},${k.close},` +
        `${k.vol},${k.takerBuy},${k.trades},${k.quoteVolN})`,
    );
  }
  return h.hex();
}

/** Kombinierter Tages-Digest aus den Tabellen-Digests (SQL: `day_digest_all`). */
export function combineDigests(perTable: Record<DigestTable, string>): string {
  const h = createHash('sha256');
  h.update(DIGEST_TABLES.map((t) => `${t}:${perTable[t]}`).join('\n'), 'utf8');
  return h.digest('hex');
}

/** Digest der Klassifikation (Minute, Klasse, D, s für q und b) – nicht in der DB, für Vergleiche. */
export function qualityDigest(r: ReconcileResult): string {
  const h = new LineHasher();
  for (let m = 0; m < r.cls.length; m++) {
    h.line(`${m},${r.cls[m]},${r.dQ[m]},${r.dB[m]},${r.sQ[m]},${r.sB[m]}`);
  }
  return h.hex();
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
