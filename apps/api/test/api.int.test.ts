// Integrationstests der API gegen "<OF_DB_NAME>_test_api" (`npm run db:up && npm run test:db`), mit
// synthetischen Daten (seed.ts) und der nur lesenden Rolle of_api. Die Entwicklungsdatenbank wird nie
// berührt. Beweist:
//  - /symbols, /bars, /footprint sind für den Web-Client gültig (dessen eigene Prüfungen: checkSymbolsResponse,
//    BarStore/FootprintStore.addEncoded mit Erwartung) und decodierbar (decodeTile);
//  - Vorbedingung Kachel = /bars (gleiche Bars, gleiche buy+sell je Bar) für jede angebotene (tf, R);
//  - Footprint aus jeder Quelltabelle = Re-Binning der Basistabelle fp_1m;
//  - Profile (Range und je Tag, mit Offsets) exakt = Summe über fp_1m, neu gebinnt, über Chunk- und
//    Tagesgrenzen; Notional exakt (> 2^53, nie über Number);
//  - final/immutable, ETag, 304, Cache-Treffer, Versionswechsel eines Tages, 409 bei veralteter cfg
//    (und dieselbe cfg nach Rücknahme bzw. Neustart), 422 (nicht angeboten, Grenzen mit Vorschlag),
//    400/404, Abbruch der DB-Abfrage bei Client-Abbruch, lock_timeout mit Wiederholung, 503 bei Überlast.
import {
  checkDailyProfiles,
  checkRangeProfile,
  decodeTile,
  fpTableGrid,
  parseConfig,
  profileMarks,
  rollupBars,
  TIMEFRAMES,
  type Bar,
  type DailyProfilesResponse,
  type DbConfig,
  type FpTableName,
  type RangeProfileResponse,
} from '@orderflow/core';
import {
  alterRolePasswordSql,
  connect,
  dropAndCreateDatabase,
  migrateUp,
  type Sql,
} from '@orderflow/db';
import { randomBytes } from 'node:crypto';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSymbolsResponse } from '../../web/src/lib/api.ts';
import { BarStore } from '../../web/src/lib/bar-store.ts';
import { FootprintStore } from '../../web/src/lib/footprint-store.ts';
import { parseApiConfig, type ApiConfig } from '../src/config.ts';
import { createPool, readTx } from '../src/db.ts';
import { startApi, type RunningApi } from '../src/main.ts';
import { FP_TABLE_NAMES } from '../src/plan.ts';
import { chunkLockList, queryLevels, tsLit } from '../src/queries.ts';
import {
  BAD_DAY,
  DAY_MS,
  FIRST_DAY,
  generate,
  LAST_DAY,
  MINUTE_MS,
  HOLE_FROM_MIN,
  HOLE_TO_MIN,
  insertBars1m,
  klineTrades,
  PROVISIONAL_UNTIL_MIN,
  OUTLIER_MS,
  PROVISIONAL_DAY,
  seed,
  SYM_ID,
  TICK,
  type Seeded,
} from './seed.ts';

const base = parseConfig(process.env).db;
// Eigene Testdatenbank der API-Suite: andere Pakete (Importer, Recorder) setzen "<OF_DB_NAME>_test" in
// ihren Integrationstests neu auf – parallel laufende Suiten würden sich sonst gegenseitig stören.
const testDb = `${base.database}_test_api`;
const adminCfg: DbConfig = { ...base, database: testDb };
const HOUR = 3_600_000;
interface SymJson {
  tileConfigVersion: number;
  tiles: Record<string, Record<string, number>>;
}
let admin: Sql;
let data: Seeded;
/**
 * Eigene Testrolle statt of_api (Review): Rollen gelten clusterweit; ein Test darf das Passwort der
 * Rolle, mit der die Entwicklungs-API läuft, nie ändern. of_api_test bekommt in der Testdatenbank genau
 * die Tabellenrechte und Rolleneinstellungen von of_api (aus den Migrationen) – sonst nichts.
 */
const TEST_ROLE = 'of_api_test';
const apiPassword = randomBytes(18).toString('hex');
/** Tabellen, die of_api lesen darf (Migrationen 0009/0010); jede neue Tabelle muss hier bewusst landen. */
const API_READABLE = [
  'bar_1d',
  'bar_1h',
  'bar_1m',
  'data_day',
  'data_minute_issue',
  'fp_15m_b100',
  'fp_1d_b100',
  'fp_1d_b1000',
  'fp_1h_b10',
  'fp_1h_b100',
  'fp_1m',
  'fp_1m_b10',
  'fp_5m_b10',
  'kline_1m',
  'symbol',
  'symbol_tick_history',
];

function apiCfg(over: Partial<ApiConfig> = {}): ApiConfig {
  const c = parseApiConfig({
    ...process.env,
    OF_DB_NAME: testDb,
    OF_API_DB_USER: TEST_ROLE,
    OF_API_DB_PASSWORD: apiPassword,
  });
  // Tests prüfen Quelle und Schätzung über die Diagnose-Header; Status-Listener nur wo nötig
  return { ...c, port: 0, pollMs: 100, adminPort: 0, diagHeaders: true, ...over };
}

async function start(over: Partial<ApiConfig> = {}): Promise<RunningApi> {
  return startApi(apiCfg(over), { logger: false });
}

async function get(api: RunningApi, path: string, init: RequestInit = {}) {
  const res = await fetch(api.url + path, init);
  const buf = new Uint8Array(await res.arrayBuffer());
  return {
    res,
    buf,
    json: () => JSON.parse(new TextDecoder().decode(buf)) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------- Referenzrechnung (nur fp_1m/bar_1m)

/** Level-Summen aus fp_1m über [from, to), gebucketet auf (tfSec, w); sortiert nach (t, row). */
function refLevels(tfSec: number, w: number, from: number, to: number) {
  const fp = data.fp.fp_1m;
  const m = new Map<string, [number, number, number, number, number, number]>();
  for (let i = 0; i < fp.n; i++) {
    const ts = fp.ts[i]!;
    if (ts < from || ts >= to) continue;
    const t = (ts - (ts % (tfSec * 1000))) / 1000;
    const px = fp.px[i]!;
    const row = (px - (px % w)) / w;
    const k = `${t}|${row}`;
    const e = m.get(k) ?? [t, row, 0, 0, 0, 0];
    e[2] += fp.buyQ[i]!;
    e[3] += fp.sellQ[i]!;
    e[4] += fp.buyA[i]!;
    e[5] += fp.sellA[i]!;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function refBars(tfSec: number, from: number, to: number): Bar[] {
  const all = tfSec === 60 ? data.bars1m : rollupBars(data.bars1m, tfSec / 60);
  return all.filter((b) => b.ts >= from && b.ts < to);
}

/** Dichtes Profil aus fp_1m über [from, to) bei Breite w. */
function refProfile(from: number, to: number, w: number) {
  const fp = data.fp.fp_1m;
  const rows = new Map<number, [number, number]>();
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < fp.n; i++) {
    const ts = fp.ts[i]!;
    if (ts < from || ts >= to) continue;
    const px = fp.px[i]!;
    const r = (px - (px % w)) / w;
    const e = rows.get(r) ?? [0, 0];
    e[0] += fp.buyQ[i]!;
    e[1] += fp.sellQ[i]!;
    rows.set(r, e);
    lo = Math.min(lo, r);
    hi = Math.max(hi, r);
  }
  if (lo === Infinity) return { rowLo: null, buy: [] as number[], sell: [] as number[] };
  const buy: number[] = [];
  const sell: number[] = [];
  for (let r = lo; r <= hi; r++) {
    buy.push(rows.get(r)?.[0] ?? 0);
    sell.push(rows.get(r)?.[1] ?? 0);
  }
  return { rowLo: lo, buy, sell };
}

function refNotional(from: number, to: number): bigint {
  let n = 0n;
  for (const b of data.bars1m) if (b.ts >= from && b.ts < to) n += b.notional;
  return n;
}

/** Erwartetes `final`: alle überdeckten UTC-Tage existieren und sind unveränderlich. */
function expFinal(from: number, to: number): boolean {
  const d0 = Math.floor(from / DAY_MS);
  const d1 = Math.floor((to - 1) / DAY_MS);
  return d0 >= FIRST_DAY && d1 < PROVISIONAL_DAY;
}

const dataFrom = FIRST_DAY * DAY_MS;
const dataTo = (LAST_DAY + 1) * DAY_MS;

beforeAll(async () => {
  await dropAndCreateDatabase(adminCfg);
  admin = connect(adminCfg);
  await migrateUp(admin);
  await mirrorApiRole(admin);
  data = generate();
  await seed(admin, data);
}, 120_000);

afterAll(async () => {
  // Testrolle wieder entfernen (Rechte in der Testdatenbank zuerst)
  try {
    await admin?.unsafe(`DROP OWNED BY ${TEST_ROLE}`);
    await admin?.unsafe(`DROP ROLE IF EXISTS ${TEST_ROLE}`);
  } finally {
    await admin?.end();
  }
});

/** Legt of_api_test als Spiegel von of_api in der Testdatenbank an (Rechte + Rolleneinstellungen). */
async function mirrorApiRole(sql: Sql): Promise<void> {
  await sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${TEST_ROLE}') THEN
      CREATE ROLE ${TEST_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF; END $$`);
  // nur der SCRAM-Verifier geht an den Server (W4a); jede API-Verbindung unten beweist, dass er gilt
  await sql.unsafe(alterRolePasswordSql(TEST_ROLE, apiPassword));
  const [cfg] = await sql<{ rolconfig: string[] | null }[]>`
    SELECT rolconfig FROM pg_roles WHERE rolname = 'of_api'`;
  await sql.unsafe(`ALTER ROLE ${TEST_ROLE} RESET ALL`);
  for (const kv of cfg!.rolconfig ?? []) {
    const m = /^([a-z_]+)=([A-Za-z0-9_.]+)$/.exec(kv);
    if (!m) throw new Error(`unerwartete Rolleneinstellung ${kv}`);
    await sql.unsafe(`ALTER ROLE ${TEST_ROLE} SET ${m[1]} = '${m[2]}'`);
  }
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${TEST_ROLE}`);
  const grants = await sql<{ t: string }[]>`
    SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
       AND has_table_privilege('of_api', c.oid, 'SELECT')`;
  for (const { t } of grants) await sql.unsafe(`GRANT SELECT ON "${t}" TO ${TEST_ROLE}`);
}

describe('Rolle of_api', () => {
  it('liest (auch Columnstore-Chunks), schreibt nie', async () => {
    const sql = createPool(apiCfg());
    try {
      const [c] = await sql`SELECT count(*)::int AS n FROM fp_1m WHERE sym_id = ${SYM_ID}`;
      expect(c!.n).toBe(data.fp.fp_1m.n);
      await expect(sql`DELETE FROM data_day`).rejects.toThrow(/read-only|permission/);
      await expect(sql.begin('read write', (tx) => tx`DELETE FROM data_day`)).rejects.toThrow(
        /permission/,
      );
      // Migration 0010 (W4b/W4d): work_mem 16 MB, kein Zugriff auf Manifest/Verwaltung
      const [wm] = await sql`SHOW work_mem`;
      expect(wm!.work_mem).toBe('16MB');
      for (const t of ['raw_file', 'raw_day', 'schema_migrations', 'verify_run'])
        await expect(sql.unsafe(`SELECT 1 FROM ${t} LIMIT 1`), t).rejects.toThrow(/permission/);
      const [rc] = await admin<
        { c: string[] }[]
      >`SELECT rolconfig AS c FROM pg_roles WHERE rolname = 'of_api'`;
      expect(rc!.c).toEqual(
        expect.arrayContaining(['work_mem=16MB', 'default_transaction_read_only=on']),
      );
    } finally {
      await sql.end();
    }
  });

  it('of_api liest genau die freigegebenen Tabellen (neue Tabellen müssen bewusst auf die Liste)', async () => {
    // Migration 0009 vergibt Standardrechte: jede künftige Tabelle wäre für die API lesbar. Dieser Test
    // schlägt fehl, bis die neue Tabelle hier (API_READABLE) eingetragen oder per REVOKE entzogen ist.
    const rows = await admin<{ t: string }[]>`
      SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND has_table_privilege('of_api', c.oid, 'SELECT') ORDER BY 1`;
    expect(rows.map((r) => r.t)).toEqual([...API_READABLE].sort());
  });

  it('die echte Rolle of_api direkt geprüft (nicht über den Spiegel)', async () => {
    const [r] = await admin<
      { su: boolean; cr: boolean; db: boolean; create: boolean; cfg: string[] }[]
    >`
      SELECT rolsuper AS su, rolcreaterole AS cr, rolcreatedb AS db,
             has_schema_privilege('of_api', 'public', 'CREATE') AS create, rolconfig AS cfg
        FROM pg_roles WHERE rolname = 'of_api'`;
    expect(r).toMatchObject({ su: false, cr: false, db: false, create: false });
    expect([...r!.cfg].sort()).toEqual(
      [
        'default_transaction_read_only=on',
        'idle_in_transaction_session_timeout=60s',
        'lock_timeout=5s',
        'statement_timeout=15s',
        'work_mem=16MB',
      ].sort(),
    );
    for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
      for (const t of API_READABLE) {
        const [x] = await admin<
          { ok: boolean }[]
        >`SELECT has_table_privilege('of_api', ${t}, ${p}) AS ok`;
        expect(x!.ok, `${p} ${t}`).toBe(false);
      }
    // Recorder-Objekte (Migrationen 0013–0016): keine Konvertierung, keine Mitgliedschaft
    const [fn] = await admin<{ ok: boolean }[]>`
      SELECT has_function_privilege('of_api', 'of_recompress_chunk(regclass)', 'EXECUTE') AS ok`;
    expect(fn!.ok, 'EXECUTE of_recompress_chunk').toBe(false);
    const [mb] = await admin<{ ok: boolean }[]>`
      SELECT pg_has_role('of_api', 'of_recorder', 'MEMBER') AS ok`;
    expect(mb!.ok, 'of_api Mitglied von of_recorder').toBe(false);
  });

  it('die Testrolle ist nicht of_api (Tests ändern kein Passwort der echten Rolle)', async () => {
    const sql = createPool(apiCfg());
    try {
      const [u] = await sql`SELECT current_user AS u`;
      expect(u!.u).toBe(TEST_ROLE);
    } finally {
      await sql.end();
    }
  });
});

describe('Endpunkte gegen den Web-Client', () => {
  let api: RunningApi;
  let sym: {
    tileConfigVersion: number;
    tiles: Record<string, Record<string, number>>;
    dataFrom: number;
    dataTo: number;
  };
  beforeAll(async () => {
    api = await start();
    const { res, json } = await get(api, '/api/v1/symbols');
    expect(res.status).toBe(200);
    const body = json();
    expect(checkSymbolsResponse(body)).toEqual([]);
    sym = (body.symbols as (typeof sym & { name: string })[])[0]!;
  });
  afterAll(async () => api?.close());

  it('/symbols: Form, Datenbereich, angebotene Kombinationen, Cache-Header', async () => {
    const { res, json } = await get(api, '/api/v1/symbols');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('etag')).toMatch(/^".+"$/);
    const s = (json().symbols as Record<string, unknown>[])[0]!;
    expect(s).toMatchObject({
      name: 'BTCUSDT',
      priceDecimals: 2,
      qtyDecimals: 3,
      tickRefUnits: TICK,
      tickUnits: TICK,
      dataFrom,
      dataTo,
    });
    // jede Quelltabelle ist für mindestens eine angebotene Kombination die gewählte
    expect(Object.keys(sym.tiles)).toEqual(Object.keys(TIMEFRAMES));
    const etag = res.headers.get('etag')!;
    const again = await get(api, '/api/v1/symbols', { headers: { 'If-None-Match': etag } });
    expect(again.res.status).toBe(304);
  });

  it('/bars: ausgerichtete 1 000er-Abschnitte, Header-Zeitraum exakt, Bars = Referenz', async () => {
    for (const tf of Object.keys(TIMEFRAMES)) {
      const tfSec = TIMEFRAMES[tf as keyof typeof TIMEFRAMES];
      const span = 1000 * tfSec * 1000;
      const store = new BarStore(`BTCUSDT|${tf}`, 2);
      for (let c = Math.floor(dataFrom / span); c * span < dataTo; c++) {
        const from = c * span;
        const to = from + span;
        const { res, buf } = await get(
          api,
          `/api/v1/bars?sym=BTCUSDT&tf=${tf}&from=${from}&to=${to}`,
        );
        expect(res.status, `${tf} ${c}`).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
        store.addEncoded(c, buf.slice().buffer, { sym: 'BTCUSDT', tf, from, to }); // Client-Prüfung
        const dec = decodeTile(buf);
        expect(dec.header).toMatchObject({
          kind: 'bars',
          sym: 'BTCUSDT',
          tf,
          tfSec,
          from,
          to,
          R: null,
        });
        // final nur, wenn jeder überdeckte UTC-Tag existiert und unveränderlich ist
        expect(dec.header.final).toBe(expFinal(from, to));
        expect(res.headers.get('cache-control')).toBe(
          expFinal(from, to) ? 'public, max-age=604800' : 'no-cache',
        );
        const ref = refBars(tfSec, from, to);
        expect(dec.header.nBars).toBe(ref.length);
        ref.forEach((b, i) => {
          expect([
            dec.bars.time[i],
            dec.bars.open[i],
            dec.bars.high[i],
            dec.bars.low[i],
            dec.bars.close[i],
            dec.bars.buyQ[i],
            dec.bars.sellQ[i],
            dec.bars.buyA[i],
            dec.bars.sellA[i],
          ]).toEqual([
            b.ts / 1000,
            b.open,
            b.high,
            b.low,
            b.close,
            b.buyQ,
            b.sellQ,
            b.buyA,
            b.sellA,
          ]);
        });
      }
    }
  });

  it('/footprint: jede angebotene (tf, R), jede Kachel: Client-Prüfung, = Referenz, = /bars', async () => {
    const sources = new Set<string>();
    const rejected: { tf: string; R: number; k: number; suggestR: number | null }[] = [];
    let tiles = 0;
    for (const [tf, m] of Object.entries(sym.tiles)) {
      const tfSec = TIMEFRAMES[tf as keyof typeof TIMEFRAMES];
      for (const [Rs, n] of Object.entries(m)) {
        const R = Number(Rs);
        const w = R * TICK;
        const span = n * tfSec * 1000;
        const store = new FootprintStore(3);
        for (let k = Math.floor(dataFrom / span); k * span < dataTo; k++) {
          const url = `/api/v1/footprint?sym=BTCUSDT&tf=${tf}&R=${R}&tile=${k}&cfg=${sym.tileConfigVersion}`;
          const { res, buf, json } = await get(api, url);
          const from0 = k * span;
          const refCells = refLevels(tfSec, w, from0, from0 + span).length;
          // Zell-Wächter: eine Kachel über 60 000 Zellen nie ausliefern, sondern einzeln 422
          if (refCells > 60_000) {
            expect(res.status, url).toBe(422);
            expect(json()).toMatchObject({
              reason: 'tile_cells_exceeded',
              cells: refCells,
              limit: 60_000,
            });
            rejected.push({ tf, R, k, suggestR: json().suggestR as number | null });
            continue;
          }
          expect(res.status, url).toBe(200);
          sources.add(res.headers.get('x-source')!);
          tiles++;
          store.addEncoded(`BTCUSDT|${tf}|${R}`, buf.slice().buffer, {
            sym: 'BTCUSDT',
            tf,
            R,
            k,
            n,
          });
          const dec = decodeTile(buf);
          const from = k * span;
          const to = from + span;
          expect(dec.header).toMatchObject({
            kind: 'footprint',
            from,
            to,
            tile: { index: k, n },
            R,
          });
          expect(dec.header.nLevels).toBeLessThanOrEqual(60_000);
          // Level = Re-Binning von fp_1m
          const ref = refLevels(tfSec, w, from, to);
          expect(dec.header.nLevels).toBe(ref.length);
          let j = 0;
          for (let i = 0; i < dec.header.nBars; i++) {
            for (
              let q = dec.levels!.levelOffset[i]!;
              q < dec.levels!.levelOffset[i + 1]!;
              q++, j++
            ) {
              const e = ref[j]!;
              expect([
                dec.bars.time[i],
                dec.levels!.row[q],
                dec.levels!.buy[q],
                dec.levels!.sell[q],
              ]).toEqual([e[0], e[1], e[2], e[3]]);
              expect([dec.levels!.buyA[q], dec.levels!.sellA[q]]).toEqual([e[4], e[5]]);
            }
          }
          // Vorbedingung des Clients: gleiche Bars und gleiche buy+sell wie /bars über denselben Zeitraum
          const c0 = Math.floor(from / (1000 * tfSec * 1000));
          const c1 = Math.floor((to - 1) / (1000 * tfSec * 1000));
          const times: number[] = [];
          const vols: number[] = [];
          for (let c = c0; c <= c1; c++) {
            const b = decodeTile(
              (
                await get(
                  api,
                  `/api/v1/bars?sym=BTCUSDT&tf=${tf}&from=${c * 1000 * tfSec * 1000}&to=${(c + 1) * 1000 * tfSec * 1000}`,
                )
              ).buf,
            );
            for (let i = 0; i < b.header.nBars; i++) {
              const t = b.bars.time[i]!;
              if (t * 1000 < from || t * 1000 >= to) continue;
              times.push(t);
              vols.push(b.bars.buyQ[i]! + b.bars.sellQ[i]!);
            }
          }
          expect(Array.from(dec.bars.time)).toEqual(times);
          expect(Array.from(dec.bars.buyQ, (v, i) => v + dec.bars.sellQ[i]!)).toEqual(vols);
        }
      }
    }
    expect(tiles).toBeGreaterThan(100);
    // die Ausreißer-Minuten (seed.ts) ergeben genau eine abgelehnte 1m-Kachel bei R = 1; Vorschlag R = 2
    expect(rejected).toEqual([
      {
        tf: '1m',
        R: 1,
        k: Math.floor(OUTLIER_MS / (sym.tiles['1m']!['1']! * 60_000)),
        suggestR: 2,
      },
    ]);
    expect([...sources].sort()).toEqual([...FP_TABLE_NAMES].sort());
  }, 120_000);

  it('Footprint aus jeder Quelltabelle (alle passenden tf, R) = Re-Binning von fp_1m', async () => {
    const sql = createPool(apiCfg());
    try {
      const ac = new AbortController();
      let combos = 0;
      for (const t of FP_TABLE_NAMES as FpTableName[]) {
        const g = fpTableGrid(t);
        for (const [tf, tfSec] of Object.entries(TIMEFRAMES)) {
          if (tfSec % (g.tfMin * 60) !== 0) continue;
          for (const R of [g.bin, g.bin * 2, g.bin * 5, g.bin * 100]) {
            const w = R * TICK;
            const from = dataFrom - DAY_MS;
            const to = dataTo + DAY_MS;
            const { value } = await readTx(sql, { signal: ac.signal, lockRetries: 0 }, (tx) =>
              queryLevels(tx, SYM_ID, t, tfSec, w, TICK, from, to),
            );
            const ref = refLevels(tfSec, w, from, to);
            const got = value.time.map((x, i) => [
              x,
              value.row[i],
              value.buy[i],
              value.sell[i],
              value.buyA[i],
              value.sellA[i],
            ]);
            expect(got, `${t} ${tf} R=${R}`).toEqual(ref);
            combos++;
          }
        }
      }
      expect(combos).toBeGreaterThan(60);
    } finally {
      await sql.end();
    }
  }, 120_000);

  it('Range-Profile exakt über Chunk- und Tagesgrenzen (zufällige, nicht ausgerichtete Bereiche)', async () => {
    let seedv = 7;
    const rnd = () => (seedv = (seedv * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const Rs = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    const seen = new Set<string>();
    for (let k = 0; k < 60; k++) {
      const start =
        dataFrom -
        2 * HOUR +
        Math.floor(rnd() * ((dataTo - dataFrom + 2 * HOUR) / MINUTE_MS)) * MINUTE_MS;
      const kind = k % 3;
      const len =
        (kind === 0
          ? 1 + Math.floor(rnd() * 30)
          : kind === 1
            ? 60 + Math.floor(rnd() * 600)
            : 1440 + Math.floor(rnd() * 4000)) * MINUTE_MS;
      const R = Rs[Math.floor(rnd() * Rs.length)]!;
      await checkRange(start, start + len, R, seen);
    }
    // ausgerichtete Spezialfälle: genau ein Tag, mehrere Tage, Tag ± 1 Minute
    for (const [a, b] of [
      [dataFrom, dataFrom + DAY_MS],
      [dataFrom, dataTo],
      [dataFrom + DAY_MS - MINUTE_MS, dataFrom + 3 * DAY_MS + MINUTE_MS],
    ] as const)
      for (const R of [5, 100, 1000]) await checkRange(a, b, R, seen);
    // alle Quelltabellen kamen vor
    expect([...seen].sort()).toEqual([...FP_TABLE_NAMES].sort());

    async function checkRange(from: number, to: number, R: number, tables: Set<string>) {
      const { res, json } = await get(
        api,
        `/api/v1/profile?sym=BTCUSDT&from=${from}&to=${to}&R=${R}`,
      );
      // über 60 000 Zeilen (Ausreißer-Minuten am provisorischen Tag bei R = 1) → 422 mit Vorschlag
      if (refProfile(from, to, R * TICK).buy.length > 60_000) {
        expect(res.status).toBe(422);
        return;
      }
      expect(res.status, `${from}-${to} R=${R}`).toBe(200);
      const body = json() as unknown as RangeProfileResponse;
      expect(checkRangeProfile(body)).toEqual([]);
      for (const s of body.sources) tables.add(s.table);
      const ref = refProfile(from, to, R * TICK);
      expect(body.profile.rowLo).toBe(ref.rowLo);
      expect(body.profile.buy).toEqual(ref.buy);
      expect(body.profile.sell).toEqual(ref.sell);
      expect(BigInt(body.profile.notional)).toBe(refNotional(from, to));
      const marks = ref.rowLo === null ? null : profileMarks(ref.rowLo, ref.buy, ref.sell, 70);
      if (marks) expect(body.profile).toMatchObject(marks);
      const allImmutable = expFinal(from, to);
      expect(body.final).toBe(allImmutable);
      expect(res.headers.get('cache-control')).toBe(
        allImmutable ? 'public, max-age=604800' : 'no-cache',
      );
    }
  }, 120_000);

  it('Notional über alle Tage > 2^53 und exakt (Number würde runden)', async () => {
    const { json } = await get(
      api,
      `/api/v1/profile?sym=BTCUSDT&from=${dataFrom}&to=${dataTo}&R=1000`,
    );
    const body = json() as unknown as RangeProfileResponse;
    const n = BigInt(body.profile.notional);
    expect(n).toBe(refNotional(dataFrom, dataTo));
    expect(n > 2n ** 53n).toBe(true);
    expect(BigInt(Number(body.profile.notional)) === n).toBe(false); // Number() verlöre Stellen
  });

  it('Tagesprofile (Offset 0, +3 h, −7 h) = je Tag Summe über fp_1m', async () => {
    for (const offsetH of [0, 3, -7]) {
      for (const R of [5, 10, 100, 1000]) {
        const off = offsetH * HOUR;
        const from = dataFrom + off;
        const to = dataTo + off;
        const { res, json } = await get(
          api,
          `/api/v1/profiles/daily?sym=BTCUSDT&from=${from}&to=${to}&R=${R}&offsetH=${offsetH}`,
        );
        expect(res.status).toBe(200);
        const body = json() as unknown as DailyProfilesResponse;
        expect(checkDailyProfiles(body)).toEqual([]);
        if (offsetH !== 0)
          expect(body.sources.every((s) => !s.table.startsWith('fp_1d'))).toBe(true);
        else if (R % 100 === 0)
          expect(body.sources.map((s) => s.table)).toEqual([
            R % 1000 === 0 ? 'fp_1d_b1000' : 'fp_1d_b100',
          ]);
        const expected = [];
        for (let a = from; a < to; a += DAY_MS) {
          const ref = refProfile(a, a + DAY_MS, R * TICK);
          if (ref.rowLo === null) continue;
          expected.push({ from: a, ...ref, notional: refNotional(a, a + DAY_MS).toString() });
        }
        expect(
          body.days.map((d) => ({
            from: d.from,
            rowLo: d.rowLo,
            buy: d.buy,
            sell: d.sell,
            notional: d.notional,
          })),
        ).toEqual(expected);
        for (const d of body.days) {
          expect(d.final).toBe(expFinal(d.from, d.to));
          expect(d.day).toBe(new Date(d.from - off).toISOString().slice(0, 10));
        }
      }
    }
  }, 60_000);

  it('Qualität: Zustände, Minutenklassen, Issue-Minuten (shift nur auf Wunsch)', async () => {
    const { res, json } = await get(
      api,
      `/api/v1/quality?sym=BTCUSDT&from=${dataFrom}&to=${dataTo}`,
    );
    expect(res.status).toBe(200);
    const q = json() as { days: Record<string, unknown>[]; issues: Record<string, unknown>[] };
    expect(q.days.length).toBe(LAST_DAY - FIRST_DAY + 1);
    const bad = q.days.find((d) => d.from === BAD_DAY * DAY_MS)!;
    expect(bad).toMatchObject({
      state: 'final_bad',
      immutable: true,
      version: 2,
      minutes: { mismatch: 1, missing: 1 },
    });
    expect(q.days.find((d) => d.from === PROVISIONAL_DAY * DAY_MS)).toMatchObject({
      state: 'provisional',
      immutable: false,
    });
    expect(q.issues.map((i) => i.kind)).toEqual(['mismatch', 'missing']);
    expect(q.issues[0]).toMatchObject({ ts: BAD_DAY * DAY_MS + 2 * MINUTE_MS, dQ: 1500, dB: -700 });
    const all = await get(api, `/api/v1/quality?sym=BTCUSDT&from=${dataFrom}&to=${dataTo}&shift=1`);
    expect((all.json().issues as unknown[]).length).toBe(4);
  });

  it('Fehlercodes: 400 (Parameter), 404 (Symbol/Pfad), 422 (nicht angeboten), 409 (cfg)', async () => {
    const c = sym.tileConfigVersion;
    const cases: [string, number][] = [
      [`/api/v1/footprint?sym=BTCUSDT&tf=1m&R=7&tile=1&cfg=${c}`, 422],
      [`/api/v1/footprint?sym=BTCUSDT&tf=1m&R=50&tile=1&cfg=${c + 1}`, 409],
      [`/api/v1/footprint?sym=BTCUSDT&tf=1m&R=50&tile=1`, 400],
      [`/api/v1/footprint?sym=BTCUSDT&tf=7m&R=50&tile=1&cfg=${c}`, 400],
      [`/api/v1/footprint?sym=BTCUSDT&tf=1m&R=050&tile=1&cfg=${c}`, 400],
      [`/api/v1/footprint?sym=XRPUSDT&tf=1m&R=50&tile=1&cfg=${c}`, 404],
      [`/api/v1/footprint?sym=BTCUSDT&tf=1m&R=50&tile=1&cfg=${c}&x=1`, 400],
      [`/api/v1/bars?sym=BTCUSDT&tf=5m&from=60000&to=600000`, 400],
      [`/api/v1/bars?sym=BTCUSDT&tf=1m&from=0&to=600000000`, 400],
      [`/api/v1/profile?sym=BTCUSDT&from=${dataFrom}&to=${dataTo}&R=3`, 400],
      [`/api/v1/profile?sym=BTCUSDT&from=${dataFrom + 1}&to=${dataTo}&R=10`, 400],
      [`/api/v1/profiles/daily?sym=BTCUSDT&from=${dataFrom}&to=${dataTo}&R=10&offsetH=2`, 400],
      [`/api/v1/nope`, 404],
    ];
    for (const [url, status] of cases) {
      const { res, json } = await get(api, url);
      expect(res.status, url).toBe(status);
      expect(typeof json().error).toBe('string');
    }
    const r409 = await get(api, `/api/v1/footprint?sym=BTCUSDT&tf=1m&R=50&tile=1&cfg=${c + 1}`);
    expect(r409.json().tileConfigVersion).toBe(c);
  });

  it('If-None-Match ändert keine Fehlerentscheidung: 409/422/400 statt 304', async () => {
    const c = sym.tileConfigVersion;
    const any = { 'If-None-Match': '*' };
    const cases: [string, number][] = [
      [`/api/v1/footprint?sym=BTCUSDT&tf=1m&R=50&tile=1&cfg=${c + 1}`, 409],
      [`/api/v1/footprint?sym=BTCUSDT&tf=1m&R=7&tile=1&cfg=${c}`, 422],
      [`/api/v1/footprint?sym=BTCUSDT&tf=1m&R=50&tile=1&cfg=${c}&x=1`, 400],
      [`/api/v1/bars?sym=BTCUSDT&tf=5m&from=60000&to=600000`, 400],
      [`/api/v1/profile?sym=BTCUSDT&from=${dataFrom}&to=${dataTo}&R=3`, 400],
    ];
    for (const [url, status] of cases)
      expect((await get(api, url, { headers: any })).res.status, url).toBe(status);
  });

  it('304 auch für die gzip-Variante; HEAD liefert Kopfzeilen ohne Körper bzw. 304', async () => {
    const url = `/api/v1/bars?sym=BTCUSDT&tf=1m&from=${(FIRST_DAY + 1) * DAY_MS}&to=${(FIRST_DAY + 1) * DAY_MS + 60_000_000}`;
    const a = await get(api, url, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(a.res.status).toBe(200);
    const etag = a.res.headers.get('etag')!;
    expect(a.res.headers.get('vary')).toMatch(/Accept-Encoding/);
    const g = await get(api, url, {
      headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': etag },
    });
    expect(g.res.status).toBe(304);
    expect(g.res.headers.get('etag')).toBe(etag);
    expect(g.buf.length).toBe(0);
    const h = await fetch(api.url + url, { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect(h.headers.get('etag')).toBe(etag);
    expect(h.headers.get('content-type')).toBe('application/octet-stream');
    expect((await h.arrayBuffer()).byteLength).toBe(0);
    const h304 = await fetch(api.url + url, { method: 'HEAD', headers: { 'If-None-Match': etag } });
    expect(h304.status).toBe(304);
  });

  it('/quality: gecacht und gebündelt, 304 vor der Datenabfrage, Issue-Seiten', async () => {
    const url = `/api/v1/quality?sym=BTCUSDT&from=${dataFrom}&to=${dataTo}&shift=1`;
    const a = await get(api, url);
    expect(a.res.status).toBe(200);
    expect(a.res.headers.get('cache-control')).toBe('no-cache');
    const b = await get(api, url);
    expect(b.res.headers.get('x-cache')).toBe('hit');
    const etag = a.res.headers.get('etag')!;
    const c = await get(api, url, { headers: { 'If-None-Match': etag } });
    expect(c.res.status).toBe(304);
    expect(c.res.headers.get('x-cache')).toBe('revalidated');
    // deep_check ändert sich ohne neue Datenversion → neue ETag (Fingerabdruck der Qualitätsfelder)
    const d = new Date(BAD_DAY * DAY_MS).toISOString().slice(0, 10);
    await admin`UPDATE data_day SET deep_check = 'passed' WHERE sym_id = ${SYM_ID} AND day = ${d}::date`;
    await sleep(400);
    const e = await get(api, url, { headers: { 'If-None-Match': etag } });
    expect(e.res.status).toBe(200);
    expect(e.res.headers.get('etag')).not.toBe(etag);
    expect((e.json().days as Record<string, unknown>[]).find((x) => x.day === d)!.deepCheck).toBe(
      'passed',
    );
    await admin`UPDATE data_day SET deep_check = NULL WHERE sym_id = ${SYM_ID} AND day = ${d}::date`;
    expect(e.json()).toMatchObject({ issuesNext: null, issuesTruncated: false });
    // Seiten: ab der 2. Issue-Minute
    const second = BAD_DAY * DAY_MS + 3 * MINUTE_MS;
    const p2 = await get(api, `${url}&issuesFrom=${second}`);
    expect((p2.json().issues as { ts: number }[]).every((x) => x.ts >= second)).toBe(true);
    expect((p2.json().issues as unknown[]).length).toBe(3);
    // höchstens 400 Tage je Anfrage
    expect(
      (await get(api, `/api/v1/quality?sym=BTCUSDT&from=0&to=${401 * DAY_MS}`)).res.status,
    ).toBe(400);
  });

  it('CORS für erlaubte Ursprünge (Standard: Loopback), sonst kein Header', async () => {
    const ok = await get(api, '/api/v1/symbols', { headers: { Origin: 'http://127.0.0.1:5174' } });
    expect(ok.res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5174');
    const no = await get(api, '/api/v1/symbols', { headers: { Origin: 'https://evil.example' } });
    expect(no.res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('öffentliche /health ohne Interna, auch lokal und hinter einem Proxy (W3)', async () => {
    for (const headers of [{}, { 'X-Forwarded-For': '1.2.3.4' }, { 'X-Real-IP': '1.2.3.4' }]) {
      const r = await get(api, '/api/v1/health', { headers });
      expect(r.res.status).toBe(200);
      expect(r.json()).toEqual({ status: 'ok' });
      expect(r.res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('nosniff an jeder Antwort', async () => {
    for (const u of [
      '/api/v1/symbols',
      '/api/v1/nope',
      `/api/v1/bars?sym=BTCUSDT&tf=1m&from=0&to=60000`,
    ])
      expect((await get(api, u)).res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('Betriebsschutz: Status-Listener, Diagnose-Header, CORS-Liste, Zeitgrenzen', () => {
  it('ausführliche Health nur auf dem Loopback-Status-Listener (W3)', async () => {
    const port = await freePort();
    const api = await start({ adminPort: port, host: '127.0.0.1' });
    try {
      expect(api.adminUrl).toBe(`http://127.0.0.1:${port}`);
      const r = await fetch(`${api.adminUrl}/health`);
      const j = (await r.json()) as Record<string, unknown>;
      expect(j.status).toBe('healthy');
      expect(j).toHaveProperty('memory');
      expect(j).toHaveProperty('cache');
      // der öffentliche Port kennt den Detailpfad nicht
      expect((await get(api, '/health')).res.status).toBe(404);
    } finally {
      await api.close();
    }
  });

  it('Katalog fällt länger als staleAfterMs aus → 503 statt 304/Cache-Treffer auf altem Stand', async () => {
    const api = await start({ staleAfterMs: 1_000 });
    try {
      const url = `/api/v1/profile?sym=BTCUSDT&from=${dataFrom}&to=${dataFrom + DAY_MS}&R=100`;
      const a = await get(api, url);
      expect(a.res.status).toBe(200);
      const cat = api.deps.catalog;
      await cat.stop();
      cat.lastError = 'connect ECONNREFUSED';
      cat.lastErrorKind = 'connection';
      cat.lastRefresh = Date.now() - 500; // Ausfall kürzer als die Schwelle: weiter bedient
      expect((await get(api, url)).res.headers.get('x-cache')).toBe('hit');
      // Sperren eines Imports (55P03) über die Schwelle: weiter bedient, Health „degraded"
      cat.lastErrorKind = 'lock';
      cat.lastRefresh = Date.now() - 2_000; // > staleAfterMs, < 3 · staleAfterMs (sonst „hängt")
      expect((await get(api, url)).res.headers.get('x-cache')).toBe('hit');
      const deg = await get(api, '/api/v1/health');
      expect([deg.res.status, deg.json().status]).toEqual([200, 'degraded']);
      cat.lastErrorKind = 'connection';
      cat.lastRefresh = Date.now() - 5_000;
      for (const h of [{}, { 'If-None-Match': a.res.headers.get('etag')! }]) {
        const r = await get(api, url, { headers: h });
        expect(r.res.status).toBe(503);
        expect(r.res.headers.get('retry-after')).toBe('5');
      }
      expect((await get(api, '/api/v1/symbols')).res.status).toBe(503);
      expect((await get(api, '/api/v1/health')).res.status).toBe(503);
    } finally {
      await api.close();
    }
  });

  it('Diagnose-Header standardmäßig aus', async () => {
    const api = await start({ diagHeaders: false });
    try {
      const r = await get(
        api,
        `/api/v1/profile?sym=BTCUSDT&from=${dataFrom}&to=${dataFrom + DAY_MS}&R=100`,
      );
      expect(r.res.status).toBe(200);
      for (const h of ['x-source', 'x-rows-estimate', 'server-timing'])
        expect(r.res.headers.get(h), h).toBeNull();
      const c = await get(api, '/api/v1/symbols', { headers: { Origin: 'http://127.0.0.1:5174' } });
      expect(c.res.headers.get('access-control-expose-headers')).toBe('ETag, Retry-After, X-Cache');
    } finally {
      await api.close();
    }
  });

  it('CORS mit konfigurierter Liste: nur exakte Ursprünge, Loopback nicht mehr', async () => {
    const api = await start({ cors: ['https://of.example'] });
    try {
      const ok = await get(api, '/api/v1/symbols', { headers: { Origin: 'https://of.example' } });
      expect(ok.res.headers.get('access-control-allow-origin')).toBe('https://of.example');
      for (const o of [
        'http://127.0.0.1:5174',
        'https://of.example:8443',
        'https://evil.example',
      ]) {
        const r = await get(api, '/api/v1/symbols', { headers: { Origin: o } });
        expect(r.res.headers.get('access-control-allow-origin'), o).toBeNull();
      }
    } finally {
      await api.close();
    }
  });

  it('belegter Port: Start schlägt fehl und schließt die Datenbank-Pools (kein hängender Prozess)', async () => {
    const busyPort = await freePort();
    const blocker = createServer().listen(busyPort, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    const count = async () => {
      const [r] = await admin<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = ${testDb} AND application_name LIKE 'orderflow-api%'`;
      return r!.n;
    };
    try {
      const before = await count();
      await expect(start({ port: busyPort })).rejects.toThrow(/EADDRINUSE/);
      for (let i = 0; i < 40 && (await count()) > before; i++) await sleep(50);
      expect(await count()).toBe(before);
    } finally {
      blocker.close();
    }
  });

  it('Zeitgrenzen (W2): Leerlauf-Socket und tröpfelnde Kopfzeilen werden geschlossen', async () => {
    const api = await start({ connectionTimeoutMs: 300, requestTimeoutMs: 600 });
    try {
      const { port } = new URL(api.url);
      // Leerlauf: nichts senden
      const idle = await socketLife(Number(port), () => {});
      expect(idle).toBeLessThan(2_000);
      // Slow-Loris: alle 100 ms ein Kopfzeilen-Byte (hält den Socket aktiv, nie fertig)
      const loris = await socketLife(Number(port), (sock) => {
        sock.write('GET /api/v1/symbols HTTP/1.1\r\nHost: x\r\nX-A: ');
        const t = setInterval(() => sock.write('a'), 100);
        sock.on('close', () => clearInterval(t));
      });
      expect(loris).toBeLessThan(3_000);
    } finally {
      await api.close();
    }
  });
});

/** Öffnet eine TCP-Verbindung, führt `use` aus und misst die Zeit bis zum Schließen durch den Server. */
function socketLife(port: number, use: (s: Socket) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const sock = createConnection({ host: '127.0.0.1', port }, () => use(sock));
    sock.on('error', () => {});
    sock.on('close', () => resolve(Date.now() - t0));
    setTimeout(() => {
      sock.destroy();
      reject(new Error('Server hat den Socket nicht geschlossen'));
    }, 10_000).unref();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

describe('Grenzen (422 mit Vorschlag)', () => {
  let api: RunningApi;
  let cells100: number;
  beforeAll(async () => {
    // Grenzen passend zu den synthetischen Daten: Zeilen eines Tages bei R = 100 minus 1
    cells100 = refProfile(dataFrom, dataFrom + DAY_MS, 100 * TICK).buy.length;
    api = await start({ maxSourceRows: 3_000, maxTileSourceRows: 3_000, maxCells: cells100 - 1 });
  });
  afterAll(async () => api?.close());

  it('Quellzeilen vor der Ausführung geschätzt; Zellen aus dem Preisbereich; Vorschlag für R', async () => {
    const two = `from=${dataFrom}&to=${dataFrom + 2 * DAY_MS}`;
    const rows = await get(api, `/api/v1/profile?sym=BTCUSDT&${two}&R=5`);
    expect(rows.res.status).toBe(422);
    expect(rows.json().error).toMatch(/Quellzeilen/);
    expect(rows.json()).toMatchObject({ reason: 'profile_source_rows', limit: 3_000 });
    expect(rows.json().rowsEstimate).toBeGreaterThan(3_000);
    expect(Number(rows.res.headers.get('x-rows-estimate'))).toBeGreaterThan(3_000);
    const sr = rows.json().suggestR as number;
    expect(sr).toBeGreaterThan(5);
    const retry = await get(api, `/api/v1/profile?sym=BTCUSDT&${two}&R=${sr}`);
    expect(Number(retry.res.headers.get('x-rows-estimate'))).toBeLessThanOrEqual(3_000);
    const day = `from=${dataFrom}&to=${dataFrom + DAY_MS}`;
    const cells = await get(api, `/api/v1/profile?sym=BTCUSDT&${day}&R=100`);
    expect(cells.res.status).toBe(422);
    expect(cells.json().error).toMatch(/Zeilen/);
    expect(cells.json()).toMatchObject({
      reason: 'profile_rows',
      rows: cells100,
      limit: cells100 - 1,
    });
    expect(cells.json().suggestR).toBe(200);
    const ok = await get(api, `/api/v1/profile?sym=BTCUSDT&${day}&R=200`);
    expect(ok.res.status).toBe(200);
    expect((ok.json() as unknown as RangeProfileResponse).profile.buy.length).toBeLessThan(
      cells100,
    );
    const daily = await get(api, `/api/v1/profiles/daily?sym=BTCUSDT&${day}&R=100`);
    expect(daily.res.status).toBe(422);
    // `If-None-Match: *` macht aus der Ablehnung nie ein 304
    const star = await get(api, `/api/v1/profile?sym=BTCUSDT&${day}&R=100`, {
      headers: { 'If-None-Match': '*' },
    });
    expect(star.res.status).toBe(422);
  });

  it('angebotene Kombinationen halten die Quellzeilengrenze ein (kein 422 für angebotene Kacheln)', async () => {
    const s = ((await get(api, '/api/v1/symbols')).json().symbols as SymJson[])[0]!;
    const tiles = s.tiles;
    for (const [tf, m] of Object.entries(tiles)) {
      const tfSec = TIMEFRAMES[tf as keyof typeof TIMEFRAMES];
      for (const [R, n] of Object.entries(m)) {
        const k = Math.floor(dataFrom / (n * tfSec * 1000));
        const r = await get(
          api,
          `/api/v1/footprint?sym=BTCUSDT&tf=${tf}&R=${R}&tile=${k}&cfg=${s.tileConfigVersion}`,
        );
        expect(r.res.status, `${tf} ${R}`).toBe(200);
        expect(Number(r.res.headers.get('x-rows-estimate'))).toBeLessThanOrEqual(3_000);
      }
    }
  });
});

describe('Versionen, Unveränderlichkeit, Cache', () => {
  let api: RunningApi;
  const day = FIRST_DAY + 1;
  let cfg0: number;
  let url: string;
  beforeAll(async () => {
    api = await start();
    const s = ((await get(api, '/api/v1/symbols')).json().symbols as SymJson[])[0]!;
    cfg0 = s.tileConfigVersion;
    const n = s.tiles['1m']!['100']!;
    url = `/api/v1/footprint?sym=BTCUSDT&tf=1m&R=100&tile=${Math.floor((day * DAY_MS + 5 * HOUR) / (n * 60_000))}&cfg=${cfg0}`;
  });
  afterAll(async () => api?.close());
  const waitCatalog = () => sleep(400);

  it('final → immutable + ETag = dataVersion; Treffer aus dem Cache; 304', async () => {
    const a = await get(api, url);
    expect(a.res.status).toBe(200);
    const h = decodeTile(a.buf).header;
    expect(h.final).toBe(true);
    expect(a.res.headers.get('cache-control')).toBe('public, max-age=604800');
    expect(a.res.headers.get('etag')).toBe(`"${h.dataVersion}"`);
    expect(a.res.headers.get('x-cache')).toBe('miss');
    const b = await get(api, url, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(b.res.headers.get('x-cache')).toBe('hit');
    expect(Buffer.from(b.buf).equals(Buffer.from(a.buf))).toBe(true);
    const c = await get(api, url, { headers: { 'If-None-Match': `"${h.dataVersion}"` } });
    expect(c.res.status).toBe(304);
  });

  it('neue Tagesversion → neue dataVersion/ETag, kein Treffer; nicht unveränderlich → no-cache', async () => {
    const before = decodeTile((await get(api, url)).buf).header.dataVersion;
    await admin`UPDATE data_day SET version = version + 1 WHERE sym_id = ${SYM_ID} AND day = ${new Date(day * DAY_MS).toISOString().slice(0, 10)}::date`;
    await waitCatalog();
    const a = await get(api, url);
    const h = decodeTile(a.buf).header;
    expect(h.dataVersion).not.toBe(before);
    expect(a.res.headers.get('x-cache')).toBe('miss');
    expect(h.final).toBe(true);
    await admin`UPDATE data_day SET edge_pending = true WHERE sym_id = ${SYM_ID} AND day = ${new Date(day * DAY_MS).toISOString().slice(0, 10)}::date`;
    await waitCatalog();
    const b = await get(api, url);
    expect(decodeTile(b.buf).header.final).toBe(false);
    expect(b.res.headers.get('cache-control')).toBe('no-cache');
    // W1: auch nicht finale Antworten kommen aus dem Server-Cache (kurz, unter der dataVersion)
    expect((await get(api, url)).res.headers.get('x-cache')).toBe('hit');
    await admin`UPDATE data_day SET edge_pending = false WHERE sym_id = ${SYM_ID} AND day = ${new Date(day * DAY_MS).toISOString().slice(0, 10)}::date`;
    await waitCatalog();
  });

  it('Ausreißer-Kachel: 422 mit Grund und Vorschlag, gecacht, no-store; cfg stabil bei neuer Version des Tages', async () => {
    const s0 = ((await get(api, '/api/v1/symbols')).json().symbols as SymJson[])[0]!;
    const n = s0.tiles['1m']!['1']!;
    const k = Math.floor(OUTLIER_MS / (n * 60_000));
    const u = (kk: number) =>
      `/api/v1/footprint?sym=BTCUSDT&tf=1m&R=1&tile=${kk}&cfg=${s0.tileConfigVersion}`;
    const bad = await get(api, u(k));
    expect(bad.res.status).toBe(422);
    expect(bad.res.headers.get('cache-control')).toBe('no-store');
    expect(bad.res.headers.get('etag')).toBeNull();
    expect(bad.json()).toMatchObject({ reason: 'tile_cells_exceeded', limit: 60_000, suggestR: 2 });
    expect((await get(api, u(k))).res.headers.get('x-cache')).toBe('hit'); // keine zweite Abfrage
    for (const kk of [k - 1, k + 1]) expect((await get(api, u(kk))).res.status).toBe(200);
    // auch mit If-None-Match nie 304 für die abgelehnte Kachel
    for (const v of ['"x"', '*']) {
      const inm = await get(api, u(k), { headers: { 'If-None-Match': v } });
      expect(inm.res.status, v).toBe(422);
    }
    // `*` auf eine erfolgreich gecachte Kachel derselben Version → 304
    await get(api, u(k + 1));
    expect((await get(api, u(k + 1), { headers: { 'If-None-Match': '*' } })).res.status).toBe(304);
    // neue Version des (nicht finalen) Ausreißer-Tages: Angebot und cfg unverändert
    const d = new Date(PROVISIONAL_DAY * DAY_MS).toISOString().slice(0, 10);
    await admin`UPDATE data_day SET version = version + 1 WHERE sym_id = ${SYM_ID} AND day = ${d}::date`;
    await waitCatalog();
    const s1 = ((await get(api, '/api/v1/symbols')).json().symbols as SymJson[])[0]!;
    expect(s1.tileConfigVersion).toBe(s0.tileConfigVersion);
    expect(s1.tiles).toEqual(s0.tiles);
    expect((await get(api, u(k))).res.status).toBe(422);
  });

  it('Neuimport von Referenztagen mit gleichen Daten ändert tileConfigVersion nie', async () => {
    const cfgOf = async () =>
      ((await get(api, '/api/v1/symbols')).json().symbols as SymJson[])[0]!.tileConfigVersion;
    const before = await cfgOf();
    const ref = [FIRST_DAY, FIRST_DAY + 1, FIRST_DAY + 2, FIRST_DAY + 3].map((d) =>
      new Date(d * DAY_MS).toISOString().slice(0, 10),
    );
    // Phase 1: alle im Zustand importing (nicht unveränderlich), Folgetag veraltet
    await admin`UPDATE data_day SET state = 'importing', state_before_import = 'final_ok'
                 WHERE sym_id = ${SYM_ID} AND day = ANY(${ref}::date[])`;
    await admin`UPDATE data_day SET stale = true WHERE sym_id = ${SYM_ID} AND day = ${new Date(BAD_DAY * DAY_MS).toISOString().slice(0, 10)}::date`;
    await waitCatalog();
    expect(await cfgOf()).toBe(before);
    // Phase 2: Import fertig, neue Version, gleiche Daten
    await admin`UPDATE data_day SET state = 'final_ok', state_before_import = NULL, version = version + 1
                 WHERE sym_id = ${SYM_ID} AND day = ANY(${ref}::date[])`;
    await admin`UPDATE data_day SET stale = false, version = version + 1 WHERE sym_id = ${SYM_ID} AND day = ${new Date(BAD_DAY * DAY_MS).toISOString().slice(0, 10)}::date`;
    await waitCatalog();
    expect(await cfgOf()).toBe(before);
  });

  it('geänderte Kachelkonfiguration → 409 auf alte cfg; Rücknahme und Neustart liefern dieselbe cfg', async () => {
    const d = new Date(day * DAY_MS).toISOString().slice(0, 10);
    const [b] = await admin<{ ts: Date; high_px: number }[]>`
      SELECT ts, high_px FROM bar_1m WHERE sym_id = ${SYM_ID} AND ts >= ${d}::date ORDER BY ts LIMIT 1`;
    // ein Ausreißer-Bar ändert maxRows aller tf → neue Kachellängen
    await admin`UPDATE bar_1m SET high_px = high_px + 900000 WHERE sym_id = ${SYM_ID} AND ts = ${b!.ts}`;
    await admin`UPDATE data_day SET version = version + 1 WHERE sym_id = ${SYM_ID} AND day = ${d}::date`;
    await waitCatalog();
    const s = ((await get(api, '/api/v1/symbols')).json().symbols as SymJson[])[0]!;
    expect(s.tileConfigVersion).not.toBe(cfg0);
    const r = await get(api, url);
    expect(r.res.status).toBe(409);
    expect(r.json().tileConfigVersion).toBe(s.tileConfigVersion);
    await admin`UPDATE bar_1m SET high_px = ${b!.high_px} WHERE sym_id = ${SYM_ID} AND ts = ${b!.ts}`;
    await admin`UPDATE data_day SET version = version + 1 WHERE sym_id = ${SYM_ID} AND day = ${d}::date`;
    await waitCatalog();
    const s2 = ((await get(api, '/api/v1/symbols')).json().symbols as SymJson[])[0]!;
    expect(s2.tileConfigVersion).toBe(cfg0);
    const tileA = decodeTile((await get(api, url)).buf).header.dataVersion;
    const other = await start();
    try {
      const s3 = ((await get(other, '/api/v1/symbols')).json().symbols as SymJson[])[0]!;
      expect(s3.tileConfigVersion).toBe(cfg0);
      expect(decodeTile((await get(other, url)).buf).header.dataVersion).toBe(tileA);
    } finally {
      await other.close();
    }
  });
});

describe('Sperren, Abbruch, Überlast', () => {
  // eigene Verbindung für die Sperre (admin hat max. 1 Verbindung und fragt pg_stat_activity ab)
  let locker: Sql;
  beforeAll(() => {
    locker = connect(adminCfg);
  });
  afterAll(async () => locker?.end());
  /** Hält eine exklusive Sperre auf fp_1m, bis release() gerufen wird. */
  async function holdLock(tables = ['fp_1m']): Promise<() => Promise<void>> {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const done = locker.begin(async (tx) => {
      for (const t of tables) await tx.unsafe(`LOCK TABLE ${t} IN ACCESS EXCLUSIVE MODE`);
      locked();
      await released;
    });
    await isLocked;
    return async () => {
      release();
      await done;
    };
  }
  // R = 5 liest fp_1m (einzige passende Quelle)
  const profileUrl = (k: number) =>
    `/api/v1/profile?sym=BTCUSDT&from=${dataFrom + k * MINUTE_MS}&to=${dataFrom + (k + 30) * MINUTE_MS}&R=5`;
  const waiting = async () => {
    const [r] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = ${testDb} AND application_name = 'orderflow-api' AND wait_event_type = 'Lock'`;
    return r!.n;
  };

  it('Client-Abbruch bricht die wartende DB-Abfrage ab', async () => {
    const api = await start({ lockTimeoutMs: 20_000 });
    const release = await holdLock();
    try {
      const ac = new AbortController();
      const p = fetch(api.url + profileUrl(1), { signal: ac.signal }).catch((e: unknown) => e);
      for (let i = 0; i < 50 && (await waiting()) === 0; i++) await sleep(50);
      expect(await waiting()).toBe(1);
      ac.abort();
      await p;
      for (let i = 0; i < 40 && (await waiting()) > 0; i++) await sleep(50);
      expect(await waiting()).toBe(0); // Query.cancel → die API-Sitzung wartet nicht mehr
    } finally {
      await release();
      await api.close();
    }
  });

  it('lock_timeout mit Wiederholung: kurze Sperre → Erfolg, lange Sperre → 503 + Retry-After', async () => {
    const api = await start({ lockTimeoutMs: 100, lockRetries: 3 });
    try {
      let release = await holdLock();
      const t0 = Date.now();
      const p = get(api, profileUrl(2));
      await sleep(300);
      await release();
      const r = await p;
      expect(r.res.status).toBe(200);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
      release = await holdLock();
      const q = await get(api, profileUrl(3));
      await release();
      expect(q.res.status).toBe(503);
      expect(q.res.headers.get('retry-after')).toBe('2');
    } finally {
      await api.close();
    }
  });

  it('Gleichzeitigkeitslimit: volle Warteschlange → 503 statt Postgres zu überlasten', async () => {
    const api = await start({ dbPool: 1, maxQueue: 0, lockTimeoutMs: 20_000 });
    const release = await holdLock();
    try {
      const first = get(api, profileUrl(4));
      for (let i = 0; i < 50 && (await waiting()) === 0; i++) await sleep(50);
      const second = await get(api, profileUrl(5));
      expect(second.res.status).toBe(503);
      expect(second.res.headers.get('retry-after')).toBe('1');
      await release();
      expect((await first).res.status).toBe(200);
    } finally {
      await api.close();
    }
  });
  // nicht final (überdeckt den provisorischen Tag), liest fp_1m
  const openUrl = (k: number) =>
    `/api/v1/profile?sym=BTCUSDT&from=${PROVISIONAL_DAY * DAY_MS + k * MINUTE_MS}&to=${PROVISIONAL_DAY * DAY_MS + (k + 30) * MINUTE_MS}&R=5`;

  it('W1: nicht finale Antwort aus dem Cache und 304 ohne Datenabfrage (Tabellen gesperrt)', async () => {
    const api = await start({ lockTimeoutMs: 20_000 });
    try {
      const a = await get(api, openUrl(1));
      expect(a.res.status).toBe(200);
      expect(a.json().final).toBe(false);
      expect(a.res.headers.get('cache-control')).toBe('no-cache');
      const etag = a.res.headers.get('etag')!;
      const release = await holdLock(['fp_1m', 'bar_1m', 'data_day']);
      try {
        const t0 = Date.now();
        const r304 = await get(api, openUrl(1), { headers: { 'If-None-Match': etag } });
        expect(r304.res.status).toBe(304);
        expect(r304.res.headers.get('etag')).toBe(etag);
        expect(r304.res.headers.get('x-cache')).toBe('revalidated');
        const hit = await get(api, openUrl(1));
        expect(hit.res.status).toBe(200);
        expect(hit.res.headers.get('x-cache')).toBe('hit');
        expect(Date.now() - t0).toBeLessThan(1_000);
        expect(await waiting()).toBe(0); // keine API-Sitzung wartet auf die Sperren
      } finally {
        await release();
      }
    } finally {
      await api.close();
    }
  });

  it('W1: Ansturm gleicher Anfragen → eine Datenabfrage, alle 200 (Pool 1, keine Warteschlange)', async () => {
    const api = await start({ dbPool: 1, maxQueue: 0, lockTimeoutMs: 20_000 });
    const release = await holdLock();
    try {
      const all = Array.from({ length: 50 }, () => get(api, openUrl(2)));
      for (let i = 0; i < 50 && (await waiting()) === 0; i++) await sleep(50);
      expect(await waiting()).toBe(1);
      await release();
      const res = await Promise.all(all);
      expect(res.map((r) => r.res.status)).toEqual(Array(50).fill(200));
      const kinds = res.map((r) => r.res.headers.get('x-cache'));
      expect(kinds.filter((k) => k === 'miss')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'shared')).toHaveLength(49);
    } finally {
      await release().catch(() => {});
      await api.close();
    }
  });

  it('W1: nicht finale Einträge laufen nach nonFinalTtlMs ab', async () => {
    const api = await start({ nonFinalTtlMs: 300 });
    try {
      expect((await get(api, openUrl(3))).res.headers.get('x-cache')).toBe('miss');
      expect((await get(api, openUrl(3))).res.headers.get('x-cache')).toBe('hit');
      await sleep(400);
      expect((await get(api, openUrl(3))).res.headers.get('x-cache')).toBe('miss');
    } finally {
      await api.close();
    }
  });

  it('Verbindungsabbruch durch die Datenbank (57P01) → 503 + Retry-After, danach wieder 200', async () => {
    const api = await start({ lockTimeoutMs: 20_000 });
    const release = await holdLock();
    try {
      const p = get(api, profileUrl(6));
      for (let i = 0; i < 50 && (await waiting()) === 0; i++) await sleep(50);
      expect(await waiting()).toBe(1);
      await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                   WHERE datname = ${testDb} AND application_name = 'orderflow-api'
                     AND wait_event_type = 'Lock'`;
      const r = await p;
      expect(r.res.status).toBe(503);
      expect(r.res.headers.get('retry-after')).toBe('5');
      await release();
      expect((await get(api, profileUrl(6))).res.status).toBe(200);
    } finally {
      await release().catch(() => {});
      await api.close();
    }
  });
});

describe('Inkonsistente Snapshots (Review Pass 4: „Bar ohne Level")', () => {
  let locker: Sql;
  beforeAll(() => {
    locker = connect(adminCfg);
  });
  afterAll(async () => locker?.end());

  /** Chunk von `table`, der den Tag `day` enthält. */
  async function chunkOf(table: string, day: number): Promise<string> {
    const rows = await admin<{ c: string }[]>`
      SELECT format('%I.%I', chunk_schema, chunk_name) AS c FROM timescaledb_information.chunks
       WHERE hypertable_name = ${table} AND range_start <= ${new Date(day * DAY_MS)}
         AND range_end > ${new Date(day * DAY_MS)}`;
    return rows[0]!.c;
  }

  /**
   * Startet `convert_to_rowstore` der Chunks in einer offenen Transaktion (hält die Sperren) und
   * committed erst auf commit(); danach wieder in den Columnstore.
   */
  async function conversionInProgress(chunks: string[]) {
    let commit!: () => void;
    const go = new Promise<void>((r) => (commit = r));
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    const done = locker.begin(async (tx) => {
      for (const c of chunks) await tx.unsafe(`CALL convert_to_rowstore('${c}'::regclass)`);
      started();
      await go;
    });
    await begun;
    return {
      commit: async () => {
        commit();
        await done;
      },
      recompress: async () => {
        for (const c of chunks)
          await locker.unsafe(`CALL convert_to_columnstore('${c}'::regclass)`);
      },
    };
  }

  it('Ursache und Fix: Konvertierung läuft schon, wenn der Leser kommt (Snapshot vor/nach der Sperre)', async () => {
    const sql = createPool(apiCfg({ lockTimeoutMs: 20_000 }));
    const day = FIRST_DAY; // fp_1m dieses Tages liegt im Columnstore (seed.ts)
    const range = { table: 'fp_1m' as const, from: day * DAY_MS, to: (day + 1) * DAY_MS };
    const count = `SELECT count(*)::int AS n FROM fp_1m WHERE sym_id = ${SYM_ID}
                     AND ts >= ${tsLit(range.from)} AND ts < ${tsLit(range.to)}`;
    const [{ n: total }] = (await admin.unsafe(count)) as unknown as [{ n: number }];
    const c = await chunkOf('fp_1m', day);
    const ac = new AbortController();
    const run = async (opts: { prelock?: () => Promise<string[]> }, first: string) => {
      const conv = await conversionInProgress([c]);
      const reader = readTx(sql, { signal: ac.signal, lockRetries: 0, ...opts }, async (tx) => {
        await tx.rows(first); // blockiert, solange die Konvertierung ihre Sperre hält
        return (await tx.rows(count))[0]![0];
      });
      await sleep(300);
      await conv.commit();
      const n = (await reader).value;
      await conv.recompress();
      return n;
    };
    try {
      // bisheriges Präludium (SELECT … LIMIT 0): Snapshot VOR dem Warten → Chunk leer (der Befund)
      expect(
        await run(
          {},
          `(SELECT 1 FROM fp_1m WHERE ts >= ${tsLit(range.from)} AND ts < ${tsLit(range.to)} LIMIT 0)`,
        ),
      ).toBe(0);
      // Fix: LOCK TABLE der Chunks als erste Anweisung (kein Snapshot), Snapshot erst danach
      expect(await run({ prelock: () => chunkLockList(sql, [range]) }, 'SELECT 1')).toBe(total);
    } finally {
      await sql.end();
    }
  });

  it('Kachel und /bars während einer laufenden Konvertierung beider Seiten: richtige Daten oder 503, nie leer', async () => {
    const api = await start({ lockTimeoutMs: 20_000 });
    const day = FIRST_DAY + 1;
    try {
      const s = ((await get(api, '/api/v1/symbols')).json().symbols as SymJson[])[0]!;
      const n = s.tiles['1m']!['10']!;
      const m = day * DAY_MS + 9 * 3_600_000;
      const k = Math.floor(m / (n * 60_000));
      const tileUrl = `/api/v1/footprint?sym=BTCUSDT&tf=1m&R=10&tile=${k}&cfg=${s.tileConfigVersion}`;
      const barsFrom = Math.floor(m / 60_000_000) * 60_000_000;
      const barsUrl = `/api/v1/bars?sym=BTCUSDT&tf=1m&from=${barsFrom}&to=${barsFrom + 60_000_000}`;
      const conv = await conversionInProgress([
        await chunkOf('bar_1m', day),
        await chunkOf('fp_1m_b10', day),
      ]);
      const pending = [get(api, tileUrl), get(api, barsUrl)];
      await sleep(300);
      await conv.commit();
      const [tile, bars] = await Promise.all(pending);
      await conv.recompress();
      for (const r of [tile!, bars!]) {
        expect([200, 503]).toContain(r.res.status);
        if (r.res.status !== 200) continue;
        const dec = decodeTile(r.buf);
        const ref = refBars(60, dec.header.from, dec.header.to);
        expect(dec.header.nBars).toBe(ref.length);
        expect(dec.header.nBars).toBeGreaterThan(0);
      }
      expect(tile!.res.status).toBe(200);
    } finally {
      await api.close();
    }
  });

  /** Entfernt die fp_1m_b10-Zeilen einer Minute (Bar ohne Level) und gibt die Wiederherstellung zurück. */
  async function dropLevels(minuteMs: number): Promise<() => Promise<void>> {
    const fp = data.fp.fp_1m_b10;
    const rows: string[] = [];
    for (let i = 0; i < fp.n; i++)
      if (fp.ts[i] === minuteMs)
        rows.push(
          `(${SYM_ID}, ${tsLit(minuteMs)}, ${fp.px[i]}, ${fp.buyQ[i]}, ${fp.sellQ[i]}, ${fp.buyA[i]}, ${fp.sellA[i]})`,
        );
    expect(rows.length).toBeGreaterThan(0);
    await admin.unsafe(
      `DELETE FROM fp_1m_b10 WHERE sym_id = ${SYM_ID} AND ts = ${tsLit(minuteMs)}`,
    );
    return async () => {
      await admin.unsafe(`INSERT INTO fp_1m_b10 VALUES ${rows.join(', ')}`);
    };
  }
  const minuteOf = (day: number) =>
    data.bars1m.find((b) => b.ts >= day * DAY_MS + 600 * MINUTE_MS && b.ts < (day + 1) * DAY_MS)!
      .ts;

  it('nicht unveränderlicher Tag: 503 + Retry-After, nicht gecacht, kein Datenfehler gemeldet', async () => {
    const api = await start();
    const m = minuteOf(PROVISIONAL_DAY);
    const restore = await dropLevels(m);
    try {
      const s = ((await get(api, '/api/v1/symbols')).json().symbols as SymJson[])[0]!;
      const n = s.tiles['1m']!['10']!;
      const url = `/api/v1/footprint?sym=BTCUSDT&tf=1m&R=10&tile=${Math.floor(m / (n * 60_000))}&cfg=${s.tileConfigVersion}`;
      for (let i = 0; i < 2; i++) {
        const r = await get(api, url);
        expect(r.res.status).toBe(503);
        expect(r.res.headers.get('retry-after')).toBe('2');
        expect(r.res.headers.get('cache-control')).toBe('no-store');
        expect(r.json().error).toMatch(/inkonsistent/);
      }
      expect(api.deps.catalog.dataErrors).toEqual([]);
    } finally {
      await restore();
      await api.close();
    }
  });

  it('unveränderlicher Tag: 503, laut gemeldet (Health degraded, /quality apiDataErrors), auch für Profile', async () => {
    const api = await start();
    const day = FIRST_DAY + 1;
    const m = minuteOf(day);
    const restore = await dropLevels(m);
    try {
      const s = ((await get(api, '/api/v1/symbols')).json().symbols as SymJson[])[0]!;
      const n = s.tiles['1m']!['10']!;
      const tile = await get(
        api,
        `/api/v1/footprint?sym=BTCUSDT&tf=1m&R=10&tile=${Math.floor(m / (n * 60_000))}&cfg=${s.tileConfigVersion}`,
      );
      expect(tile.res.status).toBe(503);
      // Profil über drei Minuten (nur fp_1m_b10): Summen ungleich → ebenfalls 503
      const prof = await get(
        api,
        `/api/v1/profile?sym=BTCUSDT&from=${m}&to=${m + 3 * MINUTE_MS}&R=10`,
      );
      expect(prof.res.status).toBe(503);
      expect(api.deps.catalog.dataErrors.length).toBeGreaterThan(0);
      const h = await get(api, '/api/v1/health');
      expect([h.res.status, h.json().status]).toEqual([200, 'degraded']);
      const q = await get(
        api,
        `/api/v1/quality?sym=BTCUSDT&from=${day * DAY_MS}&to=${(day + 1) * DAY_MS}`,
      );
      const errs = q.json().apiDataErrors as { from: string; message: string }[];
      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0]!.message).toMatch(/ohne Level|Summen/);
    } finally {
      await restore();
      await api.close();
    }
  });
});

describe('Stats-Spalten (x.trades, x.maxDelta, x.minDelta, x.cotHigh, x.cotLow)', () => {
  let api: RunningApi;
  beforeAll(async () => {
    api = await start();
  });
  afterAll(async () => api?.close());

  /** Brute Force je Bar aus bar_1m (unabhängig von composeBars formuliert, KONZEPT §3.5). */
  function brute(tfSec: number, from: number, to: number) {
    const out = new Map<
      number,
      { trades: number; maxD: number; minD: number; cotH: number; cotL: number }
    >();
    const groups = new Map<number, Bar[]>();
    for (const b of data.bars1m) {
      if (b.ts < from || b.ts >= to) continue;
      const k = b.ts - (b.ts % (tfSec * 1000));
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(b);
    }
    for (const [k, ms] of groups) {
      let p = 0;
      let maxD = -Infinity;
      let minD = Infinity;
      const low = Math.min(...ms.map((m) => m.low));
      const high = Math.max(...ms.map((m) => m.high));
      const d = ms.map((m) => m.buyQ - m.sellQ);
      ms.forEach((m, i) => {
        maxD = Math.max(maxD, p + m.runMax);
        minD = Math.min(minD, p + m.runMin);
        p += d[i]!;
      });
      const jl = ms.findIndex((m) => m.low === low);
      const jh = ms.findIndex((m) => m.high === high);
      const after = (j: number) => d.slice(j + 1).reduce((a, b) => a + b, 0);
      out.set(k / 1000, {
        trades: ms.reduce((a, m) => a + klineTrades(m), 0),
        maxD,
        minD,
        cotH: ms[jl]!.dFromLow + after(jl),
        cotL: ms[jh]!.dFromHigh + after(jh),
      });
    }
    return out;
  }

  it('/bars?stats=1: jede Spalte = Brute Force aus bar_1m, für jeden Zeitrahmen', async () => {
    let checked = 0;
    for (const [tf, tfSec] of Object.entries(TIMEFRAMES)) {
      const span = 1000 * tfSec * 1000;
      for (let c = Math.floor(dataFrom / span); c * span < dataTo; c++) {
        const from = c * span;
        const to = from + span;
        const r = await get(api, `/api/v1/bars?sym=BTCUSDT&tf=${tf}&from=${from}&to=${to}&stats=1`);
        expect(r.res.status, `${tf} ${c}`).toBe(200);
        const dec = decodeTile(r.buf);
        const x = dec.extra!;
        const ref = brute(tfSec, from, to);
        expect(dec.header.nBars).toBe(ref.size);
        const withTrades = 'x.trades' in x;
        // x.trades nur, wo billig (≤ 100 000 geschätzte kline-Zeilen, Schätzung aus den Tagen mit
        // Daten): die 6 Testtage liegen überall darunter
        expect(withTrades, tf).toBe(true);
        for (let i = 0; i < dec.header.nBars; i++) {
          const e = ref.get(dec.bars.time[i]!)!;
          expect(
            [x['x.maxDelta']![i], x['x.minDelta']![i], x['x.cotHigh']![i], x['x.cotLow']![i]],
            `${tf} t=${dec.bars.time[i]}`,
          ).toEqual([e.maxD, e.minD, e.cotH, e.cotL]);
          if (withTrades) expect(x['x.trades']![i]).toBe(e.trades);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(9_000);
  }, 120_000);

  it('Footprint ?stats=1: gleiche Spalten wie /bars; ohne stats keine x.-Spalten (bestehende Clients)', async () => {
    const s = ((await get(api, '/api/v1/symbols')).json().symbols as SymJson[])[0]!;
    for (const [tf, R] of [
      ['1m', '10'],
      ['5m', '100'],
      ['1h', '1000'],
      ['1d', '1000'],
    ] as const) {
      const n = s.tiles[tf]![R]!;
      const tfSec = TIMEFRAMES[tf];
      const k = Math.floor((dataFrom + DAY_MS) / (n * tfSec * 1000));
      const base = `/api/v1/footprint?sym=BTCUSDT&tf=${tf}&R=${R}&tile=${k}&cfg=${s.tileConfigVersion}`;
      const plain = decodeTile((await get(api, base)).buf);
      expect(plain.extra).toBeUndefined();
      const st = await get(api, `${base}&stats=1`);
      expect(st.res.status).toBe(200);
      const dec = decodeTile(st.buf);
      expect(dec.header.dataVersion).not.toBe(plain.header.dataVersion);
      expect(Array.from(dec.bars.time)).toEqual(Array.from(plain.bars.time));
      const ref = brute(tfSec, dec.header.from, dec.header.to);
      for (let i = 0; i < dec.header.nBars; i++) {
        const e = ref.get(dec.bars.time[i]!)!;
        expect([
          dec.extra!['x.maxDelta']![i],
          dec.extra!['x.cotHigh']![i],
          dec.extra!['x.cotLow']![i],
        ]).toEqual([e.maxD, e.cotH, e.cotL]);
      }
      // Größe: 36 B je Bar zusätzlich (4 × f64 + i32), Level unverändert
      expect(st.buf.length - (await get(api, base)).buf.length).toBeLessThanOrEqual(
        dec.header.nBars * 40 + 256,
      );
    }
    expect(
      (await get(api, `/api/v1/bars?sym=BTCUSDT&tf=1m&from=0&to=60000&stats=2`)).res.status,
    ).toBe(400);
  });
});

describe('Profil-Vertrag: Grenzen, Tageslisten, Version je Tag, VWAP', () => {
  let api: RunningApi;
  beforeAll(async () => {
    api = await start();
  });
  afterAll(async () => api?.close());

  it('/symbols veröffentlicht die Grenzen der Endpunkte', async () => {
    const j = (await get(api, '/api/v1/symbols')).json();
    expect(checkSymbolsResponse(j)).toEqual([]);
    expect(j.limits).toMatchObject({
      tiles: { maxCells: 60_000, maxSourceRows: 300_000 },
      bars: { maxBars: 5_000 },
      profile: { maxRows: 60_000, maxSourceRows: 1_500_000, maxR: 1_000_000, maxDailyDays: 400 },
      quality: { maxDays: 400, maxIssues: 5_000 },
    });
  });

  it('Tagesprofile: emptyDays/missingDays, dataVersion je Tag, VWAP = notional / Volumen', async () => {
    const from = (FIRST_DAY - 2) * DAY_MS;
    const to = (LAST_DAY + 3) * DAY_MS;
    const r = await get(api, `/api/v1/profiles/daily?sym=BTCUSDT&from=${from}&to=${to}&R=1000`);
    expect(r.res.status).toBe(200);
    const j = r.json() as unknown as DailyProfilesResponse;
    expect(checkDailyProfiles(j)).toEqual([]);
    const fmt = (d: number) => new Date(d * DAY_MS).toISOString().slice(0, 10);
    expect(j.missingDays).toEqual([
      fmt(FIRST_DAY - 2),
      fmt(FIRST_DAY - 1),
      fmt(LAST_DAY + 1),
      fmt(LAST_DAY + 2),
    ]);
    expect(j.emptyDays).toEqual([]);
    expect(j.days.length).toBe(LAST_DAY - FIRST_DAY + 1);
    expect(new Set(j.days.map((d) => d.dataVersion)).size).toBe(j.days.length);
    for (const d of j.days) {
      const vol = d.buyQ + d.sellQ;
      expect(d.vwap).toBeCloseTo(Number(BigInt(d.notional)) / vol, 3);
      expect(d.final).toBe(expFinal(d.from, d.to));
    }
    // dataVersion eines Tages hängt nur von seinen UTC-Tagen ab: gleich in einer anderen Anfrage
    const one = await get(
      api,
      `/api/v1/profiles/daily?sym=BTCUSDT&from=${FIRST_DAY * DAY_MS}&to=${(FIRST_DAY + 1) * DAY_MS}&R=1000`,
    );
    const d0 = (one.json() as unknown as DailyProfilesResponse).days[0]!;
    expect(d0.dataVersion).toBe(j.days[0]!.dataVersion);
  });
});

describe('Leerprüfung: echte Lücken bleiben gültig, der Gefahrenfall wird erkannt', () => {
  let api: RunningApi;
  beforeAll(async () => {
    api = await start();
  });
  afterAll(async () => api?.close());
  const H = 3_600_000;

  it('unveränderlicher Tag mit 4-Stunden-Loch: /bars, Footprint und Profil im Loch → 200 leer', async () => {
    const a = BAD_DAY * DAY_MS + HOLE_FROM_MIN * MINUTE_MS;
    const b = BAD_DAY * DAY_MS + HOLE_TO_MIN * MINUTE_MS;
    const bars = await get(api, `/api/v1/bars?sym=BTCUSDT&tf=1m&from=${a}&to=${b}`);
    expect(bars.res.status).toBe(200);
    expect(decodeTile(bars.buf).header.nBars).toBe(0);
    const prof = await get(api, `/api/v1/profile?sym=BTCUSDT&from=${a}&to=${b}&R=100`);
    expect(prof.res.status).toBe(200);
    expect((prof.json() as unknown as RangeProfileResponse).profile.rowLo).toBeNull();
    // über Mitternacht hinein: Vortag 20:00 bis ins Loch → Daten des Vortags, gültig
    const x = await get(
      api,
      `/api/v1/bars?sym=BTCUSDT&tf=1h&from=${BAD_DAY * DAY_MS - 4 * H}&to=${a + 3 * H}`,
    );
    expect(x.res.status).toBe(200);
    expect(decodeTile(x.buf).header.nBars).toBe(
      refBars(3600, BAD_DAY * DAY_MS - 4 * H, a + 3 * H).length,
    );
  });

  it('halb gefüllter nicht finaler Tag: Fenster im Loch (auch 8 h) → 200 leer, nie 503', async () => {
    const a = PROVISIONAL_DAY * DAY_MS + PROVISIONAL_UNTIL_MIN * MINUTE_MS;
    for (const [from, to] of [
      [a, a + H],
      [a, a + 4 * H],
      [a + H, a + 9 * H],
    ]) {
      const r = await get(api, `/api/v1/bars?sym=BTCUSDT&tf=1m&from=${from}&to=${to}`);
      expect(r.res.status, `${from}`).toBe(200);
      expect(decodeTile(r.buf).header.nBars).toBe(0);
      const p = await get(api, `/api/v1/profile?sym=BTCUSDT&from=${from}&to=${to}&R=10`);
      expect(p.res.status).toBe(200);
    }
    const s = ((await get(api, '/api/v1/symbols')).json().symbols as SymJson[])[0]!;
    // kleinste angebotene Kachel (n Minuten), vollständig im Loch
    const R = Object.entries(s.tiles['1m']!).sort((x, y) => x[1] - y[1])[0]!;
    const n = R[1];
    expect(n * 60_000).toBeLessThanOrEqual(4 * H);
    const k = Math.ceil((a + H) / (n * 60_000));
    const t = await get(
      api,
      `/api/v1/footprint?sym=BTCUSDT&tf=1m&R=${R[0]}&tile=${k}&cfg=${s.tileConfigVersion}`,
    );
    expect(t.res.status).toBe(200);
    expect(decodeTile(t.buf).header.nBars).toBe(0);
    // Tagesprofil mit Offset über den unfertigen Tag: gültig
    const d = await get(
      api,
      `/api/v1/profiles/daily?sym=BTCUSDT&from=${PROVISIONAL_DAY * DAY_MS + 6 * H}&to=${(PROVISIONAL_DAY + 1) * DAY_MS + 6 * H}&R=100&offsetH=6`,
    );
    expect(d.res.status).toBe(200);
  });

  it('Gefahrenfall: gespeicherte Minuten belegt, Snapshot liefert keine → Wiederholung → 503, nie gecacht', async () => {
    const day = FIRST_DAY + 2;
    const a = day * DAY_MS + 10 * H;
    const b = a + 2 * H;
    const gone = data.bars1m.filter((x) => x.ts >= a && x.ts < b);
    expect(gone.length).toBeGreaterThan(60);
    // bar_1m der Stunden löschen, ohne neue Tagesversion (wie ein leer gelesener Chunk)
    await admin.unsafe(
      `DELETE FROM bar_1m WHERE sym_id = ${SYM_ID} AND ts >= ${tsLit(a)} AND ts < ${tsLit(b)}`,
    );
    try {
      for (let i = 0; i < 2; i++) {
        const r = await get(api, `/api/v1/bars?sym=BTCUSDT&tf=1m&from=${a}&to=${b}`);
        expect(r.res.status).toBe(503);
        expect(r.res.headers.get('cache-control')).toBe('no-store');
        expect(r.json().error).toMatch(/inkonsistent/);
      }
    } finally {
      await insertBars1m(admin, gone);
    }
    expect((await get(api, `/api/v1/bars?sym=BTCUSDT&tf=1m&from=${a}&to=${b}`)).res.status).toBe(
      200,
    );
  });
});
