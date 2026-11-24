// Integrationstest des Postgres-Schreibers (KONZEPT §4.3, §4.8) gegen die lokale Timescale-DB:
// `npm run db:up && npm run test:db`. Arbeitet auf "<OF_DB_NAME>_test" (wird neu angelegt).
//
// Prüft: Import eines synthetischen Tages → data_day final_ok, version 2 (inkl. Randminute), Digest = day_digest_all
// (TS-Textform = Postgres-Zeilentextform); Re-Import → version + 2, identischer Digest (K8);
// Zeilenzahlen = Dry-Run; Auflösung der Randminute eines vorher importierten Nachbartags;
// Single-Writer-Lock inkl. Verbindungsabbruch (Review K2); Randminute ohne bar-Zeile (W1);
// Resume mit offenen Randminuten (W2); DB-verankerte Digest-Textform inkl. bigint > 2^53.
import {
  barDigest,
  fpDigest,
  FpBuilder,
  getSymbol,
  parseConfig,
  parseDay,
  type Bar,
  type DbConfig,
} from '@orderflow/core';
import { connect, dropAndCreateDatabase, migrateUp, type Sql } from '@orderflow/db';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
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

async function run(
  writer: DayWriter,
  from: string,
  to: string,
  neighbours = true,
  dir?: string,
  alreadyOpen = false,
) {
  if (!alreadyOpen) await writer.open();
  try {
    return await new Importer({
      dataDir: dir ?? dataDir,
      spec: BTC,
      firstDay: parseDay(from),
      lastDay: parseDay(to),
      prefer: 'auto',
      neighbours,
      writer,
      importerVersion: 'int-test',
      sidecar: false,
      log: () => {},
    }).run();
  } finally {
    if (!alreadyOpen) await writer.close();
  }
}

let lastOpened: PostgresWriter | null = null;
async function opened(w: PostgresWriter): Promise<PostgresWriter> {
  await w.open();
  lastOpened = w;
  return w;
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
      version: 2, // Schreiben + Auflösung von Minute 1439 (resolveEdge erhöht die Version)
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

  it('Re-Import identischer Daten: nichts geschrieben, nur Herkunft; --force schreibt (K8, N3)', async () => {
    const [before] = await sql`SELECT version, digest FROM data_day WHERE day = '2026-09-10'`;
    await sql`UPDATE data_day SET importer_version = 'alt' WHERE day = '2026-09-10'`;
    const [same] = await run(new PostgresWriter(cfg, BTC), '2026-09-10', '2026-09-10');
    expect(same!.decision).toBe('skip');
    const [dd] =
      await sql`SELECT version, digest, importer_version FROM data_day WHERE day = '2026-09-10'`;
    expect(dd).toMatchObject({
      version: before!.version,
      digest: before!.digest,
      importer_version: 'int-test',
    });
    const forced = await new Importer({
      dataDir,
      spec: BTC,
      firstDay: parseDay('2026-09-10'),
      lastDay: parseDay('2026-09-10'),
      prefer: 'monthly',
      neighbours: true,
      writer: await opened(new PostgresWriter(cfg, BTC)),
      importerVersion: 'int-test',
      sidecar: false,
      log: () => {},
      force: true,
    }).run();
    expect(forced[0]!.decision).toBe('write');
    const [d2] = await sql`SELECT version, digest FROM data_day WHERE day = '2026-09-10'`;
    expect(d2!.digest).toBe(before!.digest);
    expect(d2!.version).toBeGreaterThan(before!.version as number);
    await lastOpened?.close();
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

describe('Review-Regressionen (DB)', () => {
  it('K2: Lock-Verlust nach Verbindungsabbruch wird erkannt; fremder Halter → Abbruch, sonst neu erwerben', async () => {
    const a = new PostgresWriter(cfg, BTC);
    await a.open();
    const pid = await a.backendPid();
    await sql`SELECT pg_terminate_backend(${pid})`;
    const b = new PostgresWriter(cfg, BTC);
    await b.open(); // Lock ist frei geworden
    await expect(run(a, '2026-09-25', '2026-09-25', false, undefined, true)).rejects.toThrow(
      /Lock verloren/,
    );
    const st = await sql`SELECT state FROM data_day WHERE day = '2026-09-25'`;
    expect(st).toHaveLength(0); // nichts geschrieben, kein Zustand verändert
    await b.close();
    const [s2] = await run(a, '2026-09-25', '2026-09-25', false, undefined, true);
    expect(s2!.dbDigest).toBe(s2!.digest);
    await a.close();
  });

  it('W1: Randminute ohne bar_1m-Zeile wird beim Nachbartag als missing aufgelöst', async () => {
    const dir = archive({ dropAggMinute: { day: '2026-09-12', minute: 1439 } });
    await run(new PostgresWriter(cfg, BTC), '2026-09-12', '2026-09-12', false, dir);
    const [p] = await sql`
      SELECT state, edge_last_pending, min_missing FROM data_day WHERE day = '2026-09-12'`;
    expect(p).toMatchObject({ state: 'final_ok', edge_last_pending: true });
    await run(new PostgresWriter(cfg, BTC), '2026-09-13', '2026-09-13', false, dir);
    const [r] = await sql`
      SELECT state, edge_last_pending, edge_pending, min_missing FROM data_day WHERE day = '2026-09-12'`;
    expect(r).toMatchObject({ state: 'final_bad', edge_last_pending: false, min_missing: 1 });
    const iss = await sql`SELECT kind FROM data_minute_issue WHERE ts = '2026-09-12 23:59:00+00'`;
    expect(iss.map((x) => x.kind)).toEqual(['missing']);
    const bar = await sql`SELECT 1 FROM bar_1m WHERE ts = '2026-09-12 23:59:00+00'`;
    expect(bar).toHaveLength(0);
  });

  it('W2: Resume über einen Bereich löst offene Randminuten übersprungener Tage auf', async () => {
    await run(new PostgresWriter(cfg, BTC), '2026-09-01', '2026-09-03', false);
    const [p] = await sql`SELECT edge_last_pending FROM data_day WHERE day = '2026-09-03'`;
    expect(p!.edge_last_pending).toBe(true);
    const res = await run(new PostgresWriter(cfg, BTC), '2026-09-01', '2026-09-05', false);
    expect(res.map((s) => s.skipped)).toEqual([true, true, true, false, false]);
    const [r] = await sql`
      SELECT edge_last_pending, edge_pending, min_shift FROM data_day WHERE day = '2026-09-03'`;
    expect(r!.edge_last_pending).toBe(false);
    const [b] = await sql`SELECT check_state FROM bar_1m WHERE ts = '2026-09-03 23:59:00+00'`;
    expect(b!.check_state).toBe(2);
  });

  it('Digest-Textform gegen Postgres verankert (inkl. bigint > 2^53 und negativer Werte)', async () => {
    const t = Date.UTC(2026, 7, 1); // eigener Tag ohne andere Zeilen
    const fb = new FpBuilder();
    fb.push(t, 6195920, 2147483647, 0, 1, 0);
    fb.push(t + 60_000, 6195930, 0, 7, 0, 3);
    await sql`INSERT INTO fp_1m VALUES (1, ${new Date(t)}, 6195920, 2147483647, 0, 1, 0),
                                       (1, ${new Date(t + 60_000)}, 6195930, 0, 7, 0, 3)`;
    const [f] = await sql`SELECT day_digest('fp_1m', 1::smallint, '2026-08-01') AS d`;
    expect(f!.d).toBe(fpDigest(1, fb.build()));
    const bar: Bar = {
      ts: t,
      open: 1,
      high: 3,
      low: 1,
      close: 2,
      buyQ: 9007199254740991,
      sellQ: 5,
      buyA: 1,
      sellA: 2,
      notional: 35500000000000001n,
      firstAggId: 3533987381,
      lastAggId: 3537300026,
      firstTradeMs: t + 58,
      lastTradeMs: t + 86_399_999,
      runMax: 3,
      runMin: -9007199254740991,
      dFromLow: -1,
      dFromHigh: -2,
    };
    await sql.unsafe(
      `INSERT INTO bar_1d VALUES (1, $1, 1, 3, 1, 2, 9007199254740991, 5, 1, 2, 35500000000000001,
         3533987381, 3537300026, $2, $3, 3, -9007199254740991, -1, -2)`,
      [new Date(t), String(t + 58), String(t + 86_399_999)],
    );
    const [b] = await sql`SELECT day_digest('bar_1d', 1::smallint, '2026-08-01') AS d,
                                 notional::text AS n FROM bar_1d WHERE ts = ${new Date(t)}`;
    expect(b!.n).toBe('35500000000000001');
    expect(b!.d).toBe(barDigest(1, [bar]));
  });
});

describe('Review N1–N6 (DB)', () => {
  const jobsPaused = async () =>
    Number(
      (
        await sql`SELECT count(*) FILTER (WHERE NOT scheduled)::int AS n FROM timescaledb_information.jobs
                   WHERE proc_name = 'policy_compression' AND hypertable_schema = 'public'`
      )[0]!.n,
    );

  it('N1: Backfill pausiert Jobs, konvertiert fertige Chunks und aktiviert die Jobs beim Schließen', async () => {
    const w = new PostgresWriter(cfg, BTC, { backfill: true });
    await run(w, '2026-09-26', '2026-09-27', false);
    expect(await jobsPaused()).toBe(0);
    const [c] = await sql`
      SELECT bool_and(is_compressed) AS all FROM timescaledb_information.chunks
       WHERE hypertable_name = 'fp_1m' AND range_start >= '2026-09-26' AND range_end <= '2026-09-28'`;
    expect(c!.all).toBe(true);
  });

  it('N1: nach kill -9 eines Backfills repariert der nächste open() die pausierten Jobs', async () => {
    const child = spawn(
      process.execPath,
      [
        'apps/importer/src/main.ts',
        'import',
        '--symbol',
        'BTCUSDT',
        '--month',
        '2026-09',
        '--prefer',
        'monthly',
        '--db',
        '--backfill',
        '--force',
        '--quiet',
        '--data-dir',
        dataDir,
      ],
      { env: { ...process.env, OF_DB_NAME: cfg.database }, stdio: 'ignore' },
    );
    try {
      for (let i = 0; i < 300 && (await jobsPaused()) === 0; i++) await sleep(100);
      expect(await jobsPaused()).toBeGreaterThan(0);
    } finally {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
    await sleep(300); // Sitzung des getöteten Prozesses endet
    expect(await jobsPaused()).toBeGreaterThan(0);
    const logs: string[] = [];
    const w = new PostgresWriter(cfg, BTC, { log: (l) => logs.push(l) });
    await w.open();
    await w.close();
    expect(await jobsPaused()).toBe(0);
    expect(logs.some((l) => l.includes('pausierte Columnstore-Jobs'))).toBe(true);
  });

  it('N2: geänderter Vortag → Folgetag wird kaskadiert neu klassifiziert; ohne Quellen stale', async () => {
    const bad = archive({ dropAggMinute: { day: '2026-09-14', minute: 1439 } });
    await run(new PostgresWriter(cfg, BTC), '2026-09-14', '2026-09-15', false, bad);
    const [b15] = await sql`SELECT state FROM data_day WHERE day = '2026-09-15'`;
    expect(b15!.state).toBe('final_bad'); // Minute 0: Übertrag fehlt
    const good = archive();
    const res = await run(new PostgresWriter(cfg, BTC), '2026-09-14', '2026-09-14', false, good);
    expect(res.map((x) => [x.day, x.decision])).toEqual([
      ['2026-09-14', 'write'],
      ['2026-09-15', 'write'],
    ]);
    const [g15] =
      await sql`SELECT state, stale, carry_in_q, immutable FROM data_day WHERE day = '2026-09-15'`;
    expect(g15).toMatchObject({ state: 'final_ok', stale: false, carry_in_q: '9' });
    // ohne Quelldateien für den Folgetag: stale statt stiller Inkonsistenz
    const only14 = archive({ dailyDays: ['2026-09-14'], monthly: false });
    await run(new PostgresWriter(cfg, BTC), '2026-09-14', '2026-09-14', false, bad);
    const r = await run(new PostgresWriter(cfg, BTC), '2026-09-14', '2026-09-14', false, only14);
    expect(r).toHaveLength(1);
    const [s15] = await sql`SELECT stale, immutable FROM data_day WHERE day = '2026-09-15'`;
    expect(s15).toMatchObject({ stale: true, immutable: false });
  });

  it('N4: Fehler in Transaktion B stellt den Zustand vor einem früheren Abbruch wieder her', async () => {
    await run(new PostgresWriter(cfg, BTC), '2026-09-18', '2026-09-18');
    const [before] = await sql`SELECT state, digest FROM data_day WHERE day = '2026-09-18'`;
    // früherer Abbruch nach Transaktion A
    await sql`UPDATE data_day SET state = 'importing', state_before_import = 'final_ok' WHERE day = '2026-09-18'`;
    const w = new PostgresWriter(cfg, BTC);
    (w as unknown as { upsertRawDay: () => Promise<void> }).upsertRawDay = async () => {
      throw new Error('boom');
    };
    await w.open();
    await expect(
      new Importer({
        dataDir,
        spec: BTC,
        firstDay: parseDay('2026-09-18'),
        lastDay: parseDay('2026-09-18'),
        prefer: 'monthly',
        neighbours: false,
        writer: w,
        importerVersion: 'int-test',
        sidecar: false,
        log: () => {},
      }).run(),
    ).rejects.toThrow(/boom/);
    await w.close();
    const [after] = await sql`SELECT state, digest FROM data_day WHERE day = '2026-09-18'`;
    expect(after).toMatchObject({ state: before!.state, digest: before!.digest });
  });

  it('N4: Konvertierungsfehler nach dem Commit setzt den neuen Zustand nicht zurück', async () => {
    const logs: string[] = [];
    const w = new PostgresWriter(cfg, BTC, { backfill: true, log: (l) => logs.push(l) });
    let calls = 0;
    const orig = w.convertFinishedChunks.bind(w);
    w.convertFinishedChunks = async (u: number) => {
      if (++calls === 1) throw new Error('lock timeout (simuliert)');
      return orig(u);
    };
    const [s] = await run(w, '2026-09-19', '2026-09-19', false);
    expect(s!.decision).toBe('write');
    const [d] = await sql`SELECT state FROM data_day WHERE day = '2026-09-19'`;
    expect(d!.state).toBe('final_ok');
    expect(logs.some((l) => l.includes('Konvertierung nach 2026-09-19 fehlgeschlagen'))).toBe(true);
  });

  it('N6: immutable erst ohne offene Randminute', async () => {
    await run(new PostgresWriter(cfg, BTC), '2026-09-22', '2026-09-22', false);
    const [a] = await sql`SELECT immutable FROM data_day WHERE day = '2026-09-22'`;
    expect(a!.immutable).toBe(false);
    await run(new PostgresWriter(cfg, BTC), '2026-09-21', '2026-09-23');
    const [b] = await sql`SELECT immutable FROM data_day WHERE day = '2026-09-22'`;
    expect(b!.immutable).toBe(true);
  });
});
