// Integrationstest gegen die lokale Timescale-DB (`npm run db:up`, dann `npm run test:db`).
// Arbeitet auf einer eigenen Datenbank "<OF_DB_NAME>_test", die bei jedem Lauf neu angelegt wird;
// die Entwicklungsdatenbank bleibt unberührt.
import { parseConfig, type DbConfig } from '@orderflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../src/connection.ts';
import { dropAndCreateDatabase, migrateDown, migrateUp, MIGRATIONS_DIR } from '../src/migrate.ts';
import { loadMigrations } from '../src/migrations.ts';

const ALL_MIGRATIONS = loadMigrations(MIGRATIONS_DIR).length;

const base = parseConfig(process.env).db;
const cfg: DbConfig = { ...base, database: `${base.database}_test` };

const P1_TABLES = [
  'symbol',
  'symbol_tick_history',
  'raw_file',
  'raw_day',
  'data_day',
  'data_minute_issue',
  'verify_run',
  'fp_1m',
  'fp_1m_b10',
  'fp_5m_b10',
  'fp_15m_b100',
  'fp_1h_b10',
  'fp_1h_b100',
  'fp_1d_b100',
  'fp_1d_b1000',
  'bar_1m',
  'bar_1h',
  'bar_1d',
  'kline_1m',
  // P3 (Migration 0011)
  'ingest_status',
  'live_kline_check',
  'recorder_quality',
  // P5 (Migration 0017)
  'big_order',
];
// KONZEPT §3.9: Chunk-Intervall und Columnstore-Frist je Hypertable
// afterDays null = kein Columnstore (Jahres-Chunk-Tabellen, Migration 0006 / Review N5).
// Policy-Frist 4 Tage seit Migration 0016 (Marge offener Chunks of_hot_margin() = 3 Tage + 1).
const HYPERTABLES: Record<string, { chunkDays: number; afterDays: number | null }> = {
  fp_1m: { chunkDays: 1, afterDays: 4 },
  fp_1m_b10: { chunkDays: 7, afterDays: 4 },
  fp_5m_b10: { chunkDays: 7, afterDays: 4 },
  fp_15m_b100: { chunkDays: 30, afterDays: 4 },
  fp_1h_b10: { chunkDays: 30, afterDays: 4 },
  fp_1h_b100: { chunkDays: 30, afterDays: 4 },
  bar_1m: { chunkDays: 30, afterDays: 4 },
  kline_1m: { chunkDays: 30, afterDays: 4 },
  big_order: { chunkDays: 30, afterDays: 4 },
  fp_1d_b100: { chunkDays: 365, afterDays: null },
  fp_1d_b1000: { chunkDays: 365, afterDays: null },
  bar_1h: { chunkDays: 365, afterDays: null },
  bar_1d: { chunkDays: 365, afterDays: null },
};

let sql: Sql;

beforeAll(async () => {
  await dropAndCreateDatabase(cfg);
  sql = connect(cfg);
});
afterAll(async () => {
  await sql?.end();
});

describe('Timescale-Lizenz', () => {
  it('Community-Funktionen verfügbar', async () => {
    await migrateUp(sql);
    const [lic] = await sql`SHOW timescaledb.license`;
    expect(lic?.['timescaledb.license']).toBe('timescale');
    const [ext] = await sql`SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`;
    expect(ext?.extversion).toBeTruthy();
  });
});

describe('Migrationen', () => {
  it('erneutes Anwenden ist ein No-op', async () => {
    expect(await migrateUp(sql)).toEqual([]);
  });

  it('legt genau die P1-Tabellen an', async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'`;
    expect(rows.map((r) => r.table_name as string).sort()).toEqual([...P1_TABLES].sort());
  });

  it('Hypertables: Chunk-Intervall, Columnstore aktiv, Policy-Frist, segmentby/orderby', async () => {
    const dims = await sql`
      SELECT hypertable_name AS t, extract(epoch FROM time_interval) / 86400 AS days
        FROM timescaledb_information.dimensions WHERE hypertable_schema = 'public'`;
    const policies = await sql`
      SELECT hypertable_name AS t, config->>'compress_after' AS after
        FROM timescaledb_information.jobs
       WHERE proc_name IN ('policy_compression', 'policy_columnstore') AND hypertable_schema = 'public'`;
    // Spaltennamen der Info-Sicht variieren je Version; daher als JSON prüfen.
    const settings = await sql`
      SELECT to_jsonb(s) AS j FROM timescaledb_information.hypertable_columnstore_settings s`;
    const hts = await sql`
      SELECT hypertable_name AS t, compression_enabled AS enabled FROM timescaledb_information.hypertables`;
    expect(dims.map((d) => d.t as string).sort()).toEqual(Object.keys(HYPERTABLES).sort());
    for (const [t, want] of Object.entries(HYPERTABLES)) {
      expect(Number(dims.find((d) => d.t === t)?.days), `${t} chunk`).toBe(want.chunkDays);
      const p = policies.find((x) => x.t === t);
      const s = settings.find((x) => String(x.j.hypertable).endsWith(t));
      const ht = hts.find((x) => x.t === t);
      if (want.afterDays === null) {
        expect(p, `${t} ohne policy`).toBeUndefined();
        expect(ht?.enabled, `${t} ohne columnstore`).toBe(false);
        continue;
      }
      expect(ht?.enabled, `${t} columnstore`).toBe(true);
      expect(p, `${t} policy`).toBeDefined();
      expect(String(p?.after), `${t} after`).toMatch(
        new RegExp(`^(${want.afterDays} days|${want.afterDays * 24}:)`),
      );
      expect(s, `${t} columnstore settings`).toBeDefined();
      expect(JSON.stringify(s?.j), `${t} segmentby`).toContain('sym_id');
    }
  });

  it('day_digest ist deterministisch und lehnt unbekannte Tabellen ab', async () => {
    await sql`INSERT INTO fp_1m VALUES (1, '2026-11-01 00:00:00+00', 6900000, 5, 3, 2, 1)`;
    await sql`INSERT INTO fp_1m VALUES (1, '2026-11-01 00:01:00+00', 6900010, 1, 0, 1, 0)`;
    const [a] = await sql`SELECT day_digest('fp_1m', 1::smallint, '2026-11-01') AS d`;
    await sql`SET timezone = 'Asia/Tokyo'`;
    const [b] = await sql`SELECT day_digest('fp_1m', 1::smallint, '2026-11-01') AS d`;
    await sql`RESET timezone`;
    expect(a?.d).toMatch(/^[0-9a-f]{64}$/);
    expect(b?.d).toBe(a?.d);
    const [empty] = await sql`SELECT day_digest('fp_1m', 1::smallint, '2026-11-02') AS d`;
    expect(empty?.d).not.toBe(a?.d);
    await expect(sql`SELECT day_digest('pg_class', 1::smallint, '2026-11-01')`).rejects.toThrow(
      /unbekannte Tabelle/,
    );
    await sql`DELETE FROM fp_1m`;
  });

  it('Columnstore: ein Chunk lässt sich komprimieren und wieder entpacken', async () => {
    await sql`INSERT INTO fp_1m VALUES (1, '2026-10-01 00:00:00+00', 6900000, 5, 3, 2, 1)`;
    // nur der Chunk dieses Tages (leere Chunks früherer Tests bleiben nach DELETE bestehen)
    const chunks = await sql`
      SELECT show_chunks('fp_1m', newer_than => '2026-10-01'::timestamptz,
                                  older_than => '2026-10-02'::timestamptz) AS c`;
    expect(chunks).toHaveLength(1);
    const c = chunks[0]!.c as string;
    // aktuelle API (seit 2.18): convert_to_columnstore / convert_to_rowstore statt compress_/decompress_chunk
    await sql.unsafe(`CALL convert_to_columnstore('${c}'::regclass)`);
    const [cs] = await sql`
      SELECT is_compressed FROM timescaledb_information.chunks
       WHERE hypertable_name = 'fp_1m' AND format('%I.%I', chunk_schema, chunk_name)::regclass = ${c}::regclass`;
    expect(cs?.is_compressed).toBe(true);
    await sql.unsafe(`CALL convert_to_rowstore('${c}'::regclass)`);
    await sql`DELETE FROM fp_1m`;
  });

  it('0017 auf bestehenden Daten: alte Digests werden Version 1, Untergrenzen aus den Einheiten, down entfernt alles', async () => {
    const all = loadMigrations(MIGRATIONS_DIR);
    const i17 = all.findIndex((m) => m.version === '0017');
    expect(await migrateDown(sql, all.length - i17)).toEqual(['0017_big_order']);
    await sql`INSERT INTO symbol (sym_id, name, price_unit, price_decimals, tick_ref_units, qty_unit, qty_decimals, data_from)
              VALUES (1, 'BTCUSDT', 0.01, 2, 10, 0.001, 3, '2025-01-01'),
                     (2, 'ETHUSDT', 0.001, 3, 10, 0.001, 3, '2025-01-01')`;
    await sql`INSERT INTO data_day (sym_id, day, state, digest) VALUES
                (1, '2026-09-01', 'final_ok', 'alt'), (1, '2026-09-02', 'provisional', NULL)`;
    // ein offener Leser auf data_day: die Migration wartet höchstens 5 s und bricht dann ab (S4)
    const reader = connect(cfg);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const tx = reader.begin(async (t) => {
      await t`SELECT count(*) FROM data_day`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await expect(migrateUp(sql)).rejects.toThrow(/lock timeout/);
    expect(Date.now() - t0).toBeLessThan(15_000);
    release();
    await tx;
    await reader.end();
    await migrateUp(sql);
    const days =
      await sql`SELECT day::text AS day, digest_version, orders_n FROM data_day ORDER BY day`;
    expect(days.map((d) => [d.day, d.digest_version, d.orders_n])).toEqual([
      ['2026-09-01', 1, null],
      ['2026-09-02', null, null],
    ]);
    const floors = await sql`SELECT name, big_floor_n::text AS f FROM symbol ORDER BY sym_id`;
    expect(floors.map((r) => [r.name, r.f])).toEqual([
      ['BTCUSDT', '50000000000'], // 500 000 USDT / (0,01 · 0,001)
      ['ETHUSDT', '250000000000'], // 250 000 USDT / (0,001 · 0,001)
    ]);
    // Digest und Version nur gemeinsam
    await expect(
      sql`UPDATE data_day SET digest_version = NULL WHERE day = '2026-09-01'`,
    ).rejects.toThrow(/data_day_digest_version/);
    await expect(sql`UPDATE data_day SET digest = 'neu' WHERE day = '2026-09-02'`).rejects.toThrow(
      /data_day_digest_version/,
    );
    // v1 = Fassung 0005 (zwölf Teile), v2 = zusätzlich big_order und order_day; unbekannte Version
    const [v] = await sql`
      SELECT day_digest_all_v(1::smallint, '2026-09-01', 1) AS v1,
             day_digest_all_v(1::smallint, '2026-09-01', 2) AS v2,
             day_digest_all(1::smallint, '2026-09-01') AS cur`;
    expect(v!.cur).toBe(v!.v2);
    expect(v!.v1).not.toBe(v!.v2);
    await expect(sql`SELECT day_digest_all_v(1::smallint, '2026-09-01', 3)`).rejects.toThrow(
      /unbekannte Digest-Version/,
    );
    // order_day liest die Zeile aus data_day (NULL-Felder leer), ohne Zeile = leerer Digest
    await sql`UPDATE data_day SET orders_n = 5, orders_notional = 123 WHERE day = '2026-09-02'`;
    const [od] = await sql`
      SELECT day_digest('order_day', 1::smallint, '2026-09-02') AS a,
             encode(sha256(convert_to('(1,2026-09-02,5,123,)', 'UTF8')), 'hex') AS want,
             day_digest('order_day', 1::smallint, '2026-08-31') AS none,
             encode(sha256(''::bytea), 'hex') AS empty`;
    expect(od!.a).toBe(od!.want);
    expect(od!.none).toBe(od!.empty);
    // big_order: Prüfbedingungen der Order-Regel
    await expect(
      sql`INSERT INTO big_order VALUES (1, '2026-09-02 00:00:00.5+00', 10, 12, 1, 100, 100, 3, 300, 2)`,
    ).rejects.toThrow(/check/i);
    await sql`INSERT INTO big_order VALUES (1, '2026-09-02 00:00:00.5+00', 10, 12, 1, 100, 100, 3, 300, 3)`;
    const [bo] = await sql`
      SELECT day_digest('big_order', 1::smallint, '2026-09-02') AS a,
             encode(sha256(convert_to('(1,"2026-09-02 00:00:00.5+00",10,12,1,100,100,3,300,3)', 'UTF8')), 'hex') AS want`;
    expect(bo!.a).toBe(bo!.want);
    // of_recompress_chunk kennt big_order (lehnt den offenen Chunk wegen der Marge ab, nicht als fremd)
    const [ch] = await sql`
      SELECT format('%I.%I', chunk_schema, chunk_name) AS c FROM timescaledb_information.chunks
       WHERE hypertable_name = 'big_order'`;
    const r = await sql`SELECT of_chunk_is_hot(${ch!.c as string}::regclass) AS hot`;
    if (r[0]!.hot) {
      await expect(sql`SELECT of_recompress_chunk(${ch!.c as string}::regclass)`).rejects.toThrow(
        /offen/,
      );
    } else {
      await sql`SELECT of_recompress_chunk(${ch!.c as string}::regclass)`;
    }
    expect(await migrateDown(sql, 1)).toEqual(['0017_big_order']);
    const [gone] = await sql`
      SELECT to_regclass('big_order') AS t,
             (SELECT count(*)::int FROM information_schema.columns
               WHERE table_name = 'data_day' AND column_name IN ('orders_n', 'digest_version')) AS cols,
             (SELECT count(*)::int FROM symbol WHERE big_floor_n IS NOT NULL) AS floors`;
    expect(gone).toEqual({ t: null, cols: 0, floors: 0 });
    await sql`DELETE FROM data_day`;
    await sql`DELETE FROM symbol`;
    await migrateUp(sql);
  });

  it('Rollback aller Migrationen und erneutes Anwenden funktionieren', async () => {
    const rolled = await migrateDown(sql, 'all');
    expect(rolled).toHaveLength(ALL_MIGRATIONS);
    const left = await sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`;
    expect(left).toHaveLength(0);
    expect(await migrateUp(sql)).toHaveLength(ALL_MIGRATIONS);
  });
});
