// Nur lesende Gegenprobe der Stats-Spalten auf echten Daten: startet die API (eigener Port), holt
// /bars?stats=1 und /footprint?stats=1 für einige Abschnitte/Kacheln je tf und vergleicht jede Spalte mit
// einer unabhängigen SQL-Rechnung direkt aus bar_1m (Fensterfunktionen, KONZEPT §3.5) bzw. kline_1m.
//   node --env-file=.env apps/api/bench/stats-check.ts
import { decodeTile, TIMEFRAMES } from '@orderflow/core';
import { parseApiConfig } from '../src/config.ts';
import { createPool, int } from '../src/db.ts';
import { startApi } from '../src/main.ts';

const cfg = { ...parseApiConfig(process.env), port: 0, adminPort: 0, statementTimeoutMs: 60_000 };
const api = await startApi(cfg, { logger: false });
const sql = createPool(cfg, 'orderflow-api-stats-check');
const sym = (
  (await (await fetch(`${api.url}/api/v1/symbols`)).json()) as {
    symbols: {
      name: string;
      dataFrom: number;
      dataTo: number;
      tileConfigVersion: number;
      tiles: Record<string, Record<string, number>>;
    }[];
  }
).symbols.find((s) => s.name === (process.env.CHECK_SYM ?? 'BTCUSDT'))!;
const [{ id }] =
  (await sql`SELECT sym_id AS id FROM symbol WHERE name = ${sym.name}`) as unknown as [
    { id: number },
  ];

async function reference(tfSec: number, from: number, to: number) {
  const A = `'${new Date(from).toISOString()}'::timestamptz`;
  const B = `'${new Date(to).toISOString()}'::timestamptz`;
  const rows = await sql
    .unsafe(
      `WITH m AS (
       SELECT time_bucket('${tfSec} seconds'::interval, ts) AS b, ts, high_px, low_px, buy_q - sell_q AS d,
              run_max, run_min, d_from_low, d_from_high
         FROM bar_1m WHERE sym_id = $1 AND ts >= ${A} AND ts < ${B}),
     p AS (
       SELECT *, coalesce(sum(d) OVER (PARTITION BY b ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS pre,
              sum(d) OVER (PARTITION BY b) AS tot, min(low_px) OVER (PARTITION BY b) AS bl,
              max(high_px) OVER (PARTITION BY b) AS bh FROM m),
     k AS (SELECT time_bucket('${tfSec} seconds'::interval, ts) AS b, sum(trades) AS tr FROM kline_1m
            WHERE sym_id = $1 AND ts >= ${A} AND ts < ${B} GROUP BY 1)
     SELECT extract(epoch from p.b)::int8, max(pre + run_max)::int8, min(pre + run_min)::int8,
            ((array_agg(d_from_low + tot - pre - d ORDER BY ts) FILTER (WHERE low_px = bl))[1])::int8,
            ((array_agg(d_from_high + tot - pre - d ORDER BY ts) FILTER (WHERE high_px = bh))[1])::int8,
            coalesce(max(k.tr), 0)::int8
       FROM p LEFT JOIN k ON k.b = p.b GROUP BY p.b ORDER BY 1`,
      [id],
    )
    .values();
  return new Map(
    rows.map((r) => [int(r[0]), [int(r[1]), int(r[2]), int(r[3]), int(r[4]), int(r[5])]]),
  );
}

let bars = 0;
let mismatches = 0;
const report: string[] = [];
async function check(label: string, url: string, tfSec: number) {
  const dec = decodeTile(new Uint8Array(await (await fetch(api.url + url)).arrayBuffer()));
  const x = dec.extra ?? {};
  const ref = await reference(tfSec, dec.header.from, dec.header.to);
  let bad = 0;
  for (let i = 0; i < dec.header.nBars; i++) {
    const e = ref.get(dec.bars.time[i]!);
    const got = [x['x.maxDelta']![i], x['x.minDelta']![i], x['x.cotHigh']![i], x['x.cotLow']![i]];
    if (!e || got.some((v, j) => v !== e[j]) || (x['x.trades'] && x['x.trades'][i] !== e[4])) bad++;
  }
  bars += dec.header.nBars;
  mismatches += bad;
  report.push(
    `${label}: ${dec.header.nBars} Bars, x.trades ${x['x.trades'] ? 'ja' : 'nein'}, Abweichungen ${bad}`,
  );
}
for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d'] as const) {
  const tfSec = TIMEFRAMES[tf];
  const span = 1000 * tfSec * 1000;
  const mid = Math.floor((sym.dataFrom + sym.dataTo) / 2 / span) * span;
  await check(
    `bars ${tf}`,
    `/api/v1/bars?sym=${sym.name}&tf=${tf}&from=${mid}&to=${mid + span}&stats=1`,
    tfSec,
  );
  const Rs = Object.keys(sym.tiles[tf] ?? {});
  const R = Rs[Math.floor(Rs.length / 2)]!;
  const n = sym.tiles[tf]![R]!;
  const k = Math.floor((sym.dataTo - 2 * 86_400_000) / (n * tfSec * 1000));
  await check(
    `footprint ${tf} R=${R} tile ${k}`,
    `/api/v1/footprint?sym=${sym.name}&tf=${tf}&R=${R}&tile=${k}&cfg=${sym.tileConfigVersion}&stats=1`,
    tfSec,
  );
}
console.log(report.join('\n'));
console.log(`${sym.name}: ${bars} Bars geprüft, ${mismatches} Abweichungen`);
await sql.end();
await api.close();
process.exitCode = mismatches === 0 ? 0 : 1;
