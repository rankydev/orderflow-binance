// Schutz destruktiver Datenbankbefehle (Review): Produktionsmarker, down nur mit --yes und bei
// vorhandenen Tagesdaten nur mit --destroy-data. In einer Wegwerf-Datenbank.
import { parseConfig, type DbConfig } from '@orderflow/core';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../src/connection.ts';
import { isProductionDatabase, PRODUCTION_MARKER } from '../src/guard.ts';
import { dropAndCreateDatabase } from '../src/migrate.ts';

const base = parseConfig(process.env).db;
const cfg: DbConfig = { ...base, database: `${base.database}_test_cliguard` };
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const run = promisify(execFile);

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, OF_DB_NAME: cfg.database },
    });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout + x.stderr };
  }
}

async function admin<T>(f: (sql: ReturnType<typeof connect>) => Promise<T>): Promise<T> {
  const sql = connect(cfg, 'postgres');
  try {
    return await f(sql);
  } finally {
    await sql.end();
  }
}
const mark = (on: boolean) =>
  admin((sql) =>
    sql.unsafe(`COMMENT ON DATABASE ${cfg.database} IS ${on ? `'${PRODUCTION_MARKER}'` : 'NULL'}`),
  );

beforeAll(async () => {
  expect((await cli('reset', '--yes')).code).toBe(0); // legt an und migriert
});
afterAll(async () => {
  await mark(false).catch(() => {});
  await admin((sql) => sql`DROP DATABASE IF EXISTS ${sql(cfg.database)} WITH (FORCE)`);
});

describe('db-CLI: destruktive Befehle', () => {
  it('down ohne --yes verweigert', async () => {
    const r = await cli('down', '1');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--yes/);
  });

  it('down mit Tagesdaten nur mit --destroy-data', async () => {
    const sql = connect(cfg);
    await sql`INSERT INTO symbol (sym_id, name, price_unit, price_decimals, tick_ref_units, qty_unit, qty_decimals, data_from)
              VALUES (1, 'BTCUSDT', 0.1, 1, 1, 0.001, 3, '2026-06-10')`;
    await sql`INSERT INTO data_day (sym_id, day, state) VALUES (1, '2026-09-01', 'importing')`;
    await sql.end();
    const r = await cli('down', '1', '--yes');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--destroy-data/);
  });

  it('Produktionsmarker: reset und down verweigert, auch mit allen Bestätigungen', async () => {
    await mark(true);
    expect(await admin((sql) => isProductionDatabase(sql, cfg.database))).toBe(true);
    const d = await cli('down', '1', '--yes', '--destroy-data');
    expect(d.code).toBe(1);
    expect(d.out).toMatch(/Produktionsmarker/);
    const r = await cli('reset', '--yes');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Produktionsmarker/);
    await expect(dropAndCreateDatabase(cfg)).rejects.toThrow(/Produktionsmarker/);
    // die Datenbank existiert noch mit ihren Daten
    const sql = connect(cfg);
    const [n] = await sql`SELECT count(*)::int AS n FROM data_day`;
    await sql.end();
    expect(n!.n).toBe(1);
    await mark(false);
  });

  it('ohne Marker, mit --yes --destroy-data: down läuft', async () => {
    const r = await cli('down', '1', '--yes', '--destroy-data');
    expect(r.code).toBe(0);
  });
});
