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
import { rowsOnFor, type SymbolState } from '../catalog.ts';
import { guardedRead, requireSymbol, type Deps } from '../context.ts';
import { serveVersioned } from '../respond.ts';
import { badRequest, HttpError, unprocessable } from '../errors.ts';
import { etagOfBody, makeResponse, send, acceptsGzip } from '../http.ts';
import { checkRange, MAX_TIME_MS, Params, SYMBOL_RE } from '../params.ts';
import { barTableFor, coveredDays, estimateRows } from '../plan.ts';
import { queryBars, queryLevels, readDays, type BarRows, type LevelRows } from '../queries.ts';
import { versionOf } from '../versions.ts';

export const SYMBOLS_SCHEMA = 2;
/** Größte Bar-Anzahl je /bars-Anfrage (der Client fragt 1 000 an). */
export const MAX_BARS_PER_REQUEST = 5_000;
const BIN = 'application/octet-stream';

export function symbolsBody(syms: SymbolState[]): string {
  return JSON.stringify({
    schema: SYMBOLS_SCHEMA,
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
    if (!deps.catalog.ready) throw new HttpError(503, 'API startet noch (Katalog lädt)', {}, 1);
    const body = Buffer.from(symbolsBody(deps.catalog.symbols()));
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
    p.done();
    const s = requireSymbol(deps, symName);
    const tfSec = TIMEFRAMES[tf];
    checkRange(from, to, tfSec * 1000, 'bars');
    if ((to - from) / (tfSec * 1000) > MAX_BARS_PER_REQUEST)
      throw badRequest(`höchstens ${MAX_BARS_PER_REQUEST} Bars je Anfrage`);
    const [d0, d1] = coveredDays(from, to);
    const parts = ['bars', s.name, tf, from, to];
    const pre = versionOf(parts, d0, d1, (d) => s.days.get(d));
    const table = barTableFor(tfSec / 60);
    req.ctx.src = table;
    const est = estimateRows(table, from, to, rowsOnFor(s));
    req.ctx.rowsEstimate = est;
    if (est > deps.cfg.maxSourceRows)
      throw unprocessable(`Bereich zu groß (≈ ${est} Quellzeilen > ${deps.cfg.maxSourceRows})`);
    const key = `bars|${s.name}|${tf}|${from}|${to}`;
    return serveVersioned(deps, req, reply, key, pre, async (ctx) => {
      const { days, bars } = await guardedRead(deps, ctx, async (tx) => {
        const days = await readDays(tx, s.symId, d0, d1);
        const bars = await queryBars(tx, s.symId, table, tfSec, from, to);
        return { days, bars };
      });
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
      };
      const body = asBuffer(encodeTile({ meta, bars: barColumns(bars) }));
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
    const parts = ['fp', s.name, tf, R, n, tile, s.tileConfigVersion];
    const pre = versionOf(parts, d0, d1, (d) => s.days.get(d));
    const key = `fp|${s.name}|${tf}|${R}|${tile}|${s.tileConfigVersion}`;
    req.ctx.src = table;
    const barTable = barTableFor(tfSec / 60);
    const rowsOn = rowsOnFor(s);
    const est = estimateRows(table, from, to, rowsOn) + estimateRows(barTable, from, to, rowsOn);
    req.ctx.rowsEstimate = est;
    if (est > deps.cfg.maxSourceRows) {
      // Kommt bei angebotenen Kombinationen nicht vor (computeTiles prüft dieselbe Grenze).
      throw unprocessable(`Kachel zu groß (≈ ${est} Quellzeilen > ${deps.cfg.maxSourceRows})`);
    }
    const width = R * s.tickRefUnits;
    return serveVersioned(deps, req, reply, key, pre, async (ctx) => {
      const { days, bars, levels } = await guardedRead(deps, ctx, async (tx) => {
        const days = await readDays(tx, s.symId, d0, d1);
        const bars = await queryBars(tx, s.symId, barTable, tfSec, from, to);
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
        return { days, bars, levels };
      });
      const ver = versionOf(parts, d0, d1, (d) => days.get(d));
      if (ver.dataVersion !== pre.dataVersion) void deps.catalog.refresh();
      // Kacheln folgen der Grenze aus TILE-FORMAT.md (60 000), nicht OF_API_MAX_CELLS (nur Profile)
      if (levels.row.length > TILE_MAX_CELLS) {
        // Zwischen Import und Neuberechnung möglich (TILE-FORMAT.md): neu berechnen, dann 409.
        await deps.catalog.refresh();
        const now = deps.catalog.symbol(s.name);
        if (now && now.tileConfigVersion !== cfgV) {
          throw new HttpError(409, 'Kachelkonfiguration wurde neu berechnet', {
            tileConfigVersion: now.tileConfigVersion,
          });
        }
        throw new HttpError(500, `Kachel mit ${levels.row.length} Zellen über der harten Grenze`);
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
        encodeTile({ meta, bars: barColumns(bars), levels: levelColumns(bars, levels) }),
      );
      return makeResponse(body, BIN, ver.dataVersion, ver.final, true);
    });
  });
}
