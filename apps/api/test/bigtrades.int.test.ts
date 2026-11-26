// Integrationstests von GET /api/v1/bigtrades gegen "<OF_DB_NAME>_test_api_bt" (eigene Testdatenbank,
// Rolle als Spiegel von of_api), mit synthetischen big_order-Zeilen im Columnstore. Beweist:
//  - of_api genügt (Lesen von big_order und data_day-Orderfeldern über die API);
//  - Zeilen exakt = big_order ≥ Schwelle, nur in Tagen mit Order-Daten; Abdeckung je Tag mit Grund
//    (digest_v1, no_day, no_floor, unknown_totals, partial bei höherer Untergrenze) – Zeilen eines Tages
//    ohne Order-Daten werden nie ausgeliefert;
//  - Schwelle unter der Untergrenze → 422 mit minUsdt; Symbol ohne Untergrenze → 422;
//  - final/Cache-Control/ETag/304 für finale und laufende Bereiche, neue Version → neuer ETag;
//  - Ausdünnung je (Bar, Seite) auf die k größten = Referenzrechnung; 422 mit Vorschlag bei zu vielen
//    Treffern bzw. gelesenen Zeilen; Stufenstatistik des Katalogs exakt.
import {
  decodeBigTrades,
  parseConfig,
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
const D = 20_700; // 2026-09-04; alle Tage in einem 30-Tage-Chunk [20 700, 20 730)
const UNIT = 100_000; // BTC: price_unit · qty_unit = 10^-5 USDT
const FLOOR = 500_000 * UNIT;
const PX = 9_000_000; // 90 000 USDT
/** Tage: Zustand und Orderfelder (Migration 0017). */
const DAYS: {
  off: number;
  state: string;
  dv: 1 | 2 | null;
  ordersN: number | null;
  floor: number | null;
}[] = [
  { off: 0, state: 'final_ok', dv: 2, ordersN: 1000, floor: FLOOR },
  { off: 1, state: 'final_ok', dv: 2, ordersN: 1000, floor: FLOOR },
  { off: 2, state: 'final_ok', dv: 1, ordersN: null, floor: null }, // vor 0017 geschrieben
  { off: 3, state: 'final_bad', dv: 2, ordersN: 1000, floor: 2 * FLOOR }, // höhere Untergrenze
  // off 4: keine Zeile
  { off: 5, state: 'final_ok', dv: 2, ordersN: 1000, floor: null }, // ohne Untergrenze geschrieben
  { off: 6, state: 'provisional', dv: null, ordersN: 1000, floor: FLOOR }, // Live, vollständig
  { off: 7, state: 'provisional', dv: null, ordersN: null, floor: null }, // Live, unbekannt
  { off: 8, state: 'final_ok', dv: 2, ordersN: 1000, floor: FLOOR }, // schwer: Ausdünnung
];
const HEAVY = 25_000;

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
function dayOrders(off: number, n: number, floor: number, id0: number): Order[] {
  const out: Order[] = [];
  for (let i = 0; i < n; i++) {
    const usdt = 500_000 + ((i * 7919 + off * 104_729) % 9_500_000);
    const qty = Math.floor((usdt * UNIT) / PX) + 1;
    const aggN = 1 + (i % 4);
    const o = {
      // zwei Orders je 5. Zeitpunkt mit gleichem ts (Reihenfolge nach first_agg_id)
      ts: (D + off) * DAY + Math.floor((i * DAY) / n) - (i % 5 === 1 ? Math.floor(DAY / n) : 0),
      id: id0 + i * 10,
      side: 1 + ((i * 31) % 2),
      pf: PX,
      pl: PX + (aggN - 1) * 10,
      qty,
      notional: qty * PX,
      aggN,
    };
    if (o.notional >= floor) out.push(o);
  }
  return out;
}

let admin: Sql;
let api: RunningApi;
/** Alle gespeicherten Orders je Tagesoffset (auch die der Tage ohne Order-Daten). */
const stored = new Map<number, Order[]>();

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

/** Erwartete Zeilen: gespeicherte Orders ≥ minN in den Tagesoffsets `offs`, nach (ts, id). */
function expected(offs: number[], from: number, to: number, minN: number): Order[] {
  return offs
    .flatMap((o) => stored.get(o) ?? [])
    .filter((o) => o.ts >= from && o.ts < to && o.notional >= minN)
    .sort((a, b) => a.ts - b.ts || a.id - b.id);
}

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

async function insertOrders(orders: Order[]): Promise<void> {
  for (let i = 0; i < orders.length; i += 5000) {
    const part = orders.slice(i, i + 5000).map((o) => ({
      sym_id: 1,
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

beforeAll(async () => {
  await dropAndCreateDatabase(adminCfg);
  admin = connect(adminCfg);
  await migrateUp(admin);
  await mirrorApiRole(admin, TEST_ROLE, apiPassword);
  await admin`INSERT INTO symbol (sym_id, name, price_unit, price_decimals, tick_ref_units, qty_unit,
                                  qty_decimals, data_from, big_floor_n)
              VALUES (1, 'BTCUSDT', 0.01, 2, 10, 0.001, 3, '2026-01-01', ${FLOOR}),
                     (2, 'ETHUSDT', 0.001, 3, 10, 0.001, 3, '2026-01-01', NULL)`;
  for (const d of DAYS) {
    const day = new Date((D + d.off) * DAY).toISOString().slice(0, 10);
    await admin`INSERT INTO data_day (sym_id, day, state, version, source, edge_pending, edge_first_pending,
                                      edge_last_pending, digest, digest_version, orders_n, orders_notional,
                                      big_floor_n)
                VALUES (1, ${day}::date, ${d.state}, 3, 'vision', false, false, false,
                        ${d.dv === null ? null : 'x'}, ${d.dv}, ${d.ordersN},
                        ${d.ordersN === null ? null : '123'}::bigint, ${d.floor})`;
    // Auch Tage ohne Order-Daten bekommen Zeilen (v1-Reste, unvollständiger Live-Tag): sie dürfen nie
    // ausgeliefert werden. Tag 5 (ohne Untergrenze) hat wie im Betrieb keine.
    if (d.off === 5) continue;
    const orders = dayOrders(
      d.off,
      d.off === 8 ? HEAVY : 300,
      d.floor ?? FLOOR,
      1_000_000 * (d.off + 1),
    );
    stored.set(d.off, orders);
    await insertOrders(orders);
  }
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

describe('/bigtrades', () => {
  it('of_api darf big_order lesen, nicht schreiben; Columnstore', async () => {
    const [r] = await admin<{ s: boolean; i: boolean; c: boolean }[]>`
      SELECT has_table_privilege('of_api', 'big_order', 'SELECT') AS s,
             has_table_privilege('of_api', 'big_order', 'INSERT') AS i,
             bool_and(is_compressed) AS c FROM timescaledb_information.chunks
       WHERE hypertable_name = 'big_order'`;
    expect(r).toEqual({ s: true, i: false, c: true });
  });

  it('/symbols: Untergrenze je Symbol und Grenzen', async () => {
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
    expect(by.get('ETHUSDT')).toBeNull();
  });

  it('finaler Bereich: exakte Zeilen, final, Cache-Control eine Woche, ETag/304', async () => {
    const from = D * DAY;
    const to = (D + 2) * DAY;
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
    expect(d.meta.coverage).toEqual([
      { from, to, status: 'ok', reason: null, floorN: FLOOR, final: true },
    ]);
    const want = expected([0, 1], from, to, FLOOR);
    expect(want.length).toBeGreaterThan(500);
    expect(rowsOf(d)).toEqual(want);
    expect(d.meta.total).toBe(want.length);
    // bar = Beginn der 1h-Bar; VWAP = notional / qty liegt zwischen px_first und px_last
    for (let i = 0; i < d.header.n; i++) {
      expect(d.rows.bar[i]! * 1000).toBe(Math.floor(d.rows.ts[i]! / HOUR) * HOUR);
      const vwap = d.rows.notional[i]! / d.rows.qty[i]!;
      expect(vwap).toBeGreaterThanOrEqual(Math.min(d.rows.pxFirst[i]!, d.rows.pxLast[i]!));
    }
    const etag = r.res.headers.get('etag')!;
    expect(etag).toBe(`"${d.meta.dataVersion}"`);
    const again = await get(url(from, to, 500_000), { headers: { 'If-None-Match': etag } });
    expect(again.res.status).toBe(304);
    expect(again.res.headers.get('cache-control')).toBe('public, max-age=604800');
    // höhere Schwelle: Teilmenge, eigene Version
    const hi = (await get(url(from, to, 5_000_000))).decode();
    expect(rowsOf(hi)).toEqual(expected([0, 1], from, to, 5_000_000 * UNIT));
    expect(hi.meta.dataVersion).not.toBe(d.meta.dataVersion);
  });

  it('Abdeckung: Tage ohne Order-Daten als none mit Grund, nie als leer; partial bei höherer Untergrenze', async () => {
    const from = D * DAY;
    const to = (D + 8) * DAY;
    const r = await get(url(from, to, 500_000, '1d'));
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get('cache-control')).toBe('no-cache');
    const d = r.decode();
    const at = (o: number) => (D + o) * DAY;
    expect(d.meta.coverage).toEqual([
      { from: at(0), to: at(2), status: 'ok', reason: null, floorN: FLOOR, final: true },
      { from: at(2), to: at(3), status: 'none', reason: 'digest_v1', floorN: null, final: true },
      {
        from: at(3),
        to: at(4),
        status: 'partial',
        reason: 'floor_above',
        floorN: 2 * FLOOR,
        final: true,
      },
      { from: at(4), to: at(5), status: 'none', reason: 'no_day', floorN: null, final: false },
      { from: at(5), to: at(6), status: 'none', reason: 'no_floor', floorN: null, final: true },
      { from: at(6), to: at(7), status: 'ok', reason: null, floorN: FLOOR, final: false },
      {
        from: at(7),
        to: at(8),
        status: 'none',
        reason: 'unknown_totals',
        floorN: null,
        final: false,
      },
    ]);
    expect(d.meta.final).toBe(false);
    // gespeicherte Zeilen der Tage 2 (v1) und 7 (Live, unbekannt) werden nicht ausgeliefert
    expect(stored.get(2)!.length).toBeGreaterThan(0);
    expect(stored.get(7)!.length).toBeGreaterThan(0);
    expect(rowsOf(d)).toEqual(expected([0, 1, 3, 6], from, to, FLOOR));
    expect(d.rows.ts.some((t) => t >= at(2) && t < at(3))).toBe(false);
    expect(d.rows.ts.some((t) => t >= at(7) && t < at(8))).toBe(false);
    // Schwelle ≥ Untergrenze von Tag 3: dort ok
    const d3 = (await get(url(at(3), at(4), 1_000_000, '1d'))).decode();
    expect(d3.meta.coverage).toEqual([
      { from: at(3), to: at(4), status: 'ok', reason: null, floorN: 2 * FLOOR, final: true },
    ]);
    expect(d3.meta.final).toBe(true);
    // nur ein Tag ohne Order-Daten: unveränderlich, aber nicht final (Neuimport ausstehend)
    const v1 = await get(url(at(2), at(3), 500_000, '1d'));
    expect(v1.res.headers.get('cache-control')).toBe('no-cache');
    expect(v1.decode().header.n).toBe(0);
  });

  it('Schwelle unter der Untergrenze → 422 mit minUsdt; Symbol ohne Untergrenze → 422', async () => {
    const r = await get(url(D * DAY, (D + 1) * DAY, 499_999));
    expect(r.res.status).toBe(422);
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    expect(r.json()).toMatchObject({ reason: 'below_floor', minUsdt: 500_000, floorN: FLOOR });
    const e = await get(url(D * DAY, (D + 1) * DAY, 500_000, '1h', 'ETHUSDT'));
    expect(e.res.status).toBe(422);
    expect(e.json()).toMatchObject({ reason: 'not_available' });
  });

  it('Parameter: Ausrichtung, Bar-Grenze, unbekannt/fehlend → 400, Symbol → 404', async () => {
    const f = D * DAY;
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
    const from = (D + 8) * DAY;
    const to = (D + 9) * DAY;
    const all = expected([8], from, to, FLOOR);
    expect(all.length).toBeGreaterThan(BIGTRADES_MAX_ROWS);
    const d = (await get(url(from, to, 500_000, '15m'))).decode();
    // Referenz: Rang je (15m-Bar, Seite) nach notional absteigend, dann ts, id
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
    // hohe Schwelle: keine Ausdünnung
    const hi = (await get(url(from, to, 8_000_000, '15m'))).decode();
    expect(hi.meta.k).toBeNull();
    expect(rowsOf(hi)).toEqual(expected([8], from, to, 8_000_000 * UNIT));
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

  it('zu viele Treffer → 422 mit suggestMinUsdt; zu viele gelesene Zeilen → 422 mit suggestTo', async () => {
    const s = api.deps.catalog.symbol('BTCUSDT')!;
    const st = s.stats.get(D)!;
    const orig = st.bigHist!;
    try {
      // 200 000 Orders 500 000 … 1 Mio. USDT, 1 000 darüber (die Statistik ändert sich nur mit der
      // Tagesversion; hier im Speicher ersetzt)
      const h = new Int32Array(orig.length);
      h[3] = 200_000;
      h[4] = 1_000;
      st.bigHist = h;
      const r = await get(url(D * DAY, (D + 1) * DAY, 500_000));
      expect(r.res.status).toBe(422);
      expect(r.res.headers.get('cache-control')).toBe('no-store');
      expect(r.json()).toMatchObject({
        reason: 'matched_rows_exceeded',
        rowsEstimate: 201_000,
        limit: BIGTRADES_MAX_MATCHED_ROWS,
        suggestMinUsdt: 1_000_000,
      });
      expect((await get(url(D * DAY, (D + 1) * DAY, 1_000_000))).res.status).toBe(200);
      // gelesene Zeilen unabhängig von der Schwelle: 7,2 Mio. am Tag
      h[0] = 7_000_000;
      const s2 = await get(url(D * DAY, (D + 1) * DAY, 100_000_000));
      expect(s2.res.status).toBe(422);
      const b = s2.json() as { reason: string; suggestTo: number; rowsEstimate: number };
      expect(b.reason).toBe('source_rows_exceeded');
      expect(b.rowsEstimate).toBe(7_201_000);
      // größtes 1h-ausgerichtetes to mit ≤ 5 Mio. geschätzten Zeilen: 7 201 000 · h/24 ≤ 5 Mio. → h = 16
      expect(b.suggestTo).toBe(D * DAY + 16 * HOUR);
      expect((await get(url(D * DAY, b.suggestTo, 100_000_000))).res.status).toBe(200);
    } finally {
      st.bigHist = orig;
    }
  });

  it('laufender Tag: no-cache, neue Tagesversion → neuer ETag', async () => {
    const from = (D + 6) * DAY;
    const to = (D + 7) * DAY;
    const a = await get(url(from, to, 500_000));
    expect(a.res.headers.get('cache-control')).toBe('no-cache');
    const etag = a.res.headers.get('etag')!;
    expect(
      (await get(url(from, to, 500_000), { headers: { 'If-None-Match': etag } })).res.status,
    ).toBe(304);
    // Recorder schreibt eine Minute: Version + 1, eine neue Order
    const qty = Math.ceil((9_000_000 * UNIT) / PX);
    const o: Order = { ...stored.get(6)![0]!, ts: to - 1, id: 99_000_000, qty, notional: qty * PX };
    await admin.begin(async (tx) => {
      await tx.unsafe(`INSERT INTO big_order VALUES (1, $1, $2, $2, $3, $4, $4, $5, $6, 1)`, [
        new Date(o.ts).toISOString(),
        o.id,
        o.side,
        PX,
        o.qty,
        o.notional,
      ]);
      await tx`UPDATE data_day SET version = version + 1 WHERE sym_id = 1 AND day = ${new Date(from).toISOString().slice(0, 10)}::date`;
    });
    let b = await get(url(from, to, 500_000), { headers: { 'If-None-Match': etag } });
    for (let i = 0; i < 50 && b.res.status === 304; i++) {
      await sleep(50);
      b = await get(url(from, to, 500_000), { headers: { 'If-None-Match': etag } });
    }
    expect(b.res.status).toBe(200);
    expect(b.res.headers.get('etag')).not.toBe(etag);
    const d = b.decode();
    expect(rowsOf(d).at(-1)).toEqual({ ...o, aggN: 1, pl: PX });
  });
});
