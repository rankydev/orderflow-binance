// Integrationstests von GET /api/v1/bigtrades gegen "<OF_DB_NAME>_test_api_bt" (eigene Testdatenbank,
// Rolle als Spiegel von of_api), mit synthetischen big_order-Zeilen im Columnstore. Beweist:
//  - of_api genügt (Lesen von big_order, data_day-Orderfeldern, data_minute_issue, bar_1m);
//  - Zeilen exakt = big_order ≥ Schwelle, nur in Abschnitten mit Order-Daten; Abdeckung mit Grund
//    (digest_v1, no_day, no_floor, unknown_totals, partial; minutengenau: not_recorded vor dem
//    Aufzeichnungsbeginn eines Live-Tages, pending nach live_until, gap, source_missing) – Zeilen eines
//    Abschnitts ohne Order-Daten werden nie ausgeliefert;
//  - Schwelle unter der Untergrenze → 422 mit minUsdt (BTC und ETH, 10^5 bzw. 10^6); ohne Untergrenze → 422;
//  - final/Cache-Control/ETag/304 für finale und laufende Bereiche, neue Version und Wechsel von
//    immutable → neuer ETag; Neuimport läuft (importing) und erstmals importierter Tag;
//  - Ausdünnung je (Bar, Seite) auf die k größten = Referenzrechnung; 422 mit Vorschlag bei zu vielen
//    Treffern (echte Zeilen, Katalog nach Versionswechsel) bzw. gelesenen Zeilen; Stufenstatistik exakt.
import {
  decodeBigTrades,
  parseConfig,
  type CoverageSpan,
  type DbConfig,
  type DecodedBigTrades,
} from '@orderflow/core';
import { connect, dropAndCreateDatabase, migrateUp, type Sql } from '@orderflow/db';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIG_LADDER_USDT } from '../src/bigtrades-plan.ts';
import { parseApiConfig, type ApiConfig } from '../src/config.ts';
import { startApi, type RunningApi } from '../src/main.ts';
import {
  BIG_HOLES_PER_DAY,
  BIGTRADES_MAX_MATCHED_ROWS,
  BIGTRADES_MAX_ROWS,
  BIGTRADES_MAX_SOURCE_ROWS,
} from '../src/routes/bigtrades.ts';
import { mirrorApiRole } from './api-role.ts';

const base = parseConfig(process.env).db;
const testDb = `${base.database}_test_api_bt`;
const adminCfg: DbConfig = { ...base, database: testDb };
const TEST_ROLE = 'of_api_test_bt';
const apiPassword = randomBytes(18).toString('hex');

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const D = 20_700; // 2026-09-04; alle Tage in einem 30-Tage-Chunk [20 700, 20 730)
const UNIT = 100_000; // BTC: price_unit · qty_unit = 10^-5 USDT
const FLOOR = 500_000 * UNIT;
const PX = 9_000_000; // 90 000 USDT
const ETH_UNIT = 1_000_000; // ETH: 0,001 · 0,001 = 10^-6 USDT
const ETH_FLOOR = 250_000 * ETH_UNIT;
const ETH_PX = 3_000_000; // 3 000 USDT
/** Tag 15: mehr Lückenminuten als BIG_HOLES_PER_DAY → ganzer Tag too_many_holes. */
const HOLEY = 15;
const at = (off: number, h = 0, m = 0) => (D + off) * DAY + h * HOUR + m * MIN;

interface DayFix {
  off: number;
  state: string;
  dv: 1 | 2 | null;
  ordersN: number | null;
  floor: number | null;
  source?: 'vision' | 'live';
  liveUntil?: number;
  first?: number;
  last?: number;
  before?: string;
  orders?: number;
}
/** Tage: Zustand und Orderfelder (Migration 0017), Live-Felder (0011). */
const DAYS: DayFix[] = [
  { off: 0, state: 'final_ok', dv: 2, ordersN: 1000, floor: FLOOR },
  { off: 1, state: 'final_ok', dv: 2, ordersN: 1000, floor: FLOOR },
  { off: 2, state: 'final_ok', dv: 1, ordersN: null, floor: null }, // vor 0017 geschrieben
  { off: 3, state: 'final_bad', dv: 2, ordersN: 1000, floor: 2 * FLOOR, orders: 3000 }, // höhere Untergrenze, missing
  // off 4: keine Zeile
  { off: 5, state: 'final_ok', dv: 2, ordersN: 1000, floor: null, last: 5_999_999, orders: 0 },
  // Live, vollständig, erste aggId schließt an den Vortag an, geschrieben bis 20:00
  {
    off: 6,
    state: 'provisional',
    dv: null,
    ordersN: 1000,
    floor: FLOOR,
    source: 'live',
    first: 6_000_000,
    liveUntil: at(6, 20),
  },
  { off: 7, state: 'provisional', dv: null, ordersN: null, floor: null, source: 'live' }, // unbekannt
  { off: 8, state: 'final_ok', dv: 2, ordersN: 1000, floor: FLOOR, orders: 25_000 }, // Ausdünnung
  { off: 9, state: 'final_ok', dv: 2, ordersN: 1000, floor: FLOOR, last: 9_999_999, orders: 0 },
  // Live ohne Anschluss: Recorder begann 10:00 (bar_1m ab 10:00), gap 12:00–12:02, bis 15:00
  {
    off: 10,
    state: 'provisional',
    dv: null,
    ordersN: 1000,
    floor: FLOOR,
    source: 'live',
    first: 10_500_000,
    liveUntil: at(10, 15),
    orders: 3000,
  },
  // Neuimport läuft (alte Daten sichtbar) bzw. erstmals im Import (noch keine Daten)
  { off: 11, state: 'importing', dv: 2, ordersN: 1000, floor: FLOOR, before: 'final_ok' },
  { off: 12, state: 'importing', dv: null, ordersN: null, floor: null, orders: 0 },
  { off: HOLEY, state: 'final_bad', dv: 2, ordersN: 1000, floor: FLOOR },
];

interface Order {
  ts: number;
  id: number;
  side: number;
  pf: number;
  pl: number;
  qty: number;
  notional: number;
  aggN: number;
}

/** Orders eines Tages (deterministisch), Notional ≥ Untergrenze des Tages (wie gespeichert). */
function dayOrders(
  off: number,
  n: number,
  floor: number,
  id0: number,
  px = PX,
  unit = UNIT,
): Order[] {
  const out: Order[] = [];
  for (let i = 0; i < n; i++) {
    const usdt = 250_000 + ((i * 1_299_709 + off * 104_729) % 9_750_000);
    const qty = Math.floor((usdt * unit) / px) + 1;
    const aggN = 1 + (i % 4);
    const o = {
      // zwei Orders je 5. Zeitpunkt mit gleichem ts (Reihenfolge nach first_agg_id)
      ts: at(off) + Math.floor((i * DAY) / n) - (i % 5 === 1 ? Math.floor(DAY / n) : 0),
      id: id0 + i * 10,
      side: 1 + ((i * 31) % 2),
      pf: px,
      pl: px + (aggN - 1) * 10,
      qty,
      notional: qty * px,
      aggN,
    };
    if (o.notional >= floor) out.push(o);
  }
  return out;
}

let admin: Sql;
let api: RunningApi;
/** Alle gespeicherten BTC-Orders je Tagesoffset (auch die der Abschnitte ohne Order-Daten). */
const stored = new Map<number, Order[]>();
let ethOrders: Order[] = [];
/** Minuten ohne Order-Daten (data_minute_issue). */
const MISSING = [at(3, 1, 40), at(3, 1, 41)];
/** mismatch-Minute an Tag 3 (dazu eine mismatch-Zeile auf MISSING[0]: dort gilt missing). */
const MISMATCH = at(3, 3);

const GAPS = [at(10, 12, 0), at(10, 12, 1)];

function apiCfg(over: Partial<ApiConfig> = {}): ApiConfig {
  const c = parseApiConfig({
    ...process.env,
    OF_DB_NAME: testDb,
    OF_API_DB_USER: TEST_ROLE,
    OF_API_DB_PASSWORD: apiPassword,
  });
  return { ...c, port: 0, pollMs: 100, adminPort: 0, diagHeaders: true, ...over };
}

async function get(path: string, init: RequestInit = {}) {
  const res = await fetch(api.url + path, init);
  const buf = new Uint8Array(await res.arrayBuffer());
  return {
    res,
    buf,
    json: () => JSON.parse(new TextDecoder().decode(buf)) as Record<string, unknown>,
    decode: (): DecodedBigTrades => decodeBigTrades(buf),
  };
}

const url = (from: number, to: number, min: number, tf = '1h', sym = 'BTCUSDT') =>
  `/api/v1/bigtrades?sym=${sym}&tf=${tf}&from=${from}&to=${to}&min=${min}`;

/** Erwartete Zeilen: gespeicherte Orders ≥ minN in [from, to), deren Zeit `covered` ist, nach (ts, id). */
function expected(
  from: number,
  to: number,
  minN: number,
  covered: (ts: number) => boolean,
  src: Order[] = [...stored.values()].flat(),
): Order[] {
  return src
    .filter((o) => o.ts >= from && o.ts < to && o.notional >= minN && covered(o.ts))
    .sort((a, b) => a.ts - b.ts || a.id - b.id);
}

/** Zeitpunkt liegt in einem ok/partial-Abschnitt der Antwort. */
const inCoverage = (cov: CoverageSpan[]) => (ts: number) =>
  cov.some((c) => c.status !== 'none' && ts >= c.from && ts < c.to);

function rowsOf(d: DecodedBigTrades): Order[] {
  const r = d.rows;
  return Array.from(r.ts, (ts, i) => ({
    ts,
    id: r.firstAggId[i]!,
    side: r.side[i]!,
    pf: r.pxFirst[i]!,
    pl: r.pxLast[i]!,
    qty: r.qty[i]!,
    notional: r.notional[i]!,
    aggN: r.aggN[i]!,
  }));
}

async function insertOrders(orders: Order[], symId = 1): Promise<void> {
  for (let i = 0; i < orders.length; i += 5000) {
    const part = orders.slice(i, i + 5000).map((o) => ({
      sym_id: symId,
      ts: new Date(o.ts).toISOString(),
      first_agg_id: o.id,
      last_agg_id: o.id + o.aggN - 1,
      side: o.side,
      px_first: o.pf,
      px_last: o.pl,
      qty: o.qty,
      notional: o.notional,
      agg_n: o.aggN,
    }));
    await admin.unsafe(
      `INSERT INTO big_order SELECT * FROM json_populate_recordset(NULL::big_order, ($1::text)::json)`,
      [JSON.stringify(part)],
    );
  }
}

const dayStr = (off: number) => new Date(at(off)).toISOString().slice(0, 10);

async function waitFor(fn: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error('Bedingung nicht erreicht');
}

beforeAll(async () => {
  await dropAndCreateDatabase(adminCfg);
  admin = connect(adminCfg);
  await migrateUp(admin);
  await mirrorApiRole(admin, TEST_ROLE, apiPassword);
  await admin`INSERT INTO symbol (sym_id, name, price_unit, price_decimals, tick_ref_units, qty_unit,
                                  qty_decimals, data_from, big_floor_n)
              VALUES (1, 'BTCUSDT', 0.01, 2, 10, 0.001, 3, '2026-01-01', ${FLOOR}),
                     (2, 'ETHUSDT', 0.001, 3, 10, 0.001, 3, '2026-01-01', ${ETH_FLOOR}),
                     (3, 'SOLUSDT', 0.01, 2, 1, 0.01, 2, '2026-01-01', NULL)`;
  for (const d of DAYS) {
    await admin`INSERT INTO data_day (sym_id, day, state, version, source, edge_pending, edge_first_pending,
                                      edge_last_pending, digest, digest_version, orders_n, orders_notional,
                                      big_floor_n, live_until, first_agg_id, last_agg_id, state_before_import)
                VALUES (1, ${dayStr(d.off)}::date, ${d.state}, 3, ${d.source ?? 'vision'}, false, false, false,
                        ${d.dv === null ? null : 'x'}, ${d.dv}, ${d.ordersN},
                        ${d.ordersN === null ? null : '123'}::bigint, ${d.floor},
                        ${d.liveUntil === undefined ? null : new Date(d.liveUntil)},
                        ${d.first ?? (d.off + 1) * 1_000_000}, ${d.last ?? (d.off + 1) * 1_000_000 + 999_999},
                        ${d.before ?? null})`;
    // Auch Abschnitte ohne Order-Daten bekommen Zeilen (v1-Reste, unvollständiger Live-Tag, vor
    // Aufzeichnungsbeginn, nach live_until): sie dürfen nie ausgeliefert werden.
    const n = d.orders ?? 300;
    if (n === 0) continue;
    const orders = dayOrders(d.off, n, d.floor ?? FLOOR, 1_000_000 * (d.off + 1));
    stored.set(d.off, orders);
    await insertOrders(orders);
  }
  // ETH: ein Tag, Untergrenze 250 000 USDT in 10^-6 USDT
  await admin`INSERT INTO data_day (sym_id, day, state, version, source, edge_pending, digest, digest_version,
                                    orders_n, orders_notional, big_floor_n)
              VALUES (2, ${dayStr(0)}::date, 'final_ok', 1, 'vision', false, 'x', 2, 10, 1, ${ETH_FLOOR})`;
  ethOrders = dayOrders(0, 200, ETH_FLOOR, 7_000_000, ETH_PX, ETH_UNIT);
  await insertOrders(ethOrders, 2);
  // Live-Tag 10: bar_1m erst ab 10:00 (Recorder-Start), dazu gap-Minuten; Tag 3: missing-Minuten
  await admin.unsafe(
    `INSERT INTO bar_1m SELECT 1, $1::timestamptz + g * interval '1 minute', ${PX}, ${PX}, ${PX}, ${PX},
            1, 1, 1, 1, ${2 * PX}, 10500000 + g * 2, 10500001 + g * 2, 0, 0, 0, 0, 0, 0, 1, 0
       FROM generate_series(0, 299) g`,
    [new Date(at(10, 10)).toISOString()],
  );
  for (const [ts, kind] of [
    ...MISSING.map((t) => [t, 'missing'] as const),
    [MISSING[0]!, 'mismatch'] as const,
    [MISMATCH, 'mismatch'] as const,
    ...Array.from(
      { length: BIG_HOLES_PER_DAY + 1 },
      (_, i) => [at(HOLEY, 0, 2 * i), 'mismatch'] as const,
    ),
    ...GAPS.map((t) => [t, 'gap'] as const),
  ])
    await admin`INSERT INTO data_minute_issue (sym_id, ts, kind) VALUES (1, ${new Date(ts)}, ${kind})`;
  const chunks = await admin<{ c: string }[]>`
    SELECT format('%I.%I', chunk_schema, chunk_name) AS c FROM timescaledb_information.chunks
     WHERE hypertable_name = 'big_order'`;
  expect(chunks.length).toBe(1);
  for (const { c } of chunks) await admin.unsafe(`CALL convert_to_columnstore('${c}'::regclass)`);
  api = await startApi(apiCfg(), { logger: false });
}, 120_000);

afterAll(async () => {
  try {
    await api?.close();
    await admin?.unsafe(`DROP OWNED BY ${TEST_ROLE}`);
    await admin?.unsafe(`DROP ROLE IF EXISTS ${TEST_ROLE}`);
  } finally {
    await admin?.end();
  }
});

const ok = (from: number, to: number, final: boolean, floorN = FLOOR): CoverageSpan => ({
  from,
  to,
  status: 'ok',
  reason: null,
  floorN,
  final,
});
const none = (from: number, to: number, reason: string, final: boolean): CoverageSpan => ({
  from,
  to,
  status: 'none',
  reason: reason as CoverageSpan['reason'],
  floorN: null,
  final,
});
const partial = (from: number, to: number): CoverageSpan => ({
  from,
  to,
  status: 'partial',
  reason: 'floor_above',
  floorN: 2 * FLOOR,
  final: true,
});

/** Tag 3 bis `end`: Lückenminuten missing (vor mismatch) und mismatch, dazwischen `c`. */
const day3 = (c: (a: number, b: number) => CoverageSpan, end: number): CoverageSpan[] => [
  c(at(3), MISSING[0]!),
  none(MISSING[0]!, MISSING[1]! + MIN, 'source_missing', true),
  c(MISSING[1]! + MIN, MISMATCH),
  none(MISMATCH, MISMATCH + MIN, 'mismatch', true),
  c(MISMATCH + MIN, end),
];

describe('/bigtrades', () => {
  it('of_api darf big_order, data_minute_issue, bar_1m lesen, nicht schreiben; Columnstore', async () => {
    const [r] = await admin<{ s: boolean; i: boolean; m: boolean; b: boolean; c: boolean }[]>`
      SELECT has_table_privilege('of_api', 'big_order', 'SELECT') AS s,
             has_table_privilege('of_api', 'big_order', 'INSERT') AS i,
             has_table_privilege('of_api', 'data_minute_issue', 'SELECT') AS m,
             has_table_privilege('of_api', 'bar_1m', 'SELECT') AS b,
             bool_and(is_compressed) AS c FROM timescaledb_information.chunks
       WHERE hypertable_name = 'big_order'`;
    expect(r).toEqual({ s: true, i: false, m: true, b: true, c: true });
  });

  it('/symbols: Untergrenze je Symbol (BTC 10^5, ETH 10^6) und Grenzen', async () => {
    const b = (await get('/api/v1/symbols')).json() as {
      limits: { bigtrades: Record<string, number> };
      symbols: { name: string; bigTrades: unknown }[];
    };
    expect(b.limits.bigtrades).toEqual({
      maxBars: 5000,
      maxRows: BIGTRADES_MAX_ROWS,
      maxSourceRows: BIGTRADES_MAX_SOURCE_ROWS,
      maxMatchedRows: BIGTRADES_MAX_MATCHED_ROWS,
      maxMinUsdt: 1_000_000_000,
    });
    const by = new Map(b.symbols.map((s) => [s.name, s.bigTrades]));
    expect(by.get('BTCUSDT')).toEqual({ floorN: FLOOR, minUsdt: 500_000, notionalDecimals: 5 });
    expect(by.get('ETHUSDT')).toEqual({
      floorN: ETH_FLOOR,
      minUsdt: 250_000,
      notionalDecimals: 6,
    });
    expect(by.get('SOLUSDT')).toBeNull();
  });

  it('finaler Bereich: exakte Zeilen, final, Cache-Control eine Woche, ETag/304', async () => {
    const from = at(0);
    const to = at(2);
    const r = await get(url(from, to, 500_000));
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.res.headers.get('cache-control')).toBe('public, max-age=604800');
    expect(r.res.headers.get('x-source')).toBe('big_order');
    const d = r.decode();
    expect(d.meta).toMatchObject({
      sym: 'BTCUSDT',
      tf: '1h',
      tfSec: 3600,
      priceDecimals: 2,
      qtyDecimals: 3,
      notionalDecimals: 5,
      from,
      to,
      minUsdt: 500_000,
      minN: FLOOR,
      final: true,
      k: null,
      omitted: 0,
    });
    expect(d.meta.coverage).toEqual([ok(from, to, true)]);
    const want = expected(from, to, FLOOR, () => true);
    expect(want.length).toBeGreaterThan(500);
    expect(rowsOf(d)).toEqual(want);
    expect(d.meta.total).toBe(want.length);
    for (let i = 0; i < d.header.n; i++)
      expect(d.rows.bar[i]! * 1000).toBe(Math.floor(d.rows.ts[i]! / HOUR) * HOUR);
    const etag = r.res.headers.get('etag')!;
    expect(etag).toBe(`"${d.meta.dataVersion}"`);
    const again = await get(url(from, to, 500_000), { headers: { 'If-None-Match': etag } });
    expect(again.res.status).toBe(304);
    expect(again.res.headers.get('cache-control')).toBe('public, max-age=604800');
    const hi = (await get(url(from, to, 5_000_000))).decode();
    expect(rowsOf(hi)).toEqual(expected(from, to, 5_000_000 * UNIT, () => true));
    expect(hi.meta.dataVersion).not.toBe(d.meta.dataVersion);
  });

  it('ETH: Notional in 10^-6 USDT, Schwelle 250 000', async () => {
    const r = await get(url(at(0), at(1), 250_000, '1h', 'ETHUSDT'));
    expect(r.res.status).toBe(200);
    const d = r.decode();
    expect(d.meta).toMatchObject({
      priceDecimals: 3,
      qtyDecimals: 3,
      notionalDecimals: 6,
      minUsdt: 250_000,
      minN: ETH_FLOOR,
      final: true,
    });
    expect(rowsOf(d)).toEqual(expected(at(0), at(1), ETH_FLOOR, () => true, ethOrders));
    const hi = (await get(url(at(0), at(1), 3_000_000, '1h', 'ETHUSDT'))).decode();
    expect(rowsOf(hi)).toEqual(expected(at(0), at(1), 3_000_000 * ETH_UNIT, () => true, ethOrders));
    expect(hi.header.n).toBeGreaterThan(0);
    const low = await get(url(at(0), at(1), 249_999, '1h', 'ETHUSDT'));
    expect(low.res.status).toBe(422);
    expect(low.json()).toMatchObject({
      reason: 'below_floor',
      minUsdt: 250_000,
      floorN: ETH_FLOOR,
    });
  });

  it('Abdeckung: Tage ohne Order-Daten als none mit Grund; partial; missing-Minuten; Live bis live_until', async () => {
    const from = at(0);
    const to = at(8);
    const r = await get(url(from, to, 500_000, '1d'));
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get('cache-control')).toBe('no-cache');
    const d = r.decode();
    expect(d.meta.coverage).toEqual([
      ok(at(0), at(2), true),
      none(at(2), at(3), 'digest_v1', true),
      ...day3(partial, at(4)),
      none(at(4), at(5), 'no_day', false),
      none(at(5), at(6), 'no_floor', true),
      // Live-Tag 6 schließt an Tag 5 an: ab 00:00 aufgezeichnet, bis live_until 20:00
      ok(at(6), at(6, 20), false),
      none(at(6, 20), at(7), 'pending', false),
      none(at(7), at(8), 'unknown_totals', false),
    ]);
    expect(d.meta.final).toBe(false);
    const want = expected(from, to, FLOOR, inCoverage(d.meta.coverage));
    expect(rowsOf(d)).toEqual(want);
    // gespeicherte Zeilen außerhalb der Abdeckung gibt es und sie fehlen in der Antwort
    for (const [a, b] of [
      [at(2), at(3)],
      [at(6, 20), at(7)],
      [at(7), at(8)],
      [MISSING[0]!, MISSING[1]! + MIN],
      [MISMATCH, MISMATCH + MIN],
    ] as const) {
      expect(
        [...stored.values()].flat().some((o) => o.ts >= a && o.ts < b),
        `${a}`,
      ).toBe(true);
      expect(d.rows.ts.some((t) => t >= a && t < b)).toBe(false);
    }
    // Schwelle ≥ Untergrenze von Tag 3: dort ok, aber wegen der missing-Minuten nicht final
    const d3 = await get(url(at(3), at(4), 1_000_000, '1d'));
    expect(d3.res.headers.get('cache-control')).toBe('no-cache');
    expect(d3.decode().meta.coverage).toEqual([
      ...day3((a, b) => ok(a, b, true, 2 * FLOOR), at(4)),
    ]);
    // nur ein Tag ohne Order-Daten bzw. partial: unveränderlich, aber nicht final
    for (const p of [url(at(2), at(3), 500_000, '1d'), url(at(3), at(4), 500_000, '1d')]) {
      const x = await get(p);
      expect(x.res.headers.get('cache-control'), p).toBe('no-cache');
      expect(x.decode().meta.final).toBe(false);
    }
  });

  it('Live-Tag ohne Anschluss: not_recorded bis zum Ende der ersten Minute, gap, pending; Zukunft no_day', async () => {
    const from = at(10);
    const to = at(14); // über den letzten Tag mit Daten hinaus
    const d = (await get(url(from, to, 500_000))).decode();
    expect(d.meta.coverage).toEqual([
      none(at(10), at(10, 10, 1), 'not_recorded', false),
      ok(at(10, 10, 1), GAPS[0]!, false),
      none(GAPS[0]!, GAPS[1]! + MIN, 'gap', false),
      ok(GAPS[1]! + MIN, at(10, 15), false),
      none(at(10, 15), at(11), 'pending', false),
      // Neuimport läuft: die alten Daten gelten weiter, aber nicht unveränderlich
      ok(at(11), at(12), false),
      // erstmals im Import: noch keine Daten
      none(at(12), at(14), 'no_day', false),
    ]);
    expect(rowsOf(d)).toEqual(expected(from, to, FLOOR, inCoverage(d.meta.coverage)));
    expect(d.rows.ts.some((t) => t < at(10, 10, 1) && t >= at(10))).toBe(false);
    expect(d.rows.ts.some((t) => t >= at(10, 15) && t < at(11))).toBe(false);
    expect(d.meta.final).toBe(false);
  });

  it('Teiltage über gemischte Tage (from/to mitten im Tag)', async () => {
    const from = at(1, 12);
    const to = at(3, 6);
    const d = (await get(url(from, to, 500_000))).decode();
    expect(d.meta.coverage).toEqual([
      ok(from, at(2), true),
      none(at(2), at(3), 'digest_v1', true),
      ...day3(partial, to),
    ]);
    expect(rowsOf(d)).toEqual(expected(from, to, FLOOR, inCoverage(d.meta.coverage)));
  });

  it('Schwelle unter der Untergrenze → 422 mit minUsdt; Symbol ohne Untergrenze → 422', async () => {
    const r = await get(url(at(0), at(1), 499_999));
    expect(r.res.status).toBe(422);
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    expect(r.json()).toMatchObject({ reason: 'below_floor', minUsdt: 500_000, floorN: FLOOR });
    const e = await get(url(at(0), at(1), 500_000, '1h', 'SOLUSDT'));
    expect(e.res.status).toBe(422);
    expect(e.json()).toMatchObject({ reason: 'not_available' });
  });

  it('Parameter: Ausrichtung, Bar-Grenze, unbekannt/fehlend → 400, Symbol → 404', async () => {
    const f = at(0);
    for (const p of [
      url(f + 60_000, f + DAY, 500_000),
      url(f, f + 5001 * HOUR, 500_000),
      url(f, f, 500_000),
      url(f, f + DAY, 0),
      url(f, f + DAY, 1_000_000_001),
      `/api/v1/bigtrades?sym=BTCUSDT&tf=1h&from=${f}&to=${f + DAY}`,
      `${url(f, f + DAY, 500_000)}&x=1`,
      `/api/v1/bigtrades?sym=BTCUSDT&tf=7m&from=${f}&to=${f + DAY}&min=500000`,
      `/api/v1/bigtrades?sym=BTCUSDT&tf=1h&from=${f}&to=${f + DAY}&min=0500000`,
    ])
      expect((await get(p)).res.status, p).toBe(400);
    expect((await get(url(f, f + DAY, 500_000, '1h', 'XYZUSDT'))).res.status).toBe(404);
  });

  it('Ausdünnung: je (Bar, Seite) die k größten, omitted, deterministisch', async () => {
    const from = at(8);
    const to = at(9);
    const all = expected(from, to, FLOOR, () => true);
    expect(all.length).toBeGreaterThan(BIGTRADES_MAX_ROWS);
    const d = (await get(url(from, to, 500_000, '15m'))).decode();
    const groups = new Map<string, Order[]>();
    for (const o of all) {
      const g = `${Math.floor(o.ts / 900_000)}|${o.side}`;
      groups.set(g, [...(groups.get(g) ?? []), o]);
    }
    const rank = new Map<Order, number>();
    for (const g of groups.values()) {
      g.sort((a, b) => b.notional - a.notional || a.ts - b.ts || a.id - b.id);
      g.forEach((o, i) => rank.set(o, i + 1));
    }
    let k = 0;
    while (
      [...groups.values()].reduce((s, g) => s + Math.min(g.length, k + 1), 0) <= BIGTRADES_MAX_ROWS
    )
      k++;
    const want = all.filter((o) => rank.get(o)! <= k);
    expect(d.meta.k).toBe(k);
    expect(d.meta.total).toBe(all.length);
    expect(d.meta.omitted).toBe(all.length - want.length);
    expect(rowsOf(d)).toEqual(want);
    expect(d.header.n).toBeLessThanOrEqual(BIGTRADES_MAX_ROWS);
    const hi = (await get(url(from, to, 8_000_000, '15m'))).decode();
    expect(hi.meta.k).toBeNull();
    expect(rowsOf(hi)).toEqual(expected(from, to, 8_000_000 * UNIT, () => true));
  });

  it('Katalog: Stufenstatistik je Tag exakt (Zeilen je Notional-Stufe)', async () => {
    const s = api.deps.catalog.symbol('BTCUSDT')!;
    for (const [off, orders] of stored) {
      const h = s.stats.get(D + off)?.bigHist;
      expect(h, `Tag ${off}`).toBeDefined();
      const want = new Array<number>(BIG_LADDER_USDT.length + 1).fill(0);
      for (const o of orders) want[BIG_LADDER_USDT.filter((u) => u * UNIT <= o.notional).length]!++;
      expect([...h!], `Tag ${off}`).toEqual(want);
    }
  });

  it('zu viele Treffer: echte Zeilen, Katalog nach Versionswechsel → 422 mit suggestMinUsdt', async () => {
    // 160 000 Orders 500 000 … 1 Mio. USDT an Tag 9, wie ein Import: Zeilen + neue Tagesversion
    await admin.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO big_order
         SELECT 1, $1::timestamptz + (g * 540) * interval '1 millisecond', 50000000 + g * 2, 50000000 + g * 2, 1 + g % 2,
                ${PX}, ${PX}, 1, (500000 + (g::int8 * 7919) % 500000) * ${UNIT}, 1
           FROM generate_series(0, 159999) g`,
        [new Date(at(9)).toISOString()],
      );
      await tx`UPDATE data_day SET version = version + 1 WHERE sym_id = 1 AND day = ${dayStr(9)}::date`;
    });
    const s = () => api.deps.catalog.symbol('BTCUSDT')!;
    await waitFor(
      async () =>
        (s()
          .stats.get(D + 9)
          ?.bigHist?.reduce((a, b) => a + b, 0) ?? 0) === 160_000,
    );
    const cnt = async (usdt: number) =>
      Number(
        (
          await admin<{ n: string }[]>`
            SELECT count(*)::text AS n FROM big_order
             WHERE sym_id = 1 AND ts >= ${new Date(at(9))} AND ts < ${new Date(at(10))}
               AND notional >= ${usdt * UNIT}`
        )[0]!.n,
      );
    let want: number | null = null;
    for (const u of BIG_LADDER_USDT)
      if (u > 500_000 && (await cnt(u)) <= BIGTRADES_MAX_MATCHED_ROWS) {
        want = u;
        break;
      }
    expect(want).not.toBeNull();
    const r = await get(url(at(9), at(10), 500_000));
    expect(r.res.status).toBe(422);
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    expect(r.json()).toMatchObject({
      reason: 'matched_rows_exceeded',
      rowsEstimate: 160_000,
      limit: BIGTRADES_MAX_MATCHED_ROWS,
      suggestMinUsdt: want,
    });
    // knapp unter einer Stufe: Schranke = Orders ab der Stufe darunter (ein Stufenintervall zu viel,
    // nicht mehr alles ab der 1-2-5-Stufe darunter)
    const prev = BIG_LADDER_USDT[BIG_LADDER_USDT.indexOf(want!) - 1]!;
    const near = await get(url(at(9), at(10), want! - 1));
    expect(near.res.status).toBe(422);
    expect((near.json() as { rowsEstimate: number }).rowsEstimate).toBe(await cnt(prev));
    const ok2 = await get(url(at(9), at(10), want!));
    expect(ok2.res.status).toBe(200);
    expect(ok2.decode().meta.total).toBe(await cnt(want!));
  });

  it('zu viele gelesene Zeilen → 422 mit suggestTo (Statistik im Speicher ersetzt)', async () => {
    const st = api.deps.catalog.symbol('BTCUSDT')!.stats.get(D)!;
    const orig = st.bigHist!;
    try {
      const h = new Int32Array(orig.length);
      h[0] = 7_000_000;
      h[1] = 201_000;
      st.bigHist = h;
      const s2 = await get(url(at(0), at(1), 100_000_000));
      expect(s2.res.status).toBe(422);
      const b = s2.json() as { reason: string; suggestTo: number; rowsEstimate: number };
      expect(b.reason).toBe('source_rows_exceeded');
      expect(b.rowsEstimate).toBe(7_201_000);
      // größtes 1h-ausgerichtetes to mit ≤ 5 Mio. geschätzten Zeilen: 7 201 000 · h/24 ≤ 5 Mio. → h = 16
      expect(b.suggestTo).toBe(at(0, 16));
      expect((await get(url(at(0), b.suggestTo, 100_000_000))).res.status).toBe(200);
    } finally {
      st.bigHist = orig;
    }
  });

  it('laufender Tag: no-cache, neue Minute (Version + live_until) → neuer ETag, Order sichtbar', async () => {
    const from = at(6);
    const to = at(7);
    const a = await get(url(from, to, 500_000));
    expect(a.res.headers.get('cache-control')).toBe('no-cache');
    const etag = a.res.headers.get('etag')!;
    expect(
      (await get(url(from, to, 500_000), { headers: { 'If-None-Match': etag } })).res.status,
    ).toBe(304);
    // Recorder schreibt die Minute 20:00: eine Order, live_until 20:01, Version + 1
    const qty = Math.ceil((9_000_000 * UNIT) / PX);
    const o: Order = {
      ...stored.get(6)![0]!,
      ts: at(6, 20) + 30_000,
      id: 99_000_000,
      qty,
      notional: qty * PX,
      aggN: 1,
      pl: PX,
    };
    await admin.begin(async (tx) => {
      await tx.unsafe(`INSERT INTO big_order VALUES (1, $1, $2, $2, $3, $4, $4, $5, $6, 1)`, [
        new Date(o.ts).toISOString(),
        o.id,
        o.side,
        PX,
        o.qty,
        o.notional,
      ]);
      await tx`UPDATE data_day SET version = version + 1, live_until = ${new Date(at(6, 20, 1))}
                WHERE sym_id = 1 AND day = ${dayStr(6)}::date`;
    });
    let b = await get(url(from, to, 500_000), { headers: { 'If-None-Match': etag } });
    for (let i = 0; i < 50 && b.res.status === 304; i++) {
      await sleep(50);
      b = await get(url(from, to, 500_000), { headers: { 'If-None-Match': etag } });
    }
    expect(b.res.status).toBe(200);
    expect(b.res.headers.get('etag')).not.toBe(etag);
    const d = b.decode();
    expect(d.meta.coverage).toEqual([
      ok(from, at(6, 20, 1), false),
      none(at(6, 20, 1), to, 'pending', false),
    ]);
    expect(rowsOf(d).at(-1)).toEqual(o);
  });

  it('neue gap-Minute ohne Versionswechsel (markGap) → neuer ETag', async () => {
    const p = url(at(10), at(11), 500_000);
    const a = await get(p);
    const etag = a.res.headers.get('etag')!;
    await admin`INSERT INTO data_minute_issue (sym_id, ts, kind) VALUES (1, ${new Date(at(10, 13))}, 'gap')`;
    await waitFor(
      async () => (await get(p, { headers: { 'If-None-Match': etag } })).res.status === 200,
    );
    const d = (await get(p)).decode();
    expect(d.meta.coverage.some((c) => c.reason === 'gap' && c.from === at(10, 13))).toBe(true);
  });

  it('Wechsel von immutable (Folgetag veraltet) → neuer ETag, kein Wochen-Cache', async () => {
    const p = url(at(0), at(2), 500_000);
    const a = await get(p);
    expect(a.res.headers.get('cache-control')).toBe('public, max-age=604800');
    const etag = a.res.headers.get('etag')!;
    try {
      // stale = true ändert nur immutable (die Version bleibt)
      await admin`UPDATE data_day SET stale = true WHERE sym_id = 1 AND day = ${dayStr(1)}::date`;
      await waitFor(
        async () => (await get(p, { headers: { 'If-None-Match': etag } })).res.status === 200,
      );
      const b = await get(p);
      expect(b.res.headers.get('etag')).not.toBe(etag);
      expect(b.res.headers.get('cache-control')).toBe('no-cache');
      expect(b.decode().meta.coverage).toEqual([ok(at(0), at(1), true), ok(at(1), at(2), false)]);
    } finally {
      await admin`UPDATE data_day SET stale = false WHERE sym_id = 1 AND day = ${dayStr(1)}::date`;
    }
  });

  it('mehr Lückenminuten als die Grenze: ganzer Tag none too_many_holes, keine Zeilen, kein 500', async () => {
    const r = await get(url(at(HOLEY), at(HOLEY + 1), 500_000));
    expect(r.res.status).toBe(200);
    const d = r.decode();
    expect(d.meta.coverage).toEqual([none(at(HOLEY), at(HOLEY + 1), 'too_many_holes', true)]);
    expect(stored.get(HOLEY)!.length).toBeGreaterThan(0);
    expect(d.header.n).toBe(0);
    expect(d.meta.final).toBe(false);
  });

  it('Import des Vortags (Anschluss der aggIds) ändert ETag und Aufzeichnungsbeginn', async () => {
    const p = url(at(10), at(11), 500_000);
    const a = await get(p);
    const etag = a.res.headers.get('etag')!;
    expect(a.decode().meta.coverage[0]!.reason).toBe('not_recorded');
    // Tag 9 neu importiert: letzte aggId schließt jetzt an Tag 10 an (Tag 10 selbst unverändert)
    await admin`UPDATE data_day SET last_agg_id = 10499999, version = version + 1
                 WHERE sym_id = 1 AND day = ${dayStr(9)}::date`;
    await waitFor(
      async () => (await get(p, { headers: { 'If-None-Match': etag } })).res.status === 200,
    );
    const b = (await get(p)).decode();
    expect(b.meta.coverage[0]).toEqual(ok(at(10), GAPS[0]!, false));
  });

  it('Lückenbudget: Tage ohne Order-Daten (digest_v1) verbrauchen es nicht', async () => {
    // 35 v1-Tage mit je 118 mismatch-Minuten (Σ 4 130 > BIG_HOLES_TOTAL), danach ein gültiger Tag
    await admin.unsafe(
      `INSERT INTO data_day (sym_id, day, state, version, source, edge_pending, digest, digest_version)
       SELECT 1, DATE '1970-01-01' + d, 'final_ok', 1, 'vision', false, 'x', 1
         FROM generate_series(${D + 16}, ${D + 50}) d`,
    );
    await admin.unsafe(
      `INSERT INTO data_minute_issue (sym_id, ts, kind)
       SELECT 1, to_timestamp(d::int8 * 86400 + m * 60), 'mismatch'
         FROM generate_series(${D + 16}, ${D + 50}) d, generate_series(0, 117) m`,
    );
    await admin`INSERT INTO data_day (sym_id, day, state, version, source, edge_pending, digest, digest_version,
                                      orders_n, orders_notional, big_floor_n)
                VALUES (1, ${dayStr(51)}::date, 'final_ok', 1, 'vision', false, 'x', 2, 1, 1, ${FLOOR})`;
    // 110 Minuten: mehr als der Rest des Budgets, hätten die v1-Tage es verbraucht (4 000 − 33 · 118 = 106)
    await admin.unsafe(
      `INSERT INTO data_minute_issue (sym_id, ts, kind)
       SELECT 1, $1::timestamptz + m * interval '1 minute', 'mismatch' FROM generate_series(0, 109) m`,
      [new Date(at(51, 5)).toISOString()],
    );
    await waitFor(async () => api.deps.catalog.symbol('BTCUSDT')!.days.has(D + 51));
    const d = (await get(url(at(16), at(52), 500_000, '1d'))).decode();
    expect(d.meta.coverage).toEqual([
      none(at(16), at(51), 'digest_v1', true),
      ok(at(51), at(51, 5), true),
      none(at(51, 5), at(51, 5, 110), 'mismatch', true),
      ok(at(51, 5, 110), at(52), true),
    ]);
  });
});
