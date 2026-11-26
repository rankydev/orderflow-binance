// Datenbank-Schreiber des Recorders (KONZEPT §4.2, §4.3). Eine Transaktion je abgeschlossener
// Minute: Lock prüfen → data_day des Tages FOR UPDATE (anlegen als `provisional`; ist der Tag nicht
// `provisional`, wird nichts geschrieben) → je betroffener Tabelle Bucket löschen und neu einfügen
// (Replace, nie Merge; auch big_order der Minute) → data_day (version + 1, live_until, Ordersummen
// des Tages absolut). Leser sehen eine Minute ganz oder gar
// nicht. Eigener Advisory-Lock (ein Recorder je Datenbank), unabhängig vom Importer-Lock; die
// Reihenfolge „data_day-Zeile zuerst" in Recorder und Importer verhindert Deadlocks.
import {
  DAY_MS,
  formatDay,
  initialBigFloorN,
  MINUTE_MS,
  pgTimestamptz,
  unitString,
  type Bar,
  type DbConfig,
  type FpTable,
  type MinuteDelta,
  type SymbolSpec,
} from '@orderflow/core';
import { connect, type Sql } from '@orderflow/db';
import { BIG_ORDER_COLS, bigOrderText, readBigFloor, safeNumber } from '@orderflow/importer';
import type { TransactionSql } from 'postgres';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const RECORDER_LOCK_KEY = 7_042_026;
export const SOURCE_LIVE = 1;
export const SOURCE_LIVE_REST = 2;

const FP_COLS = 'sym_id, ts, px, buy_q, sell_q, buy_a, sell_a';
const BAR_COLS =
  'sym_id, ts, open_px, high_px, low_px, close_px, buy_q, sell_q, buy_a, sell_a, notional, ' +
  'first_agg_id, last_agg_id, first_trade_ms, last_trade_ms, run_max, run_min, d_from_low, d_from_high';

type Tx = Sql | TransactionSql;

function fpText(symId: number, t: FpTable): string {
  const out: string[] = [];
  for (let i = 0; i < t.n; i++) {
    out.push(
      `${symId}\t${pgTimestamptz(t.ts[i]!)}\t${t.px[i]}\t${t.buyQ[i]}\t${t.sellQ[i]}\t${t.buyA[i]}\t${t.sellA[i]}\n`,
    );
  }
  return out.join('');
}

function barText(symId: number, b: Bar, tail: string): string {
  return (
    `${symId}\t${pgTimestamptz(b.ts)}\t${b.open}\t${b.high}\t${b.low}\t${b.close}\t${b.buyQ}\t${b.sellQ}\t` +
    `${b.buyA}\t${b.sellA}\t${b.notional}\t${b.firstAggId}\t${b.lastAggId}\t${b.firstTradeMs}\t` +
    `${b.lastTradeMs}\t${b.runMax}\t${b.runMin}\t${b.dFromLow}\t${b.dFromHigh}${tail}\n`
  );
}

async function copy(tx: Tx, table: string, cols: string, text: string): Promise<void> {
  if (!text) return;
  const w = await tx.unsafe(`COPY ${table} (${cols}) FROM STDIN`).writable();
  await pipeline(Readable.from([text]), w);
}

export type MinuteWriteResult = 'written' | 'not_provisional';

export interface StoredFinal {
  day: number;
  lastAggId: number | null;
  carry: { q: number; b: number } | null;
  cand: { q: number; b: number } | null;
}

export class LiveWriter {
  private sql: Sql | null = null;
  private readonly cfg: DbConfig;
  private readonly log: (s: string) => void;
  writes = 0;
  /** Tage (sym|day), deren big_order in dieser Sitzung einmal ganz aus dem Speicher ersetzt wurde. */
  private readonly bigSynced = new Set<string>();
  writeMsTotal = 0;
  writeMsMax = 0;

  constructor(cfg: DbConfig, log: (s: string) => void = () => {}) {
    this.cfg = cfg;
    this.log = log;
  }

  get db(): Sql {
    if (!this.sql) throw new Error('LiveWriter nicht geöffnet');
    return this.sql;
  }

  async open(): Promise<void> {
    this.sql = connect(this.cfg, this.cfg.database, { applicationName: 'orderflow-recorder' });
    const [l] = await this.db`SELECT pg_try_advisory_lock(${RECORDER_LOCK_KEY}) AS ok`;
    if (!l?.ok) {
      await this.sql.end();
      this.sql = null;
      throw new Error('Ein anderer Recorder hält den Recorder-Lock; Abbruch');
    }
  }

  async close(): Promise<void> {
    if (!this.sql) return;
    try {
      await this.sql`SELECT pg_advisory_unlock(${RECORDER_LOCK_KEY})`;
    } finally {
      await this.sql.end();
      this.sql = null;
    }
  }

  private async ensureLock(tx: Tx): Promise<void> {
    const [r] = await tx`
      SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()
                       AND granted AND classid = 0 AND objid = ${RECORDER_LOCK_KEY} AND objsubid = 1) AS held`;
    if (r?.held) return;
    const [t] = await tx`SELECT pg_try_advisory_lock(${RECORDER_LOCK_KEY}) AS ok`;
    if (!t?.ok) throw new Error('Recorder-Lock verloren und von einem anderen Prozess gehalten');
    this.log('Recorder-Lock nach Verbindungsneuaufbau neu erworben');
  }

  /** Symbolzeile anlegen, falls sie fehlt (gleiche Werte wie der Importer, §3.2). */
  async ensureSymbol(spec: SymbolSpec): Promise<void> {
    await this.db`
      INSERT INTO symbol (sym_id, name, price_unit, price_decimals, tick_ref_units, qty_unit, qty_decimals,
                          data_from, big_floor_n)
      VALUES (${spec.symId}, ${spec.name}, ${unitString(spec.priceDecimals)}::numeric, ${spec.priceDecimals},
              ${spec.tickRefUnits}, ${unitString(spec.qtyDecimals)}::numeric, ${spec.qtyDecimals}, ${spec.dataFrom}::date,
              ${initialBigFloorN(spec)})
      ON CONFLICT (sym_id) DO NOTHING`; // bestehende Zeile (auch ihre Untergrenze) bleibt maßgeblich
  }

  /**
   * Symbolzeile sicherstellen und die Einheiten mit dem Code vergleichen (Review S2, wie
   * PostgresWriter.open). Ohne Zeile schlüge das erste Minutenschreiben mit 23503 fehl und der Tag
   * würde nach fünf Versuchen eingefroren; bei abweichenden Einheiten wären alle Preise falsch.
   */
  async checkSymbol(spec: SymbolSpec): Promise<void> {
    try {
      await this.ensureSymbol(spec);
    } catch (e) {
      if (String((e as { code?: unknown }).code) !== '23505') throw e;
      const [o] = await this.db`SELECT sym_id FROM symbol WHERE name = ${spec.name}`;
      throw new Error(
        `Tabelle symbol: ${spec.name} hat sym_id ${String(o?.sym_id)}, der Code erwartet ${spec.symId}`,
        { cause: e },
      );
    }
    const [row] = await this.db`
      SELECT name, price_unit::text AS pu, price_decimals, tick_ref_units, qty_unit::text AS qu, qty_decimals
        FROM symbol WHERE sym_id = ${spec.symId}`;
    if (
      !row ||
      row.name !== spec.name ||
      row.pu !== unitString(spec.priceDecimals) ||
      row.price_decimals !== spec.priceDecimals ||
      row.tick_ref_units !== spec.tickRefUnits ||
      row.qu !== unitString(spec.qtyDecimals) ||
      row.qty_decimals !== spec.qtyDecimals
    ) {
      throw new Error(
        `Tabelle symbol (sym_id ${spec.symId}) passt nicht zu den Einheiten im Code für ${spec.name}: ${JSON.stringify(row)}`,
      );
    }
  }

  /** Letzter finaler Tag des Symbols (Startpunkt der Kette) und provisorische Tage danach. */
  async startState(spec: SymbolSpec): Promise<{
    final: StoredFinal | null;
    provisional: { day: number; state: string; liveUntil: number | null; frozen: string | null }[];
    bigFloorN: number | null;
  }> {
    const n = (v: unknown) => safeNumber(v, 'data_day');
    const [f] = await this.db`
      SELECT day::text AS day, last_agg_id, carry_q, carry_b, cand_last_q, cand_last_b FROM data_day
       WHERE sym_id = ${spec.symId} AND state IN ('final_ok', 'final_bad') ORDER BY day DESC LIMIT 1`;
    const final: StoredFinal | null = f
      ? {
          day: Date.parse(`${f.day as string}T00:00:00Z`) / DAY_MS,
          lastAggId: f.last_agg_id === null ? null : n(f.last_agg_id),
          carry: f.carry_q === null ? null : { q: n(f.carry_q), b: n(f.carry_b) },
          cand: f.cand_last_q === null ? null : { q: n(f.cand_last_q), b: n(f.cand_last_b) },
        }
      : null;
    const prov = await this.db`
      SELECT day::text AS day, state, live_until, live_frozen FROM data_day
       WHERE sym_id = ${spec.symId} AND state NOT IN ('final_ok', 'final_bad')
         AND day > ${final ? formatDay(final.day) : '1970-01-01'}::date ORDER BY day`;
    return {
      final,
      // dieselbe Quelle wie der Importer (Migration 0017); feste Größe für die Laufzeit
      bigFloorN: await readBigFloor(this.db, spec.symId),
      provisional: prov.map((p) => ({
        day: Date.parse(`${p.day as string}T00:00:00Z`) / DAY_MS,
        state: p.state as string,
        liveUntil: p.live_until ? (p.live_until as Date).getTime() : null,
        frozen: (p.live_frozen as string | null) ?? null,
      })),
    };
  }

  /** Eine abgeschlossene Minute in einer Transaktion schreiben. */
  async writeMinute(spec: SymbolSpec, d: MinuteDelta): Promise<MinuteWriteResult> {
    const t0 = performance.now();
    const symId = spec.symId;
    const dayStr = formatDay(d.day);
    const minuteEnd = new Date(d.day * DAY_MS + (d.minute + 1) * MINUTE_MS);
    let synced: string | null = null;
    const res = await this.db.begin(async (tx) => {
      await this.ensureLock(tx);
      const [row] = await tx`
        SELECT state, source FROM data_day WHERE sym_id = ${symId} AND day = ${dayStr}::date FOR UPDATE`;
      if (!row) {
        await tx`INSERT INTO data_day (sym_id, day, state, source, version)
                 VALUES (${symId}, ${dayStr}::date, 'provisional', 'live', 0)`;
      } else if (row.state !== 'provisional') {
        return 'not_provisional' as const;
      }
      for (const b of d.fp) {
        await tx.unsafe(`DELETE FROM ${b.table} WHERE sym_id = $1 AND ts >= $2 AND ts < $3`, [
          symId,
          new Date(b.from),
          new Date(b.to),
        ]);
        await copy(tx, b.table, FP_COLS, fpText(symId, b.rows));
      }
      for (const b of d.bars) {
        await tx.unsafe(`DELETE FROM ${b.table} WHERE sym_id = $1 AND ts >= $2 AND ts < $3`, [
          symId,
          new Date(b.from),
          new Date(b.to),
        ]);
        if (b.table === 'bar_1m') {
          const src = d.viaRest ? SOURCE_LIVE_REST : SOURCE_LIVE;
          // check_state 0 = ungeprüft: der Kline-Abgleich live steht in live_kline_check
          await copy(
            tx,
            'bar_1m',
            `${BAR_COLS}, source, check_state`,
            b.bars.map((x) => barText(symId, x, `\t${src}\t0`)).join(''),
          );
        } else {
          await copy(tx, b.table, BAR_COLS, b.bars.map((x) => barText(symId, x, '')).join(''));
        }
      }
      // Order-Daten des Tages (Review S1): der Speicher (LiveDay) enthält nach einem Neustart den
      // ganzen Tag aus der Spool, geschrieben werden aber nur Minuten ab live_until. Davor kann
      // big_order fehlen (alter Recorder vor Migration 0017) oder mit einer anderen Untergrenze
      // stehen. Daher: deckt der Speicher genau die bar_1m-Zeilen des Tages in der DB (Anzahl,
      // Σ Notional, Σ aggTrades, Σ erste/letzte aggId), wird big_order für den GANZEN Tag aus dem
      // Speicher ersetzt (einmal je Tag und Sitzung, danach minutenweise), und die Ordersummen und
      // die Untergrenze gelten. Sonst nur die Minute; Summen und Untergrenze NULL (unbekannt).
      const dayFrom = new Date(d.day * DAY_MS);
      const dayTo = new Date((d.day + 1) * DAY_MS);
      const [c] = await tx`
        SELECT count(*)::int AS n, coalesce(sum(notional), 0)::text AS ntl,
               coalesce(sum(buy_a + sell_a), 0)::text AS a,
               coalesce(sum(first_agg_id), 0)::text AS f, coalesce(sum(last_agg_id), 0)::text AS l
          FROM bar_1m WHERE sym_id = ${symId} AND ts >= ${dayFrom} AND ts < ${dayTo}`;
      const o = d.orders;
      const complete =
        c!.n === o.minutes &&
        c!.ntl === String(o.notional) &&
        c!.a === String(o.aggTrades) &&
        c!.f === String(o.firstIdSum) &&
        c!.l === String(o.lastIdSum);
      const key = `${symId}|${d.day}`;
      const wholeDay = complete && !this.bigSynced.has(key);
      const [from, to] = wholeDay ? [dayFrom, dayTo] : [new Date(d.big.from), new Date(d.big.to)];
      await tx`DELETE FROM big_order WHERE sym_id = ${symId} AND ts >= ${from} AND ts < ${to}`;
      await copy(
        tx,
        'big_order',
        BIG_ORDER_COLS,
        bigOrderText(symId, wholeDay ? d.bigDay() : d.big.rows),
      );
      const source = d.viaRest || row?.source === 'live+rest' ? 'live+rest' : 'live';
      const day = d.bars.find((b) => b.table === 'bar_1d')!.bars[0]!;
      await tx`
        UPDATE data_day SET version = version + 1, source = ${source},
               first_agg_id = ${day.firstAggId}, last_agg_id = ${day.lastAggId},
               rows = ${day.buyA + day.sellA},
               orders_n = ${complete ? o.n : null},
               orders_notional = ${complete ? String(o.notional) : null}::bigint,
               big_floor_n = ${complete ? o.bigFloorN : null},
               live_until = greatest(coalesce(live_until, ${minuteEnd}), ${minuteEnd}),
               live_minutes = (SELECT count(*) FROM bar_1m WHERE sym_id = ${symId}
                                 AND ts >= ${new Date(d.day * DAY_MS)} AND ts < ${new Date((d.day + 1) * DAY_MS)})
         WHERE sym_id = ${symId} AND day = ${dayStr}::date`;
      if (wholeDay) synced = key;
      return 'written' as const;
    });
    // erst nach dem Commit: ab jetzt genügt der minutenweise Ersatz
    if (synced) this.bigSynced.add(synced);
    const ms = performance.now() - t0;
    if (res === 'written') {
      this.writes++;
      this.writeMsTotal += ms;
      this.writeMsMax = Math.max(this.writeMsMax, ms);
    }
    return res;
  }

  /**
   * Minuten einer nicht füllbaren Lücke als `gap` vermerken (§4.2; werden nicht geschrieben).
   * Begrenzt auf 3 Tage (≤ 4 321 Zeilen) – ein falscher Anfang (z. B. 0) kann keinen Speicherlauf auslösen.
   */
  /**
   * Minuten [fromMs, toMs] als `gap` vermerken – beide Enden inklusive: die Minute des letzten
   * Trades vor und die des ersten Trades nach einer Lücke sind betroffen (Trades derselben Minute
   * fehlen). Wer eine Lücke bis zu einer Minutengrenze meint, übergibt Grenze − 1.
   */
  async markGap(spec: SymbolSpec, fromMs: number, toMs: number): Promise<void> {
    if (!(toMs >= fromMs) || toMs - fromMs > 3 * DAY_MS) {
      throw new Error(`markGap: unplausibler Bereich ${fromMs}…${toMs}`);
    }
    const rows = [];
    for (let t = fromMs - (fromMs % MINUTE_MS); t <= toMs; t += MINUTE_MS) {
      rows.push({ sym_id: spec.symId, ts: new Date(t), kind: 'gap' });
    }
    if (rows.length === 0) return;
    await this.db`INSERT INTO data_minute_issue ${this.db(rows)} ON CONFLICT DO NOTHING`;
  }

  /** Zuletzt geschriebene details des Recorders je Symbol (Neustart: persistierte Zustände). */
  async statusDetails(): Promise<Record<string, unknown>[]> {
    const rows = await this.db`SELECT details FROM ingest_status WHERE component = 'recorder'`;
    return rows.map((r) => (r.details ?? {}) as Record<string, unknown>);
  }

  /**
   * Läuft diese Sitzung mit erhöhten Rechten (Superuser, of_admin oder Mitglied davon, CREATE im
   * Schema)? Der Recorder verweigert dann den Start (Review: die Prüfung über OF_DB_USER greift nur,
   * wenn die Variable gesetzt ist).
   */
  async elevatedRole(): Promise<string | null> {
    const [r] = await this.db`
      SELECT current_user AS u, r.rolsuper AS su,
             EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'of_admin')
               AND pg_has_role(current_user, 'of_admin', 'MEMBER') AS admin,
             has_schema_privilege(current_user, 'public', 'CREATE') AS ddl
        FROM pg_roles r WHERE r.rolname = current_user`;
    if (!r) return 'Rolle unbekannt';
    if (r.su) return `${r.u as string} ist Superuser`;
    if (r.admin) return `${r.u as string} ist of_admin oder Mitglied davon`;
    if (r.ddl) return `${r.u as string} darf im Schema public Objekte anlegen`;
    return null;
  }

  /** Teilweise komprimierte Chunks (Status-Bit 8) der Projekttabellen (Review H2). */
  async partialChunks(): Promise<string[]> {
    const rows = await this.db`
      SELECT format('%I.%I', c.chunk_schema, c.chunk_name) AS c
        FROM timescaledb_information.chunks c
        JOIN _timescaledb_catalog.chunk k
          ON k.relid = format('%I.%I', c.chunk_schema, c.chunk_name)::regclass
       WHERE c.hypertable_schema = 'public' AND (k.status & 8) <> 0
       ORDER BY 1`;
    return rows.map((r) => r.c as string);
  }

  /** Offene Chunks (range_end > now() - of_hot_margin()) der Projekttabellen im Columnstore (Migration 0015). */
  async hotCompressedChunks(): Promise<string[]> {
    const rows = await this.db`
      SELECT format('%I.%I', c.chunk_schema, c.chunk_name) AS c
        FROM timescaledb_information.chunks c
        JOIN _timescaledb_catalog.chunk k
          ON k.relid = format('%I.%I', c.chunk_schema, c.chunk_name)::regclass
       WHERE c.hypertable_schema = 'public' AND (k.status & 1) <> 0
         AND c.range_end > now() - of_hot_margin()
       ORDER BY 1`;
    return rows.map((r) => r.c as string);
  }

  async markFrozen(spec: SymbolSpec, day: number, reason: string): Promise<void> {
    const ds = formatDay(day);
    await this.db.begin(async (tx) => {
      await this.ensureLock(tx);
      await tx`
        INSERT INTO data_day (sym_id, day, state, source, version, live_frozen)
        VALUES (${spec.symId}, ${ds}::date, 'provisional', 'live', 1, ${reason})
        ON CONFLICT (sym_id, day) DO UPDATE SET live_frozen = EXCLUDED.live_frozen,
               version = data_day.version + 1
         WHERE data_day.state = 'provisional'`; // nie in importing/final (Review W2)
    });
  }

  async writeKlineChecks(
    rows: {
      sym_id: number;
      ts: Date;
      cls: number;
      d_q: number;
      d_b: number;
      s_q: number;
      s_b: number;
      cand_q: number;
      cand_b: number;
      kline_vol: number;
      kline_taker: number;
      kline_trades: number;
    }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.db`
      INSERT INTO live_kline_check ${this.db(rows)}
      ON CONFLICT (sym_id, ts) DO UPDATE SET cls = EXCLUDED.cls, d_q = EXCLUDED.d_q, d_b = EXCLUDED.d_b,
        s_q = EXCLUDED.s_q, s_b = EXCLUDED.s_b, cand_q = EXCLUDED.cand_q, cand_b = EXCLUDED.cand_b,
        kline_vol = EXCLUDED.kline_vol, kline_taker = EXCLUDED.kline_taker,
        kline_trades = EXCLUDED.kline_trades, checked_at = now()`;
  }

  async writeStatus(row: {
    sym_id: number;
    last_agg_id: number | null;
    last_trade_ms: number | null;
    ws_connected: boolean;
    open_gaps: number;
    unwritten_minutes: number;
    rest_weight_1m: number;
    spool_lag_ms: number;
    last_committed_minute: Date | null;
    last_finalised_day: string | null;
    details: unknown;
  }): Promise<void> {
    await this.db`
      INSERT INTO ingest_status (component, sym_id, last_agg_id, last_trade_ms, ws_connected, open_gaps,
        unwritten_minutes, rest_weight_1m, spool_lag_ms, last_committed_minute, last_finalised_day, details, updated_at)
      VALUES ('recorder', ${row.sym_id}, ${row.last_agg_id}, ${row.last_trade_ms}, ${row.ws_connected},
        ${row.open_gaps}, ${row.unwritten_minutes}, ${row.rest_weight_1m}, ${row.spool_lag_ms},
        ${row.last_committed_minute}, ${row.last_finalised_day}::date, ${this.db.json(row.details as never)}, now())
      ON CONFLICT (component, sym_id) DO UPDATE SET last_agg_id = EXCLUDED.last_agg_id,
        last_trade_ms = EXCLUDED.last_trade_ms, ws_connected = EXCLUDED.ws_connected,
        open_gaps = EXCLUDED.open_gaps, unwritten_minutes = EXCLUDED.unwritten_minutes,
        rest_weight_1m = EXCLUDED.rest_weight_1m, spool_lag_ms = EXCLUDED.spool_lag_ms,
        last_committed_minute = EXCLUDED.last_committed_minute,
        last_finalised_day = coalesce(EXCLUDED.last_finalised_day, ingest_status.last_finalised_day),
        details = EXCLUDED.details, updated_at = now()`;
  }
}
