// GET /api/v1/symbols, /api/v1/bars, /api/v1/footprint – Vertrag in docs/TILE-FORMAT.md.
import {
  encodeTile,
  TILE_MAX_CELLS,
  TIMEFRAMES,
  type BarColumns,
  type LevelColumns,
  type TileMeta,
} from '@orderflow/core';
import type { FastifyInstance } from 'fastify';
import { coarserOffered, minutesFor, rowsOnFor, type SymbolState } from '../catalog.ts';
import { assertFresh, guardedRead, requireSymbol, type Deps } from '../context.ts';
import { serveVersioned } from '../respond.ts';
import { badRequest, HttpError, unprocessable } from '../errors.ts';
import { etagOfBody, makeResponse, send, acceptsGzip } from '../http.ts';
import { checkRange, MAX_BARS_PER_REQUEST, MAX_TIME_MS, Params, SYMBOL_RE } from '../params.ts';
import { barTableFor, coveredDays, estimateRows } from '../plan.ts';
import { allImmutable, checkCoverage, checkTile } from '../consistency.ts';
import type { ReadTx } from '../db.ts';
import type { BarTable } from '../plan.ts';
import {
  clampCommittedTo,
  queryBars,
  queryLevels,
  readCommittedTo,
  querySubBars,
  queryTrades,
  readDays,
  type BarRows,
  type LevelRows,
} from '../queries.ts';
import { STATS_COLUMNS, statsColumns, TRADES_MAX_ROWS } from '../stats.ts';
import { MAX_DAILY_DAYS, MAX_RANGE_MS, PROFILE_MAX_R } from './profile.ts';
import { MAX_ISSUES, MAX_QUALITY_DAYS } from './status.ts';
import {
  BIGTRADES_MAX_BARS,
  BIGTRADES_MAX_MATCHED_ROWS,
  BIGTRADES_MAX_MIN_USDT,
  BIGTRADES_MAX_ROWS,
  BIGTRADES_MAX_SOURCE_ROWS,
} from './bigtrades.ts';
import { versionOf } from '../versions.ts';

export const SYMBOLS_SCHEMA = 2;
export { MAX_BARS_PER_REQUEST };
const BIN = 'application/octet-stream';

/** Grenzen der Endpunkte für Clients (statisch je Konfiguration; ändert sich nicht mit den Daten). */
export function apiLimits(cfg: Deps['cfg']) {
  return {
    tiles: {
      maxCells: TILE_MAX_CELLS,
      maxSourceRows: Math.min(cfg.maxTileSourceRows, cfg.maxSourceRows),
      statsColumns: [...STATS_COLUMNS],
    },
    bars: { maxBars: MAX_BARS_PER_REQUEST },
    profile: {
      maxRows: cfg.maxCells,
      maxSourceRows: cfg.maxSourceRows,
      // R: Leiter {1, 2, 5}·10^k Ticks, R · tickRefUnits ≥ tickUnits, R ≤ maxR
      maxR: PROFILE_MAX_R,
      maxRangeDays: MAX_RANGE_MS / 86_400_000,
      maxDailyDays: MAX_DAILY_DAYS,
      offsetH: { min: -23, max: 23 },
      va: { min: 1, max: 100, default: 70 },
    },
    quality: { maxDays: MAX_QUALITY_DAYS, maxIssues: MAX_ISSUES },
    bigtrades: {
      maxBars: BIGTRADES_MAX_BARS,
      maxRows: BIGTRADES_MAX_ROWS,
      maxSourceRows: BIGTRADES_MAX_SOURCE_ROWS,
      maxMatchedRows: BIGTRADES_MAX_MATCHED_ROWS,
      maxMinUsdt: BIGTRADES_MAX_MIN_USDT,
    },
  };
}

export function symbolsBody(syms: SymbolState[], limits?: ReturnType<typeof apiLimits>): string {
  return JSON.stringify({
    schema: SYMBOLS_SCHEMA,
    ...(limits ? { limits } : {}),
    symbols: syms.map((s) => ({
      name: s.name,
      priceDecimals: s.priceDecimals,
      qtyDecimals: s.qtyDecimals,
      tickRefUnits: s.tickRefUnits,
      tickUnits: s.tickUnits,
      dataFrom: s.dataFrom,
      dataTo: s.dataTo,
      tileConfigVersion: s.tileConfigVersion,
      tiles: s.tiles,
      // null: Big Trades für dieses Symbol nicht verfügbar (docs/BIGTRADES-API.md)
      bigTrades: s.big
        ? {
            floorN: s.big.floorN,
            minUsdt: s.big.minUsdt,
            notionalDecimals: s.big.notionalDecimals,
          }
        : null,
    })),
  });
}

function barColumns(b: BarRows): BarColumns {
  return {
    time: Int32Array.from(b.time),
    open: Int32Array.from(b.open),
    high: Int32Array.from(b.high),
    low: Int32Array.from(b.low),
    close: Int32Array.from(b.close),
    buyQ: Float64Array.from(b.buyQ),
    sellQ: Float64Array.from(b.sellQ),
    buyA: Int32Array.from(b.buyA),
    sellA: Int32Array.from(b.sellA),
  };
}

/** Level in CSR-Form zu den Bars; jede Bar braucht ≥ 1 Level und jedes Level eine Bar. */
export function levelColumns(bars: BarRows, lv: LevelRows): LevelColumns {
  const nb = bars.time.length;
  const nl = lv.row.length;
  const off = new Int32Array(nb + 1);
  let j = 0;
  for (let i = 0; i < nb; i++) {
    off[i] = j;
    const t = bars.time[i]!;
    if (j < nl && lv.time[j]! < t) throw new Error(`Level bei t=${lv.time[j]} ohne Bar`);
    while (j < nl && lv.time[j] === t) j++;
    if (off[i] === j) throw new Error(`Bar t=${t} ohne Level`);
  }
  if (j !== nl) throw new Error(`Level bei t=${lv.time[j]} ohne Bar`);
  off[nb] = nl;
  return {
    levelOffset: off,
    row: Int32Array.from(lv.row),
    buy: Float64Array.from(lv.buy),
    sell: Float64Array.from(lv.sell),
    buyA: Int32Array.from(lv.buyA),
    sellA: Int32Array.from(lv.sellA),
  };
}

/** x.trades nur, wenn die kline_1m-Zeilen des Zeitraums billig sind (Schätzung wie bar_1m). */
function tradesCheap(s: SymbolState, from: number, to: number): boolean {
  return estimateRows('bar_1m', from, to, rowsOnFor(s)) <= TRADES_MAX_ROWS;
}

/** Stats-Spalten (stats.ts) aus den Teilbars derselben Bar-Tabelle, im selben Snapshot. */
async function readStats(
  tx: ReadTx,
  symId: number,
  table: BarTable,
  tfSec: number,
  from: number,
  to: number,
  bars: BarRows,
  trades: boolean,
  o: { immutable: boolean; where: Record<string, unknown> },
): Promise<Record<string, Int32Array | Float64Array>> {
  const sub = await querySubBars(tx, symId, table, from, to);
  const tr = trades ? await queryTrades(tx, symId, tfSec, from, to) : null;
  return statsColumns(bars, sub, tfSec, tr, o.immutable, o.where);
}

/** Sicht ohne Kopie. */
const asBuffer = (u8: Uint8Array) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

function baseMeta(s: SymbolState, tf: string, tfSec: number) {
  return {
    sym: s.name,
    tf,
    tfSec,
    priceDecimals: s.priceDecimals,
    qtyDecimals: s.qtyDecimals,
    tickRefUnits: s.tickRefUnits,
  };
}

export function registerTileRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/v1/symbols', async (req, reply) => {
    new Params(req.query).done();
    assertFresh(deps);
    const body = Buffer.from(symbolsBody(deps.catalog.symbols(), apiLimits(deps.cfg)));
    const r = await makeResponse(
      body,
      'application/json',
      etagOfBody(body),
      false,
      acceptsGzip(req),
    );
    return send(req, reply, r);
  });

  app.get('/api/v1/bars', async (req, reply) => {
    const p = new Params(req.query);
    const symName = p.str('sym', SYMBOL_RE);
    const tf = p.tf();
    const from = p.int('from', 0, MAX_TIME_MS);
    const to = p.int('to', 0, MAX_TIME_MS);
    const withStats = p.int('stats', 0, 1, 0) === 1;
    p.done();
    const s = requireSymbol(deps, symName);
    const tfSec = TIMEFRAMES[tf];
    checkRange(from, to, tfSec * 1000, 'bars');
    if ((to - from) / (tfSec * 1000) > MAX_BARS_PER_REQUEST)
      throw badRequest(`höchstens ${MAX_BARS_PER_REQUEST} Bars je Anfrage`);
    const [d0, d1] = coveredDays(from, to);
    const parts = ['bars', s.name, tf, from, to, withStats ? 'stats' : ''];
    const pre = versionOf(parts, d0, d1, (d) => s.days.get(d));
    const table = barTableFor(tfSec / 60);
    req.ctx.src = table;
    const rowsOn = rowsOnFor(s);
    const est = estimateRows(table, from, to, rowsOn);
    req.ctx.rowsEstimate = est;
    if (est > deps.cfg.maxSourceRows)
      throw unprocessable(`Bereich zu groß (≈ ${est} Quellzeilen > ${deps.cfg.maxSourceRows})`);
    const key = `bars|${s.name}|${tf}|${from}|${to}|${withStats ? 1 : 0}`;
    const trades = withStats && tradesCheap(s, from, to);
    return serveVersioned(deps, req, reply, key, pre, async (ctx) => {
      const lock = [
        { table, from, to },
        ...(trades ? [{ table: 'kline_1m' as const, from, to }] : []),
      ];
      const { days, bars, extra, committedTo } = await guardedRead(
        deps,
        ctx,
        async (tx) => {
          const days = await readDays(tx, s.symId, d0, d1);
          // Live-Naht: im selben Snapshot wie die Zeilen (Minuten < committedTo sind enthalten)
          const committedTo = clampCommittedTo(await readCommittedTo(tx, s.symId), from, to);
          const bars = await queryBars(tx, s.symId, table, tfSec, from, to);
          checkCoverage(
            bars.time.map((t) => t * 1000),
            from,
            to,
            minutesFor(s, (d) => days.get(d)?.version),
            allImmutable(days, d0, d1),
            { sym: s.name, d0, d1, tf },
          );
          const extra = withStats
            ? await readStats(tx, s.symId, table, tfSec, from, to, bars, trades, {
                immutable: allImmutable(days, d0, d1),
                where: { sym: s.name, d0, d1, tf },
              })
            : undefined;
          return { days, bars, extra, committedTo };
        },
        lock,
      );
      const ver = versionOf(parts, d0, d1, (d) => days.get(d));
      if (ver.dataVersion !== pre.dataVersion) void deps.catalog.refresh();
      const meta: TileMeta = {
        ...baseMeta(s, tf, tfSec),
        kind: 'bars',
        R: null,
        from,
        to,
        tile: null,
        dataVersion: ver.dataVersion,
        final: ver.final,
        committedTo,
      };
      const body = asBuffer(
        encodeTile({ meta, bars: barColumns(bars), ...(extra ? { extra } : {}) }),
      );
      return makeResponse(body, BIN, ver.dataVersion, ver.final, true);
    });
  });

  app.get('/api/v1/footprint', async (req, reply) => {
    const p = new Params(req.query);
    const symName = p.str('sym', SYMBOL_RE);
    const tf = p.tf();
    const R = p.int('R', 1, 1_000_000_000);
    const tile = p.int('tile', 0, 2 ** 31);
    const cfgV = p.int('cfg', 0, Number.MAX_SAFE_INTEGER);
    const withStats = p.int('stats', 0, 1, 0) === 1;
    p.done();
    const s = requireSymbol(deps, symName);
    if (cfgV !== s.tileConfigVersion) {
      throw new HttpError(
        409,
        `tileConfigVersion ${cfgV} veraltet (aktuell ${s.tileConfigVersion})`,
        {
          tileConfigVersion: s.tileConfigVersion,
        },
      );
    }
    const n = s.tiles[tf]?.[String(R)];
    const table = s.tileSrc.get(`${tf}|${R}`);
    if (!n || !table)
      throw unprocessable(`(tf=${tf}, R=${R}) wird nicht angeboten (siehe /symbols)`);
    const tfSec = TIMEFRAMES[tf];
    const span = n * tfSec * 1000;
    const from = tile * span;
    const to = from + span;
    if (to > MAX_TIME_MS) throw badRequest('Kachel außerhalb des Formats');
    const [d0, d1] = coveredDays(from, to);
    const parts = ['fp', s.name, tf, R, n, tile, s.tileConfigVersion, withStats ? 'stats' : ''];
    const pre = versionOf(parts, d0, d1, (d) => s.days.get(d));
    const key = `fp|${s.name}|${tf}|${R}|${tile}|${s.tileConfigVersion}|${withStats ? 1 : 0}`;
    req.ctx.src = table;
    const barTable = barTableFor(tfSec / 60);
    const rowsOn = rowsOnFor(s);
    const est = estimateRows(table, from, to, rowsOn) + estimateRows(barTable, from, to, rowsOn);
    req.ctx.rowsEstimate = est;
    const tileCap = Math.min(deps.cfg.maxTileSourceRows, deps.cfg.maxSourceRows);
    if (est > tileCap) {
      // Das Angebot hält die Grenze auf den Referenztagen ein; ein ungewöhnlich schwerer laufender oder
      // neuer Tag kann sie je Kachel überschreiten → 422 nur für diese Kachel (wie der Zell-Wächter).
      throw unprocessable(`Kachel zu groß (≈ ${est} Quellzeilen > ${tileCap}); gröberes R wählen`, {
        reason: 'tile_source_rows_exceeded',
        rowsEstimate: est,
        limit: tileCap,
        suggestR: coarserOffered(s.tiles, tf, R),
      });
    }
    const width = R * s.tickRefUnits;
    return serveVersioned(deps, req, reply, key, pre, async (ctx) => {
      const trades = withStats && tradesCheap(s, from, to);
      const lock = [
        { table: barTable, from, to },
        { table, from, to },
        ...(trades ? [{ table: 'kline_1m' as const, from, to }] : []),
      ];
      const { days, bars, levels, extra } = await guardedRead(
        deps,
        ctx,
        async (tx) => {
          const days = await readDays(tx, s.symId, d0, d1);
          const bars = await queryBars(tx, s.symId, barTable, tfSec, from, to);
          checkCoverage(
            bars.time.map((t) => t * 1000),
            from,
            to,
            minutesFor(s, (d) => days.get(d)?.version),
            allImmutable(days, d0, d1),
            { sym: s.name, d0, d1, tf, R, tile },
          );
          const levels = await queryLevels(
            tx,
            s.symId,
            table,
            tfSec,
            width,
            s.tickRefUnits,
            from,
            to,
          );
          const immutable = allImmutable(days, d0, d1);
          checkTile(bars, levels, immutable, { sym: s.name, d0, d1, tf, R, tile });
          const extra = withStats
            ? await readStats(tx, s.symId, barTable, tfSec, from, to, bars, trades, {
                immutable,
                where: { sym: s.name, d0, d1, tf, R, tile },
              })
            : undefined;
          return { days, bars, levels, extra };
        },
        lock,
      );
      const ver = versionOf(parts, d0, d1, (d) => days.get(d));
      if (ver.dataVersion !== pre.dataVersion) void deps.catalog.refresh();
      // Zell-Wächter (TILE-FORMAT.md): eine Kachel über 60 000 Zellen wird nie ausgeliefert, sondern
      // einzeln mit 422 abgelehnt (Ausreißer oberhalb des P95 bzw. nicht finaler Tag). Kein 500, keine
      // Neuberechnung der Konfiguration (die bleibt stabil), die Ablehnung wird wie eine Antwort gecacht.
      if (levels.row.length > TILE_MAX_CELLS) {
        const body = Buffer.from(
          JSON.stringify({
            error: `Kachel mit ${levels.row.length} Zellen über ${TILE_MAX_CELLS}; gröberes R wählen`,
            reason: 'tile_cells_exceeded',
            cells: levels.row.length,
            limit: TILE_MAX_CELLS,
            suggestR: coarserOffered(s.tiles, tf, R),
          }),
        );
        return {
          body,
          gzip: null,
          type: 'application/json',
          etag: ver.dataVersion,
          final: ver.final,
          status: 422,
        };
      }
      const meta: TileMeta = {
        ...baseMeta(s, tf, tfSec),
        kind: 'footprint',
        R,
        from,
        to,
        tile: { index: tile, n },
        dataVersion: ver.dataVersion,
        final: ver.final,
      };
      const body = asBuffer(
        encodeTile({
          meta,
          bars: barColumns(bars),
          levels: levelColumns(bars, levels),
          ...(extra ? { extra } : {}),
        }),
      );
      return makeResponse(body, BIN, ver.dataVersion, ver.final, true);
    });
  });
}
