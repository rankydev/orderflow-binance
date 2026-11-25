// Katalog: Symbole, Tagesstände (data_day) und je Tag abgeleitete Statistiken, im Speicher gehalten
// und laufend aus der Datenbank nachgeführt (nur lesend). Daraus entstehen die /symbols-Antwort, die
// Kachellängen je (tf, R) (TILE-FORMAT.md „Kachellänge"), tileConfigVersion und die
// Zeilenstatistik für die Schätzung der Quellzeilen (KONZEPT §5.1).
//
// Persistenz ohne Schreibzugriff: Alles hier ist eine Funktion der gespeicherten Daten. Je UTC-Tag
// werden (a) die größte Zeilenzahl eines Bars je (tf, R) und (b) die Zeilenzahl je Quelltabelle
// berechnet und mit data_day.version als Schlüssel gehalten; ändert sich eine Version (Import,
// Randauflösung, Kaskade), wird nur dieser Tag neu berechnet. maxRows je (tf, R) ist das Maximum
// über die Tage (Bars der Zeitrahmen ≤ 1d überqueren nie eine UTC-Tagesgrenze, also exakt), und
// tileConfigVersion ist ein Hash über die angebotenen (tf, R) → n. Nach einem Neustart ergibt sich
// auf demselben Datenstand dieselbe Version; zwei API-Instanzen (Mac, VPS) auf identischen Daten
// liefern dieselbe Version. Die Version ist deshalb eine undurchsichtige Ganzzahl, nur auf
// Gleichheit zu prüfen (TILE-FORMAT.md).
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chooseFpSource,
  ladder,
  TIMEFRAMES,
  tileBarsForMax,
  type FpTableName,
  type Timeframe,
} from '@orderflow/core';
import { int, readTx, type ReadTx, type Sql } from './db.ts';
import { tsLit } from './queries.ts';
import { BAR_TABLES, barTableFor, FP_TABLE_NAMES, type BarTable, type RowsOn } from './plan.ts';
import { DAY_MS, SYMBOL_RE } from './params.ts';

/** Größte angebotene Zeilengröße einer Footprint-Kachel in Ticks (wie die Fixtures). */
export const TILE_MAX_R = 10_000;
export const TILE_LADDER: readonly number[] = ladder(TILE_MAX_R);
/** Erhöhen, wenn sich der Inhalt von Kacheln bei gleichem Datenstand ändert (trennt alle Caches). */
export const TILE_BUILD_VERSION = 1;
export const TIMEFRAME_LIST = Object.keys(TIMEFRAMES) as Timeframe[];

/** Nominale Zeilen/Tag (KONZEPT §3.6, BTC), nur falls noch keine Statistik vorliegt. */
const NOMINAL_ROWS: Record<FpTableName, number> = {
  fp_1m: 650_000,
  fp_1m_b10: 70_000,
  fp_5m_b10: 29_000,
  fp_15m_b100: 2_000,
  fp_1h_b10: 10_000,
  fp_1h_b100: 1_000,
  fp_1d_b100: 200,
  fp_1d_b1000: 20,
};

export interface DayInfo {
  day: number;
  state: string;
  version: number;
  immutable: boolean;
  /** Tag hat (oder hatte vor einem laufenden Ersatz) gespeicherte Daten. */
  hasData: boolean;
}

interface DayStats {
  version: number;
  /** je tf: größte Zeilenzahl eines Bars je Leiterstufe (Index wie TILE_LADDER) */
  maxRows: Map<Timeframe, Int32Array>;
  /** Zeilen je Tabelle an diesem Tag */
  rows: Map<FpTableName | BarTable, number>;
}

export interface SymbolState {
  symId: number;
  name: string;
  priceDecimals: number;
  qtyDecimals: number;
  tickRefUnits: number;
  tickUnits: number;
  days: Map<number, DayInfo>;
  stats: Map<number, DayStats>;
  dataFrom: number;
  dataTo: number;
  tiles: Record<string, Record<string, number>>;
  /** Quelltabelle je angebotenem (tf, R) – dieselbe Wahl beim Anbieten und beim Ausliefern. */
  tileSrc: Map<string, FpTableName>;
  tileConfigVersion: number;
}

export interface CatalogOptions {
  pollMs: number;
  lockRetries: number;
  maxSourceRows: number;
  log: (level: 'info' | 'warn' | 'error', msg: string, obj?: Record<string, unknown>) => void;
}

/** Ereignis-Naht für die Live-Phase (P2, Invalidierung per WS): 'dayChanged' {sym, day, version}. */
export interface DayChanged {
  sym: string;
  day: number;
  version: number | null;
}

export class Catalog extends EventEmitter {
  private readonly sql: Sql;
  private readonly opt: CatalogOptions;
  private syms = new Map<string, SymbolState>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly ac = new AbortController();
  /** Zeitpunkt (ms) der letzten erfolgreichen Aktualisierung; 0 = noch nie. */
  lastRefresh = 0;
  lastError: string | null = null;
  /** Fehlschläge in Folge (Backoff, gedrosselte Warnung). */
  failures = 0;
  private lastWarnAt = -Infinity;

  constructor(sql: Sql, opt: CatalogOptions) {
    super();
    this.sql = sql;
    this.opt = opt;
  }

  get ready(): boolean {
    return this.lastRefresh > 0;
  }

  symbols(): SymbolState[] {
    return [...this.syms.values()].sort((a, b) => a.symId - b.symId);
  }

  symbol(name: string): SymbolState | undefined {
    return this.syms.get(name);
  }

  /** Startet die laufende Aktualisierung (erste sofort). */
  start(): Promise<void> {
    const first = this.refresh();
    const loop = () => {
      if (this.stopped) return;
      // Backoff bei Fehlern (Datenbank weg): pollMs · 2^n, höchstens 30 s
      const delay =
        this.failures === 0
          ? this.opt.pollMs
          : Math.min(30_000, this.opt.pollMs * 2 ** Math.min(this.failures, 10));
      this.timer = setTimeout(() => {
        this.refresh().finally(loop);
      }, delay);
      this.timer.unref();
    };
    void first.finally(loop);
    return first;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ac.abort();
    await this.running?.catch(() => {});
  }

  /** Aktualisiert jetzt (eine laufende Aktualisierung wird abgewartet, nicht verdoppelt). */
  refresh(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.doRefresh()
      .then(() => {
        this.lastRefresh = Date.now();
        if (this.failures > 0)
          this.opt.log('info', 'Katalog-Aktualisierung wieder erfolgreich', {
            failures: this.failures,
          });
        this.failures = 0;
        this.lastError = null;
      })
      .catch((e: unknown) => {
        if (this.stopped) return;
        this.failures++;
        this.lastError = e instanceof Error ? e.message : String(e);
        // gedrosselt: erste Meldung sofort, danach höchstens eine je 60 s (keine Log-Flut)
        const now = Date.now();
        if (now - this.lastWarnAt >= 60_000) {
          this.lastWarnAt = now;
          this.opt.log('warn', 'Katalog-Aktualisierung fehlgeschlagen', {
            err: this.lastError,
            failures: this.failures,
          });
        }
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async doRefresh(): Promise<void> {
    const { value: next } = await readTx(
      this.sql,
      { signal: this.ac.signal, lockRetries: this.opt.lockRetries },
      (tx) => this.load(tx),
    );
    const events: DayChanged[] = [];
    for (const s of next.values()) {
      const old = this.syms.get(s.name);
      for (const [d, info] of s.days) {
        const o = old?.days.get(d);
        if (!o || o.version !== info.version || o.immutable !== info.immutable)
          events.push({ sym: s.name, day: d, version: info.version });
      }
      if (old)
        for (const d of old.days.keys())
          if (!s.days.has(d)) events.push({ sym: s.name, day: d, version: null });
    }
    this.syms = next;
    // Beim ersten Laden keine Ereignisflut
    if (this.lastRefresh > 0) for (const ev of events) this.emit('dayChanged', ev);
  }

  private async load(tx: ReadTx): Promise<Map<string, SymbolState>> {
    const symRows = await tx.rows(
      `SELECT s.sym_id, s.name, s.price_decimals, s.qty_decimals, s.tick_ref_units,
              (SELECT h.min_step_units FROM symbol_tick_history h
                WHERE h.sym_id = s.sym_id ORDER BY h.day DESC LIMIT 1)
         FROM symbol s WHERE s.active ORDER BY s.sym_id`,
    );
    const dayRows = await tx.rows(
      `SELECT sym_id, (day - DATE '1970-01-01')::int, state, version, immutable,
              state_before_import IS NOT NULL
         FROM data_day ORDER BY sym_id, day`,
    );
    const out = new Map<string, SymbolState>();
    const byId = new Map<number, SymbolState>();
    for (const r of symRows) {
      const name = String(r[1]);
      if (!SYMBOL_RE.test(name)) continue;
      const tickRef = int(r[4]);
      const old = this.syms.get(name);
      const s: SymbolState = {
        symId: int(r[0]),
        name,
        priceDecimals: int(r[2]),
        qtyDecimals: int(r[3]),
        tickRefUnits: tickRef,
        tickUnits: r[5] === null ? tickRef : int(r[5]),
        days: new Map(),
        stats: old ? new Map(old.stats) : new Map(),
        dataFrom: 0,
        dataTo: 0,
        tiles: {},
        tileSrc: new Map(),
        tileConfigVersion: 0,
      };
      out.set(name, s);
      byId.set(s.symId, s);
    }
    for (const r of dayRows) {
      const s = byId.get(int(r[0]));
      if (!s) continue;
      const state = String(r[2]);
      const day = int(r[1]);
      // Ein neu angelegter Tag im Zustand importing hat noch keine Daten; ein Ersatz schon.
      const hasData = state !== 'importing' || r[5] === true;
      s.days.set(day, { day, state, version: int(r[3]), immutable: r[4] === true, hasData });
    }
    for (const s of out.values()) {
      for (const d of s.stats.keys()) if (!s.days.get(d)?.hasData) s.stats.delete(d);
      const todo = [...s.days.values()]
        .filter((i) => i.hasData && s.stats.get(i.day)?.version !== i.version)
        .map((i) => i.day);
      for (const [a, b] of runs(todo, 31)) await this.computeStats(tx, s, a, b);
      finalize(s, this.opt.maxSourceRows);
    }
    return out;
  }

  /** Statistik der Tage [d0, d1] (inklusive) eines Symbols in einer Abfrage je Art. */
  private async computeStats(tx: ReadTx, s: SymbolState, d0: number, d1: number): Promise<void> {
    const A = tsLit(d0 * DAY_MS);
    const B = tsLit((d1 + 1) * DAY_MS);
    const widths = TILE_LADDER.map((R) => R * s.tickRefUnits);
    if (!widths.every((w) => Number.isSafeInteger(w) && w > 0))
      throw new Error('Zeilenbreite ungültig');
    const fresh = new Map<number, DayStats>();
    for (let d = d0; d <= d1; d++) {
      const info = s.days.get(d);
      if (!info?.hasData) continue;
      fresh.set(d, { version: info.version, maxRows: new Map(), rows: new Map() });
    }
    const parts: string[] = [];
    for (const tf of TIMEFRAME_LIST) {
      const tfSec = TIMEFRAMES[tf];
      const table = barTableFor(tfSec / 60);
      const direct = tfSec === { bar_1m: 60, bar_1h: 3600, bar_1d: 86400 }[table];
      const src = direct
        ? `SELECT ts AS t, high_px AS h, low_px AS l FROM ${table}
            WHERE sym_id = $1 AND ts >= ${A} AND ts < ${B}`
        : `SELECT time_bucket('${tfSec} seconds'::interval, ts) AS t, max(high_px) AS h, min(low_px) AS l
             FROM ${table} WHERE sym_id = $1 AND ts >= ${A} AND ts < ${B} GROUP BY 1`;
      // eine Spalte je Leiterstufe (ein Durchlauf, kein Kreuzprodukt); Breiten sind geprüfte Ganzzahlen
      const cols = widths.map((w) => `max(b.h / ${w} - b.l / ${w} + 1)::int`).join(', ');
      parts.push(
        `SELECT '${tf}'::text, (extract(epoch from time_bucket('1 day'::interval, b.t))::int8 / 86400)::int, ${cols}
           FROM (${src}) b GROUP BY time_bucket('1 day'::interval, b.t)`,
      );
    }
    const mr = await tx.rows(parts.join('\nUNION ALL\n'), [s.symId]);
    for (const r of mr) {
      const st = fresh.get(int(r[1]));
      if (!st) continue;
      st.maxRows.set(
        String(r[0]) as Timeframe,
        Int32Array.from(widths, (_, i) => int(r[2 + i])),
      );
    }
    const cnt: string[] = [];
    for (const t of [...FP_TABLE_NAMES, ...BAR_TABLES]) {
      cnt.push(
        // GROUP BY time_bucket direkt (vektorisiert); der Tagesindex entsteht außerhalb
        `SELECT '${t}'::text, (extract(epoch from q.b)::int8 / 86400)::int, q.c FROM (
           SELECT time_bucket('1 day'::interval, ts) AS b, count(*) AS c
             FROM ${t} WHERE sym_id = $1 AND ts >= ${A} AND ts < ${B} GROUP BY 1) q`,
      );
    }
    for (const r of await tx.rows(cnt.join('\nUNION ALL\n'), [s.symId])) {
      fresh.get(int(r[1]))?.rows.set(String(r[0]) as FpTableName | BarTable, int(r[2]));
    }
    for (const [d, st] of fresh) s.stats.set(d, st);
  }
}

/** Zusammenhängende Läufe (je ≤ maxLen Tage) aus einer sortierten Tagesliste. */
export function runs(days: number[], maxLen: number): [number, number][] {
  const out: [number, number][] = [];
  for (const d of days) {
    const last = out[out.length - 1];
    if (last && d === last[1] + 1 && d - last[0] < maxLen) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

/** Zeilen je (Tabelle, Tag) aus der Statistik eines Symbols. */
export function rowsOnFor(s: SymbolState): RowsOn {
  return (table, day) => s.stats.get(day)?.rows.get(table);
}

/** Durchschnitt und Maximum der Zeilen/Tag je Tabelle (Tage mit Daten). */
function rowsPerDay(s: SymbolState): { avg: Record<string, number>; max: Record<string, number> } {
  const sum: Record<string, number> = {};
  const max: Record<string, number> = {};
  let n = 0;
  for (const st of s.stats.values()) {
    n++;
    for (const [t, r] of st.rows) {
      sum[t] = (sum[t] ?? 0) + r;
      max[t] = Math.max(max[t] ?? 0, r);
    }
  }
  const avg: Record<string, number> = {};
  for (const t of FP_TABLE_NAMES) avg[t] = n > 0 && sum[t] ? sum[t] / n : NOMINAL_ROWS[t];
  for (const t of FP_TABLE_NAMES) max[t] ??= n > 0 ? 0 : NOMINAL_ROWS[t];
  return { avg, max };
}

/**
 * Kachellänge je (tf, R) nach TILE-FORMAT.md (Maximum über die gesamte Historie, Zuschlag 1,5,
 * angeboten nur bei 32 · m ≤ 60 000) und zusätzlich nur, wenn eine Kachel die Quellzeilengrenze
 * sicher einhält (größte Tageszeilenzahl der Quelle × Kachelspanne ≤ maxSourceRows) – sonst
 * bekäme der Client für eine angebotene Kombination ein 422.
 */
export function computeTiles(
  s: Pick<SymbolState, 'tickRefUnits' | 'tickUnits' | 'stats'>,
  maxSourceRows: number,
): { tiles: Record<string, Record<string, number>>; src: Map<string, FpTableName> } {
  const { avg, max } = rowsPerDay(s as SymbolState);
  const tiles: Record<string, Record<string, number>> = {};
  const src = new Map<string, FpTableName>();
  for (const tf of TIMEFRAME_LIST) {
    const tfSec = TIMEFRAMES[tf];
    const m: Record<string, number> = {};
    TILE_LADDER.forEach((R, i) => {
      if (R * s.tickRefUnits < s.tickUnits) return;
      let maxRows = 0;
      for (const st of s.stats.values()) maxRows = Math.max(maxRows, st.maxRows.get(tf)?.[i] ?? 0);
      if (maxRows === 0) return;
      const n = tileBarsForMax(maxRows);
      if (n === null) return;
      const table = chooseFpSource(tfSec / 60, R, avg as Record<FpTableName, number>);
      const spanDays = (n * tfSec) / 86_400;
      const bar = barTableFor(tfSec / 60);
      let barMax = 0;
      for (const st of s.stats.values()) barMax = Math.max(barMax, st.rows.get(bar) ?? 0);
      if ((max[table]! + barMax) * spanDays > maxSourceRows) return;
      m[String(R)] = n;
      src.set(`${tf}|${R}`, table);
    });
    if (Object.keys(m).length > 0) tiles[tf] = m;
  }
  return { tiles, src };
}

/** tileConfigVersion: Hash über die Kachelkonfiguration (undurchsichtige Ganzzahl in 1…2^47). */
export function configVersion(tiles: Record<string, Record<string, number>>): number {
  const canon = TIMEFRAME_LIST.filter((tf) => tiles[tf]).map((tf) => [
    tf,
    Object.entries(tiles[tf]!).sort((a, b) => Number(a[0]) - Number(b[0])),
  ]);
  const h = createHash('sha256')
    .update(JSON.stringify({ v: TILE_BUILD_VERSION, tiles: canon }))
    .digest('hex');
  return 1 + (parseInt(h.slice(0, 12), 16) % 2 ** 47);
}

function finalize(s: SymbolState, maxSourceRows: number): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (const i of s.days.values()) {
    if (!i.hasData) continue;
    lo = Math.min(lo, i.day);
    hi = Math.max(hi, i.day);
  }
  s.dataFrom = lo === Infinity ? 0 : lo * DAY_MS;
  s.dataTo = hi === -Infinity ? 0 : (hi + 1) * DAY_MS;
  const t = computeTiles(s, maxSourceRows);
  s.tiles = t.tiles;
  s.tileSrc = t.src;
  s.tileConfigVersion = configVersion(t.tiles);
}

/** Tagesstände [d0, d1] eines Symbols für die Datenversion (fehlende Tage = null). */
export function dayStates(s: SymbolState, d0: number, d1: number): (DayInfo | null)[] {
  const out: (DayInfo | null)[] = [];
  for (let d = d0; d <= d1; d++) out.push(s.days.get(d) ?? null);
  return out;
}
