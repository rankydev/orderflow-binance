import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/migrate.ts';
import { loadMigrations, planDown, planUp, type Migration } from '../src/migrations.ts';

const real = loadMigrations(MIGRATIONS_DIR);

describe('Migrationsdateien im Repo', () => {
  it('sind lückenlos nummeriert und haben je eine up- und down-Datei', () => {
    expect(real.map((m) => m.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017',
    ]);
    for (const m of real) {
      expect(m.upSql.trim().length).toBeGreaterThan(0);
      expect(m.downSql.trim().length).toBeGreaterThan(0);
    }
  });

  it('legen die Tabellen des Konzepts an (big_order ab P5, size_hist_* noch nicht)', () => {
    const created = real
      .flatMap((m) => [...m.upSql.matchAll(/CREATE TABLE (\w+)/g)].map((x) => x[1]))
      .concat(
        // per DO-Schleife erzeugte Tabellen
        [
          ...real
            .map((m) => m.upSql)
            .join('\n')
            .matchAll(/\('((?:fp|bar)_\w+)'/g),
        ].map((x) => x[1]),
      );
    for (const t of [
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
      'big_order',
    ]) {
      expect(created, t).toContain(t);
    }
    const all = real
      .map((m) => m.upSql)
      .join('\n')
      .replace(/--.*$/gm, ''); // Kommentare ignorieren
    for (const later of ['size_hist']) {
      expect(all).not.toContain(later);
    }
  });
});

const mig = (version: string, up = 'SELECT 1'): Migration => ({
  version,
  name: `m${version}`,
  upSql: up,
  downSql: 'SELECT 1',
  checksum: `sum-${up}`,
});
const applied = (m: Migration) => ({ version: m.version, name: m.name, checksum: m.checksum });

describe('Planung', () => {
  const ms = [mig('0001'), mig('0002'), mig('0003')];

  it('planUp liefert nur Ausstehende; angewendeter Stand ist ein No-op', () => {
    expect(planUp(ms, [])).toHaveLength(3);
    expect(planUp(ms, ms.slice(0, 2).map(applied)).map((m) => m.version)).toEqual(['0003']);
    expect(planUp(ms, ms.map(applied))).toEqual([]);
  });

  it('erkennt nachträglich geänderte Migrationen', () => {
    const changed = [mig('0001', 'SELECT 2'), ...ms.slice(1)];
    expect(() => planUp(changed, [applied(ms[0]!)])).toThrow(/Checksum/);
  });

  it('erkennt angewendete Migrationen, die im Repo fehlen', () => {
    expect(() => planUp(ms.slice(0, 1), ms.slice(0, 2).map(applied))).toThrow(/fehlt/);
  });

  it('planDown rollt jüngste zuerst zurück', () => {
    const a = ms.map(applied);
    expect(planDown(ms, a, 1).map((m) => m.version)).toEqual(['0003']);
    expect(planDown(ms, a, 2).map((m) => m.version)).toEqual(['0003', '0002']);
    expect(planDown(ms, a, 'all').map((m) => m.version)).toEqual(['0003', '0002', '0001']);
    expect(planDown(ms, [], 'all')).toEqual([]);
  });
});

describe('loadMigrations', () => {
  it('lehnt fehlende down-Dateien und falsche Namen ab', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0001_a.up.sql'), 'SELECT 1');
    expect(() => loadMigrations(dir)).toThrow(/beide/);
    writeFileSync(join(dir, '0001_a.down.sql'), 'SELECT 1');
    expect(loadMigrations(dir)).toHaveLength(1);
    writeFileSync(join(dir, 'bad.sql'), '');
    expect(() => loadMigrations(dir)).toThrow(/Ungültiger/);
  });
});
