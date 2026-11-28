// Teilübertragung der Big-Trades-Historie (deploy/transfer-bigtrades.sh, DB-Teil): Export
// (deploy/bin/bigtrades-export.sh) aus einer Quell-DB mit Digest-Version 2 und Einspielen
// (deploy/bin/bigtrades-apply.sh) in eine Ziel-DB, die dieselben Tage in Version 1 hält – so, wie
// Migration 0017 sie auf dem Server hinterlässt (keine big_order-Zeilen, Ordersummen NULL, Digest =
// day_digest_all_v(…, 1)). Beide DBs auf dem Wegwerf-Server von scripts/test-db-throwaway.sh, die
// Skripte rufen psql per `docker exec` im Wegwerf-Container auf (OF_TEST_DB_CONTAINER; ohne die
// Variable wird die Suite übersprungen: `npm run test:db:throwaway`).
//
// Fälle: Probelauf ändert nichts; abweichende Untergrenze, belegter Importer-Lock und
// Finalisierungsfenster brechen vor dem Schreiben ab; Verbindungsabbruch mitten in einem Tag lässt
// nur ganze Tage zurück; gescheiterte v2-Gegenprobe rollt den Tag zurück, ein gesperrter Tag bleibt
// unverändert (busy); der Lauf überträgt die passenden Tage (v2 = Quelle), überspringt den Tag mit
// abweichendem v1-Tabelleninhalt und den schon v2 gespeicherten; danach keine teilweise
// komprimierten Chunks; Wiederholung ist ein No-op; verify meldet genau den übersprungenen Tag.
import { getSymbol, parseDay, type DbConfig, parseConfig } from '@orderflow/core';
import { connect, dropAndCreateDatabase, migrateUp, type Sql } from '@orderflow/db';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Importer } from '../src/pipeline.ts';
import { PostgresWriter } from '../src/writer/postgres.ts';
import { tmpDir } from './helpers.ts';
import { archive } from './synth.ts';

const CONTAINER = process.env.OF_TEST_DB_CONTAINER;
const suite = CONTAINER ? describe : describe.skip;
const REPO = resolve(import.meta.dirname, '../../..');
const base = parseConfig(process.env).db;
const srcCfg: DbConfig = { ...base, database: `${base.database}_test_bt_src` };
const dstCfg: DbConfig = { ...base, database: `${base.database}_test_bt_dst` };
const dst2Cfg: DbConfig = { ...base, database: `${base.database}_test_bt_dst2` };
const BTC = getSymbol('BTCUSDT');
const FLOOR = 30_000_000; // wie pgwriter.int.test.ts (synthetische Einzel-aggTrades)
const DAYS = ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14'];
const V1_DAYS = ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-14']; // 09-13 bleibt v2
const TAMPERED = '2026-09-12';
const NOON = '2026-11-28T12:00:00Z'; // feste Uhr außerhalb des Finalisierungsfensters
let src: Sql;
let dst: Sql;
let work: string;
let dataDir: string;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}
function sh(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync('bash', args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 300_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function exportTo(name: string, extra: string[] = []): string {
  const dir = join(work, name);
  const r = sh(['deploy/bin/bigtrades-export.sh', dir, ...extra], {
    OF_SRC_CONTAINER: CONTAINER!,
    OF_SRC_DB: srcCfg.database,
  });
  expect(r.status, r.stderr).toBe(0);
  return dir;
}
function apply(dir: string, mode: string, extra: string[] = [], env: Record<string, string> = {}) {
  return sh([join(dir, 'bigtrades-apply.sh'), dir, mode, ...extra], {
    OF_DB_CONTAINER: CONTAINER!,
    OF_BT_DB: dstCfg.database,
    OF_BT_NOW: NOON,
    ...env,
  });
}
const dayLines = (out: string, verdict: string) =>
  out
    .split('\n')
    .filter((l) => l.startsWith('day|') && l.split('|')[3] === verdict)
    .map((l) => l.split('|')[2]);

/** Fingerabdruck des Ziels: data_day, big_order, Chunk-Zustände. */
async function fingerprint(sql: Sql): Promise<string> {
  const [r] = await sql`
    SELECT (SELECT md5(string_agg(ROW(sym_id, day, state, version, digest, digest_version, orders_n,
                                      orders_notional, big_floor_n)::text, ',' ORDER BY sym_id, day))
              FROM data_day) AS dd,
           (SELECT count(*)::text || ':' || coalesce(sum(notional), 0)::text FROM big_order) AS bo,
           (SELECT string_agg(k.relid::regclass::text || '=' || k.status, ',' ORDER BY k.relid::regclass::text)
              FROM _timescaledb_catalog.chunk k) AS ch`;
  return JSON.stringify(r);
}
async function partialChunks(sql: Sql): Promise<number> {
  const [r] =
    await sql`SELECT count(*)::int AS n FROM _timescaledb_catalog.chunk WHERE (status & 8) <> 0`;
  return r!.n as number;
}
async function dayRow(sql: Sql, day: string) {
  const [r] = await sql`
    SELECT state, version, digest, digest_version, orders_n::text, big_floor_n::text,
           day_digest_all_v(sym_id, day, coalesce(digest_version, 2)::int) AS actual,
           (SELECT count(*)::int FROM big_order b WHERE b.sym_id = d.sym_id
              AND b.ts >= d.day::timestamp AT TIME ZONE 'UTC' AND b.ts < (d.day + 1)::timestamp AT TIME ZONE 'UTC') AS n_big
      FROM data_day d WHERE sym_id = ${BTC.symId} AND day = ${day}::date`;
  return r!;
}

async function prepare(cfg: DbConfig, dataDir: string, lastDay = DAYS.at(-1)!): Promise<Sql> {
  await dropAndCreateDatabase(cfg);
  const sql = connect(cfg);
  await migrateUp(sql);
  await sql`INSERT INTO symbol (sym_id, name, price_unit, price_decimals, tick_ref_units, qty_unit,
                                qty_decimals, data_from, big_floor_n)
            VALUES (${BTC.symId}, ${BTC.name}, 0.01, 2, 10, 0.001, 3, ${BTC.dataFrom}::date, ${FLOOR})`;
  const w = new PostgresWriter(cfg, BTC);
  await w.open();
  try {
    await new Importer({
      dataDir,
      spec: BTC,
      firstDay: parseDay(DAYS[0]!),
      lastDay: parseDay(lastDay),
      prefer: 'auto',
      neighbours: true,
      writer: w,
      importerVersion: 'int-test',
      sidecar: false,
      log: () => {},
    }).run();
  } finally {
    await w.close();
  }
  return sql;
}

suite('transfer-bigtrades (Export → Ziel in Digest-Version 1)', () => {
  beforeAll(async () => {
    work = tmpDir('bt-');
    dataDir = archive();
    src = await prepare(srcCfg, dataDir);
    dst = await prepare(dstCfg, dataDir);
    // Ziel wie nach Migration 0017 auf dem Server: Tage in Version 1 ohne Order-Daten
    await dst.begin(async (tx) => {
      await tx`SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0`;
      for (const d of V1_DAYS) {
        await tx`DELETE FROM big_order WHERE sym_id = ${BTC.symId}
                   AND ts >= ${d}::date::timestamp AT TIME ZONE 'UTC'
                   AND ts < (${d}::date + 1)::timestamp AT TIME ZONE 'UTC'`;
        await tx`UPDATE data_day SET orders_n = NULL, orders_notional = NULL, big_floor_n = NULL,
                        digest = day_digest_all_v(sym_id, day, 1), digest_version = 1
                  WHERE sym_id = ${BTC.symId} AND day = ${d}::date`;
      }
      // 09-12: Aggregattabelle weicht ab (gespeicherter v1-Digest bleibt der alte)
      await tx`UPDATE bar_1m SET buy_q = buy_q + 1
                WHERE sym_id = ${BTC.symId} AND ts = ${TAMPERED}::date::timestamp AT TIME ZONE 'UTC' + interval '12 hours'`;
    });
    // alle kalten Chunks in den Columnstore: der Lauf schreibt dann per DML in komprimierte Chunks
    await dst`SELECT of_recompress_chunk(format('%I.%I', c.chunk_schema, c.chunk_name)::regclass)
                FROM timescaledb_information.chunks c
                JOIN timescaledb_information.hypertables h USING (hypertable_schema, hypertable_name)
               WHERE h.compression_enabled AND c.range_end <= now() - of_hot_margin()`;
  }, 300_000);
  afterAll(async () => {
    await src?.end();
    await dst?.end();
  });

  it('Probelauf (dry-run): Urteile je Tag, nichts geändert', async () => {
    const dir = exportTo('manifest', ['--manifest-only']);
    const before = await fingerprint(dst);
    const r = apply(dir, 'dry-run');
    expect(r.status, r.stderr).toBe(2); // ein Tag übersprungen
    expect(dayLines(r.stdout, 'would')).toEqual(['2026-09-10', '2026-09-11', '2026-09-14']);
    expect(dayLines(r.stdout, 'same')).toEqual(['2026-09-13']);
    expect(dayLines(r.stdout, 'skip')).toEqual([TAMPERED]);
    expect(r.stdout).toContain('Tabelleninhalt v1');
    expect(await fingerprint(dst)).toBe(before);
    // ein Lauf mit einer Nutzlast ohne Orders wird verweigert
    const m = apply(dir, 'apply');
    expect(m.status).toBe(3);
    expect(m.stderr).toContain('manifest');
    expect(await fingerprint(dst)).toBe(before);
  }, 120_000);

  it('Abbruch vor dem Schreiben: Untergrenze, Importer-Lock, Fenster', async () => {
    const dir = exportTo('full');
    const before = await fingerprint(dst);
    await dst`UPDATE symbol SET big_floor_n = ${FLOOR * 2} WHERE sym_id = ${BTC.symId}`;
    const f = apply(dir, 'apply');
    await dst`UPDATE symbol SET big_floor_n = ${FLOOR} WHERE sym_id = ${BTC.symId}`;
    expect(f.status).toBe(3);
    expect(f.stdout).toContain('floor|BTCUSDT|lokal=30000000|ziel=60000000|ABWEICHEND');
    expect(await fingerprint(dst)).toBe(before);

    const holder = connect(dstCfg);
    try {
      await holder`SELECT pg_advisory_lock(7042025)`;
      const l = apply(dir, 'apply', ['--lock-wait', '1']);
      expect(l.status).toBe(3);
      expect(l.stderr).toContain('Importer-Lock belegt');
      expect(await fingerprint(dst)).toBe(before);
    } finally {
      await holder.end();
    }

    const w = apply(dir, 'apply', [], { OF_BT_NOW: '2026-11-28T05:30:00Z' });
    expect(w.status).toBe(3);
    expect(w.stdout).toContain('check|fenster|vor_finalisierung');
    expect(await fingerprint(dst)).toBe(before);
  }, 120_000);

  it('Aufrufer bricht ab (SIGTERM während des Wartens auf den Lock): Server-Sitzung endet', async () => {
    const dir = join(work, 'full');
    const before = await fingerprint(dst);
    const holder = connect(dstCfg);
    try {
      await holder`SELECT pg_advisory_lock(7042025)`;
      const child = spawn(
        'bash',
        [join(dir, 'bigtrades-apply.sh'), dir, 'apply', '--lock-wait', '60'],
        {
          cwd: REPO,
          env: {
            ...process.env,
            OF_DB_CONTAINER: CONTAINER!,
            OF_BT_DB: dstCfg.database,
            OF_BT_NOW: NOON,
          },
          stdio: 'ignore',
        },
      );
      const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
      const sessions = async () =>
        (
          (await dst`SELECT count(*)::int AS n FROM pg_stat_activity
                     WHERE application_name = 'orderflow-bigtrades'`) as unknown as [{ n: number }]
        )[0].n;
      for (let i = 0; i < 100 && (await sessions()) === 0; i++) await sleep(100);
      expect(await sessions()).toBe(1);
      child.kill('SIGTERM');
      expect(await exited).toBe(3);
      for (let i = 0; i < 50 && (await sessions()) > 0; i++) await sleep(100);
      expect(await sessions()).toBe(0);
    } finally {
      await holder.end();
    }
    expect(await fingerprint(dst)).toBe(before);
  }, 120_000);

  it('Verbindungsabbruch mitten im zweiten Tag: nur ganze Tage, Lock frei', async () => {
    const dir = join(work, 'full');
    const v11 = await dayRow(dst, '2026-09-11');
    const r = apply(dir, 'apply', [], { OF_BT_ABORT_AFTER: '1' });
    expect(r.status).toBe(3);
    expect(dayLines(r.stdout, 'ok')).toEqual(['2026-09-10']);
    // 09-10 vollständig in v2, 09-11 unverändert (v1, keine big_order-Zeilen, nicht „importing“)
    const d10 = await dayRow(dst, '2026-09-10');
    expect(d10.digest_version).toBe(2);
    expect(d10.actual).toBe(d10.digest);
    expect(await dayRow(dst, '2026-09-11')).toEqual(v11);
    const [l] =
      await dst`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 7042025`;
    expect(l!.n).toBe(0);
    // der komprimierte big_order-Chunk ist nach dem DML von 09-10 teilweise komprimiert (lesbar,
    // konsistent); den Abschluss holt der nächste Lauf nach (Test „Lauf“: partial_chunks|0)
    expect(await partialChunks(dst)).toBeGreaterThan(0);
  }, 120_000);

  it('v2-Gegenprobe scheitert → Tag zurückgerollt (fail); gesperrter Tag → busy, unverändert', async () => {
    // Nutzlast verfälschen: eine big_order-Zeile von 09-11 mit anderer Menge (Zählungen stimmen)
    const dir = join(work, 'bad');
    cpSync(join(work, 'full'), dir, { recursive: true });
    const lines = gunzipSync(readFileSync(join(dir, 'payload.sql.gz')))
      .toString('utf8')
      .split('\n');
    const i = lines.findIndex((x) => /^1\t2026-09-11 \d\d:/.test(x));
    const f = lines[i]!.split('\t');
    f[7] = String(Number(f[7]) + 1); // qty
    lines[i] = f.join('\t');
    writeFileSync(join(dir, 'payload.sql.gz'), gzipSync(lines.join('\n')));
    const b11 = await dayRow(dst, '2026-09-11');
    const b14 = await dayRow(dst, '2026-09-14');
    const holder = await dst.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT 1 FROM data_day WHERE sym_id = ${BTC.symId} AND day = '2026-09-14' FOR UPDATE`;
      const r = apply(dir, 'apply');
      expect(r.status).toBe(1);
      expect(dayLines(r.stdout, 'fail')).toEqual(['2026-09-11']);
      expect(r.stdout).toContain('v2-Digest ≠ lokal (big_order abweichend, order_day gleich)');
      expect(dayLines(r.stdout, 'busy')).toEqual(['2026-09-14']);
      expect(r.stderr).toMatch(/^ergebnis\|exit=1\|fail=1\|busy=1\|/m);
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect(await dayRow(dst, '2026-09-11')).toEqual(b11);
    expect(await dayRow(dst, '2026-09-14')).toEqual(b14);
  }, 120_000);

  it('Lauf: passende Tage v2 = Quelle, Abweichungen übersprungen, keine teilweisen Chunks', async () => {
    const dir = join(work, 'full');
    const before = Object.fromEntries(
      await Promise.all(DAYS.map(async (d) => [d, await dayRow(dst, d)] as const)),
    );
    const r = apply(dir, 'apply');
    expect(r.status, r.stderr).toBe(2); // 09-12 übersprungen
    expect(dayLines(r.stdout, 'ok')).toEqual(['2026-09-11', '2026-09-14']);
    expect(dayLines(r.stdout, 'same')).toEqual(['2026-09-10', '2026-09-13']);
    expect(dayLines(r.stdout, 'skip')).toEqual([TAMPERED]);
    expect(r.stdout).toMatch(/^partial_chunks\|0$/m);
    expect(r.stdout).toMatch(/^hot_compressed_chunks\|0$/m);
    expect(await partialChunks(dst)).toBe(0);
    for (const d of ['2026-09-10', '2026-09-11', '2026-09-13', '2026-09-14']) {
      const s = await dayRow(src, d);
      const t = await dayRow(dst, d);
      expect(t.digest_version).toBe(2);
      expect(t.digest).toBe(s.digest);
      expect(t.actual).toBe(s.digest);
      expect(t.n_big).toBe(s.n_big);
      expect(t.orders_n).toBe(s.orders_n);
    }
    // version + 1 je übertragenem Tag (neue dataVersion der API), sonst unverändert
    expect((await dayRow(dst, '2026-09-11')).version).toBe(before['2026-09-11']!.version + 1);
    expect((await dayRow(dst, '2026-09-13')).version).toBe(before['2026-09-13']!.version);
    expect(await dayRow(dst, TAMPERED)).toEqual(before[TAMPERED]);
    // alle kalten big_order-Chunks wieder vollständig im Columnstore
    const [c] = await dst`
      SELECT count(*) FILTER (WHERE NOT is_compressed)::int AS raw, count(*)::int AS n
        FROM timescaledb_information.chunks
       WHERE hypertable_name = 'big_order' AND range_end <= now() - of_hot_margin()`;
    expect(c!.n).toBeGreaterThan(0);
    expect(c!.raw).toBe(0);
  }, 120_000);

  it('Wiederholung ist ein No-op; verify meldet nur den übersprungenen Tag', async () => {
    const dir = join(work, 'full');
    const before = await fingerprint(dst);
    const r = apply(dir, 'apply');
    expect(r.status).toBe(2);
    expect(dayLines(r.stdout, 'ok')).toEqual([]);
    expect(dayLines(r.stdout, 'same')).toHaveLength(4);
    expect(await fingerprint(dst)).toBe(before);
    const v = apply(join(work, 'manifest'), 'verify');
    expect(v.status).toBe(1);
    expect(
      v.stdout.split('\n').filter((l) => l.startsWith('verify|') && !l.endsWith('|match')),
    ).toEqual([`verify|BTCUSDT|${TAMPERED}|v1`]);
    expect(await fingerprint(dst)).toBe(before);
  }, 120_000);

  it('Rücknahme (revert): ok-Tage zurück auf v1, Rest unverändert; erneuter Lauf stellt v2 wieder her', async () => {
    const dir = join(work, 'revert');
    cpSync(join(work, 'manifest'), dir, { recursive: true });
    // Liste passt nicht zur Nutzlast → Abbruch ohne Änderung
    const before = await fingerprint(dst);
    writeFileSync(join(dir, 'revert.tsv'), 'BTCUSDT\t2026-09-20\n');
    const bad = apply(dir, 'revert');
    expect(bad.status).toBe(3);
    expect(bad.stderr).toContain('Rücknahmeliste');
    expect(await fingerprint(dst)).toBe(before);
    // 09-11 wurde übertragen; 09-12 ist v1 (nicht der übertragene Stand) → skip
    writeFileSync(join(dir, 'revert.tsv'), `BTCUSDT\t2026-09-11\nBTCUSDT\t${TAMPERED}\n`);
    const b11 = await dayRow(dst, '2026-09-11');
    const b12 = await dayRow(dst, TAMPERED);
    const r = apply(dir, 'revert');
    expect(r.status, r.stderr).toBe(2);
    expect(dayLines(r.stdout, 'reverted')).toEqual(['2026-09-11']);
    expect(dayLines(r.stdout, 'skip')).toEqual([TAMPERED]);
    expect(r.stderr).toMatch(/^ergebnis\|exit=2\|/m);
    const a11 = await dayRow(dst, '2026-09-11');
    expect(a11).toMatchObject({ digest_version: 1, orders_n: null, big_floor_n: null, n_big: 0 });
    expect(a11.actual).toBe(a11.digest);
    expect(a11.version).toBe(b11.version + 1);
    expect(await dayRow(dst, TAMPERED)).toEqual(b12);
    expect(await partialChunks(dst)).toBe(0);
    // wieder einspielen
    const again = apply(join(work, 'full'), 'apply');
    expect(again.status).toBe(2);
    expect(dayLines(again.stdout, 'ok')).toEqual(['2026-09-11']);
    expect((await dayRow(dst, '2026-09-11')).digest).toBe(b11.digest);
    expect(await partialChunks(dst)).toBe(0);
  }, 120_000);

  it('Ziel ohne historische big_order-Chunks; Abweichungen Zustand/Klassifikation/v2/fehlender Tag', async () => {
    // Wie der Server: big_order erst seit 0017, für die Historie gibt es keinen Chunk
    const t = await prepare(dst2Cfg, dataDir, '2026-09-13'); // 09-14 fehlt auf dem Ziel
    try {
      await t.begin(async (tx) => {
        await tx`SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0`;
        await tx`DELETE FROM big_order`;
        await tx`UPDATE data_day SET orders_n = NULL, orders_notional = NULL, big_floor_n = NULL,
                        digest = day_digest_all_v(sym_id, day, 1), digest_version = 1`;
        await tx`UPDATE data_day SET state = 'final_bad' WHERE day = '2026-09-11'`;
        await tx`UPDATE data_day SET quality_digest = 'anders' WHERE day = '2026-09-12'`;
        await tx`UPDATE data_day SET digest = repeat('0', 64), digest_version = 2 WHERE day = '2026-09-13'`;
      });
      await t`SELECT drop_chunks('big_order', older_than => now())`;
      const [c0] =
        await t`SELECT count(*)::int AS n FROM timescaledb_information.chunks WHERE hypertable_name = 'big_order'`;
      expect(c0!.n).toBe(0);
      const r = apply(join(work, 'full'), 'apply', [], { OF_BT_DB: dst2Cfg.database });
      expect(r.status, r.stderr).toBe(2);
      expect(dayLines(r.stdout, 'ok')).toEqual(['2026-09-10']);
      const skips = r.stdout
        .split('\n')
        .filter((l) => l.startsWith('day|') && l.split('|')[3] === 'skip');
      expect(skips.map((l) => `${l.split('|')[2]} ${l.split('|')[4]}`)).toEqual([
        '2026-09-11 Zustand final_bad ≠ lokal final_ok',
        '2026-09-12 Klassifikation (quality_digest) ≠ lokal',
        '2026-09-13 Ziel hat schon Digest-Version 2 mit anderem Digest/Zustand (final_ok)',
        '2026-09-14 Tag fehlt auf dem Ziel',
      ]);
      // neuer kalter Chunk angelegt und vollständig komprimiert
      expect(r.stdout).toMatch(/^chunk\|.*\|columnstore\|/m);
      const [c] = await t`
        SELECT count(*)::int AS n, count(*) FILTER (WHERE is_compressed)::int AS z
          FROM timescaledb_information.chunks WHERE hypertable_name = 'big_order'`;
      expect(c).toEqual({ n: 1, z: 1 });
      expect(await partialChunks(t)).toBe(0);
      const s10 = await dayRow(src, '2026-09-10');
      const t10 = await dayRow(t, '2026-09-10');
      expect(t10.actual).toBe(s10.digest);
      expect(t10.n_big).toBe(s10.n_big);
    } finally {
      await t.end();
    }
  }, 120_000);
});
