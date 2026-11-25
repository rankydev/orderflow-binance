// Synthetische Testdaten für die API-Integrationstests: deterministische aggTrades je Tag → dieselben
// Aggregate wie der Importer (packages/core: aggregateDay, computeFpRollups, computeBarRollups) →
// Testdatenbank "<OF_DB_NAME>_test_api" (als Admin-Rolle, nie die Entwicklungsdatenbank).
// Enthält Minuten ohne Trades, breite Bars, große Trades (Tagesnotional > 2^53) und Columnstore-Chunks.
import {
  aggregateDay,
  computeBarRollups,
  computeFpRollups,
  FP_TABLES,
  FpBuilder,
  type AggTrade,
  type Bar,
  type FpTable,
  type FpTableName,
} from '@orderflow/core';
import type { Sql } from '@orderflow/db';

export const SYM_ID = 1;
export const TICK = 10;
/** 2026-09-29 … 2026-10-04: überquert die 7-Tage-Chunkgrenze (20 727) und die 30-Tage-Grenze (20 730). */
export const FIRST_DAY = 20_725;
export const LAST_DAY = 20_730;
export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;
/** Tag mit Zustand final_bad (trotzdem unveränderlich) und Tag provisional (nicht unveränderlich). */
export const BAD_DAY = 20_728;
export const PROVISIONAL_DAY = 20_730;
/**
 * Ausreißer am provisorischen Tag: zwei aufeinanderfolgende Minuten mit je OUTLIER_ROWS Trades auf
 * denselben, je einen Tick auseinanderliegenden Preisen. Eine 1m-Kachel bei R = 1 hat damit über
 * 60 000 Zellen (Zell-Wächter → 422 für genau diese Kachel), ein Profil bei R = 1 nur ≈ 31 000 Zeilen.
 */
export const OUTLIER_MINUTE = 600;
export const OUTLIER_ROWS = 31_000;
export const OUTLIER_MS = PROVISIONAL_DAY * 86_400_000 + OUTLIER_MINUTE * 60_000;
/** Echte Lücke am unveränderlichen BAD_DAY: keine Trades 05:00–09:00 UTC (wie ein Börsenausfall). */
export const HOLE_FROM_MIN = 300;
export const HOLE_TO_MIN = 540;
/** Der provisorische (Live-)Tag hat Daten nur bis 15:00 UTC, danach nichts (unfertiger Tag). */
export const PROVISIONAL_UNTIL_MIN = 900;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface Seeded {
  fp: Record<FpTableName, FpTable>;
  bars1m: Bar[];
  bar1h: Bar[];
  bar1d: Bar[];
}

/** aggTrades eines Tages (aggId-Reihenfolge, T nicht fallend). */
function dayTrades(day: number, rnd: () => number, state: { a: number; tid: number; px: number }) {
  const out: AggTrade[] = [];
  const t0 = day * DAY_MS;
  for (let m = 0; m < 1440; m++) {
    if (day === PROVISIONAL_DAY && (m === OUTLIER_MINUTE || m === OUTLIER_MINUTE + 1)) {
      // zu Minutenbeginn, vor den übrigen Trades der Minute (Zeit nicht fallend)
      for (let j = 0; j < OUTLIER_ROWS; j++) {
        const T0 = t0 + m * MINUTE_MS;
        out.push({
          a: state.a++,
          px: state.px + j * TICK,
          q: 1,
          f: state.tid,
          l: state.tid,
          T: T0,
          m: j % 2 === 0,
        });
        state.tid++;
      }
    }
    if (rnd() < 0.2) continue; // Minuten ohne Trades
    if (day === BAD_DAY && m >= HOLE_FROM_MIN && m < HOLE_TO_MIN) continue;
    if (day === PROVISIONAL_DAY && m >= PROVISIONAL_UNTIL_MIN) continue;
    const k = 1 + Math.floor(rnd() * 4);
    let T = t0 + m * MINUTE_MS + Math.floor(rnd() * 1000);
    if (rnd() < 0.03) state.px += (rnd() < 0.5 ? -1 : 1) * 600 * TICK; // breite Bars
    for (let i = 0; i < k; i++) {
      state.px = Math.max(1_000_000, state.px + Math.round((rnd() - 0.5) * 80) * TICK);
      const big = i === 0 && m % 3 === 0; // große Trades: Tagesnotional > 2^53
      const q = big ? 2_000_000 : 1 + Math.floor(rnd() * 5000);
      const fills = 1 + Math.floor(rnd() * 3);
      out.push({
        a: state.a++,
        px: state.px,
        q,
        f: state.tid,
        l: state.tid + fills - 1,
        T,
        m: rnd() < 0.5,
      });
      state.tid += fills;
      T += 1 + Math.floor(rnd() * 5000);
    }
  }
  return out;
}

function concat(parts: FpTable[]): FpTable {
  const b = new FpBuilder(parts.reduce((s, p) => s + p.n, 0) + 16);
  for (const p of parts)
    for (let i = 0; i < p.n; i++)
      b.push(p.ts[i]!, p.px[i]!, p.buyQ[i]!, p.sellQ[i]!, p.buyA[i]!, p.sellA[i]!);
  return b.build();
}

export function generate(): Seeded {
  const rnd = mulberry32(20_261_124);
  const state = { a: 1_000_000, tid: 5_000_000, px: 10_000_000 };
  const parts: Record<string, FpTable[]> = Object.fromEntries(FP_TABLES.map((t) => [t, []]));
  const bars1m: Bar[] = [];
  for (let d = FIRST_DAY; d <= LAST_DAY; d++) {
    const agg = aggregateDay(d, dayTrades(d, rnd, state));
    const r = computeFpRollups(agg.fp1m, TICK);
    for (const t of FP_TABLES) parts[t]!.push(r[t]);
    bars1m.push(...agg.bars);
  }
  const { bar_1h, bar_1d } = computeBarRollups(bars1m);
  const fp = Object.fromEntries(FP_TABLES.map((t) => [t, concat(parts[t]!)])) as Record<
    FpTableName,
    FpTable
  >;
  return { fp, bars1m, bar1h: bar_1h, bar1d: bar_1d };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Trade-Anzahl der Kline einer Minute (synthetisch, deterministisch, ≠ aggTrade-Anzahl). */
export function klineTrades(b: Bar): number {
  return b.buyA + b.sellA + ((b.ts / 60_000) % 7);
}

function fpJson(t: FpTable): string {
  const rows: string[] = [];
  for (let i = 0; i < t.n; i++)
    rows.push(
      `{"sym_id":${SYM_ID},"ts":"${iso(t.ts[i]!)}","px":${t.px[i]},"buy_q":${t.buyQ[i]},"sell_q":${t.sellQ[i]},"buy_a":${t.buyA[i]},"sell_a":${t.sellA[i]}}`,
    );
  return `[${rows.join(',')}]`;
}

/** bar_1m-Zeilen einfügen (Tests: Wiederherstellung nach absichtlichem Löschen). */
export async function insertBars1m(admin: Sql, bars: Bar[]): Promise<void> {
  await admin.unsafe(
    `INSERT INTO bar_1m SELECT * FROM json_populate_recordset(NULL::bar_1m, ($1::text)::json)`,
    [barJson(bars, true)],
  );
}

function barJson(bars: Bar[], minute: boolean): string {
  return JSON.stringify(
    bars.map((b) => ({
      sym_id: SYM_ID,
      ts: iso(b.ts),
      open_px: b.open,
      high_px: b.high,
      low_px: b.low,
      close_px: b.close,
      buy_q: b.buyQ,
      sell_q: b.sellQ,
      buy_a: b.buyA,
      sell_a: b.sellA,
      notional: b.notional.toString(),
      first_agg_id: b.firstAggId,
      last_agg_id: b.lastAggId,
      first_trade_ms: b.firstTradeMs,
      last_trade_ms: b.lastTradeMs,
      run_max: b.runMax,
      run_min: b.runMin,
      d_from_low: b.dFromLow,
      d_from_high: b.dFromHigh,
      ...(minute ? { source: 3, check_state: 1 } : {}),
    })),
  );
}

/** Schreibt alles in die (frisch migrierte) Testdatenbank und konvertiert einige Chunks in den Columnstore. */
export async function seed(admin: Sql, s: Seeded): Promise<void> {
  await admin`INSERT INTO symbol (sym_id, name, price_unit, price_decimals, tick_ref_units, qty_unit,
                                  qty_decimals, data_from)
              VALUES (${SYM_ID}, 'BTCUSDT', 0.01, 2, ${TICK}, 0.001, 3, '2026-06-10')`;
  for (const t of FP_TABLES) {
    await admin.unsafe(
      `INSERT INTO ${t} SELECT * FROM json_populate_recordset(NULL::${t}, ($1::text)::json)`,
      [fpJson(s.fp[t])],
    );
  }
  for (const [t, bars] of [
    ['bar_1m', s.bars1m],
    ['bar_1h', s.bar1h],
    ['bar_1d', s.bar1d],
  ] as const) {
    await admin.unsafe(
      `INSERT INTO ${t} SELECT * FROM json_populate_recordset(NULL::${t}, ($1::text)::json)`,
      [barJson(bars, t === 'bar_1m')],
    );
  }
  // Kline-Referenz (Binance-Trade-Anzahl je Minute) für x.trades: je Bar-Minute eine Zeile
  await admin.unsafe(
    `INSERT INTO kline_1m SELECT * FROM json_populate_recordset(NULL::kline_1m, ($1::text)::json)`,
    [
      JSON.stringify(
        s.bars1m.map((b) => ({
          sym_id: SYM_ID,
          ts: iso(b.ts),
          open_px: b.open,
          high_px: b.high,
          low_px: b.low,
          close_px: b.close,
          vol: b.buyQ + b.sellQ,
          taker_buy: b.buyQ,
          trades: klineTrades(b),
          quote_vol_n: b.notional.toString(),
        })),
      ),
    ],
  );
  for (let d = FIRST_DAY; d <= LAST_DAY; d++) {
    const state = d === BAD_DAY ? 'final_bad' : d === PROVISIONAL_DAY ? 'provisional' : 'final_ok';
    const day = iso(d * DAY_MS).slice(0, 10);
    await admin`INSERT INTO data_day (sym_id, day, state, version, source, edge_pending, edge_first_pending,
                                      edge_last_pending, min_exact, min_shift, min_mismatch, min_missing, min_gap, rows)
                VALUES (${SYM_ID}, ${day}::date, ${state}, 2, 'vision', false, false, false,
                        1400, 38, ${d === BAD_DAY ? 1 : 0}, ${d === BAD_DAY ? 1 : 0}, 0, 4000)`;
    await admin`INSERT INTO symbol_tick_history (sym_id, day, min_step_units) VALUES (${SYM_ID}, ${day}::date, ${TICK})`;
  }
  const ts = (m: number) => iso(BAD_DAY * DAY_MS + m * MINUTE_MS);
  await admin`INSERT INTO data_minute_issue (sym_id, ts, kind, d_q, d_b) VALUES
    (${SYM_ID}, ${ts(2)}, 'mismatch', 1500, -700), (${SYM_ID}, ${ts(3)}, 'missing', 99, 0),
    (${SYM_ID}, ${ts(100)}, 'shift', 3, 1), (${SYM_ID}, ${ts(101)}, 'shift', -3, -1)`;
  // Columnstore wie im Betrieb: fp_1m der ersten drei Tage, alle Chunks von fp_1m_b10/fp_5m_b10, bar_1m
  const chunks = await admin<{ c: string }[]>`
    SELECT format('%I.%I', chunk_schema, chunk_name) AS c FROM timescaledb_information.chunks
     WHERE (hypertable_name = 'fp_1m' AND range_end <= ${iso((FIRST_DAY + 3) * DAY_MS)}::timestamptz)
        OR hypertable_name IN ('fp_1m_b10', 'fp_5m_b10', 'bar_1m', 'fp_1h_b100')`;
  for (const { c } of chunks) await admin.unsafe(`CALL convert_to_columnstore('${c}'::regclass)`);
}
