// Exakte Zellzahl je Footprint-Kachel über die gesamte gespeicherte Historie, für jede angebotene
// (tf, R) der aktuellen Regel (P95 der Tagesmaxima): Anzahl Kacheln, größte Zellzahl, Kacheln über
// 30 000 und über 60 000. Nur lesend (Rolle of_api).   node --env-file=.env apps/api/bench/tile-cells.ts
import { TIMEFRAMES, tileBarsForMax } from '@orderflow/core';
import { Catalog, TILE_LADDER, TIMEFRAME_LIST } from '../src/catalog.ts';
import { parseApiConfig } from '../src/config.ts';
import { createPool, int } from '../src/db.ts';

const cfg = { ...parseApiConfig(process.env), statementTimeoutMs: 600_000, dbPool: 1 };
const sql = createPool(cfg, 'orderflow-api-tile-cells');
const cat = new Catalog(sql, {
  pollMs: 1e9,
  lockRetries: 3,
  maxSourceRows: cfg.maxSourceRows,
  log: () => {},
});
await cat.refresh();
const s = cat.symbols()[0]!;
console.log(`${s.name}: ${s.days.size} Tage, tileConfigVersion ${s.tileConfigVersion}`);
console.log(
  '| tf | R | n | alte Regel (Max) | Quelle | Kacheln | max Zellen | > 30 000 | > 60 000 |',
);
console.log('|---|---|---|---|---|---|---|---|---|');
for (const tf of TIMEFRAME_LIST) {
  const tfSec = TIMEFRAMES[tf];
  for (const [Rs, n] of Object.entries(s.tiles[tf] ?? {})) {
    const R = Number(Rs);
    const i = TILE_LADDER.indexOf(R);
    let max = 0;
    for (const st of s.stats.values()) max = Math.max(max, st.maxRows.get(tf)?.[i] ?? 0);
    const old = tileBarsForMax(max);
    const src = s.tileSrc.get(`${tf}|${R}`)!;
    const w = R * s.tickRefUnits;
    const span = n * tfSec;
    const [r] = await sql.unsafe(
      `SELECT count(*) AS a, max(c) AS b, sum((c > 30000)::int) AS c3, sum((c > 60000)::int) AS c6 FROM (
         SELECT k, count(*) AS c FROM (
           SELECT extract(epoch from time_bucket('${tfSec} seconds'::interval, ts))::int8 / ${span} AS k,
                  time_bucket('${tfSec} seconds'::interval, ts) AS b, px / ${w} AS r
             FROM ${src} WHERE sym_id = $1 GROUP BY 1, 2, 3) y GROUP BY k) x`,
      [s.symId],
    );
    const v = Object.values(r!) as unknown[];
    console.log(
      `| ${tf} | ${R} | ${n} | ${old === null ? 'nicht angeboten' : `n=${old}`} | ${src} | ${int(v[0])} | ${int(v[1])} | ${int(v[2])} | ${int(v[3])} |`,
    );
  }
}
await sql.end();
