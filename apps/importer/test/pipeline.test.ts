// Ende-zu-Ende des Import-Ablaufs auf einem synthetischen Archiv (tmp, Vision-Layout): Tages- und
// Monatsdateien desselben Monats, Klines aus Einzelfills nach Fill-Zeit (wie Binance), Straddler
// mitten am Tag und über jede Tagesgrenze. Prüft Klassifikation, Tagesrand-Übertrag über Tages- und
// Monatsgrenzen, Monats-/Tagesdatei-Gleichwertigkeit (Digest, Klassifikation, Manifest),
// Sidecar-Manifest, Resume, Checksum-Abbruch und aggId-Löcher.
import { formatDay, getSymbol, parseDay } from '@orderflow/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseImportArgs } from '../src/main.ts';
import { Importer, type DaySummary, type Prefer } from '../src/pipeline.ts';
import { DryRunWriter } from '../src/writer/dryrun.ts';
import { tmpDir } from './helpers.ts';
import { archive } from './synth.ts';

const BTC = getSymbol('BTCUSDT');
async function run(
  dataDir: string,
  from: string,
  to: string,
  prefer: Prefer,
  extra: Partial<{ writer: DryRunWriter; sidecarDir: string; neighbours: boolean }> = {},
) {
  const writer = extra.writer ?? new DryRunWriter();
  const logs: string[] = [];
  const imp = new Importer({
    dataDir,
    spec: BTC,
    firstDay: parseDay(from),
    lastDay: parseDay(to),
    prefer,
    neighbours: extra.neighbours ?? true,
    writer,
    importerVersion: 'test',
    sidecar: extra.sidecarDir ? { dir: extra.sidecarDir } : false,
    log: (s) => logs.push(s),
  });
  const summaries = await imp.run();
  return { summaries, writer, logs };
}

const strip = (s: DaySummary) => ({
  digest: s.digest,
  digests: s.digests,
  quality: s.qualityDigest,
  manifest: s.manifest,
  counts: s.counts,
});

describe('Import-Ablauf (synthetisch)', () => {
  it('Straddler → genau diese Minuten shift; Übertrag über Tagesgrenzen; Nachbartage lösen die Ränder', async () => {
    const dir = archive({ monthly: true });
    const { summaries } = await run(dir, '2026-09-10', '2026-09-12', 'monthly');
    expect(summaries).toHaveLength(3);
    for (const s of summaries) {
      expect(s.state).toBe('final_ok');
      expect(s.counts.mismatch + s.counts.missing + s.counts.edge_pending).toBe(0);
      // Minuten 100, 101 (Straddler mitten am Tag), 0 (Übertrag vom Vortag), 1439 (Übertrag in den Folgetag);
      // an Tagen mit d % 5 = 0 zusätzlich Minute 0 → 1 (Straddler in Minute 0)
      const day = parseDay(s.day);
      const shiftMin = day % 5 === 0 ? 5 : 4;
      expect(s.counts.shift, s.day).toBe(shiftMin);
      expect(s.carryIn).toEqual({ q: 9, b: 9 });
      expect(s.carryOut).toEqual({ q: 9, b: 9 });
      expect(s.totals.identityQ && s.totals.identityB && s.totals.carryBoundsOk).toBe(true);
      expect(s.continuesPrev).toBe(true);
    }
  });

  it('Monats- und Tagesdatei liefern identische Digests, Klassifikation und Manifest (Monatserster, -letzter)', async () => {
    const dir = archive({ dailyDays: ['2026-09-01', '2026-09-15', '2026-09-30'] });
    for (const d of ['2026-09-01', '2026-09-15', '2026-09-30']) {
      const daily = (await run(dir, d, d, 'daily')).summaries[0]!;
      const monthly = (await run(dir, d, d, 'monthly')).summaries[0]!;
      expect(daily.origin).toBe('daily');
      expect(monthly.origin).toBe('monthly');
      expect(strip(monthly)).toEqual(strip(daily));
    }
  });

  it('ganze Monatsdatei: alle Tage final_ok, Sidecar mit Tageseinträgen, Kontinuität über alle Tage', async () => {
    const dir = archive();
    const sc = tmpDir('side-');
    const { summaries, logs } = await run(dir, '2026-09-01', '2026-09-30', 'monthly', {
      sidecarDir: sc,
    });
    expect(summaries).toHaveLength(30);
    expect(summaries.every((s) => s.state === 'final_ok')).toBe(true);
    // ohne 08-31 und 10-01 bleiben die äußeren Randminuten offen
    expect(summaries[0]!.edges[0]!.cls).toBe('edge_pending');
    expect(summaries[29]!.edges[1]!.cls).toBe('edge_pending');
    expect(logs.some((l) => l.includes('2026-08-31 nicht verfügbar'))).toBe(true);
    const man = JSON.parse(
      readFileSync(
        join(
          sc,
          'futures/um/monthly/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2026-09.zip.manifest.json',
        ),
        'utf8',
      ),
    );
    expect(man.days).toHaveLength(30);
    expect(man.rows).toBe(man.days.reduce((a: number, d: { rows: number }) => a + d.rows, 0));
    expect(man.days.slice(1).every((d: { continuesPrev: boolean }) => d.continuesPrev)).toBe(true);
    expect(man.checksumOk).toBe(true);
  });

  it('Resume über die Ergebnisdatei überspringt fertige Tage, rechnet die Kette aber weiter', async () => {
    const dir = archive();
    const out = join(tmpDir('res-'), 'r.jsonl');
    const first = await run(dir, '2026-09-03', '2026-09-04', 'monthly');
    writeFileSync(
      out,
      first.summaries
        .slice(0, 1)
        .map((s) => JSON.stringify(s))
        .join('\n') + '\n',
    );
    const second = await run(dir, '2026-09-03', '2026-09-04', 'monthly', {
      writer: new DryRunWriter(out),
    });
    expect(second.summaries.map((s) => s.skipped)).toEqual([true, false]);
    expect(second.writer.records.map((r) => r.day)).toEqual(['2026-09-04']);
    expect(second.summaries[1]!.carryInKnown).toBe(true);
    expect(strip(second.summaries[1]!)).toEqual(strip(first.summaries[1]!));
  });

  it('falsche .CHECKSUM bricht vor jeder Verarbeitung ab', async () => {
    const dir = archive();
    const p = join(
      dir,
      'raw/binance-vision/futures/um/monthly/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2026-09.zip.CHECKSUM',
    );
    writeFileSync(p, `${'f'.repeat(64)}  BTCUSDT-aggTrades-2026-09.zip\n`);
    const w = new DryRunWriter();
    await expect(
      run(dir, '2026-09-03', '2026-09-03', 'monthly', { writer: w, neighbours: false }),
    ).rejects.toThrow(/SHA256/);
    expect(w.records).toHaveLength(0);
  });

  it('aggId-Loch zum Vortag → final_bad (aggIds nicht fortlaufend)', async () => {
    const dir = archive({ holeOnDay: parseDay('2026-09-05') });
    const { summaries } = await run(dir, '2026-09-05', '2026-09-06', 'monthly');
    expect(summaries[0]!.state).toBe('final_ok');
    expect(summaries[1]!.continuesPrev).toBe(false);
    expect(summaries[1]!.state).toBe('final_bad');
    expect(summaries[1]!.extraBad.join()).toMatch(/nicht fortlaufend/);
  });
});

describe('CLI-Argumente', () => {
  it('Bereich, Modus und Standardwerte', () => {
    const a = parseImportArgs(['--symbol', 'BTCUSDT', '--month', '2026-02'], {});
    expect([
      formatDay(a.firstDay),
      formatDay(a.lastDay),
      a.mode,
      a.prefer,
      a.neighbours,
      a.dataDir,
    ]).toEqual(['2026-02-01', '2026-02-28', 'dry-run', 'auto', true, 'data']);
    const b = parseImportArgs(
      [
        '--symbol',
        'ETHUSDT',
        '--from',
        '2026-11-20',
        '--to',
        '2026-11-22',
        '--db',
        '--prefer',
        'daily',
        '--no-neighbours',
      ],
      { OF_DATA_DIR: '/x' },
    );
    expect([b.mode, b.prefer, b.neighbours, b.dataDir, b.lastDay - b.firstDay]).toEqual([
      'db',
      'daily',
      false,
      '/x',
      2,
    ]);
    expect(() => parseImportArgs(['--symbol', 'BTCUSDT'], {})).toThrow(/genau eines/);
    expect(() => parseImportArgs(['--symbol', 'XRPUSDT', '--day', '2026-11-20'], {})).toThrow(
      /Unbekanntes Symbol/,
    );
    expect(() => parseImportArgs(['--symbol', 'BTCUSDT', '--day', '2026-02-30'], {})).toThrow(
      /Kalenderdatum/,
    );
    expect(() =>
      parseImportArgs(['--symbol', 'BTCUSDT', '--day', '2026-11-20', '--db', '--dry-run'], {}),
    ).toThrow(/schließen sich aus/);
  });
});
