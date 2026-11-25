// DB-Integration des Recorders auf "<OF_DB_NAME>_test" (`npm run test:db`): Live-Schreiben eines
// synthetischen Tages über den echten Recorder-Pfad, Sichtbarkeit für Leser (provisional, nie
// immutable, version steigt, jede Minute vollständig), Finalisierung durch den Import mit
// Qualitätsvergleich und identischen Digests, Zusammenspiel der Locks von Recorder und Importer.
import { getSymbol, parseConfig, parseDay, type DbConfig } from '@orderflow/core';
import { connect, dropAndCreateDatabase, migrateUp, type Sql } from '@orderflow/db';
import { DryRunWriter, Importer, PostgresWriter } from '@orderflow/importer';
import { randomBytes } from 'node:crypto';
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
  dir = archive({ dailyDays: ['2026-09-10', '2026-09-14'] });
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

// Rechte-Entscheidung je Tabelle für of_recorder (Review W4): jede Tabelle im Schema public muss hier
// stehen; eine neue Tabelle ohne Eintrag lässt den Test fehlschlagen.
const RECORDER_WRITES = [
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
  'data_day',
  'data_minute_issue',
  'raw_file',
  'raw_day',
  'symbol_tick_history',
  'ingest_status',
  'live_kline_check',
  'recorder_quality',
];
const RECORDER_READS_ONLY = ['symbol', 'schema_migrations', 'verify_run'];
const ROLE_DAY = '2026-09-14';

describe('Recorder-Rolle und eingefrorene Tage (Abnahme 8, Review K1, W2, W4, W5)', () => {
  // Test-Login-Rolle als Mitglied von of_recorder: gleiche Rechte, kein Eigentum – of_recorder selbst
  // bekommt kein Passwort (das setzt nur der Betrieb). Name zufällig, am Ende gelöscht.
  const ROLE = `of_rec_t_${randomBytes(4).toString('hex')}`;
  const PW = randomBytes(18).toString('hex');
  let roleCfg: DbConfig;
  let rsql: Sql;
  beforeAll(async () => {
    await sql.unsafe(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PW}' IN ROLE of_recorder`);
    // kleine Entpack-Grenze: der synthetische Tag ist klein, ein echter überschreitet die
    // Standardgrenze (100 000) – der Importer muss sie für seinen Ersatz selbst aufheben
    await sql.unsafe(
      `ALTER ROLE ${ROLE} SET timescaledb.max_tuples_decompressed_per_dml_transaction = 100`,
    );
    roleCfg = { ...cfg, user: ROLE, password: PW };
    rsql = connect(roleCfg);
  });
  afterAll(async () => {
    await rsql?.end();
    await sql.unsafe(`DROP ROLE IF EXISTS ${ROLE}`);
  });

  it('of_recorder: jede Tabelle hat eine ausdrückliche Entscheidung; Schreibrechte nur dort, kein DDL', async () => {
    const tables = (
      await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`
    ).map((r) => r.tablename as string);
    const undecided = tables.filter(
      (t) => !RECORDER_WRITES.includes(t) && !RECORDER_READS_ONLY.includes(t),
    );
    expect(undecided, 'neue Tabelle ohne Rechte-Entscheidung für of_recorder').toEqual([]);
    for (const t of tables) {
      const [p] = await sql`
        SELECT has_table_privilege('of_recorder', ${t}, 'SELECT') AS r,
               has_table_privilege('of_recorder', ${t}, 'UPDATE') AS w`;
      expect(p!.r, `${t} lesbar`).toBe(true);
      expect(p!.w, `${t} schreibbar`).toBe(RECORDER_WRITES.includes(t));
    }
    const [c] = await sql`SELECT has_schema_privilege('of_recorder', 'public', 'CREATE') AS ok`;
    expect(c!.ok).toBe(false);
    // Standardrechte: eine künftige Tabelle des Migrationsbenutzers ist lesbar, nicht schreibbar
    await sql.begin(async (tx) => {
      await tx`CREATE TABLE of_default_priv_probe (x int)`;
      const [d] = await tx`
        SELECT has_table_privilege('of_recorder', 'of_default_priv_probe', 'SELECT') AS r,
               has_table_privilege('of_recorder', 'of_default_priv_probe', 'INSERT') AS w`;
      expect(d).toEqual({ r: true, w: false });
      await tx`DROP TABLE of_default_priv_probe`;
    });
    // unter der Rolle (echte Verbindung): Statuszeile schreiben geht, DDL und direkte Konvertierung nicht
    await rsql`INSERT INTO ingest_status (component, sym_id) VALUES ('role-test', 1)
               ON CONFLICT (component, sym_id) DO NOTHING`;
    await expect(rsql`CREATE TABLE of_recorder_probe (x int)`).rejects.toMatchObject({
      code: '42501',
    });
    const [ch] = await sql`
      SELECT format('%I.%I', chunk_schema, chunk_name) AS c FROM timescaledb_information.chunks
       WHERE hypertable_name = 'fp_1m' ORDER BY range_start LIMIT 1`;
    await expect(
      rsql.unsafe('CALL convert_to_columnstore($1::regclass, if_not_columnstore => true)', [
        ch!.c as string,
      ]),
    ).rejects.toThrow(/must be owner/);
    // of_recompress_chunk nimmt nur Chunks der Projekt-Hypertables
    await expect(rsql`SELECT of_recompress_chunk('data_day'::regclass)`).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('markFrozen macht den Grund in data_day sichtbar, nur für provisorische Tage (W2)', async () => {
    const w = new LiveWriter(cfg);
    await w.open();
    await w.markFrozen(BTC, parseDay('2026-09-12'), 'nicht füllbare Lücke (Test)');
    await w.markFrozen(BTC, parseDay('2026-09-10'), 'darf finalen Tag nicht ändern');
    await w.markFrozen(BTC, parseDay('2026-09-11'), 'darf Tag im Import nicht ändern'); // importing
    await w.close();
    const rows = await sql`SELECT day::text AS day, state, live_frozen, immutable FROM data_day
                            WHERE day IN ('2026-09-10', '2026-09-11', '2026-09-12') ORDER BY day`;
    expect(rows.map((r) => [r.day, r.state, r.live_frozen, r.immutable])).toEqual([
      ['2026-09-10', 'final_ok', null, true],
      ['2026-09-11', 'importing', null, false],
      ['2026-09-12', 'provisional', 'nicht füllbare Lücke (Test)', false],
    ]);
  });

  it('Finalisierung eines schon komprimierten Tages UNTER der Recorder-Rolle: Chunks danach vollständig komprimiert, Lock-first-RR-Leser sieht nie einen leeren Chunk; live_frozen zurückgesetzt (K1, W2)', async () => {
    const day = parseDay(ROLE_DAY);
    const r = await replayDay({ dataDir: dir, symbol: 'BTCUSDT', day, db: cfg, log: () => {} });
    expect(r.equal).toBe(true);
    const w = new LiveWriter(cfg);
    await w.open();
    await w.markFrozen(BTC, day, 'Testgrund vor der Finalisierung');
    await w.close();
    const dayChunks = async () =>
      sql`
        SELECT format('%I.%I', c.chunk_schema, c.chunk_name) AS c, c.hypertable_name AS h, k.status
          FROM timescaledb_information.chunks c
          JOIN timescaledb_information.hypertables h USING (hypertable_schema, hypertable_name)
          JOIN _timescaledb_catalog.chunk k ON k.relid = format('%I.%I', c.chunk_schema, c.chunk_name)::regclass
         WHERE h.compression_enabled AND c.hypertable_schema = 'public'
           AND c.range_start < ${ROLE_DAY}::date + 1 AND c.range_end > ${ROLE_DAY}::date
         ORDER BY 1`;
    // Ausgangslage: alle Chunks des Tages komprimiert (wie nach > 3 Tagen Ausfall bzw. Policy)
    for (const c of await dayChunks())
      await sql.unsafe('CALL convert_to_columnstore($1::regclass, if_not_columnstore => true)', [
        c.c as string,
      ]);
    expect((await dayChunks()).every((c) => (c.status as number) === 1)).toBe(true);
    const lockList = (await dayChunks())
      .filter((c) => ['bar_1m', 'fp_1m', 'fp_1m_b10'].includes(c.h as string))
      .map((c) => c.c as string)
      .join(', ');

    // Lock-first REPEATABLE-READ-Leser (wie die API) während der Finalisierung
    const reader = connect(cfg);
    let done = false;
    const problems: unknown[] = [];
    let reads = 0;
    const readLoop = (async () => {
      while (!done) {
        const x = await reader.begin('isolation level repeatable read read only', async (tx) => {
          await tx.unsafe(`LOCK TABLE ${lockList} IN ACCESS SHARE MODE`);
          const [q] = await tx`
            SELECT (SELECT count(*)::int FROM bar_1m WHERE sym_id = 1 AND ts >= ${ROLE_DAY}::date AND ts < ${ROLE_DAY}::date + 1) AS b,
                   (SELECT count(DISTINCT ts)::int FROM fp_1m WHERE sym_id = 1 AND ts >= ${ROLE_DAY}::date AND ts < ${ROLE_DAY}::date + 1) AS f,
                   (SELECT count(DISTINCT ts)::int FROM fp_1m_b10 WHERE sym_id = 1 AND ts >= ${ROLE_DAY}::date AND ts < ${ROLE_DAY}::date + 1) AS g`;
          return q!;
        });
        reads++;
        if (x.b === 0 || x.b !== x.f || x.b !== x.g) problems.push(x);
      }
    })();
    const logs: string[] = [];
    try {
      const res = await finaliseDay({
        dataDir: dir,
        cfg: roleCfg,
        spec: BTC,
        day,
        sql: rsql,
        log: (m) => logs.push(m),
      });
      expect(res).toMatchObject({ quality: { identical: 1440, differing: 0 } });
    } finally {
      done = true;
      await readLoop;
      await reader.end();
    }
    expect(problems).toEqual([]);
    expect(reads).toBeGreaterThan(0);
    expect(logs.filter((l) => /WARNUNG/.test(l))).toEqual([]);
    const after = await dayChunks();
    expect(after.map((c) => [c.h, c.status])).toEqual(after.map((c) => [c.h, 1]));
    const [d] = await sql`SELECT state, immutable, live_frozen FROM data_day
                           WHERE sym_id = 1 AND day = ${ROLE_DAY}::date`;
    expect(d).toEqual({ state: 'final_ok', immutable: true, live_frozen: null });
  });

  it('Importer öffnet unter der Recorder-Rolle auch mit pausiertem Columnstore-Job (W5)', async () => {
    const [j] = await sql`
      SELECT job_id FROM timescaledb_information.jobs
       WHERE proc_name = 'policy_compression' AND hypertable_name = 'fp_1m'`;
    const id = j!.job_id as number;
    await sql`SELECT alter_job(${id}, scheduled => false)`;
    try {
      const logs: string[] = [];
      const wr = new PostgresWriter(roleCfg, BTC, { log: (m) => logs.push(m) });
      await wr.open();
      await wr.close();
      expect(logs.some((l) => /keine Rechte zur Reparatur/.test(l))).toBe(true);
      const [s] =
        await sql`SELECT scheduled FROM timescaledb_information.jobs WHERE job_id = ${id}`;
      expect(s!.scheduled).toBe(false); // nicht repariert (kein Eigentum) – ein Admin-Lauf tut es
      // der Admin-Importer repariert
      const adm = new PostgresWriter(cfg, BTC, { log: () => {} });
      await adm.open();
      await adm.close();
      const [s2] =
        await sql`SELECT scheduled FROM timescaledb_information.jobs WHERE job_id = ${id}`;
      expect(s2!.scheduled).toBe(true);
    } finally {
      await sql`SELECT alter_job(${id}, scheduled => true)`;
    }
  });

  it('Migration 0014: keine Projekt-Policy verdichtet teilweise komprimierte Chunks nach', async () => {
    const jobs = await sql`
      SELECT hypertable_name, config FROM timescaledb_information.jobs
       WHERE proc_name IN ('policy_compression', 'policy_columnstore') AND hypertable_schema = 'public'`;
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs)
      expect((j.config as { recompress?: boolean }).recompress, j.hypertable_name as string).toBe(
        false,
      );
  });
});
