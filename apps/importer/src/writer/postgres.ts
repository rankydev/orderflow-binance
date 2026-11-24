// Postgres-Schreiber (KONZEPT §4.3). Integrationstest: apps/importer/test/pgwriter.int.test.ts.
//
// Ablauf je Tag (Parse und Checksum sind zu diesem Zeitpunkt bereits vollständig erfolgreich):
//  1. Transaktion A: Lock prüfen; data_day → 'importing' (anlegen oder umstellen, alter Zustand gemerkt).
//  2. Transaktion B: Lock prüfen → DELETE des Tages in allen Tabellen (direkt, auch auf Columnstore-
//     Chunks; TimescaleDB ≥ 2.18 entpackt nur betroffene Batches) → COPY fp_1m, Rollups,
//     bar_1m/1h/1d, kline_1m → data_minute_issue (eigene Klasse je Minute), raw_file, raw_day,
//     symbol_tick_history → day_digest_all (SQL) muss dem TS-Digest gleichen → data_day final_* mit
//     version + 1, Übertrag und offenen Randminuten → COMMIT.
//  3. Fehler in B: Rollback; data_day zurück auf den vorherigen Zustand (bzw. provisional_import_failed).
// Single Writer: Session-Advisory-Lock auf einer Verbindung ohne max_lifetime/idle_timeout; vor jeder
// Transaktion wird geprüft, dass diese Sitzung ihn noch hält (sonst neu erwerben oder Abbruch).
// Backfill-Modus (§4.1): Columnstore-Jobs pausiert, abgeschlossene Chunks explizit konvertiert.
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
  type MinuteFacts,
  type ResumeKey,
  type StoredChain,
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

/** Eigene Klasse je Minute (auch für noch offene Randminuten; deren check_state bleibt 4). */
function issueRows(
  symId: number,
  day: number,
  r: ReconcileResult,
  inp: { candQ: Float64Array; candB: Float64Array },
) {
  const rows = [];
  for (let m = 0; m < 1440; m++) {
    const kind = ISSUE_KIND[r.ownCls[m]!];
    if (!kind) continue;
    rows.push(
      issueRow(symId, day, m, kind, {
        dQ: r.dQ[m]!,
        dB: r.dB[m]!,
        sQ: r.sQ[m]!,
        sB: r.sB[m]!,
        candQ: inp.candQ[m]!,
        candB: inp.candB[m]!,
      }),
    );
  }
  return rows;
}

function issueRow(symId: number, day: number, m: number, kind: string, f: MinuteFacts) {
  return {
    sym_id: symId,
    ts: new Date(day * DAY_MS + m * MINUTE_MS),
    kind,
    d_q: f.dQ,
    d_b: f.dB,
    cand_q: f.candQ,
    cand_b: f.candB,
    carry_q: f.sQ,
    carry_b: f.sB,
  };
}

const KIND_CODE: Record<string, number> = { shift: 2, mismatch: 3, missing: 5 };
const COUNT_COL: Record<number, string> = {
  1: 'min_exact',
  2: 'min_shift',
  3: 'min_mismatch',
  5: 'min_missing',
};

export interface PostgresWriterOptions {
  /** Backfill-Modus (§4.1): Columnstore-Jobs pausieren, fertige Chunks explizit konvertieren. */
  backfill?: boolean;
  /** Vor dem Ersetzen betroffene Columnstore-Chunks in den Rowstore zurückwandeln (nur Messung). */
  rowstoreBeforeReplace?: boolean;
  log?: (s: string) => void;
}

export class PostgresWriter implements DayWriter {
  readonly kind = 'postgres' as const;
  private sql: Sql | null = null;
  private readonly cfg: DbConfig;
  private readonly spec: SymbolSpec;
  private readonly opt: PostgresWriterOptions;
  private pausedJobs: number[] = [];
  /** Zeitpunkte (ms), bis zu denen Chunks im Backfill konvertiert werden dürfen. */
  private writtenUntil = 0;

  constructor(cfg: DbConfig, spec: SymbolSpec, opt: PostgresWriterOptions = {}) {
    this.cfg = cfg;
    this.spec = spec;
    this.opt = opt;
  }

  /** PID der Writer-Sitzung (für Tests: Verbindungsabbruch simulieren). */
  async backendPid(): Promise<number> {
    const [r] = await this.db`SELECT pg_backend_pid() AS p`;
    return r!.p as number;
  }

  /**
   * Prüft in der laufenden Transaktion, dass diese Sitzung den Importer-Lock hält. Nach einem
   * Verbindungsneuaufbau (Netz, pg_terminate_backend) ist er weg: dann neu erwerben, sonst Abbruch,
   * weil ein anderer Importer ihn inzwischen hält.
   */
  private async ensureLock(tx: Tx): Promise<void> {
    const [r] = await tx`
      SELECT EXISTS (SELECT 1 FROM pg_locks
                      WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
                        AND classid = 0 AND objid = ${IMPORTER_LOCK_KEY} AND objsubid = 1) AS held`;
    if (r?.held) return;
    const [t] = await tx`SELECT pg_try_advisory_lock(${IMPORTER_LOCK_KEY}) AS ok`;
    if (!t?.ok) {
      throw new Error('Importer-Lock verloren und von einem anderen Prozess gehalten; Abbruch');
    }
    this.opt.log?.('Importer-Lock nach Verbindungsneuaufbau neu erworben');
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
    if (this.opt.backfill) {
      const jobs = await this.db`
        SELECT job_id FROM timescaledb_information.jobs
         WHERE proc_name IN ('policy_compression', 'policy_columnstore') AND hypertable_schema = 'public'
           AND scheduled`;
      for (const j of jobs)
        await this.db`SELECT alter_job(${j.job_id as number}, scheduled => false)`;
      this.pausedJobs = jobs.map((j) => j.job_id as number);
      this.opt.log?.(`Backfill: ${this.pausedJobs.length} Columnstore-Jobs pausiert`);
    }
  }

  /** Backfill: alle Chunks der Projekttabellen, die vollständig vor `untilMs` enden, konvertieren. */
  async convertFinishedChunks(untilMs: number): Promise<number> {
    const chunks = await this.db`
      SELECT format('%I.%I', chunk_schema, chunk_name) AS c FROM timescaledb_information.chunks
       WHERE hypertable_schema = 'public' AND hypertable_name = ANY(${[...DIGEST_TABLES]}::text[])
         AND NOT is_compressed AND range_end <= ${new Date(untilMs)}
       ORDER BY range_start`;
    for (const c of chunks) {
      await this.db.unsafe(
        `CALL convert_to_columnstore('${c.c as string}'::regclass, if_not_columnstore => true)`,
      );
    }
    return chunks.length;
  }

  async close(): Promise<void> {
    if (!this.sql) return;
    if (this.opt.backfill) {
      if (this.writtenUntil > 0) {
        const n = await this.convertFinishedChunks(this.writtenUntil);
        this.opt.log?.(`Backfill: ${n} weitere Chunks konvertiert`);
      }
      for (const j of this.pausedJobs) await this.sql`SELECT alter_job(${j}, scheduled => true)`;
      this.pausedJobs = [];
    }
    await this.sql`SELECT pg_advisory_unlock(${IMPORTER_LOCK_KEY})`;
    await this.sql.end();
    this.sql = null;
  }

  async isDone(k: ResumeKey): Promise<boolean> {
    const [r] = await this.db`
      SELECT d.state, d.raw_sha256, d.importer_version, k.origin_sha256 AS kline_sha
        FROM data_day d
        LEFT JOIN raw_day k ON k.sym_id = d.sym_id AND k.day = d.day AND k.kind = 'klines'
       WHERE d.sym_id = ${this.spec.symId} AND d.day = ${formatDay(k.day)}::date`;
    return (
      !!r &&
      (r.state === 'final_ok' || r.state === 'final_bad') &&
      r.raw_sha256 === k.aggSha256 &&
      r.kline_sha === k.klineSha256 &&
      r.importer_version === k.importerVersion
    );
  }

  async storedChain(_symbol: string, day: number): Promise<StoredChain | null> {
    const [r] = await this.db`
      SELECT carry_q, carry_b, cand_last_q, cand_last_b, last_agg_id FROM data_day
       WHERE sym_id = ${this.spec.symId} AND day = ${formatDay(day)}::date
         AND state IN ('final_ok', 'final_bad') AND carry_q IS NOT NULL`;
    if (!r) return null;
    const n = (v: unknown) => safeNumber(v, 'data_day');
    return {
      carry: { q: n(r.carry_q), b: n(r.carry_b) },
      cand: { q: n(r.cand_last_q), b: n(r.cand_last_b) },
      lastAggId: r.last_agg_id === null ? null : n(r.last_agg_id),
    };
  }

  /** Nur für Messungen: Columnstore-Chunks des Tages vor dem Ersetzen in den Rowstore wandeln. */
  private async rowstoreDay(tx: Tx, from: Date, to: Date): Promise<void> {
    const tables = [...DIGEST_TABLES];
    const chunks = await tx`
      SELECT format('%I.%I', chunk_schema, chunk_name) AS c
        FROM timescaledb_information.chunks
       WHERE hypertable_schema = 'public' AND hypertable_name = ANY(${tables}::text[])
         AND is_compressed AND range_start < ${to} AND range_end > ${from}`;
    for (const c of chunks)
      await tx.unsafe(
        `CALL convert_to_rowstore('${c.c as string}'::regclass, if_columnstore => true)`,
      );
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
      await this.ensureLock(tx);
      const [r] =
        await tx`SELECT state FROM data_day WHERE sym_id = ${symId} AND day = ${dayStr}::date FOR UPDATE`;
      if (r)
        await tx`UPDATE data_day SET state = 'importing' WHERE sym_id = ${symId} AND day = ${dayStr}::date`;
      else
        await tx`INSERT INTO data_day (sym_id, day, state) VALUES (${symId}, ${dayStr}::date, 'importing')`;
      return (r?.state as string | undefined) ?? null;
    });

    try {
      const out = await this.db.begin(async (tx) => {
        await this.ensureLock(tx);
        if (this.opt.rowstoreBeforeReplace) await this.rowstoreDay(tx, from, to);
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
                 edge_first_pending = ${recon.cls[0] === MinuteClass.edge_pending},
                 edge_last_pending = ${recon.cls[1439] === MinuteClass.edge_pending},
                 carry_q = ${recon.carryOut.q}, carry_b = ${recon.carryOut.b},
                 cand_last_q = ${recon.candLast.q}, cand_last_b = ${recon.candLast.b},
                 digest = ${data.digest}, importer_version = ${w.importerVersion}, imported_at = now()
           WHERE sym_id = ${symId} AND day = ${dayStr}::date
          RETURNING version`;
        return { dbDigest, state, version: (v?.version as number) ?? null };
      });
      this.writtenUntil = Math.max(this.writtenUntil, (data.day + 1) * DAY_MS);
      if (this.opt.backfill) await this.convertFinishedChunks(this.writtenUntil);
      return out;
    } catch (e) {
      const restore =
        prev === 'final_ok' || prev === 'final_bad'
          ? prev
          : prev === null
            ? null
            : 'provisional_import_failed';
      try {
        if (restore === null) {
          await this
            .db`DELETE FROM data_day WHERE sym_id = ${symId} AND day = ${dayStr}::date AND state = 'importing'`;
        } else {
          await this
            .db`UPDATE data_day SET state = ${restore} WHERE sym_id = ${symId} AND day = ${dayStr}::date`;
        }
      } catch (e2) {
        throw new AggregateError(
          [e, e2],
          `Import ${dayStr} fehlgeschlagen und Zustand nicht wiederhergestellt`,
          { cause: e2 },
        );
      }
      throw e;
    }
  }

  async resolveEdge(e: EdgeUpdate): Promise<boolean> {
    const symId = e.symId;
    const dayStr = formatDay(e.day);
    const ts = new Date(e.day * DAY_MS + e.minute * MINUTE_MS);
    const flag = e.minute === 0 ? 'edge_first_pending' : 'edge_last_pending';
    const other = e.minute === 0 ? 'edge_last_pending' : 'edge_first_pending';
    if (e.minute !== 0 && e.minute !== 1439) throw new Error('resolveEdge: nur Minute 0 oder 1439');
    return this.db.begin(async (tx) => {
      await this.ensureLock(tx);
      const [dd] = await tx.unsafe(
        `SELECT state, ${flag} AS pending FROM data_day WHERE sym_id = $1 AND day = $2::date FOR UPDATE`,
        [symId, dayStr],
      );
      if (!dd || !dd.pending || (dd.state !== 'final_ok' && dd.state !== 'final_bad')) return false;
      let cls: number;
      if (e.decided) {
        cls = e.decided.cls;
        await tx`DELETE FROM data_minute_issue WHERE sym_id = ${symId} AND ts = ${ts}`;
        const kind = ISSUE_KIND[cls];
        if (kind)
          await tx`INSERT INTO data_minute_issue ${tx([issueRow(symId, e.day, e.minute, kind, e.decided.facts)])}`;
      } else {
        // beim Schreiben gespeicherte eigene Klasse (kein Issue = exact)
        const [r] =
          await tx`SELECT kind FROM data_minute_issue WHERE sym_id = ${symId} AND ts = ${ts}`;
        cls = r ? KIND_CODE[r.kind as string]! : MinuteClass.exact;
      }
      // bar_1m nur, wenn die Minute eine eigene Zeile hat (missing ohne Trades hat keine)
      await tx`UPDATE bar_1m SET check_state = ${checkStateOf(cls as 1 | 2 | 3 | 5)} WHERE sym_id = ${symId} AND ts = ${ts}`;
      const col = COUNT_COL[cls]!;
      const bad = cls === MinuteClass.mismatch || cls === MinuteClass.missing;
      await tx.unsafe(
        `UPDATE data_day SET ${col} = coalesce(${col}, 0) + 1, ${flag} = false,
                edge_pending = coalesce(${other}, false),
                state = CASE WHEN $3 THEN 'final_bad' ELSE state END,
                version = version + 1
          WHERE sym_id = $1 AND day = $2::date`,
        [symId, dayStr, bad],
      );
      return true;
    });
  }
}

/** bigint aus Postgres (als String geliefert) → Zahl, nur wenn exakt darstellbar. */
export function safeNumber(v: unknown, what: string): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isSafeInteger(n) || (typeof v === 'string' && String(n) !== v)) {
    throw new Error(`${what}: Wert ${String(v)} ist keine exakt darstellbare Ganzzahl`);
  }
  return n;
}
