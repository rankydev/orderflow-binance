// Katalog: Symbole, Tagesstände (data_day) und je Tag abgeleitete Statistiken, im Speicher gehalten
// und laufend aus der Datenbank nachgeführt (nur lesend). Daraus entstehen die /symbols-Antwort, die
// Kachellängen je (tf, R) (TILE-FORMAT.md „Kachellänge"), tileConfigVersion und die
// Zeilenstatistik für die Schätzung der Quellzeilen (KONZEPT §5.1).
//
// Persistenz ohne Schreibzugriff: Alles hier ist eine Funktion der gespeicherten Daten. Je UTC-Tag
// werden (a) die größte Zeilenzahl eines Bars je (tf, R), (b) die Zeilenzahl je Quelltabelle (Bars
// exakt, Footprint als obere Schranke aus den Bars) und (c) die gespeicherten Minuten berechnet – nur
// aus den Bar-Tabellen, nie aus den Footprint-Tabellen (Startzeit, bench/catalog-start.ts) – und
// mit data_day.version als Schlüssel gehalten; ändert sich eine Version (Import,
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
  fpTableGrid,
  ladder,
  TIMEFRAMES,
  tileBarsForMax,
  type FpTableName,
  type Timeframe,
} from '@orderflow/core';
import { int, readTx, type ReadTx, type Sql } from './db.ts';
import { chunkLockList, QUALITY_FP_SQL, readDays, tsLit } from './queries.ts';
import { BAR_TABLES, barTableFor, FP_TABLE_NAMES, type BarTable, type RowsOn } from './plan.ts';
import { DAY_MS, SYMBOL_RE } from './params.ts';
import { minuteCount } from './minutes.ts';

/** Größte angebotene Zeilengröße einer Footprint-Kachel in Ticks (wie die Fixtures). */
export const TILE_MAX_R = 10_000;
export const TILE_LADDER: readonly number[] = ladder(TILE_MAX_R);
/** Erhöhen, wenn sich der Inhalt von Kacheln bei gleichem Datenstand ändert (trennt alle Caches). */
export const TILE_BUILD_VERSION = 2;
export const TIMEFRAME_LIST = Object.keys(TIMEFRAMES) as Timeframe[];

/** Höchstzahl Tage je Statistik-Abfrage (zusammenhängender Lauf). */
export const STATS_RUN_DAYS = 366;

/** Je Footprint-Tabelle: Zeitrahmen ihres Rasters und Bin (für die Zeilenschranke aus den Bars). */
const FP_BOUND = FP_TABLE_NAMES.map((t) => {
  const g = fpTableGrid(t);
  const tf = TIMEFRAME_LIST.find((x) => TIMEFRAMES[x] === g.tfMin * 60);
  if (!tf) throw new Error(`kein Zeitrahmen für das Raster von ${t}`);
  return { table: t, tf, bin: g.bin };
});

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
  /** Fingerabdruck der Qualitätsfelder (QUALITY_FP_SQL) für /quality. */
  quality: string;
}

export interface DayStats {
  version: number;
  /** je tf: größte Zeilenzahl eines Bars je Leiterstufe (Index wie TILE_LADDER) */
  maxRows: Map<Timeframe, Int32Array>;
  /**
   * Zeilen je Tabelle an diesem Tag: Bar-Tabellen exakt gezählt; Footprint-Tabellen als OBERE SCHRANKE
   * aus den Bars ihres Zeitrasters, Σ über die Bars von (⌊high/w⌋ − ⌊low/w⌋ + 1) mit w = bin · tickRef
   * (ein Bar hat höchstens so viele Level, wie seine Spanne Zeilen hat). Gemessen auf echten Daten:
   * gebinnte Tabellen ≈ exakt, fp_1m ≈ 1,15–1,27 × tatsächlich. Kein Scan der Footprint-Tabellen –
   * die waren beim Start ≈ 2,7 GB je Symbol (siehe bench/catalog-start.ts).
   */
  rows: Map<FpTableName | BarTable, number>;
  /**
   * Gespeicherte Minuten mit Trades (bar_1m) als Bitmaske: Wort 2·h + ⌊m/30⌋, Bit m mod 30 für Minute m
   * der UTC-Stunde h (48 Wörter). Im selben gesperrten Snapshot wie die Version gelesen: Grundlage der
   * Leerprüfung (consistency.ts) – was Importer bzw. Recorder für genau diese Minute gespeichert haben.
   */
  minutes?: Uint32Array;
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
  /**
   * Letzte Statistik je Tag aus der Zeit, als er unveränderlich war (Referenztage der Kachelregel).
   * Bleibt während eines Neuimports (immutable kurz false, Folgetag stale) bestehen, bis die neue
   * Statistik vorliegt; so ändert ein Neuimport mit gleichen Daten `tiles` nie (Review Pass 3).
   */
  refStats: Map<number, DayStats>;
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
  /** Quellzeilengrenze je Kachel für das Angebot (cfg.maxTileSourceRows). */
  maxSourceRows: number;
  /** Zeitlimit einer Aktualisierung (ms); danach gilt sie als Verbindungsverlust. */
  refreshTimeoutMs?: number;
  log: (level: 'info' | 'warn' | 'error', msg: string, obj?: Record<string, unknown>) => void;
}

export interface DataError {
  at: number;
  message: string;
  sym?: string;
  d0?: number;
  d1?: number;
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
  /**
   * Datenfehler, die Anfragen auf unveränderlichen Tagen gefunden haben (Bars ohne Level, Summen
   * ungleich – trotz neuer Snapshots). Höchstens 100, jüngste zuletzt; in Health und /quality gemeldet.
   */
  private readonly dataErrorList: DataError[] = [];
  /** Wie lange ein Datenfehler ohne Wiederholung gemeldet bleibt (dann erholt sich Health). */
  static readonly DATA_ERROR_TTL_MS = 3_600_000;

  /** Datenfehler der letzten Stunde (ohne Wiederholung verfallen sie; kein Neustart nötig). */
  get dataErrors(): readonly DataError[] {
    const limit = Date.now() - Catalog.DATA_ERROR_TTL_MS;
    while (this.dataErrorList.length > 0 && this.dataErrorList[0]!.at < limit)
      this.dataErrorList.shift();
    return this.dataErrorList;
  }
  /** Art des letzten Fehlers: nur 'connection' (und Hänger) machen den Versionsstand unbrauchbar. */
  lastErrorKind: 'connection' | 'lock' | 'timeout' | 'other' | null = null;
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

  reportDataError(message: string, detail: Record<string, unknown>): void {
    const e = {
      at: Date.now(),
      message,
      ...(typeof detail.sym === 'string' ? { sym: detail.sym } : {}),
      ...(typeof detail.d0 === 'number' ? { d0: detail.d0 } : {}),
      ...(typeof detail.d1 === 'number' ? { d1: detail.d1 } : {}),
    };
    // jüngste zuletzt (Verfall von vorn): eine Wiederholung rückt ans Ende
    const i = this.dataErrorList.findIndex((x) => x.message === e.message && x.sym === e.sym);
    if (i >= 0) this.dataErrorList.splice(i, 1);
    this.dataErrorList.push(e);
    if (this.dataErrorList.length > 100) this.dataErrorList.shift();
    this.opt.log('error', 'DATENFEHLER auf unveränderlichen Tagen (Anfrage mit 503 beantwortet)', {
      ...detail,
      err: message,
    });
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

  /** Eine Aktualisierung wurde angestoßen, während eine lief (die vielleicht zu früh begann). */
  private again = false;

  /**
   * Aktualisierung jetzt anstoßen (Ereignis des Recorders: eine Minute ist festgeschrieben). Läuft
   * schon eine, folgt ihr genau eine weitere – die laufende hat ihren Snapshot evtl. vor dem Ereignis.
   */
  poke(): void {
    if (this.stopped) return;
    if (this.running) this.again = true;
    else void this.refresh();
  }

  /** Aktualisiert jetzt (eine laufende Aktualisierung wird abgewartet, nicht verdoppelt). */
  refresh(): Promise<void> {
    if (this.running) return this.running;
    // eigenes Zeitlimit: eine hängende Verbindung (schwarzes Loch) setzt sonst nie lastError
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(new Error('Katalog-Aktualisierung hängt (Zeitlimit)'), {
              kind: 'connection',
            }),
          ),
        this.opt.refreshTimeoutMs ?? 30_000,
      );
      timer.unref();
    });
    this.running = Promise.race([this.doRefresh(), limit])
      .then(() => {
        this.lastRefresh = Date.now();
        if (this.failures > 0)
          this.opt.log('info', 'Katalog-Aktualisierung wieder erfolgreich', {
            failures: this.failures,
          });
        this.failures = 0;
        this.lastError = null;
        this.lastErrorKind = null;
      })
      .catch((e: unknown) => {
        if (this.stopped) return;
        this.failures++;
        this.lastError = e instanceof Error ? e.message : String(e);
        const k = (e as { kind?: unknown }).kind;
        this.lastErrorKind = k === 'connection' || k === 'lock' || k === 'timeout' ? k : 'other';
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
        clearTimeout(timer);
        this.running = null;
        if (this.again && !this.stopped) {
          this.again = false;
          void this.refresh();
        }
      });
    return this.running;
  }

  private async doRefresh(): Promise<void> {
    const { value: next } = await readTx(
      this.sql,
      { signal: this.ac.signal, lockRetries: this.opt.lockRetries },
      (tx) => this.load(tx),
    );
    await this.updateStats(next);
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
              state_before_import IS NOT NULL, ${QUALITY_FP_SQL}
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
        refStats: old ? new Map(old.refStats) : new Map(),
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
      s.days.set(day, {
        day,
        state,
        version: int(r[3]),
        immutable: r[4] === true,
        hasData,
        quality: String(r[6]),
      });
    }
    return out;
  }

  /**
   * Statistik der geänderten Tage, je Lauf in einer EIGENEN Lesetransaktion: zuerst die Chunks sperren
   * (LOCK TABLE vor dem Snapshot, queries.ts chunkLockList), dann die Tagesversionen und die Statistik aus demselben Snapshot. In der
   * Transaktion, die data_day schon gelesen hat, könnte ein danach dekomprimierter Chunk leer
   * erscheinen (Review Pass 4) und eine falsche Statistik unter einer gültigen Version landen.
   */
  private async updateStats(out: Map<string, SymbolState>): Promise<void> {
    for (const s of out.values()) {
      for (const d of s.stats.keys()) if (!s.days.get(d)?.hasData) s.stats.delete(d);
      const todo = [...s.days.values()]
        .filter((i) => i.hasData && s.stats.get(i.day)?.version !== i.version)
        .map((i) => i.day);
      // Ein Lauf liest nur die Bar-Tabellen (≈ 45 KB je Tag und Symbol in bar_1m); bis zu einem Jahr je
      // Abfrage – die Zahl der Abfragen hängt so praktisch nur von der Zahl der Symbole ab.
      for (const [a, b] of runs(todo, STATS_RUN_DAYS)) {
        const ranges = BAR_TABLES.map((table) => ({
          table,
          from: a * DAY_MS,
          to: (b + 1) * DAY_MS,
        }));
        await readTx(
          this.sql,
          {
            signal: this.ac.signal,
            lockRetries: this.opt.lockRetries,
            prelock: () => chunkLockList(this.sql, ranges),
          },
          async (tx) => {
            const snap = await readDays(tx, s.symId, a, b);
            await this.computeStats(tx, s, a, b, snap);
          },
        );
      }
      for (const d of s.refStats.keys()) if (!s.days.get(d)?.hasData) s.refStats.delete(d);
      for (const [d, st] of s.stats) {
        const info = s.days.get(d);
        if (info?.immutable && st.version === info.version) s.refStats.set(d, st);
      }
      finalize(s, this.opt.maxSourceRows);
    }
  }

  /** Statistik der Tage [d0, d1] (inklusive) eines Symbols in einer Abfrage je Art. */
  private async computeStats(
    tx: ReadTx,
    s: SymbolState,
    d0: number,
    d1: number,
    snap: Map<number, { version: number }>,
  ): Promise<void> {
    const A = tsLit(d0 * DAY_MS);
    const B = tsLit((d1 + 1) * DAY_MS);
    const widths = TILE_LADDER.map((R) => R * s.tickRefUnits);
    if (!widths.every((w) => Number.isSafeInteger(w) && w > 0))
      throw new Error('Zeilenbreite ungültig');
    const fresh = new Map<number, DayStats>();
    for (let d = d0; d <= d1; d++) {
      const info = s.days.get(d);
      if (!info?.hasData) continue;
      // Version aus dem Snapshot der Statistik (kann neuer sein als die des Katalogs; dann rechnet
      // die nächste Aktualisierung den Tag nicht erneut, weil Statistik und Version zusammenpassen)
      const v = snap.get(d)?.version ?? info.version;
      fresh.set(d, { version: v, maxRows: new Map(), rows: new Map() });
    }
    // (1) je tf und Tag: größte Zeilenzahl eines Bars je Leiterstufe, dazu die Zeilenschranke der
    // Footprint-Tabellen mit diesem Raster (NULL, wo das Raster nicht passt) – nur aus den Bar-Tabellen
    const parts: string[] = [];
    const tickRef = s.tickRefUnits;
    for (const tf of TIMEFRAME_LIST) {
      const tfSec = TIMEFRAMES[tf];
      const table = barTableFor(tfSec / 60);
      const direct = tfSec === { bar_1m: 60, bar_1h: 3600, bar_1d: 86400 }[table];
      // Schranke je Bar: Level ≤ Zeilen seiner Spanne; bei zusammengefassten Bars zusätzlich ≤ Σ der
      // Schranken seiner Quell-Bars (Kurssprünge zwischen Minuten machen die Spanne sonst zu grob)
      const fps = FP_BOUND.filter((f) => f.tf === tf);
      const src = direct
        ? `SELECT ts AS t, high_px AS h, low_px AS l FROM ${table}
            WHERE sym_id = $1 AND ts >= ${A} AND ts < ${B}`
        : `SELECT time_bucket('${tfSec} seconds'::interval, ts) AS t, max(high_px) AS h, min(low_px) AS l
                  ${fps.map((f, i) => `, sum(high_px / ${f.bin * tickRef} - low_px / ${f.bin * tickRef} + 1) AS s${i}`).join('')}
             FROM ${table} WHERE sym_id = $1 AND ts >= ${A} AND ts < ${B} GROUP BY 1`;
      // eine Spalte je Leiterstufe (ein Durchlauf, kein Kreuzprodukt); Breiten sind geprüfte Ganzzahlen
      const cols = widths.map((w) => `max(b.h / ${w} - b.l / ${w} + 1)::int`);
      const bounds = FP_BOUND.map((f) => {
        const i = fps.indexOf(f);
        if (i < 0) return 'NULL::int8';
        const w = f.bin * tickRef;
        return direct
          ? `sum(b.h / ${w} - b.l / ${w} + 1)::int8`
          : `sum(least(b.h / ${w} - b.l / ${w} + 1, b.s${i}))::int8`;
      });
      parts.push(
        `SELECT '${tf}'::text, (extract(epoch from time_bucket('1 day'::interval, b.t))::int8 / 86400)::int, ${[...cols, ...bounds].join(', ')}
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
      FP_BOUND.forEach((f, i) => {
        const v = r[2 + widths.length + i];
        if (v !== null && v !== undefined) st.rows.set(f.table, int(v));
      });
    }
    // (2) Bar-Zeilen je Tag exakt und die gespeicherten Minuten als Maske (je Stunde zwei 30-Bit-Wörter)
    const cr = await tx.rows(
      `SELECT 'm'::text, (extract(epoch from q.b)::int8 / 3600)::int8, q.lo, q.hi FROM (
         SELECT time_bucket('1 hour'::interval, ts) AS b,
                coalesce(bit_or(1 << extract(minute from ts)::int) FILTER (WHERE extract(minute from ts) < 30), 0) AS lo,
                coalesce(bit_or(1 << (extract(minute from ts)::int - 30)) FILTER (WHERE extract(minute from ts) >= 30), 0) AS hi
           FROM bar_1m WHERE sym_id = $1 AND ts >= ${A} AND ts < ${B} GROUP BY 1) q
       UNION ALL
       SELECT t, (extract(epoch from q.b)::int8 / 86400)::int8, q.c, 0 FROM (
         SELECT 'bar_1h'::text AS t, time_bucket('1 day'::interval, ts) AS b, count(*)::int AS c
           FROM bar_1h WHERE sym_id = $1 AND ts >= ${A} AND ts < ${B} GROUP BY 2
         UNION ALL
         SELECT 'bar_1d'::text, time_bucket('1 day'::interval, ts), count(*)::int
           FROM bar_1d WHERE sym_id = $1 AND ts >= ${A} AND ts < ${B} GROUP BY 2) q`,
      [s.symId],
    );
    for (const r of cr) {
      const k = String(r[0]);
      const x = int(r[1]);
      if (k === 'm') {
        const st = fresh.get(Math.floor(x / 24));
        if (!st) continue;
        st.minutes ??= new Uint32Array(48);
        st.minutes[2 * (x % 24)] = int(r[2]);
        st.minutes[2 * (x % 24) + 1] = int(r[3]);
      } else fresh.get(x)?.rows.set(k as BarTable, int(r[2]));
    }
    for (const st of fresh.values()) {
      st.minutes ??= new Uint32Array(48);
      const n = minuteCount(st.minutes);
      if (n > 0) st.rows.set('bar_1m', n);
    }
    for (const [d, st] of fresh) s.stats.set(d, st);
  }
}

/**
 * Für die Leerprüfung: gespeicherte Minuten eines Tages (Maske) – nur, wenn die Statistik zur
 * Tagesversion des Lese-Snapshots gehört (sonst keine Aussage, also keine Prüfung).
 */
export function minutesFor(
  s: SymbolState,
  snapVersion: (day: number) => number | undefined,
): (day: number) => Uint32Array | undefined {
  return (day) => {
    const st = s.stats.get(day);
    const v = snapVersion(day);
    return st?.minutes && v !== undefined && st.version === v ? st.minutes : undefined;
  };
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
type RefInput = Pick<SymbolState, 'stats' | 'days'> & Partial<Pick<SymbolState, 'refStats'>>;

/**
 * Referenztage der Kachelregel: die zuletzt unveränderlichen Statistiken (refStats). Ohne sie (nur in
 * Unit-Tests) die heute unveränderlichen Tage; gibt es keinen, alle Tage mit Statistik.
 */
export function referenceStats(s: RefInput): DayStats[] {
  if (s.refStats && s.refStats.size > 0) return [...s.refStats.values()];
  const all = [...s.stats.entries()];
  const ref = all.filter(([d]) => s.days.get(d)?.immutable === true);
  return (ref.length > 0 ? ref : all).map(([, st]) => st);
}

function rowsPerDay(s: RefInput): { avg: Record<string, number>; max: Record<string, number> } {
  const sum: Record<string, number> = {};
  const max: Record<string, number> = {};
  let n = 0;
  // Nur Referenztage: ein schwerer laufender Tag ändert das Angebot nicht im Tagesverlauf; die Prüfung
  // je Anfrage (routes/tiles.ts) deckt ihn ab.
  for (const st of referenceStats(s)) {
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

/** Quantil der Tagesmaxima, aus dem n und das Angebot entstehen (P95; TILE-FORMAT.md). */
export const TILE_DAY_QUANTILE = 0.95;

/**
 * Referenzwert der Zeilen je Bar für (tf, Leiterindex i): das P95 der Tagesmaxima, genauer der
 * (⌊N/20⌋ + 1)-größte Wert unter N Referenztagen (bei N < 20 also das Maximum). Referenztage sind die
 * unveränderlichen Tage; gibt es keine, alle Tage mit Statistik. Nicht finale Tage (laufender Tag,
 * provisorische Live-Minuten ab P2) bleiben außen vor, damit sich `tiles` nicht im Tagesverlauf
 * ändert; ihre Kacheln schützt der Zell-Wächter beim Ausliefern (422 je Kachel).
 */
export function referenceRows(s: RefInput, tf: Timeframe, i: number): number {
  const v = referenceStats(s)
    .map((st) => st.maxRows.get(tf)?.[i] ?? 0)
    .sort((a, b) => b - a);
  if (v.length === 0) return 0;
  return v[Math.floor((1 - TILE_DAY_QUANTILE) * v.length + 1e-9)]!;
}

/**
 * Kachellänge je (tf, R) nach TILE-FORMAT.md: m = ceil(1,5 · P95 der Tagesmaxima der Zeilen je Bar),
 * n = clamp(2^floor(log2(30 000 / m)), 32, 1024), so weit halbiert, dass eine Kachel die
 * Quellzeilengrenze sicher einhält; angeboten nur bei 32 · m ≤ 60 000 und wenn auch n = 32 sie einhält (größte Tageszeilenzahl der Quelle + Bar-Tabelle,
 * über alle Tage, × Kachelspanne ≤ maxSourceRows) – sonst bekäme der Client für eine angebotene
 * Kombination ein 422. Kacheln, die trotzdem über 60 000 Zellen kommen (Ausreißer-Tage oberhalb des
 * P95, nicht finale Tage), lehnt der Wächter in routes/tiles.ts einzeln mit 422 ab.
 */
export function computeTiles(
  s: Pick<SymbolState, 'tickRefUnits' | 'tickUnits'> & RefInput,
  maxSourceRows: number,
): { tiles: Record<string, Record<string, number>>; src: Map<string, FpTableName> } {
  const { avg, max } = rowsPerDay(s);
  const tiles: Record<string, Record<string, number>> = {};
  const src = new Map<string, FpTableName>();
  for (const tf of TIMEFRAME_LIST) {
    const tfSec = TIMEFRAMES[tf];
    const m: Record<string, number> = {};
    TILE_LADDER.forEach((R, i) => {
      if (R * s.tickRefUnits < s.tickUnits) return;
      const rows = referenceRows(s, tf, i);
      if (rows === 0) return;
      let n = tileBarsForMax(rows);
      if (n === null) return;
      const table = chooseFpSource(tfSec / 60, R, avg as Record<FpTableName, number>);
      const bar = barTableFor(tfSec / 60);
      let barMax = 0;
      for (const st of referenceStats(s)) barMax = Math.max(barMax, st.rows.get(bar) ?? 0);
      // Quellzeilengrenze je Kachel: n halbieren, bis eine Kachel sie sicher einhält; reicht selbst
      // n = 32 nicht, wird (tf, R) nicht angeboten
      const est = (bars: number) => ((max[table]! + barMax) * bars * tfSec) / 86_400;
      while (n > 32 && est(n) > maxSourceRows) n /= 2;
      if (est(n) > maxSourceRows) return;
      m[String(R)] = n;
      src.set(`${tf}|${R}`, table);
    });
    if (Object.keys(m).length > 0) tiles[tf] = m;
  }
  return { tiles, src };
}

/** Nächstgröbere angebotene Zeilengröße für tf (Vorschlag bei 422 einer Kachel); null = keine. */
export function coarserOffered(
  tiles: Record<string, Record<string, number>>,
  tf: string,
  R: number,
): number | null {
  const rs = Object.keys(tiles[tf] ?? {})
    .map(Number)
    .filter((r) => r > R)
    .sort((a, b) => a - b);
  return rs[0] ?? null;
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
