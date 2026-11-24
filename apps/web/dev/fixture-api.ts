// Nur Entwicklung: Vite-Middleware, die die Fixture-Kacheln unter derselben URL-Form wie die künftige
// API ausliefert (KONZEPT §5.5): GET /api/v1/symbols, /api/v1/bars?sym&tf&from&to,
// /api/v1/footprint?sym&tf&R&tile. Wechsel auf die echte API = andere Basis-URL (VITE_API_BASE).
//
// Zusätzlich ein synthetischer Langzeit-Datensatz (Symbol BTCUSDT-SYN90, 90 Tage) nur für
// Performance-Tests: die 3 echten Tage werden 30× zeitlich verschoben wiederholt, Preise je Zyklus um
// ein Vielfaches von 1 000 $ versetzt (Vielfaches jeder Zeilenbreite der Leiter → R-konsistent).
// Kacheln dafür entstehen bei Bedarf aus den echten Kacheln (keine Riesendateien auf der Platte).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  decodeTile,
  encodeTile,
  tfSeconds,
  tileBarsForMax,
  TILE_MAX_CELLS,
  type BarColumns,
  type DecodedTile,
  type LevelColumns,
  type TileData,
} from '@orderflow/core/browser';

export interface SymbolMeta {
  name: string;
  priceDecimals: number;
  qtyDecimals: number;
  tickRefUnits: number;
  tickUnits: number;
  dataFrom: number;
  dataTo: number;
  firstOpen: number;
  lastClose: number;
  tileConfigVersion: number;
  tiles: Record<string, Record<string, number>>;
  synthetic?: { baseSymbol: string; cycles: number; driftUnits: number };
  stress?: boolean;
}

interface FixtureMeta {
  symbols: SymbolMeta[];
}

export const SYNTH_SUFFIX = '-SYN90';
/** Seitwärts-Stresssymbol für T11: jeder 1m-Bar überspannt ≈ 300 Ticks um denselben Preis, jede Zeile belegt. */
export const STRESS_SYMBOL = 'STRESS-FLAT';
const STRESS_DAYS = 7;
const STRESS_BASE = 6_000_000;
const SYNTH_CYCLES = 30;
/** Preisversatz je Zyklus auf ein Vielfaches von 100 000 price_unit (BTC: 1 000 $) gerundet. */
const SYNTH_PRICE_STEP = 100_000;

interface Series {
  bars: BarColumns;
  levels: LevelColumns | null;
}

export interface FixtureApiOptions {
  dir: string;
  /** Künstliche Antwortverzögerung (ms) zum Testen von Abbruch/Padding. */
  latencyMs?: number;
}

export class FixtureStore {
  readonly meta: FixtureMeta;
  private readonly series = new Map<string, Series>();
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    const m = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as FixtureMeta;
    const synth: SymbolMeta[] = m.symbols.map((s) => {
      const span = s.dataTo - s.dataFrom;
      const drift = Math.round((s.lastClose - s.firstOpen) / SYNTH_PRICE_STEP) * SYNTH_PRICE_STEP;
      return {
        ...s,
        name: s.name + SYNTH_SUFFIX,
        dataFrom: s.dataTo - span * SYNTH_CYCLES,
        synthetic: { baseSymbol: s.name, cycles: SYNTH_CYCLES, driftUnits: drift },
      };
    });
    const b = m.symbols[0]!;
    const tiles: Record<string, number> = {};
    // Stressbars überspannen höchstens 320 Ticks → max. Zeilen je Bar = ceil(320 / R) + 1
    for (const R of [1, 2, 5, 10, 20, 50, 100]) {
      const n = tileBarsForMax(Math.ceil(320 / R) + 1, 1);
      if (n !== null) tiles[String(R)] = n;
    }
    const stress: SymbolMeta = {
      ...b,
      name: STRESS_SYMBOL,
      dataFrom: b.dataTo - STRESS_DAYS * 86_400_000,
      tiles: { '1m': tiles },
      stress: true,
    };
    this.meta = { symbols: [...m.symbols, ...synth, stress] };
  }

  symbol(name: string): SymbolMeta | undefined {
    return this.meta.symbols.find((s) => s.name === name);
  }

  private file(...p: string[]): Uint8Array | null {
    const f = join(this.dir, ...p);
    return existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
  }

  /** Vollständige echte Reihe je (Symbol, tf[, R]) aus den Fixture-Dateien (für Ausschnitte/Synthese). */
  private baseSeries(sym: SymbolMeta, tf: string, R: number | null): Series {
    const key = `${sym.name}|${tf}|${R}`;
    const hit = this.series.get(key);
    if (hit) return hit;
    let s: Series;
    if (R === null) {
      const b = this.file(sym.name, 'bars', `${tf}.bin`);
      if (!b) throw new HttpError(404, `keine Bars für ${sym.name} ${tf}`);
      s = { bars: decodeTile(b).bars, levels: null };
    } else {
      const n = sym.tiles[tf]?.[String(R)];
      if (!n) throw new HttpError(422, `R=${R} für ${tf} nicht verfügbar`);
      const span = n * tfSeconds(tf) * 1000;
      const parts: DecodedTile[] = [];
      for (let k = Math.floor(sym.dataFrom / span); k * span < sym.dataTo; k++) {
        const b = this.file(sym.name, 'footprint', tf, String(R), `${k}.bin`);
        if (b) parts.push(decodeTile(b));
      }
      s = concatTiles(parts);
    }
    this.series.set(key, s);
    return s;
  }

  bars(symName: string, tf: string, from: number, to: number): Uint8Array {
    const sym = this.mustSymbol(symName);
    const tfSec = tfSeconds(tf);
    if (from % (tfSec * 1000) !== 0 || to % (tfSec * 1000) !== 0 || to <= from) {
      throw new HttpError(400, 'from/to nicht am Zeitrahmen ausgerichtet');
    }
    if (sym.stress) {
      return encodeTile({
        meta: this.metaFor(sym, tf, from, to),
        bars: stressSeries(sym, from, to, null).bars,
      });
    }
    const base = this.baseSeries(this.baseOf(sym), tf, null);
    const out = this.slice(sym, base, from, to, null);
    return encodeTile({
      meta: this.metaFor(sym, tf, from, to),
      bars: out.bars,
    });
  }

  footprint(symName: string, tf: string, R: number, k: number): Uint8Array {
    const sym = this.mustSymbol(symName);
    const tfSec = tfSeconds(tf);
    const n = sym.tiles[tf]?.[String(R)];
    if (!n) throw new HttpError(422, `R=${R} für ${tf} nicht verfügbar (Zellgrenze)`);
    const span = n * tfSec * 1000;
    const from = k * span;
    const to = from + span;
    const meta = {
      ...this.metaFor(sym, tf, from, to),
      kind: 'footprint' as const,
      R,
      tile: { index: k, n },
    };
    if (sym.stress) {
      const s = stressSeries(sym, from, to, R * sym.tickRefUnits);
      return guarded({ meta, bars: s.bars, levels: s.levels! });
    }
    if (!sym.synthetic) {
      const f = this.file(sym.name, 'footprint', tf, String(R), `${k}.bin`);
      if (f) return f;
      // Außerhalb der Daten: leere Kachel. Innerhalb: Datei fehlt → Fixtures und meta.json passen nicht
      // zusammen (laut melden statt still leer liefern).
      if (to <= sym.dataFrom || from >= sym.dataTo) {
        return encodeTile({ meta, bars: emptyBars(), levels: emptyLevels() });
      }
      console.warn(
        `[fixture-api] Kachel ${tf}/${R}/${k} fehlt – meta.json und Fixtures passen nicht zusammen`,
      );
      throw new HttpError(500, `Fixture-Kachel ${tf}/${R}/${k} fehlt (Fixtures neu erzeugen?)`);
    }
    const base = this.baseSeries(this.baseOf(sym), tf, R);
    const out = this.slice(sym, base, from, to, R * sym.tickRefUnits);
    const tile: TileData = { meta, bars: out.bars, levels: out.levels! };
    return guarded(tile);
  }

  private mustSymbol(name: string): SymbolMeta {
    const s = this.symbol(name);
    if (!s) throw new HttpError(404, `unbekanntes Symbol ${name}`);
    return s;
  }

  private baseOf(sym: SymbolMeta): SymbolMeta {
    return sym.synthetic ? this.mustSymbol(sym.synthetic.baseSymbol) : sym;
  }

  private metaFor(sym: SymbolMeta, tf: string, from: number, to: number): TileData['meta'] {
    return {
      kind: 'bars',
      sym: sym.name,
      tf,
      tfSec: tfSeconds(tf),
      R: null,
      priceDecimals: sym.priceDecimals,
      qtyDecimals: sym.qtyDecimals,
      tickRefUnits: sym.tickRefUnits,
      from,
      to,
      tile: null,
      dataVersion: `fixture:${sym.name}:v1`,
      final: true,
    };
  }

  /**
   * Ausschnitt [from, to) einer Reihe; bei synthetischen Symbolen über die Zyklen abgebildet
   * (Zeit verschoben, Preise/Zeilen versetzt).
   */
  private slice(
    sym: SymbolMeta,
    base: Series,
    from: number,
    to: number,
    width: number | null,
  ): Series {
    const segs: { s: number; e: number; dtSec: number; dpx: number }[] = [];
    if (!sym.synthetic) {
      segs.push({ s: from / 1000, e: to / 1000, dtSec: 0, dpx: 0 });
    } else {
      const realFrom = this.baseOf(sym).dataFrom;
      const P = this.baseOf(sym).dataTo - realFrom;
      const c0 = Math.max(0, Math.floor((from - sym.dataFrom) / P));
      const c1 = Math.min(sym.synthetic.cycles - 1, Math.floor((to - 1 - sym.dataFrom) / P));
      for (let c = c0; c <= c1; c++) {
        const cs = sym.dataFrom + c * P;
        const shift = cs - realFrom; // synthetisch = echt + shift
        const s = Math.max(from, cs) - shift;
        const e = Math.min(to, cs + P) - shift;
        const dpx = (c - (sym.synthetic.cycles - 1)) * sym.synthetic.driftUnits;
        segs.push({ s: s / 1000, e: e / 1000, dtSec: shift / 1000, dpx });
      }
    }
    const t = base.bars.time;
    const ranges = segs.map((g) => ({ ...g, i0: lowerBound(t, g.s), i1: lowerBound(t, g.e) }));
    const nb = ranges.reduce((a, r) => a + r.i1 - r.i0, 0);
    const lo = base.levels;
    const nl = lo
      ? ranges.reduce((a, r) => a + lo.levelOffset[r.i1]! - lo.levelOffset[r.i0]!, 0)
      : 0;
    const bars = allocBars(nb);
    const levels = lo ? allocLevels(nb, nl) : null;
    let k = 0;
    let j = 0;
    for (const r of ranges) {
      const drow = width ? r.dpx / width : 0;
      for (let i = r.i0; i < r.i1; i++, k++) {
        bars.time[k] = t[i]! + r.dtSec;
        bars.open[k] = base.bars.open[i]! + r.dpx;
        bars.high[k] = base.bars.high[i]! + r.dpx;
        bars.low[k] = base.bars.low[i]! + r.dpx;
        bars.close[k] = base.bars.close[i]! + r.dpx;
        bars.buyQ[k] = base.bars.buyQ[i]!;
        bars.sellQ[k] = base.bars.sellQ[i]!;
        bars.buyA[k] = base.bars.buyA[i]!;
        bars.sellA[k] = base.bars.sellA[i]!;
        if (lo && levels) {
          levels.levelOffset[k] = j;
          for (let q = lo.levelOffset[i]!; q < lo.levelOffset[i + 1]!; q++, j++) {
            levels.row[j] = lo.row[q]! + drow;
            levels.buy[j] = lo.buy[q]!;
            levels.sell[j] = lo.sell[q]!;
            levels.buyA[j] = lo.buyA[q]!;
            levels.sellA[j] = lo.sellA[q]!;
          }
        }
      }
    }
    if (levels) levels.levelOffset[nb] = j;
    return { bars, levels };
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Deterministische Seitwärtsdaten (nur 1m): Bar t überspannt ≈ 300 Ticks um STRESS_BASE, jede Zeile belegt. */
function stressSeries(sym: SymbolMeta, from: number, to: number, width: number | null): Series {
  const tick = sym.tickRefUnits;
  const t0 = Math.max(from, sym.dataFrom) / 1000;
  const t1 = Math.min(to, sym.dataTo) / 1000;
  const nb = Math.max(0, Math.ceil((t1 - t0) / 60));
  const hash = (a: number, b: number) => {
    let h = (a * 374_761_393 + b * 668_265_263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) % 1000;
  };
  const w = width ?? tick;
  const rowsOf: number[][] = [];
  let nl = 0;
  const lo: number[] = [];
  const hi: number[] = [];
  for (let i = 0; i < nb; i++) {
    const t = t0 + i * 60;
    const l = STRESS_BASE + (hash(t, 1) % 40) * tick - 150 * tick;
    const h = l + 300 * tick + (hash(t, 2) % 20) * tick;
    lo.push(l);
    hi.push(h);
    const rs: number[] = [];
    for (let r = Math.floor(l / w); r <= Math.floor(h / w); r++) rs.push(r);
    rowsOf.push(rs);
    nl += rs.length;
  }
  const bars = allocBars(nb);
  const levels = width ? allocLevels(nb, nl) : null;
  let j = 0;
  for (let i = 0; i < nb; i++) {
    const t = t0 + i * 60;
    bars.time[i] = t;
    bars.low[i] = lo[i]!;
    bars.high[i] = hi[i]!;
    bars.open[i] = lo[i]! + 100 * tick;
    bars.close[i] = hi[i]! - 100 * tick;
    if (levels) levels.levelOffset[i] = j;
    // Werte je Tick (konsistent für jede Zeilengröße: Zeile = Summe ihrer Ticks), Querprüfung H-1
    let sb = 0;
    let ss = 0;
    let rowKey = Number.NaN;
    for (let tk = Math.floor(lo[i]! / tick); tk <= Math.floor(hi[i]! / tick); tk++) {
      const b = 1 + hash(t, tk * 3);
      const s = 1 + hash(t, tk * 3 + 1);
      sb += b;
      ss += s;
      if (!levels) continue;
      const r = Math.floor((tk * tick) / w);
      if (r !== rowKey) {
        rowKey = r;
        levels.row[j] = r;
        levels.buy[j] = 0;
        levels.sell[j] = 0;
        levels.buyA[j] = 0;
        levels.sellA[j] = 0;
        j++;
      }
      levels.buy[j - 1]! += b;
      levels.sell[j - 1]! += s;
      levels.buyA[j - 1]! += 1;
      levels.sellA[j - 1]! += 1;
    }
    const ticks = Math.floor(hi[i]! / tick) - Math.floor(lo[i]! / tick) + 1;
    bars.buyQ[i] = sb;
    bars.sellQ[i] = ss;
    bars.buyA[i] = ticks;
    bars.sellA[i] = ticks;
  }
  if (levels) levels.levelOffset[nb] = j;
  return { bars, levels };
}

/** Harte Zellgrenze wie die API (§1.4); mit der Kachellänge aus tileBarsForMax nie erreicht. */
function guarded(tile: TileData): Uint8Array {
  const cells = tile.levels?.row.length ?? 0;
  if (cells > TILE_MAX_CELLS)
    throw new HttpError(422, `Kachel mit ${cells} Zellen über ${TILE_MAX_CELLS}`);
  return encodeTile(tile);
}

function lowerBound(a: Int32Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m]! < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function allocBars(n: number): BarColumns {
  return {
    time: new Int32Array(n),
    open: new Int32Array(n),
    high: new Int32Array(n),
    low: new Int32Array(n),
    close: new Int32Array(n),
    buyQ: new Float64Array(n),
    sellQ: new Float64Array(n),
    buyA: new Int32Array(n),
    sellA: new Int32Array(n),
  };
}
function allocLevels(nb: number, nl: number): LevelColumns {
  return {
    levelOffset: new Int32Array(nb + 1),
    row: new Int32Array(nl),
    buy: new Float64Array(nl),
    sell: new Float64Array(nl),
    buyA: new Int32Array(nl),
    sellA: new Int32Array(nl),
  };
}
const emptyBars = () => allocBars(0);
const emptyLevels = () => allocLevels(0, 0);

function concatTiles(parts: DecodedTile[]): Series {
  const nb = parts.reduce((a, p) => a + p.header.nBars, 0);
  const nl = parts.reduce((a, p) => a + p.header.nLevels, 0);
  const bars = allocBars(nb);
  const levels = allocLevels(nb, nl);
  let bo = 0;
  let lo = 0;
  for (const p of parts) {
    for (const k of Object.keys(bars) as (keyof BarColumns)[]) bars[k].set(p.bars[k], bo);
    const L = p.levels!;
    for (let i = 0; i < p.header.nBars; i++) levels.levelOffset[bo + i] = L.levelOffset[i]! + lo;
    levels.row.set(L.row, lo);
    levels.buy.set(L.buy, lo);
    levels.sell.set(L.sell, lo);
    levels.buyA.set(L.buyA, lo);
    levels.sellA.set(L.sellA, lo);
    bo += p.header.nBars;
    lo += p.header.nLevels;
  }
  levels.levelOffset[nb] = lo;
  return { bars, levels };
}

function intParam(u: URL, name: string): number {
  const v = u.searchParams.get(name);
  if (v === null || !/^-?\d+$/.test(v))
    throw new HttpError(400, `Parameter ${name} fehlt/ungültig`);
  return Number(v);
}
function strParam(u: URL, name: string): string {
  const v = u.searchParams.get(name);
  if (!v) throw new HttpError(400, `Parameter ${name} fehlt`);
  return v;
}

export function handleApi(
  store: FixtureStore,
  url: URL,
): { status: number; body: Uint8Array | string; type: string; etag?: string } {
  const path = url.pathname;
  if (path === '/api/v1/symbols') {
    // schema: Version der /symbols-Form (der Client prüft sie, A)
    return {
      status: 200,
      body: JSON.stringify({ schema: SYMBOLS_SCHEMA, ...store.meta }),
      type: 'application/json',
    };
  }
  if (path === '/api/v1/bars') {
    const body = store.bars(
      strParam(url, 'sym'),
      strParam(url, 'tf'),
      intParam(url, 'from'),
      intParam(url, 'to'),
    );
    return { status: 200, body, type: 'application/octet-stream' };
  }
  if (path === '/api/v1/footprint') {
    // cfg ≠ aktuelle Kachelkonfiguration → 409: der Client lädt /symbols neu statt alte n zu benutzen
    const cfg = url.searchParams.get('cfg');
    const sym = store.symbol(strParam(url, 'sym'));
    if (cfg !== null && sym && Number(cfg) !== sym.tileConfigVersion) {
      throw new HttpError(
        409,
        `tileConfigVersion ${cfg} veraltet (aktuell ${sym.tileConfigVersion})`,
      );
    }
    const body = store.footprint(
      strParam(url, 'sym'),
      strParam(url, 'tf'),
      intParam(url, 'R'),
      intParam(url, 'tile'),
    );
    return { status: 200, body, type: 'application/octet-stream' };
  }
  throw new HttpError(404, `unbekannter Endpunkt ${path}`);
}

export const SYMBOLS_SCHEMA = 2;

export function fixtureApi(opt: FixtureApiOptions): Plugin {
  let store: FixtureStore | null = null;
  let metaMtime = 0;
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/v1/')) return next();
    const send = (status: number, body: Uint8Array | string, type: string) => {
      res.statusCode = status;
      res.setHeader('Content-Type', type);
      // Fixture-Kacheln sind final und damit unveränderlich (KONZEPT §5.4); der Client hat eigenen LRU.
      if (status === 200 && type !== 'application/json') res.setHeader('Cache-Control', 'no-store');
      res.end(body);
    };
    const run = () => {
      try {
        const metaPath = join(opt.dir, 'meta.json');
        if (!existsSync(metaPath)) {
          throw new HttpError(
            503,
            `Fixtures fehlen in ${opt.dir}: npm run fixtures -w @orderflow/web`,
          );
        }
        // A: nie veralten – meta.json bei jeder Anfrage per mtime prüfen und bei Änderung neu laden
        const mtime = statSync(metaPath).mtimeMs;
        if (!store || mtime !== metaMtime) {
          const old = store;
          store = new FixtureStore(opt.dir);
          metaMtime = mtime;
          if (old) {
            console.warn(
              `\n[fixture-api] meta.json geändert – neu geladen (tileConfigVersion ${store.meta.symbols[0]?.tileConfigVersion}). Seiten neu laden.\n`,
            );
          }
        }
        const r = handleApi(store, new URL(req.url!, 'http://localhost'));
        send(r.status, r.body, r.type);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        send(
          status,
          JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
          'application/json',
        );
      }
    };
    if (opt.latencyMs) setTimeout(run, opt.latencyMs);
    else run();
  };
  return {
    name: 'orderflow-fixture-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
