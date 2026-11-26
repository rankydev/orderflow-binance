// Statischer Abgleich ohne Datenbank: die SQL-Funktion day_digest (zuletzt definiert in Migration
// 0017) hasht genau die Spalten in genau der Reihenfolge, die der Importer
// (packages/core/src/digest.ts) verwendet, und day_digest_all_v kombiniert die Teile je
// Digest-Version in derselben Reihenfolge; Version 1 ist unverändert die Liste aus 0005.
import { DIGEST_COLUMNS, DIGEST_TABLES, DIGEST_TABLES_V1, DIGEST_VERSION } from '@orderflow/core';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/migrate.ts';
import { loadMigrations } from '../src/migrations.ts';

const all = loadMigrations(MIGRATIONS_DIR);
/** Up-SQL der letzten Migration, die day_digest (neu) definiert. */
const sql = all.filter((m) => /FUNCTION day_digest\(/.test(m.upSql)).at(-1)!.upSql;
const v1Sql = all.find((m) => m.name === 'day_digest')!.upSql;
const norm = (s: string) =>
  s
    .replace(/'\s*\n\s*'/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Spaltenliste je Tabelle aus dem CASE-Ausdruck der Funktion (plus der order_day-Zweig). */
function sqlColumns(): Record<string, string> {
  const out: Record<string, string> = {};
  const body = sql.slice(sql.indexOf('v_cols := CASE'), sql.indexOf('ELSE NULL'));
  const re = /WHEN p_table (?:IN \(([^)]*)\)|= '(\w+)')\s+THEN ((?:'[^']*'\s*)+)/g;
  for (const m of body.matchAll(re)) {
    const tables = (m[1] ?? `'${m[2]}'`).split(',').map((t) => t.trim().replace(/'/g, ''));
    const cols = norm(m[3]!).replace(/^'|'$/g, '').replace(/' '/g, '');
    for (const t of tables) out[t] = cols;
  }
  const od = /IF p_table = 'order_day' THEN[\s\S]*?ROW\(([^)]*)\)::text/.exec(sql);
  if (od) out.order_day = norm(od[1]!);
  return out;
}

/** Teile-Liste einer Digest-Version aus day_digest_all_v. */
function versionParts(v: number): string[] {
  const m = new RegExp(`WHEN ${v} THEN ARRAY\\[([^\\]]*)\\]`).exec(sql)!;
  return m[1]!.split(',').map((s) => s.trim().replace(/'/g, ''));
}

describe('day_digest (SQL) ↔ Importer-Digest', () => {
  it('gleiche Spalten in gleicher Reihenfolge, check_state nicht enthalten', () => {
    const cols = sqlColumns();
    expect(Object.keys(cols).sort()).toEqual([...DIGEST_TABLES].sort());
    for (const t of DIGEST_TABLES) expect(cols[t], t).toBe(DIGEST_COLUMNS[t]);
    expect(sql.replace(/--.*$/gm, '')).not.toMatch(/check_state/);
  });

  it('day_digest_all_v kombiniert je Version in der Reihenfolge von DIGEST_TABLES(_V1)', () => {
    expect(versionParts(1)).toEqual([...DIGEST_TABLES_V1]);
    expect(versionParts(2)).toEqual([...DIGEST_TABLES]);
    expect(DIGEST_VERSION).toBe(2);
    // day_digest_all ist die aktuelle Version
    expect(sql).toMatch(/SELECT day_digest_all_v\(p_sym, p_day, 2\)/);
  });

  it('Version 1 ist genau die Liste aus Migration 0005 (gespeicherte v1-Digests bleiben prüfbar)', () => {
    const arr = /unnest\(ARRAY\[([^\]]*)\]\)/s.exec(v1Sql)![1]!;
    expect(arr.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...DIGEST_TABLES_V1]);
  });
});
