// Integrationstest des Postgres-Schreibers (KONZEPT §4.3, §4.8) gegen die lokale Timescale-DB:
// `npm run db:up && npm run test:db`. Arbeitet auf "<OF_DB_NAME>_test" (wird neu angelegt).
// STAND: geschrieben ohne verfügbare Datenbank (kein Docker bei der Implementierung) – noch nie gelaufen.
//
// Prüft: Import eines synthetischen Tages → data_day final_ok, version 1, Digest = day_digest_all
// (TS-Textform = Postgres-Zeilentextform); Re-Import → version 2, identischer Digest (K8);
// Zeilenzahlen = Dry-Run; Auflösung der Randminute eines vorher importierten Nachbartags;
// Single-Writer-Lock.
import { getSymbol, parseConfig, parseDay, type DbConfig } from '@orderflow/core';
import { connect, dropAndCreateDatabase, migrateUp, type Sql } from '@orderflow/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Importer } from '../src/pipeline.ts';
import { DryRunWriter } from '../src/writer/dryrun.ts';
import { PostgresWriter } from '../src/writer/postgres.ts';
import type { DayWriter } from '../src/writer/types.ts';
import { archive } from './synth.ts';

const base = parseConfig(process.env).db;
const cfg: DbConfig = { ...base, database: `${base.database}_test` };
const BTC = getSymbol('BTCUSDT');
let sql: Sql;
let dataDir: string;

async function run(writer: DayWriter, from: string, to: string, neighbours = true) {
  await writer.open();
  try {
    return await new Importer({
      dataDir,
      spec: BTC,
      firstDay: parseDay(from),
      lastDay: parseDay(to),
      prefer: 'monthly',
      neighbours,
      writer,
      importerVersion: 'int-test',
      sidecar: false,
      log: () => {},
    }).run();
  } finally {
    await writer.close();
  }
}

beforeAll(async () => {
  await dropAndCreateDatabase(cfg);
  sql = connect(cfg);
  await migrateUp(sql);
  dataDir = archive();
});
afterAll(async () => {
  await sql?.end();
});

describe('PostgresWriter', () => {
  it('schreibt einen Tag atomar; DB-Digest = Importer-Digest; Zeilen = Dry-Run', async () => {
    const [s] = await run(new PostgresWriter(cfg, BTC), '2026-09-10', '2026-09-10');
    const [dry] = await run(new DryRunWriter(), '2026-09-10', '2026-09-10');
    expect(s!.dbDigest).toBe(s!.digest);
    expect(s!.digest).toBe(dry!.digest);
    const [dd] = await sql`SELECT * FROM data_day WHERE sym_id = 1 AND day = '2026-09-10'`;
    expect(dd).toMatchObject({
      state: 'final_ok',
      version: 1,
      source: 'vision',
      digest: s!.digest,
      edge_pending: false,
    });
    const [{ n }] =
      (await sql`SELECT count(*)::int AS n FROM fp_1m WHERE ts >= '2026-09-10' AND ts < '2026-09-11'`) as unknown as [
        { n: number },
      ];
    expect(n).toBe(s!.fpRows.fp_1m);
    const [{ d }] =
      (await sql`SELECT day_digest_all(1::smallint, '2026-09-10'::date) AS d`) as unknown as [
        { d: string },
      ];
    expect(d).toBe(s!.digest);
    const issues =
      await sql`SELECT kind FROM data_minute_issue WHERE ts >= '2026-09-10' AND ts < '2026-09-11'`;
    expect(issues.every((r) => r.kind === 'shift')).toBe(true);
    expect(issues).toHaveLength(s!.counts.shift);
    const raw = await sql`SELECT kind, origin FROM raw_day WHERE day = '2026-09-10' ORDER BY kind`;
    expect(raw.map((r) => `${r.kind}/${r.origin}`)).toEqual(['aggTrades/monthly', 'klines/daily']);
  });

  it('Re-Import: version + 1, identischer Digest (K8); Resume überspringt', async () => {
    const before = await sql`SELECT digest FROM data_day WHERE day = '2026-09-10'`;
    await sql`UPDATE data_day SET importer_version = 'alt' WHERE day = '2026-09-10'`;
    await run(new PostgresWriter(cfg, BTC), '2026-09-10', '2026-09-10');
    const [dd] = await sql`SELECT version, digest FROM data_day WHERE day = '2026-09-10'`;
    expect(dd).toMatchObject({ version: 2, digest: before[0]!.digest });
    const [again] = await run(new PostgresWriter(cfg, BTC), '2026-09-10', '2026-09-10');
    expect(again!.skipped).toBe(true);
  });

  it('Randminute eines früher importierten Tages wird beim Import des Nachbartags aufgelöst', async () => {
    await run(new PostgresWriter(cfg, BTC), '2026-09-20', '2026-09-20', false);
    const [p] = await sql`SELECT edge_pending, min_shift FROM data_day WHERE day = '2026-09-20'`;
    expect(p!.edge_pending).toBe(true);
    await run(new PostgresWriter(cfg, BTC), '2026-09-21', '2026-09-21');
    const [r] = await sql`SELECT edge_pending, state FROM data_day WHERE day = '2026-09-20'`;
    // Minute 0 von 09-20 bleibt offen (09-19 nicht importiert und ohne Nachbarlauf), 1439 ist aufgelöst
    const [b] = await sql`SELECT check_state FROM bar_1m WHERE ts = '2026-09-20 23:59:00+00'`;
    expect(b!.check_state).toBe(2);
    expect(r!.state).toBe('final_ok');
  });

  it('Single Writer: ein zweiter Importer bekommt den Lock nicht', async () => {
    const a = new PostgresWriter(cfg, BTC);
    await a.open();
    try {
      await expect(new PostgresWriter(cfg, BTC).open()).rejects.toThrow(/Lock/);
    } finally {
      await a.close();
    }
  });
});
