// Fixture-Generator (nur Entwicklung): erzeugt Footprint- und Bar-Kacheln für BTCUSDT 2026-11-20…22
// aus den echten aggTrades-Tagesdateien, mit denselben Funktionen wie der Importer (packages/core:
// Tagesaggregation, Rollups, Quellenwahl §5.2, Kachellänge §5.3, Kachelformat §5.6).
//
// Liest nur (data/raw/binance-vision, über die streamenden Leser des Importers), schreibt nur nach
// apps/web/fixtures/ (git-ignoriert). Aufruf:  npm run fixtures -w @orderflow/web
//   Optionen: --data-dir <pfad> (Standard: OF_DATA_DIR bzw. <repo>/data), --out <pfad>, --symbol, --from, --to
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBarsTile,
  buildFootprintTile,
  chooseFpSource,
  computeFpRollups,
  encodeTile,
  FP_TABLES,
  FpBuilder,
  formatDay,
  getSymbol,
  ladder,
  maxRowsPerBar,
  medianRowsPerBar,
  parseDay,
  rollupBars,
  rollupFp,
  tfSeconds,
  tileBarsForMax,
  tileIndexAt,
  TILE_MAX_CELLS,
  type Bar,
  type FpTable,
  type FpTableName,
} from '@orderflow/core';
import { readAggTrades } from '../../importer/src/readers.ts';
import { absPath, isPresent } from '../../importer/src/files.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const symbol = arg('symbol', 'BTCUSDT');
const fromDay = parseDay(arg('from', '2026-11-20'));
const toDay = parseDay(arg('to', '2026-11-22'));
const dataDir = resolve(arg('data-dir', process.env.OF_DATA_DIR ?? join(repo, 'data')));
const outDir = resolve(arg('out', join(here, '..', 'fixtures')));
const TIMEFRAMES = ['1m', '5m', '15m', '1h'] as const;
const MAX_R = 10_000;
const spec = getSymbol(symbol);

if (outDir.startsWith(resolve(dataDir)))
  throw new Error(`Ausgabe ${outDir} liegt unter data/ – verweigert`);

function concatFp(parts: FpTable[]): FpTable {
  const b = new FpBuilder(parts.reduce((s, p) => s + p.n, 0) + 16);
  for (const p of parts)
    for (let i = 0; i < p.n; i++)
      b.push(p.ts[i]!, p.px[i]!, p.buyQ[i]!, p.sellQ[i]!, p.buyA[i]!, p.sellA[i]!);
  return b.build();
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const perTable: Record<FpTableName, FpTable[]> = Object.fromEntries(
    FP_TABLES.map((t) => [t, []]),
  ) as unknown as Record<FpTableName, FpTable[]>;
  const bars1m: Bar[] = [];
  let trades = 0;
  for (let d = fromDay; d <= toDay; d++) {
    const ref = { kind: 'aggTrades', origin: 'daily', symbol, period: formatDay(d) } as const;
    const path = absPath(dataDir, ref);
    if (!isPresent(path)) throw new Error(`Rohdatei fehlt: ${path}`);
    const td = performance.now();
    await readAggTrades(path, spec, {
      firstDay: d,
      lastDay: d,
      want: (x) => x === d,
      onDay: ({ agg }) => {
        if (!agg) return;
        trades += agg.trades;
        const fp = computeFpRollups(agg.fp1m, spec.tickRefUnits);
        for (const t of FP_TABLES) perTable[t].push(fp[t]);
        for (const b of agg.bars) bars1m.push(b);
      },
    });
    console.log(`${formatDay(d)}: gelesen in ${((performance.now() - td) / 1000).toFixed(1)} s`);
  }
  const days = toDay - fromDay + 1;
  const fp = Object.fromEntries(FP_TABLES.map((t) => [t, concatFp(perTable[t])])) as Record<
    FpTableName,
    FpTable
  >;
  const rowsPerDay = Object.fromEntries(FP_TABLES.map((t) => [t, fp[t].n / days])) as Record<
    FpTableName,
    number
  >;
  console.log(
    'Zeilen/Tag:',
    Object.fromEntries(Object.entries(rowsPerDay).map(([k, v]) => [k, Math.round(v)])),
  );

  await rm(outDir, { recursive: true, force: true });
  const symDir = join(outDir, symbol);
  const fromMs = fromDay * 86_400_000;
  const toMs = (toDay + 1) * 86_400_000;
  const dataVersion = `fixture:${symbol}:${formatDay(fromDay)}..${formatDay(toDay)}:v1`;
  const base = {
    sym: symbol,
    priceDecimals: spec.priceDecimals,
    qtyDecimals: spec.qtyDecimals,
    tickRefUnits: spec.tickRefUnits,
    dataVersion,
    final: true,
  };
  // n je (tf, R) aus dem Maximum der Zeilen je Bar (tileBarsForMax): keine Kachel über der harten
  // Grenze; Kombinationen, bei denen selbst 32 Bars sie reißen könnten, werden nicht angeboten.
  const tiles: Record<string, Record<string, number>> = {};
  const stats: Record<string, unknown>[] = [];
  let files = 0;
  let bytes = 0;
  for (const tf of TIMEFRAMES) {
    const tfSec = tfSeconds(tf);
    const tfMin = tfSec / 60;
    const bars = tfMin === 1 ? bars1m : rollupBars(bars1m, tfMin);
    const barsEnc = encodeTile(buildBarsTile({ ...base, tf, tfSec, from: fromMs, to: toMs }, bars));
    await mkdir(join(symDir, 'bars'), { recursive: true });
    await writeFile(join(symDir, 'bars', `${tf}.bin`), barsEnc);
    files++;
    bytes += barsEnc.length;
    tiles[tf] = {};
    const high = bars.map((b) => b.high);
    const low = bars.map((b) => b.low);
    for (const R of ladder(MAX_R)) {
      const width = R * spec.tickRefUnits;
      const rows = medianRowsPerBar(high, low, width);
      const maxRows = maxRowsPerBar(high, low, width);
      const n = tileBarsForMax(maxRows);
      if (n === null) continue; // nicht angeboten (32 · max > 60 000)
      const src = chooseFpSource(tfMin, R, rowsPerDay);
      const rolled = rollupFp(fp[src], tfMin, width);
      const k0 = tileIndexAt(fromMs / 1000, n, tfSec);
      const k1 = tileIndexAt(toMs / 1000 - 1, n, tfSec);
      let maxCells = 0;
      let maxSrcRows = 0;
      let over30k = 0;
      const dir = join(symDir, 'footprint', tf, String(R));
      await mkdir(dir, { recursive: true });
      for (let k = k0; k <= k1; k++) {
        const tile = buildFootprintTile(
          { ...base, tf, tfSec, R, tile: { index: k, n } },
          rolled,
          bars,
        );
        const cells = tile.levels!.row.length;
        maxCells = Math.max(maxCells, cells);
        // Geschätzte Quellzeilen der Kachel (Guard §5.1, nur Bericht): Zeilen/Tag × Kachelspanne
        maxSrcRows = Math.max(maxSrcRows, (rowsPerDay[src] * n * tfSec) / 86_400);
        if (cells > 30_000) over30k++;
        if (cells > TILE_MAX_CELLS)
          throw new Error(`Kachel ${tf}/${R}/${k} mit ${cells} Zellen – Kachellänge falsch`);
        const enc = encodeTile(tile);
        await writeFile(join(dir, `${k}.bin`), enc);
        files++;
        bytes += enc.length;
      }
      tiles[tf][String(R)] = n;
      stats.push({
        tf,
        R,
        src,
        rowsPerBar: rows,
        n,
        tiles: k1 - k0 + 1,
        maxCells,
        over30k,
        maxRowsPerBar: maxRows,
        maxSrcRows: Math.round(maxSrcRows),
      });
      if (rows <= 1) break; // gröbere Zeilen bringen nichts mehr
    }
  }
  const last = bars1m[bars1m.length - 1]!;
  const first = bars1m[0]!;
  const meta = {
    generatedAt: new Date().toISOString(),
    source: `data/raw/binance-vision daily aggTrades ${formatDay(fromDay)}..${formatDay(toDay)}`,
    trades,
    symbols: [
      {
        name: symbol,
        priceDecimals: spec.priceDecimals,
        qtyDecimals: spec.qtyDecimals,
        tickRefUnits: spec.tickRefUnits,
        tickUnits: spec.tickRefUnits,
        dataFrom: fromMs,
        dataTo: toMs,
        firstOpen: first.open,
        lastClose: last.close,
        tileConfigVersion: 2,
        tiles,
      },
    ],
    stats,
  };
  await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.table(stats);
  console.log(
    `${files} Dateien, ${(bytes / 1e6).toFixed(1)} MB, ${trades} aggTrades, ${((performance.now() - t0) / 1000).toFixed(1)} s → ${outDir}`,
  );
}

await main();
