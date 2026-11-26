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
//
// Digest-Version (data_day.digest_version, Migration 0017): 1 = die zwölf Tabellen bis P4;
// 2 = zusätzlich big_order und die Ordersummen des Tages (`order_day`: data_day.orders_n,
// orders_notional, big_floor_n). Ein gespeicherter Digest wird immer gegen SEINE Version geprüft
// (SQL `day_digest_all_v`); ein Tag mit Version < DIGEST_VERSION hat keine Order-Daten und wird
// beim nächsten Import neu geschrieben.
import { createHash, type Hash } from 'node:crypto';
import type { Bar } from './aggregation/bar.ts';
import type { BigOrder } from './aggregation/day.ts';
import type { FpTable } from './aggregation/fp.ts';
import type { FpTableName } from './aggregation/rollup.ts';
import type { Kline } from './parser/csv.ts';
import type { ReconcileResult } from './classifier/reconcile.ts';
import { formatDay, pgTimestamptz, pgTimestamptzMs } from './time.ts';

/** Aktuelle Digest-Version (data_day.digest_version), siehe Kopf. */
export const DIGEST_VERSION = 2;

export type HypertableName =
  FpTableName | 'bar_1m' | 'bar_1h' | 'bar_1d' | 'kline_1m' | 'big_order';
/** Teil des Tages-Digests: eine Tabelle oder die Ordersummen des Tages aus data_day. */
export type DigestTable = HypertableName | 'order_day';

/** Digest-Teile der Version 1 (bis P4), Reihenfolge wie `day_digest_all_v(…, 1)`. */
export const DIGEST_TABLES_V1: readonly DigestTable[] = [
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

/**
 * Reihenfolge der Teile im kombinierten Tages-Digest der aktuellen Version (identisch in SQL
 * `day_digest_all` = `day_digest_all_v(…, 2)`).
 */
export const DIGEST_TABLES: readonly DigestTable[] = [
  ...DIGEST_TABLES_V1,
  'big_order',
  'order_day',
];

/**
 * Hypertables mit Tagesdaten (der Importer ersetzt den Tag in allen; Columnstore-Pflege). Ohne
 * `order_day`, das in data_day liegt.
 */
export const DATA_HYPERTABLES: readonly HypertableName[] = DIGEST_TABLES.filter(
  (t): t is HypertableName => t !== 'order_day',
);

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
  big_order: 'sym_id, ts, first_agg_id, last_agg_id, side, px_first, px_last, qty, notional, agg_n',
  order_day: 'sym_id, day, orders_n, orders_notional, big_floor_n',
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

/** Zeilentextform einer big_order-Zeile (= ROW(<DIGEST_COLUMNS.big_order>)::text in UTC). */
export function bigOrderLine(symId: number, o: BigOrder): string {
  return (
    `(${symId},"${pgTimestamptzMs(o.ts)}",${o.firstAggId},${o.lastAggId},${o.side},` +
    `${o.pxFirst},${o.pxLast},${o.qty},${o.notional},${o.aggN})`
  );
}

/** big_order nach Primärschlüssel (ts, first_agg_id) sortiert. */
export function bigOrderDigest(symId: number, rows: readonly BigOrder[]): string {
  const h = new LineHasher();
  let lastTs = -1;
  let lastA = -1;
  for (const o of rows) {
    if (o.ts < lastTs || (o.ts === lastTs && o.firstAggId <= lastA))
      throw new Error('bigOrderDigest: Zeilen nicht nach (ts, first_agg_id) sortiert');
    lastTs = o.ts;
    lastA = o.firstAggId;
    h.line(bigOrderLine(symId, o));
  }
  return h.hex();
}

/**
 * Ordersummen des Tages (data_day.orders_n, orders_notional, big_floor_n) als eine Zeile; NULL
 * (keine Untergrenze) erscheint wie in der Postgres-Zeilentextform als leeres Feld.
 */
export function orderDayDigest(
  symId: number,
  day: number,
  o: { ordersN: number; ordersNotional: bigint; bigFloorN: number | null },
): string {
  const h = new LineHasher();
  h.line(`(${symId},${formatDay(day)},${o.ordersN},${o.ordersNotional},${o.bigFloorN ?? ''})`);
  return h.hex();
}

/**
 * Kombinierter Tages-Digest aus den Teil-Digests (SQL: `day_digest_all_v`); Standard ist die
 * aktuelle Version.
 */
export function combineDigests(
  perTable: Partial<Record<DigestTable, string>>,
  version: number = DIGEST_VERSION,
): string {
  const parts = version === 1 ? DIGEST_TABLES_V1 : version === 2 ? DIGEST_TABLES : null;
  if (!parts) throw new Error(`combineDigests: unbekannte Digest-Version ${version}`);
  const h = createHash('sha256');
  h.update(
    parts
      .map((t) => {
        const d = perTable[t];
        if (d === undefined) throw new Error(`combineDigests: Digest für ${t} fehlt`);
        return `${t}:${d}`;
      })
      .join('\n'),
    'utf8',
  );
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

/**
 * Digest der eigenen Klassen (ownCls: ohne Randvorbehalt) mit D und s je Minute. Hängt nur von den
 * Daten des Tages und dem verwendeten Übertrag s(−1) ab, nicht davon, ob der Folgetag schon
 * abgeglichen ist – daher als data_day.quality_digest gespeichert und Teil von „fertig" (Review N3).
 */
export function ownQualityDigest(r: ReconcileResult): string {
  const h = new LineHasher();
  for (let m = 0; m < r.ownCls.length; m++) {
    h.line(`${m},${r.ownCls[m]},${r.dQ[m]},${r.dB[m]},${r.sQ[m]},${r.sB[m]}`);
  }
  return h.hex();
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
