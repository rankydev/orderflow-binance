// Postgres-Schreiber (KONZEPT §4.3). UNGETESTET bis eine Datenbank verfügbar ist (Docker fehlte bei
// der Implementierung); Integrationstest: apps/importer/test/pgwriter.int.test.ts (`npm run test:db`).
//
// Ablauf je Tag (Parse und Checksum sind zu diesem Zeitpunkt bereits vollständig erfolgreich):
//  1. Transaktion A: data_day → 'importing' (Zeile anlegen oder umstellen; vorheriger Zustand gemerkt).
//  2. Transaktion B: betroffene Chunks entpacken (falls komprimiert) → DELETE des Tages in allen
//     Tabellen → COPY fp_1m, Rollups, bar_1m/1h/1d, kline_1m → data_minute_issue, raw_file, raw_day,
//     symbol_tick_history → day_digest_all (SQL) muss dem TS-Digest gleichen → data_day final_* mit
//     version + 1 → COMMIT.
//  3. Fehler in B: Rollback; data_day zurück auf den vorherigen Zustand (bzw. provisional_import_failed).
// Single Writer: Session-Advisory-Lock für den ganzen Prozess (pg_try_advisory_lock), eine Verbindung.
import {
  checkStateOf,
  DAY_MS,
  DIGEST_TABLES,
  formatDay,
  FP_TABLES,
  MinuteClass,
  MINUTE_MS,
  pgTimestamptz,
  SOURCE_VISION,
  unitString,
  type Bar,
  type DayManifest,
  type DbConfig,
  type FileManifest,
  type FpTable,
  type Kline,
  type ReconcileResult,
  type SymbolSpec,
} from '@orderflow/core';
import { connect, type Sql } from '@orderflow/db';
import type { TransactionSql } from 'postgres';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  stateOf,
  type DayWrite,
  type DayWriter,
  type EdgeUpdate,
  type WriteOutcome,
} from './types.ts';

/** Fester Schlüssel: höchstens ein Importer je Datenbank (Single Writer, §2.1/§4.3). */
export const IMPORTER_LOCK_KEY = 7_042_025;

const FP_COLS = 'sym_id, ts, px, buy_q, sell_q, buy_a, sell_a';
const BAR_COLS =
  'sym_id, ts, open_px, high_px, low_px, close_px, buy_q, sell_q, buy_a, sell_a, notional, ' +
  'first_agg_id, last_agg_id, first_trade_ms, last_trade_ms, run_max, run_min, d_from_low, d_from_high';
const KLINE_COLS =
  'sym_id, ts, open_px, high_px, low_px, close_px, vol, taker_buy, trades, quote_vol_n';

type Tx = Sql | TransactionSql;

function* fpLines(symId: number, t: FpTable): Generator<string> {
  let buf: string[] = [];
  for (let i = 0; i < t.n; i++) {
    buf.push(
      `${symId}\t${pgTimestamptz(t.ts[i]!)}\t${t.px[i]}\t${t.buyQ[i]}\t${t.sellQ[i]}\t${t.buyA[i]}\t${t.sellA[i]}\n`,
    );
    if (buf.length >= 8192) {
      yield buf.join('');
      buf = [];
    }
  }
  if (buf.length) yield buf.join('');
}

function barLine(symId: number, b: Bar): string {
  return (
    `${symId}\t${pgTimestamptz(b.ts)}\t${b.open}\t${b.high}\t${b.low}\t${b.close}\t${b.buyQ}\t${b.sellQ}\t` +
    `${b.buyA}\t${b.sellA}\t${b.notional}\t${b.firstAggId}\t${b.lastAggId}\t${b.firstTradeMs}\t` +
    `${b.lastTradeMs}\t${b.runMax}\t${b.runMin}\t${b.dFromLow}\t${b.dFromHigh}`
  );
}

function* bar1mLines(
  symId: number,
  bars: readonly Bar[],
  recon: ReconcileResult,
): Generator<string> {
  const lines: string[] = [];
  for (const b of bars) {
    const m = ((b.ts % DAY_MS) - (b.ts % MINUTE_MS)) / MINUTE_MS;
    const cs = checkStateOf(recon.cls[m] as 1 | 2 | 3 | 4 | 5);
    lines.push(`${barLine(symId, b)}\t${SOURCE_VISION}\t${cs}\n`);
  }
  yield lines.join('');
}

function* barLines(symId: number, bars: readonly Bar[]): Generator<string> {
  yield bars.map((b) => `${barLine(symId, b)}\n`).join('');
}

function* klineLines(symId: number, ks: readonly Kline[]): Generator<string> {
  yield ks
    .map(
      (k) =>
        `${symId}\t${pgTimestamptz(k.openTime)}\t${k.open}\t${k.high}\t${k.low}\t${k.close}\t` +
        `${k.vol}\t${k.takerBuy}\t${k.trades}\t${k.quoteVolN}\n`,
    )
    .join('');
}

async function copyInto(
  tx: Tx,
  table: string,
  cols: string,
  lines: Iterable<string>,
): Promise<void> {
  const w = await tx.unsafe(`COPY ${table} (${cols}) FROM STDIN`).writable();
  await pipeline(Readable.from(lines), w);
}

const ISSUE_KIND: Record<number, string> = {
  [MinuteClass.shift]: 'shift',
  [MinuteClass.mismatch]: 'mismatch',
  [MinuteClass.missing]: 'missing',
};

function issueRows(
  symId: number,
  day: number,
  r: ReconcileResult,
  inp: { candQ: Float64Array; candB: Float64Array },
  only?: number,
) {
  const rows = [];
  for (let m = 0; m < 1440; m++) {
    if (only !== undefined && m !== only) continue;
    const kind = ISSUE_KIND[only !== undefined ? r.ownCls[m]! : r.cls[m]!];
    if (!kind) continue;
    rows.push({
      sym_id: symId,
      ts: new Date(day * DAY_MS + m * MINUTE_MS),
      kind,
      d_q: r.dQ[m]!,
      d_b: r.dB[m]!,
      cand_q: inp.candQ[m]!,
      cand_b: inp.candB[m]!,
      carry_q: r.sQ[m]!,
      carry_b: r.sB[m]!,
    });
  }
  return rows;
}

export class PostgresWriter implements DayWriter {
  readonly kind = 'postgres' as const;
  private sql: Sql | null = null;
  private readonly cfg: DbConfig;
  private readonly spec: SymbolSpec;

  constructor(cfg: DbConfig, spec: SymbolSpec) {
    this.cfg = cfg;
    this.spec = spec;
  }

  private get db(): Sql {
    if (!this.sql) throw new Error('PostgresWriter nicht geöffnet');
    return this.sql;
  }

  async open(): Promise<void> {
    this.sql = connect(this.cfg);
    const [l] = await this.db`SELECT pg_try_advisory_lock(${IMPORTER_LOCK_KEY}) AS ok`;
    if (!l?.ok) {
      await this.sql.end();
      this.sql = null;
      throw new Error('Ein anderer Importer hält den Schreib-Lock (Single Writer); Abbruch');
    }
    const s = this.spec;
    await this.db`
      INSERT INTO symbol (sym_id, name, price_unit, price_decimals, tick_ref_units, qty_unit, qty_decimals, data_from)
      VALUES (${s.symId}, ${s.name}, ${unitString(s.priceDecimals)}::numeric, ${s.priceDecimals},
              ${s.tickRefUnits}, ${unitString(s.qtyDecimals)}::numeric, ${s.qtyDecimals}, ${s.dataFrom}::date)
      ON CONFLICT (sym_id) DO NOTHING`;
    const [row] = await this.db`
      SELECT name, price_unit::text AS pu, price_decimals, tick_ref_units, qty_unit::text AS qu, qty_decimals
        FROM symbol WHERE sym_id = ${s.symId}`;
    if (
      !row ||
      row.name !== s.name ||
      row.pu !== unitString(s.priceDecimals) ||
      row.price_decimals !== s.priceDecimals ||
      row.tick_ref_units !== s.tickRefUnits ||
      row.qu !== unitString(s.qtyDecimals) ||
      row.qty_decimals !== s.qtyDecimals
    ) {
      throw new Error(
        `Tabelle symbol (sym_id ${s.symId}) passt nicht zu den Einheiten im Code: ${JSON.stringify(row)}`,
      );
    }
  }

  async close(): Promise<void> {
    if (!this.sql) return;
    await this.sql`SELECT pg_advisory_unlock(${IMPORTER_LOCK_KEY})`;
    await this.sql.end();
    this.sql = null;
  }

  async isDone(
    _symbol: string,
    day: number,
    aggSha256: string,
    importerVersion: string,
  ): Promise<boolean> {
    const [r] = await this.db`
      SELECT state, raw_sha256, importer_version FROM data_day
       WHERE sym_id = ${this.spec.symId} AND day = ${formatDay(day)}::date`;
    return (
      !!r &&
      (r.state === 'final_ok' || r.state === 'final_bad') &&
      r.raw_sha256 === aggSha256 &&
      r.importer_version === importerVersion
    );
  }

  private async decompressDay(tx: Tx, from: Date, to: Date): Promise<void> {
    const tables = [...DIGEST_TABLES];
    const chunks = await tx`
      SELECT format('%I.%I', chunk_schema, chunk_name) AS c
        FROM timescaledb_information.chunks
       WHERE hypertable_schema = 'public' AND hypertable_name = ANY(${tables}::text[])
         AND is_compressed AND range_start < ${to} AND range_end > ${from}`;
    for (const c of chunks)
      await tx`SELECT decompress_chunk(${c.c as string}::regclass, if_compressed => true)`;
  }

  private async upsertFile(tx: Tx, f: FileManifest): Promise<void> {
    await tx`
      INSERT INTO raw_file (path, sym_id, kind, origin, period, bytes, sha256, checksum_expected, checksum_ok,
                            header_present, downloaded_at, importer_version)
      VALUES (${f.path}, ${this.spec.symId}, ${f.kind}, ${f.origin}, ${f.period}, ${f.bytes}, ${f.sha256},
              ${f.checksumExpected}, ${f.checksumOk}, ${f.headerPresent}, ${f.downloadedAt}, ${f.importerVersion})
      ON CONFLICT (path) DO UPDATE SET bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
        checksum_expected = EXCLUDED.checksum_expected, checksum_ok = EXCLUDED.checksum_ok,
        header_present = EXCLUDED.header_present, downloaded_at = EXCLUDED.downloaded_at,
        importer_version = EXCLUDED.importer_version`;
  }

  private async upsertRawDay(tx: Tx, d: DayManifest): Promise<void> {
    const ts = (v: number | null) => (v === null ? null : new Date(v));
    await tx`
      INSERT INTO raw_day (sym_id, kind, day, origin, origin_path, origin_sha256, rows, first_agg_id, last_agg_id,
                           agg_id_holes, agg_id_dups, ts_backwards, continues_prev, first_ts, last_ts,
                           header_present, downloaded_at, importer_version)
      VALUES (${this.spec.symId}, ${d.kind}, ${d.day}::date, ${d.origin}, ${d.originPath}, ${d.originSha256}, ${d.rows},
              ${d.firstAggId}, ${d.lastAggId}, ${d.aggIdHoles}, ${d.aggIdDups}, ${d.tsBackwards}, ${d.continuesPrev},
              ${ts(d.firstTs)}, ${ts(d.lastTs)}, ${d.headerPresent}, ${d.downloadedAt}, ${d.importerVersion})
      ON CONFLICT (sym_id, kind, day) DO UPDATE SET origin = EXCLUDED.origin, origin_path = EXCLUDED.origin_path,
        origin_sha256 = EXCLUDED.origin_sha256, rows = EXCLUDED.rows, first_agg_id = EXCLUDED.first_agg_id,
        last_agg_id = EXCLUDED.last_agg_id, agg_id_holes = EXCLUDED.agg_id_holes, agg_id_dups = EXCLUDED.agg_id_dups,
        ts_backwards = EXCLUDED.ts_backwards, continues_prev = EXCLUDED.continues_prev, first_ts = EXCLUDED.first_ts,
        last_ts = EXCLUDED.last_ts, header_present = EXCLUDED.header_present, downloaded_at = EXCLUDED.downloaded_at,
        importer_version = EXCLUDED.importer_version`;
  }

  async writeDay(w: DayWrite): Promise<WriteOutcome> {
    const { data, recon } = w;
    const symId = this.spec.symId;
    const dayStr = data.dayStr;
    const from = new Date(data.day * DAY_MS);
    const to = new Date((data.day + 1) * DAY_MS);
    const state = stateOf(recon, w.extraBad);

    const prev = await this.db.begin(async (tx) => {
      const [r] =
        await tx`SELECT state FROM data_day WHERE sym_id = ${symId} AND day = ${dayStr}::date FOR UPDATE`;
      if (r)
        await tx`UPDATE data_day SET state = 'importing' WHERE sym_id = ${symId} AND day = ${dayStr}::date`;
      else
        await tx`INSERT INTO data_day (sym_id, day, state) VALUES (${symId}, ${dayStr}::date, 'importing')`;
      return (r?.state as string | undefined) ?? null;
    });

    try {
      return await this.db.begin(async (tx) => {
        await this.decompressDay(tx, from, to);
        for (const t of DIGEST_TABLES) {
          await tx.unsafe(`DELETE FROM ${t} WHERE sym_id = $1 AND ts >= $2 AND ts < $3`, [
            symId,
            from,
            to,
          ]);
        }
        await tx`DELETE FROM data_minute_issue WHERE sym_id = ${symId} AND ts >= ${from} AND ts < ${to}`;
        for (const t of FP_TABLES) await copyInto(tx, t, FP_COLS, fpLines(symId, data.fp[t]));
        await copyInto(
          tx,
          'bar_1m',
          `${BAR_COLS}, source, check_state`,
          bar1mLines(symId, data.bar_1m, recon),
        );
        await copyInto(tx, 'bar_1h', BAR_COLS, barLines(symId, data.bar_1h));
        await copyInto(tx, 'bar_1d', BAR_COLS, barLines(symId, data.bar_1d));
        await copyInto(tx, 'kline_1m', KLINE_COLS, klineLines(symId, data.klines));
        const issues = issueRows(symId, data.day, recon, data.reconcileInput);
        if (issues.length) await tx`INSERT INTO data_minute_issue ${tx(issues)}`;
        await this.upsertFile(tx, w.aggFile);
        await this.upsertFile(tx, w.klineFile);
        await this.upsertRawDay(tx, w.aggManifest);
        await this.upsertRawDay(tx, w.klineManifest);
        if (data.agg.minStepUnits > 0) {
          await tx`
            INSERT INTO symbol_tick_history (sym_id, day, min_step_units)
            VALUES (${symId}, ${dayStr}::date, ${data.agg.minStepUnits})
            ON CONFLICT (sym_id, day) DO UPDATE SET min_step_units = EXCLUDED.min_step_units`;
        }
        const [dg] = await tx`SELECT day_digest_all(${symId}::smallint, ${dayStr}::date) AS d`;
        const dbDigest = dg?.d as string;
        if (dbDigest !== data.digest) {
          const per = await tx.unsafe(
            `SELECT t, day_digest(t, $1::smallint, $2::date) AS d FROM unnest($3::text[]) AS t`,
            [symId, dayStr, [...DIGEST_TABLES]],
          );
          const diff = per
            .filter((r) => r.d !== data.digests[r.t as keyof typeof data.digests])
            .map((r) => r.t);
          throw new Error(`Digest-Abweichung DB ↔ Importer für ${dayStr}: ${diff.join(', ')}`);
        }
        const c = recon.counts;
        const [v] = await tx`
          UPDATE data_day SET state = ${state}, version = version + 1, source = 'vision',
                 raw_sha256 = ${w.aggFile.sha256}, rows = ${w.aggManifest.rows},
                 first_agg_id = ${w.aggManifest.firstAggId}, last_agg_id = ${w.aggManifest.lastAggId},
                 min_exact = ${c.exact}, min_shift = ${c.shift}, min_mismatch = ${c.mismatch},
                 min_missing = ${c.missing}, min_gap = 0, edge_pending = ${c.edge_pending > 0},
                 digest = ${data.digest}, importer_version = ${w.importerVersion}, imported_at = now()
           WHERE sym_id = ${symId} AND day = ${dayStr}::date
          RETURNING version`;
        return { dbDigest, state, version: (v?.version as number) ?? null };
      });
    } catch (e) {
      const restore =
        prev === 'final_ok' || prev === 'final_bad'
          ? prev
          : prev === null
            ? null
            : 'provisional_import_failed';
      if (restore === null) {
        await this
          .db`DELETE FROM data_day WHERE sym_id = ${symId} AND day = ${dayStr}::date AND state = 'importing'`;
      } else {
        await this
          .db`UPDATE data_day SET state = ${restore} WHERE sym_id = ${symId} AND day = ${dayStr}::date`;
      }
      throw e;
    }
  }

  async resolveEdge(e: EdgeUpdate): Promise<boolean> {
    const symId = e.symId;
    const dayStr = formatDay(e.day);
    const ts = new Date(e.day * DAY_MS + e.minute * MINUTE_MS);
    const cls = e.recon.ownCls[e.minute]! as 1 | 2 | 3 | 5;
    return this.db.begin(async (tx) => {
      const [dd] = await tx`
        SELECT state, edge_pending FROM data_day WHERE sym_id = ${symId} AND day = ${dayStr}::date FOR UPDATE`;
      if (!dd || !dd.edge_pending || (dd.state !== 'final_ok' && dd.state !== 'final_bad'))
        return false;
      const [b] = await tx`SELECT check_state FROM bar_1m WHERE sym_id = ${symId} AND ts = ${ts}`;
      if (!b || b.check_state !== MinuteClass.edge_pending) return false;
      await tx`UPDATE bar_1m SET check_state = ${checkStateOf(cls)} WHERE sym_id = ${symId} AND ts = ${ts}`;
      await tx`DELETE FROM data_minute_issue WHERE sym_id = ${symId} AND ts = ${ts}`;
      const rows = issueRows(symId, e.day, e.recon, e.cand, e.minute);
      if (rows.length) await tx`INSERT INTO data_minute_issue ${tx(rows)}`;
      const col = { 1: 'min_exact', 2: 'min_shift', 3: 'min_mismatch', 5: 'min_missing' }[cls];
      const bad = cls === MinuteClass.mismatch || cls === MinuteClass.missing;
      await tx.unsafe(
        `UPDATE data_day SET ${col} = coalesce(${col}, 0) + 1,
                state = CASE WHEN $3 THEN 'final_bad' ELSE state END,
                edge_pending = EXISTS (SELECT 1 FROM bar_1m WHERE sym_id = $1 AND ts >= $4 AND ts < $5 AND check_state = 4)
          WHERE sym_id = $1 AND day = $2::date`,
        [symId, dayStr, bad, new Date(e.day * DAY_MS), new Date((e.day + 1) * DAY_MS)],
      );
      return true;
    });
  }
}
