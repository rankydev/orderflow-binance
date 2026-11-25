// DB-Integration des Recorders auf "<OF_DB_NAME>_test" (`npm run test:db`): Live-Schreiben eines
// synthetischen Tages über den echten Recorder-Pfad, Sichtbarkeit für Leser (provisional, nie
// immutable, version steigt, jede Minute vollständig), Finalisierung durch den Import mit
// Qualitätsvergleich und identischen Digests, Zusammenspiel der Locks von Recorder und Importer.
import { getSymbol, parseConfig, parseDay, type DbConfig } from '@orderflow/core';
import { connect, dropAndCreateDatabase, migrateUp, type Sql } from '@orderflow/db';
import { DryRunWriter, Importer, PostgresWriter } from '@orderflow/importer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive } from '../../importer/test/synth.ts';
import { finaliseDay } from '../src/finalize.ts';
import { LiveWriter } from '../src/livewriter.ts';
import { replayDay } from '../src/replay.ts';

const base = parseConfig(process.env).db;
const cfg: DbConfig = { ...base, database: `${base.database}_test_recorder` }; // eigene DB: andere Agenten nutzen _test parallel
const BTC = getSymbol('BTCUSDT');
let sql: Sql;
let dir: string;
const DAY = parseDay('2026-09-10');

beforeAll(async () => {
  await dropAndCreateDatabase(cfg);
  sql = connect(cfg);
  await migrateUp(sql);
  dir = archive({ dailyDays: ['2026-09-10'] });
});
afterAll(async () => {
  await sql?.end();
});

describe('Recorder ↔ Datenbank', () => {
  it('Live-Tag über den Recorder-Pfad = Import (minutenweise und je Tabelle); provisional, nie immutable', async () => {
    const r = await replayDay({
      dataDir: dir,
      symbol: 'BTCUSDT',
      day: DAY,
      db: cfg,
      log: () => {},
    });
    expect(r.equal).toBe(true);
    expect(r.db).toMatchObject({ identical: 1440, differing: 0, missing: 0, extra: 0 });
    const [d] = await sql`
      SELECT state, immutable, source, version, live_minutes, live_until FROM data_day
       WHERE sym_id = 1 AND day = '2026-09-10'`;
    expect(d).toMatchObject({
      state: 'provisional',
      immutable: false,
      source: 'live', // kleiner synthetischer Tag: keine eingebauten Lücken
      live_minutes: 1440,
    });
    expect(d!.version).toBeGreaterThanOrEqual(1440);
    // jede Minute vollständig: Footprint-Summen = Bar je Minute, check_state ungeprüft
    const bad = await sql`
      SELECT b.ts FROM bar_1m b
        JOIN (SELECT ts, sum(buy_q) bq, sum(sell_q) sq FROM fp_1m WHERE sym_id = 1 GROUP BY ts) f USING (ts)
       WHERE b.sym_id = 1 AND (b.buy_q <> f.bq OR b.sell_q <> f.sq OR b.check_state <> 0)`;
    expect(bad).toHaveLength(0);
  });

  it('Finalisierung ersetzt den provisorischen Tag: Qualität 1440/1440, Digest = Import, immutable', async () => {
    const res = await finaliseDay({ dataDir: dir, cfg, spec: BTC, day: DAY, sql, log: () => {} });
    expect(res).toMatchObject({
      quality: { identical: 1440, officialMinutes: 1440, differing: 0 },
    });
    const [q] =
      await sql`SELECT identical_minutes, tables_equal FROM recorder_quality WHERE day = '2026-09-10'`;
    expect(q!.identical_minutes).toBe(1440);
    expect(Object.values(q!.tables_equal as Record<string, boolean>).every(Boolean)).toBe(true);
    const [dry] = await new Importer({
      dataDir: dir,
      spec: BTC,
      firstDay: DAY,
      lastDay: DAY,
      prefer: 'daily',
      neighbours: true,
      writer: new DryRunWriter(),
      importerVersion: 'x',
      sidecar: false,
      log: () => {},
    }).run();
    const [d] =
      await sql`SELECT state, digest, immutable, source FROM data_day WHERE sym_id = 1 AND day = '2026-09-10'`;
    expect(d).toMatchObject({
      state: 'final_ok',
      digest: dry!.digest,
      immutable: true,
      source: 'vision',
    });
  });

  it('Locks: ein Recorder je DB; Importer und Recorder blockieren sich nicht; Import beendet das Schreiben', async () => {
    const a = new LiveWriter(cfg);
    await a.open();
    await expect(new LiveWriter(cfg).open()).rejects.toThrow(/Recorder-Lock/);
    const imp = new PostgresWriter(cfg, BTC);
    await imp.open(); // anderer Lock: gleichzeitig möglich
    await imp.close();
    // ein Tag, den der Import gerade übernimmt (importing), wird vom Recorder nicht beschrieben
    await sql`INSERT INTO data_day (sym_id, day, state) VALUES (1, '2026-09-11', 'importing')`;
    const delta = {
      day: parseDay('2026-09-11'),
      minute: 0,
      fp: [],
      bars: [{ table: 'bar_1d' as const, from: 0, to: 0, bars: [] }],
      viaRest: false,
      trades: 0,
    };
    expect(await a.writeMinute(BTC, delta)).toBe('not_provisional');
    await a.close();
  });
});
