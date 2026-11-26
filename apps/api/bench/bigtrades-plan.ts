// Plan und Laufzeit der /bigtrades-Abfrage (queries.ts bigOrdersSql) auf SYNTHETISCHEN big_order-Zeilen
// im Columnstore – nie auf der Entwicklungsdatenbank: legt "<OF_DB_NAME>_test_bench_bigtrades" an (Admin-
// Rolle aus OF_DB_*) und löscht sie am Ende. Gedacht für einen Wegwerf-Container:
//   scripts/test-db-throwaway.sh node apps/api/bench/bigtrades-plan.ts
// Daten: BENCH_DAYS Tage (Standard 400) × BENCH_PER_DAY Orders (Standard 4 600, gemessen 2026-11-21:
// BTC 4 257, ETH 4 626 je Tag an der Untergrenze), Notional Pareto ab 500 000 USDT mit α = 1,82
// (P(> 5 Mio.) ≈ 1,5 % ≈ 65/4 257 wie gemessen), Zeiten gleichverteilt, alle Chunks komprimiert.
import { parseConfig } from '@orderflow/core';
import { connect, dropAndCreateDatabase, migrateUp } from '@orderflow/db';
import { BIGTRADES_MAX_ROWS } from '../src/routes/bigtrades.ts';
import { bigOrdersSql } from '../src/queries.ts';
// Review H2c: Chunk-Konvertierung nur auf Test-Datenbanken
import { assertTestDatabase } from '../../importer/src/maintenance.ts';

const DAY = 86_400_000;
const DAYS = Number(process.env.BENCH_DAYS ?? 400);
const PER_DAY = Number(process.env.BENCH_PER_DAY ?? 4_600);
const FIRST = 20_400; // 2025-11-08
const FLOOR_N = 50_000_000_000; // 500 000 USDT in 10^-5 USDT (BTCUSDT)
const UNIT = 100_000; // 10^(2+3)

const base = parseConfig(process.env).db;
const cfg = { ...base, database: `${base.database}_test_bench_bigtrades` };
// Standardport der Entwicklungs-DB (docker-compose.yml): nie dort
if (cfg.port === 54320 || !process.env.OF_DB_PORT)
  throw new Error('nur im Wegwerf-Container laufen lassen (scripts/test-db-throwaway.sh)');
await dropAndCreateDatabase(cfg);
const sql = connect(cfg);
try {
  await assertTestDatabase(sql);
  await migrateUp(sql);
  await sql`INSERT INTO symbol (sym_id, name, price_unit, price_decimals, tick_ref_units, qty_unit,
                               qty_decimals, data_from, big_floor_n)
            VALUES (1, 'BTCUSDT', 0.01, 2, 10, 0.001, 3, '2025-01-01', ${FLOOR_N})`;
  const t0 = performance.now();
  await sql.unsafe(`SELECT setseed(0.42)`);
  // je Order: Zeit im Tag, Notional = Floor · U^(−1/α), Preis ≈ 90 000 USDT, qty = notional / px
  await sql.unsafe(
    `INSERT INTO big_order (sym_id, ts, first_agg_id, last_agg_id, side, px_first, px_last, qty, notional, agg_n)
     SELECT 1, t, id, id + a - 1, s, px, px + (a - 1) * 10, greatest(1, (nt / px)::int8), greatest(1, (nt / px)::int8) * px, a
       FROM (SELECT d, g,
                    to_timestamp(((${FIRST} + d)::int8 * ${DAY} + (random() * ${DAY - 1})::int8) / 1000.0) AS t,
                    (d::int8 * ${PER_DAY} + g) * 10 AS id,
                    1 + (random() * 3)::int AS s0,
                    9000000 + (random() * 100000)::int AS px,
                    (${FLOOR_N} * power(random(), -1 / 1.82))::numeric AS nt,
                    1 + (random() * 6)::int AS a
               FROM generate_series(0, ${DAYS - 1}) d, generate_series(1, ${PER_DAY}) g) x,
            LATERAL (SELECT CASE WHEN s0 % 2 = 0 THEN 1 ELSE 2 END AS s) y
      WHERE greatest(1, (nt / px)::int8) * px >= ${FLOOR_N}`,
  );
  const chunks = await sql<{ c: string }[]>`
    SELECT format('%I.%I', chunk_schema, chunk_name) AS c FROM timescaledb_information.chunks
     WHERE hypertable_name = 'big_order'`;
  for (const { c } of chunks) await sql.unsafe(`CALL convert_to_columnstore('${c}'::regclass)`);
  await sql.unsafe('ANALYZE big_order');
  const [cnt] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM big_order`;
  console.log(
    `big_order: ${cnt!.n} Zeilen, ${chunks.length} Chunks komprimiert, ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );

  const cases: { name: string; tfSec: number; days: number; minUsdt: number }[] = [];
  for (const [tf, tfSec] of [
    ['1m', 60],
    ['15m', 900],
    ['1h', 3600],
    ['4h', 14_400],
    ['1d', 86_400],
  ] as const) {
    // ein Abschnitt zu 1 000 Bars wie /bars (höchstens die erzeugten Tage)
    const days = Math.min(DAYS, Math.ceil((1000 * tfSec * 1000) / DAY));
    for (const minUsdt of [500_000, 2_000_000, 10_000_000])
      cases.push({ name: `${tf} × 1000`, tfSec, days, minUsdt });
  }
  console.log('Fall | Tage | Schwelle USDT | gelesen (Scan) | total | geliefert | ms (min von 3)');
  for (const c of cases) {
    const from = (FIRST + DAYS - c.days) * DAY;
    const to = (FIRST + DAYS) * DAY;
    const text = bigOrdersSql([{ from, to }], c.tfSec);
    const params = ['1', String(c.minUsdt * UNIT), String(BIGTRADES_MAX_ROWS)];
    let best = Infinity;
    let total = 0;
    let n = 0;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const rows = await sql.unsafe(text, params).values();
      best = Math.min(best, performance.now() - t);
      total = Number(rows[0]![0]);
      n = rows[0]![2] === null ? 0 : rows.length;
    }
    const [sc] = await sql.unsafe<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM big_order WHERE sym_id = 1 AND ts >= to_timestamp(${from / 1000}) AND ts < to_timestamp(${to / 1000})`,
    );
    console.log(
      `${c.name} | ${c.days} | ${c.minUsdt} | ${sc!.n} | ${total} | ${n} | ${best.toFixed(0)}`,
    );
  }
  // Plan für den längsten Fall mit hoher Schwelle
  const from = (FIRST + DAYS - Math.min(DAYS, 167)) * DAY;
  const plan = await sql.unsafe(
    `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${bigOrdersSql([{ from, to: (FIRST + DAYS) * DAY }], 14_400)}`,
    ['1', String(10_000_000 * UNIT), String(BIGTRADES_MAX_ROWS)],
  );
  console.log('\nPlan 4h × 1000 Bars, Schwelle 10 Mio. USDT:');
  for (const r of plan) console.log(Object.values(r)[0]);
} finally {
  await sql.end();
  const drop = connect({ ...base });
  await drop.unsafe(`DROP DATABASE IF EXISTS "${cfg.database}" WITH (FORCE)`);
  await drop.end();
}
