// Nur lesende Messung des Katalogstarts gegen die konfigurierte Datenbank: jede Abfrage mit Dauer und
// Zeilenzahl, Summen je Art, Zeit bis „ready". Schreibt nichts.
//   node --env-file=.env apps/api/bench/catalog-start.ts
import { Catalog } from '../src/catalog.ts';
import { parseApiConfig } from '../src/config.ts';
import { createPool, ReadTx } from '../src/db.ts';

const cfg = { ...parseApiConfig(process.env), statementTimeoutMs: 600_000 };
const sql = createPool({ ...cfg, dbPool: 1 }, 'orderflow-api-catalog-bench');
const log: { kind: string; ms: number; rows: number }[] = [];
const orig = ReadTx.prototype.rows;
ReadTx.prototype.rows = async function (text, params) {
  const t0 = performance.now();
  const r = await orig.call(this, text, params);
  const kind = /LOCK TABLE/.test(text)
    ? 'lock'
    : /FROM data_day ORDER BY/.test(text)
      ? 'data_day(all)'
      : /FROM symbol s/.test(text)
        ? 'symbol'
        : /FROM data_day/.test(text)
          ? 'data_day(range)'
          : /max\(b\.h/.test(text)
            ? 'maxRows'
            : /bit_or\(/.test(text)
              ? 'minutes+barCounts'
              : /count\(\*\)/.test(text)
                ? 'rowCounts'
                : 'other';
  log.push({ kind, ms: performance.now() - t0, rows: r.length });
  return r;
};
const cat = new Catalog(sql, {
  pollMs: 3_600_000,
  lockRetries: 5,
  maxSourceRows: Math.min(cfg.maxTileSourceRows, cfg.maxSourceRows),
  refreshTimeoutMs: 3_600_000,
  log: (l, m, o) => console.error(l, m, o ?? ''),
});
const t0 = performance.now();
await cat.refresh();
const total = performance.now() - t0;
await cat.stop();
await sql.end();
const by = new Map<string, { n: number; ms: number; max: number }>();
for (const q of log) {
  const b = by.get(q.kind) ?? { n: 0, ms: 0, max: 0 };
  b.n++;
  b.ms += q.ms;
  b.max = Math.max(b.max, q.ms);
  by.set(q.kind, b);
}
console.log(
  JSON.stringify(
    {
      ready: cat.ready,
      totalMs: Math.round(total),
      queries: log.length,
      symbols: cat.symbols().map((s) => ({
        name: s.name,
        days: s.days.size,
        tileConfigVersion: s.tileConfigVersion,
        ...(process.env.SHOW_TILES ? { tiles: s.tiles } : {}),
      })),
      byKind: Object.fromEntries(
        [...by].map(([k, b]) => [k, { n: b.n, ms: Math.round(b.ms), maxMs: Math.round(b.max) }]),
      ),
    },
    null,
    1,
  ),
);
