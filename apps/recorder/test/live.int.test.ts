// DB-Integration des Recorders auf "<OF_DB_NAME>_test" (`npm run test:db`): Live-Schreiben eines
// synthetischen Tages über den echten Recorder-Pfad, Sichtbarkeit für Leser (provisional, nie
// immutable, version steigt, jede Minute vollständig), Finalisierung durch den Import mit
// Qualitätsvergleich und identischen Digests, Zusammenspiel der Locks von Recorder und Importer.
import { getSymbol, parseConfig, parseDay, type DbConfig } from '@orderflow/core';
import { connect, dropAndCreateDatabase, migrateUp, type Sql } from '@orderflow/db';
import {
  DryRunWriter,
  Importer,
  PostgresWriter,
  repairOpenChunks,
  assertTestDatabase,
  otherOpenTransactions,
} from '@orderflow/importer';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive } from '../../importer/test/synth.ts';
import { finaliseDay } from '../src/finalize.ts';
import { toItem } from '../src/binance.ts';
import { LiveWriter } from '../src/livewriter.ts';
import { Recorder } from '../src/recorder.ts';
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
  dir = archive({ dailyDays: ['2026-09-10', '2026-09-14', '2026-09-15'] });
});
afterAll(async () => {
  await sql?.end();
});

describe('Recorder ↔ Datenbank', () => {
  it('replayDay verweigert eine Datenbank außerhalb des Test-Musters, bevor es löscht', async () => {
    // eigene, nicht nach Test benannte Datenbank anlegen (nie die Entwicklungs-DB berühren)
    const other: DbConfig = { ...cfg, database: `${base.database}_guardcheck` };
    await dropAndCreateDatabase(other);
    const o = connect(other);
    await migrateUp(o);
    await o.end();
    await expect(
      replayDay({ dataDir: dir, symbol: 'BTCUSDT', day: DAY, db: other, log: () => {} }),
    ).rejects.toThrow(/nur auf Test-Datenbanken/);
    const a = connect(cfg);
    await a.unsafe(`DROP DATABASE IF EXISTS ${other.database} WITH (FORCE)`);
    await a.end();
  });

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
const H3_DAY = '2026-09-15';

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
    // die API-Rolle bekommt durch 0013–0016 nichts dazu: keine Recorder-Tabellen, keine
    // Konvertierungsfunktion, keine Mitgliedschaft in of_recorder
    const [api] = await sql`
      SELECT has_function_privilege('of_api', 'of_recompress_chunk(regclass)', 'EXECUTE') AS fn,
             pg_has_role('of_api', 'of_recorder', 'MEMBER') AS member,
             has_table_privilege('of_api', 'ingest_status', 'SELECT') AS st,
             has_table_privilege('of_api', 'recorder_quality', 'SELECT') AS q,
             has_table_privilege('of_api', 'live_kline_check', 'SELECT') AS k,
             has_column_privilege('of_api', 'data_day', 'live_frozen', 'SELECT') AS frozen`;
    expect(api).toEqual({ fn: false, member: false, st: false, q: false, k: false, frozen: true });
    // of_recompress_chunk nimmt nur Chunks der Projekt-Hypertables
    await expect(rsql`SELECT of_recompress_chunk('data_day'::regclass)`).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('checkSymbol legt eine fehlende Symbolzeile unter der Recorder-Rolle an und verweigert abweichende Einheiten (S2)', async () => {
    const ETH = getSymbol('ETHUSDT');
    await sql`DELETE FROM symbol WHERE sym_id = ${ETH.symId}
                AND NOT EXISTS (SELECT 1 FROM data_day WHERE sym_id = ${ETH.symId})`;
    const w = new LiveWriter(roleCfg);
    await w.open();
    try {
      await w.checkSymbol(ETH); // fehlt → angelegt
      const [r] = await sql`SELECT name FROM symbol WHERE sym_id = ${ETH.symId}`;
      expect(r!.name).toBe('ETHUSDT');
      await w.checkSymbol(ETH); // vorhanden und passend
      const [orig] = await sql`SELECT tick_ref_units FROM symbol WHERE sym_id = ${ETH.symId}`;
      await sql`UPDATE symbol SET tick_ref_units = tick_ref_units + 1 WHERE sym_id = ${ETH.symId}`;
      try {
        await expect(w.checkSymbol(ETH)).rejects.toThrow(/passt nicht zu den Einheiten.*ETHUSDT/);
      } finally {
        await sql`UPDATE symbol SET tick_ref_units = ${orig!.tick_ref_units as number} WHERE sym_id = ${ETH.symId}`;
      }
      // gleicher Name unter anderer sym_id: lesbare Meldung statt 23505
      await expect(w.checkSymbol({ ...ETH, symId: 77 })).rejects.toThrow(
        /ETHUSDT hat sym_id 2, der Code erwartet 77/,
      );
    } finally {
      await w.close();
    }
  });

  it('erkennt erhöhte Rechte der Sitzung unabhängig von OF_DB_USER (Admin verweigert, Recorder-Rolle nicht)', async () => {
    const adm = new LiveWriter(cfg);
    await adm.open();
    expect(await adm.elevatedRole()).toMatch(/Superuser|of_admin/);
    await adm.close();
    const rec = new LiveWriter(roleCfg);
    await rec.open();
    expect(await rec.elevatedRole()).toBeNull();
    await rec.close();
  });

  it('markGap: Enden inklusive; Grenze − 1 lässt die Minute an der Grenze frei', async () => {
    const w = new LiveWriter(cfg);
    await w.open();
    const d0 = parseDay('2026-09-20') * 86_400_000;
    await w.markGap(BTC, d0 - 3 * 60_000, d0 - 1); // 23:57 … 23:59 des Vortags
    await w.close();
    const r = await sql`
      SELECT ts FROM data_minute_issue WHERE sym_id = 1 AND kind = 'gap'
         AND ts >= ${new Date(d0 - 3 * 60_000)} AND ts <= ${new Date(d0)} ORDER BY ts`;
    expect(r.map((x) => (x.ts as Date).getTime())).toEqual([
      d0 - 3 * 60_000,
      d0 - 2 * 60_000,
      d0 - 60_000,
    ]);
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

  it('of_hot_margin() ist die eine Quelle der Marge; Policies komprimieren erst nach 4 Tagen (0016)', async () => {
    const [m] = await sql`SELECT of_hot_margin()::text AS m`;
    expect(m!.m).toBe('3 days');
    const after = await sql`
      SELECT DISTINCT config ->> 'compress_after' AS a FROM timescaledb_information.jobs
       WHERE proc_name IN ('policy_compression', 'policy_columnstore')`;
    expect(after.map((r) => r.a)).toEqual(['4 days']);
    // unter der Recorder-Rolle aufrufbar
    const [c] = await sql`
      SELECT format('%I.%I', chunk_schema, chunk_name) AS c FROM timescaledb_information.chunks
       WHERE hypertable_name = 'fp_1m' ORDER BY range_start LIMIT 1`;
    const [h] = await rsql`SELECT of_chunk_is_hot(${c!.c as string}::regclass) AS hot`;
    expect(h!.hot).toBe(false); // September-Testdaten: kalt
  });

  it('jede Columnstore-Policy eines Projekt-Hypertables hat recompress=false (H2: auch künftige Migrationen)', async () => {
    const rows = await sql`
      SELECT h.hypertable_name AS t, j.job_id, j.config
        FROM timescaledb_information.hypertables h
        LEFT JOIN timescaledb_information.jobs j
          ON j.hypertable_schema = h.hypertable_schema AND j.hypertable_name = h.hypertable_name
         AND j.proc_name IN ('policy_compression', 'policy_columnstore')
       WHERE h.hypertable_schema = 'public' AND h.compression_enabled`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.job_id, `${r.t as string}: Columnstore ohne Policy`).not.toBeNull();
      expect((r.config as { recompress?: boolean }).recompress, r.t as string).toBe(false);
    }
    // und keine Policy auf einem Hypertable ohne Columnstore / außerhalb von public
    const [odd] = await sql`
      SELECT count(*)::int AS n FROM timescaledb_information.jobs
       WHERE proc_name IN ('policy_compression', 'policy_columnstore')
         AND coalesce((config ->> 'recompress')::boolean, true)`;
    expect(odd!.n).toBe(0);
    // 0015/0016: Policy-Frist mindestens die Marge für offene Chunks (of_hot_margin()); die Policy
    // vergleicht mit range_end, damit komprimiert auch sie nie einen offenen Chunk
    const [short] = await sql`
      SELECT count(*)::int AS n FROM timescaledb_information.jobs
       WHERE proc_name IN ('policy_compression', 'policy_columnstore')
         AND coalesce((config ->> 'compress_after')::interval, interval '0') < of_hot_margin()`;
    expect(short!.n).toBe(0);
  });

  it('of_recompress_chunk lehnt Chunks ohne Columnstore ab, bevor es sperrt (H4)', async () => {
    const [ch] = await sql`
      SELECT format('%I.%I', chunk_schema, chunk_name) AS c FROM timescaledb_information.chunks
       WHERE hypertable_name = 'bar_1h' ORDER BY range_start LIMIT 1`;
    expect(ch).toBeDefined();
    const holder = connect(cfg);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    const holding = holder.begin(async (tx) => {
      await tx.unsafe(`LOCK TABLE ${ch!.c as string} IN ACCESS SHARE MODE`);
      held();
      await released;
    });
    await isHeld;
    try {
      // Sperrte die Funktion zuerst, käme hier 55P03 (lock_timeout) statt 42501
      await expect(
        rsql.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '200ms'`;
          await tx`SELECT of_recompress_chunk(${ch!.c as string}::regclass)`;
        }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      release();
      await holding;
      await holder.end();
    }
  });

  it('teilweise komprimierte Chunks sind unter der Recorder-Rolle sichtbar (H2)', async () => {
    const lw = new LiveWriter(roleCfg);
    await lw.open();
    try {
      expect(await lw.partialChunks()).toEqual([]);
      // H2a: persistierte „zuerst gesehen"-Zeitpunkte werden unter der Rolle gelesen
      await lw.writeStatus({
        sym_id: 1,
        last_agg_id: null,
        last_trade_ms: null,
        ws_connected: false,
        open_gaps: 0,
        unwritten_minutes: 0,
        rest_weight_1m: 0,
        spool_lag_ms: 0,
        last_committed_minute: null,
        last_finalised_day: null,
        details: { partialChunkFirstSeen: { x: 123 } },
      });
      expect(await lw.statusDetails()).toContainEqual({ partialChunkFirstSeen: { x: 123 } });
      await sql`UPDATE fp_1m SET buy_q = buy_q WHERE sym_id = 1 AND ts = ${ROLE_DAY}::date + interval '12 hours'`;
      const p = await lw.partialChunks();
      expect(p).toHaveLength(1);
      await rsql`SELECT of_recompress_chunk(${p[0]!}::regclass)`;
      expect(await lw.partialChunks()).toEqual([]);
    } finally {
      await lw.close();
    }
  });

  it('Konvertierungsfehler nach dem Festschreiben: Tag ist final, finaliseDay meldet ihn getrennt (H3)', async () => {
    const day = parseDay(H3_DAY);
    expect(
      (await replayDay({ dataDir: dir, symbol: 'BTCUSDT', day, db: cfg, log: () => {} })).equal,
    ).toBe(true);
    const chunks = await sql`
      SELECT format('%I.%I', c.chunk_schema, c.chunk_name) AS c
        FROM timescaledb_information.chunks c
        JOIN timescaledb_information.hypertables h USING (hypertable_schema, hypertable_name)
       WHERE h.compression_enabled AND c.hypertable_schema = 'public'
         AND c.range_start < ${H3_DAY}::date + 1 AND c.range_end > ${H3_DAY}::date`;
    for (const c of chunks)
      await sql.unsafe('CALL convert_to_columnstore($1::regclass, if_not_columnstore => true)', [
        c.c as string,
      ]);
    // Konvertierungsrecht entziehen (wie eine fehlende Migration 0014): Fehler nach dem Commit
    await sql`REVOKE EXECUTE ON FUNCTION of_recompress_chunk(regclass) FROM of_recorder`;
    try {
      const res = await finaliseDay({
        dataDir: dir,
        cfg: roleCfg,
        spec: BTC,
        day,
        sql: rsql,
        log: () => {},
      });
      expect(res).toMatchObject({
        quality: { identical: 1440 },
        postCommitError: {
          source: 'conversion',
          message: expect.stringMatching(
            /Konvertierung nach 2026-09-15 fehlgeschlagen.*permission denied for function of_recompress_chunk/,
          ),
        },
      });
    } finally {
      await sql`GRANT EXECUTE ON FUNCTION of_recompress_chunk(regclass) TO of_recorder`;
    }
    const [d] = await sql`SELECT state FROM data_day WHERE sym_id = 1 AND day = ${H3_DAY}::date`;
    expect(d!.state).toBe('final_ok');
  });
});

describe('Offene Chunks nie im Columnstore (Migration 0015)', () => {
  // offene („heiße") Chunks der Projekttabellen mit Status-Bit 1 bzw. 8
  const hotChunks = async () =>
    sql`
      SELECT format('%I.%I', c.chunk_schema, c.chunk_name) AS c, c.hypertable_name AS h, k.status
        FROM timescaledb_information.chunks c
        JOIN _timescaledb_catalog.chunk k ON k.relid = format('%I.%I', c.chunk_schema, c.chunk_name)::regclass
       WHERE c.hypertable_schema = 'public' AND c.range_end > now() - of_hot_margin()
       ORDER BY 2`;
  const compressedOrPartial = async () =>
    (await hotChunks()).filter((c) => ((c.status as number) & 9) !== 0).map((c) => c.h as string);

  // Live-Minuten zur aktuellen Uhrzeit über den echten Recorder-Pfad (Recorder → LiveWriter)
  async function writeLiveMinutes(fromMs: number, minutes: number, firstId: number) {
    const w = new LiveWriter(cfg);
    await w.open();
    const spec = BTC;
    const day = Math.floor(fromMs / 86_400_000);
    const rec = new Recorder({
      symbols: ['BTCUSDT'],
      wsUrl: 'wss://test.invalid',
      socketFactory: () => ({
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        close() {},
      }),
      rest: { aggTrades: async () => [], klines: async () => [] },
      sink: {
        startState: async () => ({
          final: { day: day - 1, lastAggId: firstId - 1, carry: null, cand: null },
          provisional: [],
        }),
        writeMinute: (s, d) => w.writeMinute(s, d),
        markGap: async () => {},
        markFrozen: async () => {},
        writeKlineChecks: async () => {},
      },
      spoolDir: null,
      log: () => {},
      klineCheck: false,
      autoLoops: false,
    });
    await rec.start();
    const s = rec.sym.get('BTCUSDT')!;
    const items = [];
    let id = firstId;
    for (let t = fromMs; t < fromMs + minutes * 60_000; t += 5_000) {
      items.push(
        toItem(
          {
            a: id,
            p: (90_000 + (id % 7) / 10).toFixed(1),
            q: '0.010',
            f: id,
            l: id,
            T: t,
            m: id % 2 === 0,
          },
          spec,
          false,
        ),
      );
      id++;
    }
    rec.handle(s, items, false);
    rec.completeMinutes(s, fromMs + minutes * 60_000 + 10_000);
    await rec.drain();
    await rec.stop();
    await w.close();
    return id;
  }

  it('Live-Schreiben in alle 12 Tabellen, Policy- und Importer-Läufe: offene Chunks bleiben im Rowstore; repair-open-chunks holt komprimierte zurück', async () => {
    const now = Date.now();
    const from = now - (now % 60_000) - 40 * 60_000; // 40 Minuten zurück, ganze Minute
    let id = await writeLiveMinutes(from, 5, 9_000_000_000);
    // kline_1m bekommt live keine Zeilen (nur der Importer): eine Zeile im laufenden Chunk
    await sql`INSERT INTO kline_1m (sym_id, ts, open_px, high_px, low_px, close_px, vol, taker_buy, trades, quote_vol_n)
              VALUES (1, ${new Date(from)}, 1, 1, 1, 1, 1, 1, 1, 1) ON CONFLICT DO NOTHING`;
    const tables = new Set((await hotChunks()).map((c) => c.h as string));
    expect([...tables].sort()).toEqual(
      [...RECORDER_WRITES.slice(0, 12)].sort(), // fp_* (8), bar_1m/1h/1d, kline_1m
    );
    expect(await compressedOrPartial()).toEqual([]);

    // Vorfall nachstellen: offene Chunks komprimiert (wie das Messskript vom 2026-11-24)
    for (const c of await hotChunks())
      await sql
        .unsafe('CALL convert_to_columnstore($1::regclass, if_not_columnstore => true)', [
          c.c as string,
        ])
        .catch(() => {}); // Tabellen ohne Columnstore (bar_1h, bar_1d, fp_1d_*) lehnen ab
    const before = (await compressedOrPartial()).sort();
    expect(before.length).toBeGreaterThan(0);
    const [cnt0] =
      await sql`SELECT (SELECT count(*) FROM fp_1m) + (SELECT count(*) FROM bar_1m) AS n`;
    const logs: string[] = [];
    // H2b: der Importer warnt beim Öffnen
    const wlogs: string[] = [];
    const iw = new PostgresWriter(cfg, BTC, { log: (m) => wlogs.push(m) });
    await iw.open();
    await iw.close();
    expect(wlogs.some((l) => /offene Chunks im Columnstore.*repair-open-chunks/.test(l))).toBe(
      true,
    );
    // W1: jede offene Transaktion einer fremden Anwendung (z. B. ein REPEATABLE-READ-Prüfbericht)
    // blockiert die Reparatur sofort, auch wenn sie den Chunk noch nicht gelesen hat; API/Recorder
    // erst ab 5 s
    const maint = connect(cfg);
    const other = connect(cfg); // application_name orderflow-db-tools
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let opened!: () => void;
    const isOpen = new Promise<void>((r) => (opened = r));
    const holding = other.begin('isolation level repeatable read read only', async (tx) => {
      await tx`SELECT 1`;
      opened();
      await released;
    });
    await isOpen;
    expect((await otherOpenTransactions(maint)).length).toBe(1); // sofort, nicht erst nach 5 s
    await expect(repairOpenChunks(maint, {})).rejects.toThrow(/andere offene Transaktion/);
    expect((await repairOpenChunks(maint, { dryRun: true })).length).toBe(before.length);
    release();
    await holding;
    await other.end();
    expect(await assertTestDatabase(maint)).toMatch(/_test_recorder$/);
    // API-artige kurze Lesetransaktionen laufen während der Reparatur weiter und blockieren nicht
    // eine Transaktion unter dem Namen der API zählt erst nach 5 s
    const apiOld = connect(cfg, undefined, { applicationName: 'orderflow-api' });
    let releaseOld!: () => void;
    const oldReleased = new Promise<void>((r) => (releaseOld = r));
    let oldOpened!: () => void;
    const oldIsOpen = new Promise<void>((r) => (oldOpened = r));
    const oldHolding = apiOld.begin(async (tx) => {
      await tx`SELECT 1`;
      oldOpened();
      await oldReleased;
    });
    await oldIsOpen;
    expect(await otherOpenTransactions(maint)).toEqual([]);
    await new Promise((r) => setTimeout(r, 5500));
    expect((await otherOpenTransactions(maint)).map((t) => t.app)).toEqual(['orderflow-api']);
    releaseOld();
    await oldHolding;
    await apiOld.end();
    const api = connect(cfg, undefined, { applicationName: 'orderflow-api' });
    let stopApi = false;
    let apiReads = 0;
    const apiLoop = (async () => {
      while (!stopApi) {
        await api.begin('isolation level repeatable read read only', async (tx) => {
          await tx`SET LOCAL lock_timeout = '1s'`;
          await tx`SELECT count(*) FROM bar_1m WHERE sym_id = 1 AND ts >= now() - interval '1 hour'`;
        });
        apiReads++;
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    let rep;
    try {
      rep = await repairOpenChunks(maint, { log: (m) => logs.push(m) });
    } finally {
      stopApi = true;
      await apiLoop;
      await api.end();
    }
    expect(apiReads).toBeGreaterThan(0);
    expect(rep.map((r) => r.hypertable).sort()).toEqual(before);
    expect(rep.every((r) => r.convertMs !== null && r.lockWaitMs !== null)).toBe(true);
    expect(await compressedOrPartial()).toEqual([]);
    expect(await repairOpenChunks(maint, {})).toEqual([]); // idempotent
    await maint.end();
    const [cnt1] =
      await sql`SELECT (SELECT count(*) FROM fp_1m) + (SELECT count(*) FROM bar_1m) AS n`;
    expect(cnt1!.n).toBe(cnt0!.n);

    // weitere Live-Minuten: keine teilweise komprimierten Chunks
    id = await writeLiveMinutes(from + 5 * 60_000, 5, id);
    expect(await compressedOrPartial()).toEqual([]);

    // alle Policy-Jobs: offene Chunks bleiben unkomprimiert (Policy vergleicht range_end)
    for (const j of await sql`
      SELECT job_id FROM timescaledb_information.jobs
       WHERE proc_name IN ('policy_compression', 'policy_columnstore')`)
      await sql.unsafe(`CALL run_job(${j.job_id as number})`);
    expect(await compressedOrPartial()).toEqual([]);

    // Importer: Backfill-Konvertierung „bis in die Zukunft" und close()-Durchlauf lassen sie in Ruhe
    const wr = new PostgresWriter(cfg, BTC, { log: () => {} });
    await wr.open();
    await wr.convertFinishedChunks(Date.now() + 60 * 86_400_000);
    await wr.close();
    expect(await compressedOrPartial()).toEqual([]);

    // of_recompress_chunk lehnt einen offenen Chunk ab, bevor es sperrt
    const fp = (await hotChunks()).find((c) => c.h === 'fp_1m')!;
    await expect(
      sql`SELECT of_recompress_chunk(${fp.c as string}::regclass)`,
    ).rejects.toMatchObject({
      code: '55000',
    });
    // und nach der Wiederholung des Schreibens ist immer noch nichts komprimiert
    await writeLiveMinutes(from + 10 * 60_000, 2, id);
    expect(await compressedOrPartial()).toEqual([]);
  });
});
