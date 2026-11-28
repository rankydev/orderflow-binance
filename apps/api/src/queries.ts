// SQL der Leseendpunkte. Tabellennamen nur aus festen Listen, Zeitgrenzen als Literale aus geprüften
// Ganzzahlen (konstante Grenzen → Chunk-Ausschluss beim Planen, KONZEPT §5.8), alle übrigen Werte als
// Parameter. Mengen kommen als int8 (Text) und werden mit int() auf sichere Ganzzahlen geprüft;
// Notional nur als Text → BigInt.
import { fpTableGrid, type FpTableName } from '@orderflow/core';
import { bigintOf, int, type ReadTx, type Row, type Sql } from './db.ts';
import {
  BAR_TABLES,
  barTableMinutes,
  FP_TABLE_NAMES,
  type BarTable,
  type Segment,
} from './plan.ts';
import { DAY_MS, MAX_TIME_MS } from './params.ts';

const FP_SET = new Set<string>(FP_TABLE_NAMES);
const BAR_SET = new Set<string>(BAR_TABLES);

function fpTable(t: string): FpTableName {
  if (!FP_SET.has(t)) throw new Error(`Tabelle ${t} nicht erlaubt`);
  return t as FpTableName;
}
function barTable(t: string): BarTable {
  if (!BAR_SET.has(t)) throw new Error(`Tabelle ${t} nicht erlaubt`);
  return t as BarTable;
}

/** timestamptz-Literal aus Millisekunden (geprüfte Ganzzahl, nie aus Anfrage-Text). */
export function tsLit(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIME_MS * 2)
    throw new Error(`Zeitpunkt ${ms} ungültig`);
  return `'${new Date(ms).toISOString()}'::timestamptz`;
}

function intervalLit(sec: number): string {
  if (!Number.isSafeInteger(sec) || sec <= 0) throw new Error(`Intervall ${sec} ungültig`);
  return `'${sec} seconds'::interval`;
}

function dateLit(day: number): string {
  if (!Number.isSafeInteger(day)) throw new Error(`Tag ${day} ungültig`);
  return `(DATE '1970-01-01' + ${day})`;
}

/** Zeitbereich einer Hypertable, den eine Anfrage liest. */
export interface ReadRange {
  table: FpTableName | BarTable | 'kline_1m' | 'big_order';
  from: number;
  to: number;
}

/**
 * Chunk-Sperren vor dem Snapshot (Review Pass 4/5). Nachgewiesen (TimescaleDB 2.31, PG 17):
 * `convert_to_rowstore` ist für einen Leser mit älterem Snapshot nicht MVCC-sicher – er sieht den
 * Chunk danach leer. Eine REPEATABLE-READ-Transaktion nimmt ihren Snapshot mit der ersten Abfrage,
 * also VOR dem Planen, in dem Timescale die Chunks sperrt; eine leere Abfrage als „Präludium" schließt
 * die Lücke daher nicht (läuft eine Konvertierung schon, wartet der Leser auf die Sperre und liest
 * danach mit altem Snapshot einen leeren Chunk). `LOCK TABLE` ist eine Utility-Anweisung und nimmt
 * keinen Snapshot: als erste Anweisung der Transaktion gesperrt, entsteht der Snapshot erst danach.
 * Gesperrt werden nur die Chunks im gelesenen Zeitraum (ein LOCK auf die Hypertable sperrte alle ihre
 * Chunks – bei voller Historie Hunderte Sperren je Anfrage). Die Namen liefert eine Katalogabfrage
 * außerhalb der Transaktion (autocommit), gequotet per format('%I.%I').
 */
export async function chunkLockList(sql: Sql, ranges: ReadRange[]): Promise<string[]> {
  if (ranges.length === 0) return [];
  const conds = ranges.map((r) => {
    const t =
      r.table === 'kline_1m' || r.table === 'big_order'
        ? r.table
        : FP_SET.has(r.table)
          ? fpTable(r.table)
          : barTable(r.table);
    return `(hypertable_name = '${t}' AND range_end > ${tsLit(r.from)} AND range_start < ${tsLit(r.to)})`;
  });
  const rows = await sql
    .unsafe(
      `SELECT DISTINCT format('%I.%I', chunk_schema, chunk_name) FROM timescaledb_information.chunks
      WHERE hypertable_schema = 'public' AND (${conds.join(' OR ')}) ORDER BY 1`,
    )
    .values();
  return rows.map((r) => String(r[0]));
}

export interface DaySnap {
  day: number;
  state: string;
  version: number;
  immutable: boolean;
}

/** Tagesstände [d0, d1] aus dem Snapshot der laufenden Transaktion. */
export async function readDays(
  tx: ReadTx,
  symId: number,
  d0: number,
  d1: number,
): Promise<Map<number, DaySnap>> {
  const rows = await tx.rows(
    `SELECT (day - DATE '1970-01-01')::int, state, version, immutable FROM data_day
      WHERE sym_id = $1 AND day >= ${dateLit(d0)} AND day <= ${dateLit(d1)}`,
    [symId],
  );
  const m = new Map<number, DaySnap>();
  for (const r of rows)
    m.set(int(r[0]), {
      day: int(r[0]),
      state: String(r[1]),
      version: int(r[2]),
      immutable: r[3] === true,
    });
  return m;
}

/**
 * Grenze der Live-Naht (wire.ts, TILE-FORMAT.md `committedTo`): Minuten davor stehen in der Datenbank,
 * danach (noch) nichts. Je Tag live_until (vom Recorder geschriebener, nicht finaler Tag), sonst das
 * Tagesende (finale Tage; Tage ohne live_until stammen nicht vom Recorder) – das Maximum über alle
 * Tage des Symbols, im Snapshot der laufenden Transaktion; null = keine Zeile.
 */
export async function readCommittedTo(tx: ReadTx, symId: number): Promise<number | null> {
  const rows = await tx.rows(
    `SELECT (extract(epoch FROM max(
              CASE WHEN live_until IS NOT NULL AND state NOT IN ('final_ok', 'final_bad')
                   THEN live_until
                   ELSE (day + 1)::timestamp AT TIME ZONE 'UTC' END)) * 1000)::int8
       FROM data_day WHERE sym_id = $1`,
    [symId],
  );
  return rows.length ? intOrNull(rows[0]![0]) : null;
}

/** committedTo einer Antwort [from, to): auf den Zeitraum begrenzt (null → to: nichts kommt live hinzu). */
export function clampCommittedTo(c: number | null, from: number, to: number): number {
  if (c === null) return to;
  return Math.min(to, Math.max(from, c));
}

export interface BarRows {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  buyQ: number[];
  sellQ: number[];
  buyA: number[];
  sellA: number[];
}

/**
 * Bars des Zeitrahmens tfSec in [from, to) aus der Bar-Tabelle (gröbste mit passendem Raster);
 * höhere Zeitrahmen per time_bucket (Epoch-ausgerichtet, da jedes tf ≤ 1d einen Tag teilt).
 */
export async function queryBars(
  tx: ReadTx,
  symId: number,
  table: BarTable,
  tfSec: number,
  from: number,
  to: number,
): Promise<BarRows> {
  const t = barTable(table);
  const where = `sym_id = $1 AND ts >= ${tsLit(from)} AND ts < ${tsLit(to)}`;
  const direct = tfSec === barTableMinutes(t) * 60;
  const text = direct
    ? `SELECT extract(epoch from ts)::int8, open_px, high_px, low_px, close_px, buy_q, sell_q, buy_a, sell_a
         FROM ${t} WHERE ${where} ORDER BY ts`
    : `SELECT extract(epoch from time_bucket(${intervalLit(tfSec)}, ts))::int8 AS b,
              first(open_px, ts), max(high_px), min(low_px), last(close_px, ts),
              sum(buy_q)::int8, sum(sell_q)::int8, sum(buy_a)::int8, sum(sell_a)::int8
         FROM ${t} WHERE ${where} GROUP BY 1 ORDER BY 1`;
  const rows = await tx.rows(text, [symId]);
  const out: BarRows = {
    time: [],
    open: [],
    high: [],
    low: [],
    close: [],
    buyQ: [],
    sellQ: [],
    buyA: [],
    sellA: [],
  };
  for (const r of rows) {
    out.time.push(int(r[0]));
    out.open.push(int(r[1]));
    out.high.push(int(r[2]));
    out.low.push(int(r[3]));
    out.close.push(int(r[4]));
    out.buyQ.push(int(r[5]));
    out.sellQ.push(int(r[6]));
    out.buyA.push(int(r[7]));
    out.sellA.push(int(r[8]));
  }
  return out;
}

/** Teilbar einer Bar-Tabelle mit den Komposita-Komponenten (KONZEPT §3.5), Eingabe für composeBars. */
export interface SubBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  buyQ: number;
  sellQ: number;
  buyA: number;
  sellA: number;
  runMax: number;
  runMin: number;
  dFromLow: number;
  dFromHigh: number;
}

/** Zeilen einer Bar-Tabelle in [from, to), nach ts, mit run_max/run_min/d_from_low/d_from_high. */
export async function querySubBars(
  tx: ReadTx,
  symId: number,
  table: BarTable,
  from: number,
  to: number,
): Promise<SubBar[]> {
  const t = barTable(table);
  const rows = await tx.rows(
    `SELECT extract(epoch from ts)::int8 * 1000, open_px, high_px, low_px, close_px, buy_q, sell_q,
            buy_a, sell_a, run_max, run_min, d_from_low, d_from_high
       FROM ${t} WHERE sym_id = $1 AND ts >= ${tsLit(from)} AND ts < ${tsLit(to)} ORDER BY ts`,
    [symId],
  );
  return rows.map((r) => ({
    ts: int(r[0]),
    open: int(r[1]),
    high: int(r[2]),
    low: int(r[3]),
    close: int(r[4]),
    buyQ: int(r[5]),
    sellQ: int(r[6]),
    buyA: int(r[7]),
    sellA: int(r[8]),
    runMax: int(r[9]),
    runMin: int(r[10]),
    dFromLow: int(r[11]),
    dFromHigh: int(r[12]),
  }));
}

/** Σ kline_1m.trades je Bar-Beginn (s) des Zeitrahmens tfSec in [from, to). */
export async function queryTrades(
  tx: ReadTx,
  symId: number,
  tfSec: number,
  from: number,
  to: number,
): Promise<Map<number, number>> {
  const rows = await tx.rows(
    `SELECT extract(epoch from time_bucket(${intervalLit(tfSec)}, ts))::int8, sum(trades)::int8
       FROM kline_1m WHERE sym_id = $1 AND ts >= ${tsLit(from)} AND ts < ${tsLit(to)} GROUP BY 1`,
    [symId],
  );
  return new Map(rows.map((r) => [int(r[0]), int(r[1])]));
}

export interface LevelRows {
  /** Bar-Beginn (s) je Level, aufsteigend; innerhalb eines Bars Zeilen aufsteigend. */
  time: number[];
  row: number[];
  buy: number[];
  sell: number[];
  buyA: number[];
  sellA: number[];
}

/** Footprint-Level (tf, Zeilenbreite w) in [from, to) aus einer Footprint-Tabelle. */
export async function queryLevels(
  tx: ReadTx,
  symId: number,
  table: FpTableName,
  tfSec: number,
  width: number,
  tickRef: number,
  from: number,
  to: number,
): Promise<LevelRows> {
  const t = fpTable(table);
  const g = fpTableGrid(t);
  if (tfSec % (g.tfMin * 60) !== 0 || width % (g.bin * tickRef) !== 0)
    throw new Error(`${t} passt nicht zu tf/R`);
  const where = `sym_id = $1 AND ts >= ${tsLit(from)} AND ts < ${tsLit(to)}`;
  // Re-Bucketing in SQL (§5.2); bei gleichem Zeitraster nur über die Zeile (ts bleibt der Bar-Beginn).
  const text =
    tfSec === g.tfMin * 60
      ? `SELECT extract(epoch from ts)::int8, px / $2, sum(buy_q)::int8, sum(sell_q)::int8,
                sum(buy_a)::int8, sum(sell_a)::int8
           FROM ${t} WHERE ${where} GROUP BY ts, 2 ORDER BY ts, 2`
      : `SELECT extract(epoch from time_bucket(${intervalLit(tfSec)}, ts))::int8, px / $2,
                sum(buy_q)::int8, sum(sell_q)::int8, sum(buy_a)::int8, sum(sell_a)::int8
           FROM ${t} WHERE ${where} GROUP BY 1, 2 ORDER BY 1, 2`;
  const rows = await tx.rows(text, [symId, width]);
  const out: LevelRows = { time: [], row: [], buy: [], sell: [], buyA: [], sellA: [] };
  for (const r of rows) {
    out.time.push(int(r[0]));
    out.row.push(int(r[1]));
    out.buy.push(int(r[2]));
    out.sell.push(int(r[3]));
    out.buyA.push(int(r[4]));
    out.sellA.push(int(r[5]));
  }
  return out;
}

/** Ausdruck für den Tagesindex mit Offset (ms) eines Zeitstempels; ganzzahlig, für ts ≥ Offset. */
function dayExpr(offsetMs: number): string {
  if (!Number.isSafeInteger(offsetMs)) throw new Error('Offset ungültig');
  return `((extract(epoch from ts)::int8 * 1000 - (${offsetMs})) / ${DAY_MS})`;
}

export interface ProfileLevelRow {
  /** Tagesindex (nur bei Tagesprofilen), sonst 0 */
  day: number;
  row: number;
  buy: number;
  sell: number;
}

/**
 * Level-Summen je Zeile (Breite w) über Teilbereiche; mit `offsetMs` zusätzlich je Tag
 * (Tag = floor((ts − offset) / 24h)). Jede Quellzeile liegt ganz in einem Teilbereich und Tag.
 */
export async function queryProfileLevels(
  tx: ReadTx,
  symId: number,
  segs: Segment[],
  width: number,
  tickRef: number,
  offsetMs: number | null,
): Promise<ProfileLevelRow[]> {
  if (segs.length === 0) return [];
  const d = offsetMs === null ? '' : `${dayExpr(offsetMs)} AS d, `;
  const parts = segs.map((s) => {
    const t = fpTable(s.table);
    if (width % (fpTableGrid(t).bin * tickRef) !== 0) throw new Error(`${t} passt nicht zu R`);
    return `SELECT ${d}px / $2 AS r, sum(buy_q) AS b, sum(sell_q) AS s FROM ${t}
             WHERE sym_id = $1 AND ts >= ${tsLit(s.from)} AND ts < ${tsLit(s.to)}
             GROUP BY ${offsetMs === null ? '1' : '1, 2'}`;
  });
  const key = offsetMs === null ? 'r' : 'd, r';
  const rows = await tx.rows(
    `SELECT ${offsetMs === null ? '0' : 'd'}, r, sum(b)::int8, sum(s)::int8
       FROM (${parts.join('\nUNION ALL\n')}) u GROUP BY ${key} ORDER BY ${key}`,
    [symId, width],
  );
  return rows.map((r: Row) => ({
    day: int(r[0]),
    row: int(r[1]),
    buy: int(r[2]),
    sell: int(r[3]),
  }));
}

export interface ProfileBarRow {
  day: number;
  low: number;
  high: number;
  buyQ: number;
  sellQ: number;
  notional: bigint;
}

/** Preisbereich, Summen und Notional (exakt, BigInt) über Bar-Teilbereiche, optional je Tag. */
export async function queryProfileBars(
  tx: ReadTx,
  symId: number,
  segs: Segment<BarTable>[],
  offsetMs: number | null,
): Promise<ProfileBarRow[]> {
  if (segs.length === 0) return [];
  const d = offsetMs === null ? '' : `${dayExpr(offsetMs)} AS d, `;
  const parts = segs.map((s) => {
    const t = barTable(s.table);
    return `SELECT ${d}min(low_px) AS l, max(high_px) AS h, sum(buy_q) AS b, sum(sell_q) AS s,
                   sum(notional) AS n FROM ${t}
             WHERE sym_id = $1 AND ts >= ${tsLit(s.from)} AND ts < ${tsLit(s.to)}
             ${offsetMs === null ? '' : 'GROUP BY 1'}`;
  });
  const rows = await tx.rows(
    `SELECT ${offsetMs === null ? '0' : 'd'}, min(l), max(h), sum(b)::int8, sum(s)::int8, sum(n)::text
       FROM (${parts.join('\nUNION ALL\n')}) u
      ${offsetMs === null ? '' : 'GROUP BY d ORDER BY d'}`,
    [symId],
  );
  return rows
    .filter((r) => r[1] !== null)
    .map((r: Row) => ({
      day: int(r[0]),
      low: int(r[1]),
      high: int(r[2]),
      buyQ: int(r[3]),
      sellQ: int(r[4]),
      notional: bigintOf(r[5]),
    }));
}

/**
 * Fingerabdruck aller Qualitätsfelder eines Tages (data_day), die /quality ausliefert. Derselbe
 * Ausdruck im Katalog (für 304/Cache vor der Abfrage) und im Snapshot der Antwort: so werden auch
 * Änderungen ohne Versionssprung (deep_check, Zähler) erkannt.
 *
 * Abhängigkeit: data_minute_issue (die Issue-Minuten) ist nicht im Fingerabdruck. Das ist nur richtig,
 * weil der Importer Issue-Zeilen ausschließlich in der Import-Transaktion schreibt, die zugleich
 * data_day.version und die Minutenzähler setzt. Schreibt künftig ein anderer Weg Issues (Recorder,
 * Annotationen), muss er data_day mitändern oder dieser Ausdruck um eine Issue-Prüfsumme wachsen.
 */
export const QUALITY_FP_SQL = `md5(ROW(state, version, immutable, source, stale, edge_pending,
  edge_first_pending, edge_last_pending, deep_check, rows, min_exact, min_shift, min_mismatch,
  min_missing, min_gap)::text)`;

export interface QualityDayRow {
  /** Fingerabdruck (QUALITY_FP_SQL); nur intern, nicht Teil der Antwort. */
  fp: string;
  day: number;
  state: string;
  version: number;
  immutable: boolean;
  source: string | null;
  stale: boolean;
  edgePending: boolean | null;
  edgeFirstPending: boolean | null;
  edgeLastPending: boolean | null;
  deepCheck: string | null;
  rows: number | null;
  minutes: {
    exact: number | null;
    shift: number | null;
    mismatch: number | null;
    missing: number | null;
    gap: number | null;
  };
}

const intOrNull = (v: unknown) => (v === null || v === undefined ? null : int(v));
const boolOrNull = (v: unknown) => (v === null || v === undefined ? null : v === true);

export async function queryQualityDays(
  tx: ReadTx,
  symId: number,
  d0: number,
  d1: number,
): Promise<QualityDayRow[]> {
  const rows = await tx.rows(
    `SELECT (day - DATE '1970-01-01')::int, state, version, immutable, source, stale, edge_pending,
            edge_first_pending, edge_last_pending, deep_check, rows,
            min_exact, min_shift, min_mismatch, min_missing, min_gap, ${QUALITY_FP_SQL}
       FROM data_day WHERE sym_id = $1 AND day >= ${dateLit(d0)} AND day <= ${dateLit(d1)}
      ORDER BY day`,
    [symId],
  );
  return rows.map((r) => ({
    fp: String(r[16]),
    day: int(r[0]),
    state: String(r[1]),
    version: int(r[2]),
    immutable: r[3] === true,
    source: r[4] === null ? null : String(r[4]),
    stale: r[5] === true,
    edgePending: boolOrNull(r[6]),
    edgeFirstPending: boolOrNull(r[7]),
    edgeLastPending: boolOrNull(r[8]),
    deepCheck: r[9] === null ? null : String(r[9]),
    rows: intOrNull(r[10]),
    minutes: {
      exact: intOrNull(r[11]),
      shift: intOrNull(r[12]),
      mismatch: intOrNull(r[13]),
      missing: intOrNull(r[14]),
      gap: intOrNull(r[15]),
    },
  }));
}

export interface IssueRow {
  ts: number;
  kind: string;
  dQ: number | null;
  dB: number | null;
}

/**
 * Issue-Minuten ab `from` (inklusive) bis `to`, höchstens `limit`; eine Seite endet immer an einer
 * Minutengrenze (alle Arten einer Minute gemeinsam), `next` = erste ausgelassene Minute oder null.
 */
export async function queryIssues(
  tx: ReadTx,
  symId: number,
  from: number,
  to: number,
  withShift: boolean,
  limit: number,
): Promise<{ issues: IssueRow[]; next: number | null }> {
  // höchstens 4 Arten je Minute → limit + 4 Zeilen genügen, um die Seitengrenze zu erkennen
  const rows = await tx.rows(
    `SELECT (extract(epoch from ts)::int8 * 1000), kind, d_q, d_b FROM data_minute_issue
      WHERE sym_id = $1 AND ts >= ${tsLit(from)} AND ts < ${tsLit(to)}
        ${withShift ? '' : "AND kind <> 'shift'"}
      ORDER BY ts, kind LIMIT ${Math.trunc(limit) + 4}`,
    [symId],
  );
  const all = rows.map((r) => ({
    ts: int(r[0]),
    kind: String(r[1]),
    dQ: intOrNull(r[2]),
    dB: intOrNull(r[3]),
  }));
  if (all.length <= limit) return { issues: all, next: null };
  const next = all[limit]!.ts;
  return { issues: all.slice(0, limit).filter((x) => x.ts < next), next };
}

// ---------------------------------------------------------------- Big Trades (GET /api/v1/bigtrades)

/**
 * Anzahl der Minuten mit gap/missing/mismatch eines data_day-Tages (Alias d), über den
 * Primärschlüssel von data_minute_issue. Für Version, `final` und die Grenze der Lückenminuten von
 * /bigtrades (markGap ändert data_day.version nicht).
 */
export const HOLES_SQL = `(SELECT count(DISTINCT i.ts)::int FROM data_minute_issue i
   WHERE i.sym_id = d.sym_id AND i.kind IN ('gap', 'missing', 'mismatch')
     AND i.ts >= d.day::timestamp AT TIME ZONE 'UTC'
     AND i.ts < (d.day + 1)::timestamp AT TIME ZONE 'UTC')`;

/** Order-Felder eines Tages aus data_day (Migration 0017), im Snapshot der Antwort. */
export interface OrderDaySnap extends DaySnap {
  /** Tag hat (oder hatte vor einem laufenden Ersatz) gespeicherte Daten. */
  hasData: boolean;
  digestVersion: number | null;
  /** orders_n IS NOT NULL: Ordersummen bekannt (Order-Daten des Tages vollständig). */
  ordersKnown: boolean;
  /** data_day.big_floor_n: Untergrenze, mit der big_order für den Tag geschrieben wurde. */
  floorN: number | null;
  /** HOLES_SQL */
  holes: number;
  source: string | null;
  /** live_until in ms (Ende der letzten geschriebenen Minute) oder null. */
  liveUntil: number | null;
  firstAggId: number | null;
  lastAggId: number | null;
}

export async function readOrderDays(
  tx: ReadTx,
  symId: number,
  d0: number,
  d1: number,
): Promise<Map<number, OrderDaySnap>> {
  const rows = await tx.rows(
    `SELECT (day - DATE '1970-01-01')::int, state, version, immutable,
            state <> 'importing' OR state_before_import IS NOT NULL,
            digest_version, orders_n IS NOT NULL, big_floor_n::text, ${HOLES_SQL}, source,
            (extract(epoch FROM live_until) * 1000)::int8, first_agg_id, last_agg_id
       FROM data_day d WHERE sym_id = $1 AND day >= ${dateLit(d0)} AND day <= ${dateLit(d1)}`,
    [symId],
  );
  const m = new Map<number, OrderDaySnap>();
  for (const r of rows)
    m.set(int(r[0]), {
      day: int(r[0]),
      state: String(r[1]),
      version: int(r[2]),
      immutable: r[3] === true,
      hasData: r[4] === true,
      digestVersion: intOrNull(r[5]),
      ordersKnown: r[6] === true,
      floorN: intOrNull(r[7]),
      holes: int(r[8]),
      source: r[9] === null ? null : String(r[9]),
      liveUntil: intOrNull(r[10]),
      firstAggId: intOrNull(r[11]),
      lastAggId: intOrNull(r[12]),
    });
  return m;
}

/**
 * Lückenminuten (Beginn in ms) der Tage `days`, aufsteigend: gap vor missing (→ source_missing) vor
 * mismatch je Minute.
 */
export async function queryHoleMinutes(
  tx: ReadTx,
  symId: number,
  days: number[],
): Promise<{ ts: number; reason: 'gap' | 'source_missing' | 'mismatch' }[]> {
  if (days.length === 0) return [];
  const where = days
    .map((d) => `(ts >= ${tsLit(d * DAY_MS)} AND ts < ${tsLit((d + 1) * DAY_MS)})`)
    .join(' OR ');
  const rows = await tx.rows(
    `SELECT (extract(epoch FROM ts) * 1000)::int8, bool_or(kind = 'gap'), bool_or(kind = 'missing')
       FROM data_minute_issue
      WHERE sym_id = $1 AND kind IN ('gap', 'missing', 'mismatch') AND (${where})
      GROUP BY 1 ORDER BY 1`,
    [symId],
  );
  return rows.map((r) => ({
    ts: int(r[0]),
    reason: r[1] === true ? 'gap' : r[2] === true ? 'source_missing' : 'mismatch',
  }));
}

/** Erste gespeicherte Minute (ms) je Tag in bar_1m, für die Tage `days`. */
export async function queryFirstMinutes(
  tx: ReadTx,
  symId: number,
  days: number[],
): Promise<Map<number, number>> {
  const m = new Map<number, number>();
  if (days.length === 0) return m;
  const where = days
    .map((d) => `(ts >= ${tsLit(d * DAY_MS)} AND ts < ${tsLit((d + 1) * DAY_MS)})`)
    .join(' OR ');
  const rows = await tx.rows(
    `SELECT (extract(epoch FROM min(ts)) * 1000)::int8 FROM bar_1m
      WHERE sym_id = $1 AND (${where}) GROUP BY time_bucket('1 day'::interval, ts)`,
    [symId],
  );
  for (const r of rows) {
    const t = int(r[0]);
    m.set(Math.floor(t / DAY_MS), t);
  }
  return m;
}

export interface BigOrderRows {
  ts: number[];
  firstAggId: number[];
  side: number[];
  pxFirst: number[];
  pxLast: number[];
  qty: number[];
  notional: number[];
  aggN: number[];
  /** Orders ≥ Schwelle in den gelesenen Bereichen (vor der Ausdünnung). */
  total: number;
  /** Ausdünnung: je (Bar, Seite) die k größten; null = alle geliefert. */
  k: number | null;
}

/**
 * Orders mit notional ≥ minN in den Zeitbereichen `ranges` (je [from, to) in ms, disjunkt), nach
 * (ts, first_agg_id). Liegen mehr als maxRows vor, werden je (Bar des Zeitrahmens tfSec, Seite) nur die
 * k größten geliefert (Rang nach notional absteigend, dann ts, first_agg_id – deterministisch), mit dem
 * größten k, für das Σ min(Anzahl, k) ≤ maxRows; alles in einer Abfrage über einen Scan.
 */
export async function queryBigOrders(
  tx: ReadTx,
  symId: number,
  ranges: { from: number; to: number }[],
  tfSec: number,
  minN: number,
  maxRows: number,
): Promise<BigOrderRows> {
  const out: BigOrderRows = {
    ts: [],
    firstAggId: [],
    side: [],
    pxFirst: [],
    pxLast: [],
    qty: [],
    notional: [],
    aggN: [],
    total: 0,
    k: null,
  };
  if (ranges.length === 0) return out;
  if (!Number.isSafeInteger(minN) || minN <= 0) throw new Error(`Schwelle ${minN} ungültig`);
  if (!Number.isSafeInteger(maxRows) || maxRows <= 0)
    throw new Error(`maxRows ${maxRows} ungültig`);
  const rows = await tx.rows(bigOrdersSql(ranges, tfSec), [symId, String(minN), String(maxRows)]);
  for (const r of rows) {
    out.total = int(r[0]);
    out.k = r[1] === null ? null : int(r[1]);
    if (r[2] === null) continue;
    out.ts.push(int(r[2]));
    out.firstAggId.push(int(r[3]));
    out.side.push(int(r[4]));
    out.pxFirst.push(int(r[5]));
    out.pxLast.push(int(r[6]));
    out.qty.push(int(r[7]));
    out.notional.push(int(r[8]));
    out.aggN.push(int(r[9]));
  }
  return out;
}

/**
 * SQL von queryBigOrders ($1 sym_id, $2 Schwelle minN, $3 maxRows). o: alle Orders ≥ Schwelle (ein
 * Scan); n: Gesamtzahl; ohne Ausdünnung direkt geliefert. Sonst Rang je (Bar, Seite), Häufigkeit je
 * Rang, kumuliert → größtes k mit Σ min(Anzahl, k) ≤ maxRows. Exportiert für den Plan-Benchmark.
 */
export function bigOrdersSql(ranges: { from: number; to: number }[], tfSec: number): string {
  const tfMs = tfSec * 1000;
  if (!Number.isSafeInteger(tfMs) || tfMs <= 0) throw new Error(`Zeitrahmen ${tfSec} ungültig`);
  if (ranges.length === 0) throw new Error('keine Bereiche');
  const where = ranges.map((r) => `(ts >= ${tsLit(r.from)} AND ts < ${tsLit(r.to)})`).join(' OR ');
  return `WITH o AS MATERIALIZED (
       SELECT (extract(epoch FROM ts) * 1000)::int8 AS t, first_agg_id, side, px_first, px_last,
              qty, notional, agg_n
         FROM big_order WHERE sym_id = $1 AND notional >= $2::int8 AND (${where})),
     n AS (SELECT count(*)::int8 AS total FROM o),
     r AS MATERIALIZED (
       SELECT o.*, row_number() OVER (PARTITION BY o.t / ${tfMs}, o.side
                                      ORDER BY o.notional DESC, o.t, o.first_agg_id) AS rk
         FROM o, n WHERE n.total > $3::int8),
     h AS (SELECT rk, count(*) AS c FROM r GROUP BY rk),
     kk AS (SELECT coalesce(max(rk), 0)::int8 AS k FROM
              (SELECT rk, sum(c) OVER (ORDER BY rk) AS cum FROM h) x WHERE cum <= $3::int8),
     sel AS (
       SELECT t, first_agg_id, side, px_first, px_last, qty, notional, agg_n FROM o, n
        WHERE n.total <= $3::int8
       UNION ALL
       SELECT t, first_agg_id, side, px_first, px_last, qty, notional, agg_n FROM r, kk
        WHERE r.rk <= kk.k)
     SELECT n.total, CASE WHEN n.total > $3::int8 THEN (SELECT k FROM kk) END,
            s.t, s.first_agg_id, s.side, s.px_first, s.px_last, s.qty, s.notional, s.agg_n
       FROM n LEFT JOIN sel s ON true
      ORDER BY s.t, s.first_agg_id`;
}
