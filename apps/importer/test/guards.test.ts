// Review H2c: Skripte unter scripts/ oder bench/, die Chunks konvertieren, laufen nur gegen
// Test-Datenbanken. Der Vorfall vom 2026-11-24 (offene Chunks komprimiert) war ein solches Skript.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TEST_DB_PATTERN } from '../src/maintenance.ts';

const CONVERTS = /convert_to_(columnstore|rowstore)|\b(de)?compress_chunk\b|of_recompress_chunk/;

describe('Chunk-Konvertierung nur auf Test-Datenbanken (H2c)', () => {
  it('jedes Skript unter scripts/ oder bench/, das Chunks konvertiert, ruft assertTestDatabase', () => {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
    const files = execFileSync('git', ['ls-files'], { cwd: root })
      .toString()
      .split('\n')
      .filter((f) => /(^|\/)(scripts|bench)\//.test(f) && /\.(ts|js|mjs|cjs|sql|sh|py)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const bad = files.filter((f) => {
      const t = readFileSync(`${root}/${f}`, 'utf8');
      return CONVERTS.test(t) && !t.includes('assertTestDatabase');
    });
    expect(bad).toEqual([]);
  });

  it('Muster: Test-DBs ja, Entwicklungs- und Produktions-DB nein', () => {
    for (const d of [
      'orderflow_test',
      'orderflow_test_importer',
      'orderflow_test_recorder',
      'orderflow_probe_chunks',
    ])
      expect(TEST_DB_PATTERN.test(d), d).toBe(true);
    for (const d of ['orderflow', 'orderflow_prod', 'orderflow_tests', 'test'])
      expect(TEST_DB_PATTERN.test(d), d).toBe(false);
  });
});
