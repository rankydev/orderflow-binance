// SQL der Leseendpunkte. Tabellennamen nur aus festen Listen, Zeitgrenzen als Literale aus geprüften
// Ganzzahlen (konstante Grenzen → Chunk-Ausschluss beim Planen, KONZEPT §5.8), alle übrigen Werte als
// Parameter. Mengen kommen als int8 (Text) und werden mit int() auf sichere Ganzzahlen geprüft;
// Notional nur als Text → BigInt.
import { fpTableGrid, type FpTableName } from '@orderflow/core';
import { bigintOf, int, type ReadTx, type Row } from './db.ts';
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
