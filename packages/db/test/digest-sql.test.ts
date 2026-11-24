// Statischer Abgleich ohne Datenbank: die SQL-Funktion day_digest (Migration 0005) hasht genau die
// Spalten in genau der Reihenfolge, die der Importer (packages/core/src/digest.ts) verwendet, und
// day_digest_all kombiniert die Tabellen in derselben Reihenfolge.
import { DIGEST_COLUMNS, DIGEST_TABLES } from '@orderflow/core';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/migrate.ts';
import { loadMigrations } from '../src/migrations.ts';

const sql = loadMigrations(MIGRATIONS_DIR).find((m) => m.name === 'day_digest')!.upSql;
const norm = (s: string) =>
  s
    .replace(/'\s*\n\s*'/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Spaltenliste je Tabelle aus dem CASE-Ausdruck der Funktion. */
function sqlColumns(): Record<string, string> {
  const out: Record<string, string> = {};
  const body = sql.slice(sql.indexOf('v_cols := CASE'), sql.indexOf('ELSE NULL'));
  const re = /WHEN p_table (?:IN \(([^)]*)\)|= '(\w+)')\s+THEN ((?:'[^']*'\s*)+)/g;
  for (const m of body.matchAll(re)) {
    const tables = (m[1] ?? `'${m[2]}'`).split(',').map((t) => t.trim().replace(/'/g, ''));
    const cols = norm(m[3]!).replace(/^'|'$/g, '').replace(/' '/g, '');
    for (const t of tables) out[t] = cols;
  }
  return out;
}

describe('day_digest (SQL) ↔ Importer-Digest', () => {
  it('gleiche Spalten in gleicher Reihenfolge, check_state nicht enthalten', () => {
    const cols = sqlColumns();
    expect(Object.keys(cols).sort()).toEqual([...DIGEST_TABLES].sort());
    for (const t of DIGEST_TABLES) expect(cols[t], t).toBe(DIGEST_COLUMNS[t]);
    expect(sql.replace(/--.*$/gm, '')).not.toMatch(/check_state/);
  });

  it('day_digest_all kombiniert in der Reihenfolge von DIGEST_TABLES', () => {
    const arr = /unnest\(ARRAY\[([^\]]*)\]\)/s.exec(sql)![1]!;
    expect(arr.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...DIGEST_TABLES]);
  });
});
