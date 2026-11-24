// Golden-Tests auf echten Binance-Vision-Dateien (opt-in: `npm run test:golden`). Liest nur aus
// data/raw/binance-vision (nie schreibend). Fehlende Dateien → Test wird übersprungen (mit Grund).
//
// 1. Reproduktion einer unabhängigen früheren Messung (exakte Dezimalrechnung, aggTrades nach T
//    vs. 1m-Klines): Minuten mit exaktem Volumen / Taker-Buy je Tag, bekannte Tagesrand-Fälle,
//    Klassifikation 100 % exact/shift (KONZEPT §4.5, §4.6, §8 P1-Abnahme).
// 2. Regression je Minute gegen test/golden/*.csv (erzeugt mit UPDATE_GOLDEN=1).
// 3. Gleichwertigkeit Monats-/Tagesdatei (§3.1, §8): Monatserster, Monatsmitte, Monatsletzter.
// 4. Bekannte Datenlücke BTCUSDT 2026-10-27 00:02–00:30 UTC (in Tages- und Monatsdatei identisch).
import { getSymbol, parseDay, type ReconcileInput, type ReconcileResult } from '@orderflow/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { absPath, isPresent } from '../src/files.ts';
import {
  Importer,
  klineRef,
  resolveAggSource,
  type DaySummary,
  type Prefer,
} from '../src/pipeline.ts';
import { DryRunWriter } from '../src/writer/dryrun.ts';

type DayInfo = { symbol: string; dayStr: string; reconcileInput: ReconcileInput };

const DATA = new URL('../../../data', import.meta.url).pathname;
const GOLDEN = new URL('./golden/', import.meta.url).pathname;
const UPDATE = process.env.UPDATE_GOLDEN === '1';

function available(symbol: string, days: string[], prefer: Prefer = 'auto'): boolean {
  return days.every(
    (d) =>
      resolveAggSource(DATA, symbol, parseDay(d), prefer) !== null &&
      isPresent(absPath(DATA, klineRef(symbol, parseDay(d)))),
  );
}

async function run(symbol: string, from: string, to: string, prefer: Prefer) {
  const per: { data: DayInfo; recon: ReconcileResult }[] = [];
  const imp = new Importer({
    dataDir: DATA,
    spec: getSymbol(symbol),
    firstDay: parseDay(from),
    lastDay: parseDay(to),
    prefer,
    neighbours: true,
    writer: new DryRunWriter(),
    importerVersion: 'golden',
    sidecar: false,
    log: () => {},
    onDayData: (data, recon) => per.push({ data, recon }),
  });
  const summaries = await imp.run();
  return { summaries, per };
}

function minuteCsv(data: DayInfo, r: ReconcileResult): string {
  const inp = data.reconcileInput;
  const cls = ['', 'exact', 'shift', 'mismatch', 'edge_pending', 'missing'];
  const lines = ['minute,our_q,our_b,kline_q,kline_b,cand_q,cand_b,d_q,d_b,s_q,s_b,class'];
  for (let m = 0; m < 1440; m++) {
    lines.push(
      [
        m,
        inp.ourQ[m],
        inp.ourB[m],
        inp.klQ[m],
        inp.klB[m],
        inp.candQ[m],
        inp.candB[m],
        r.dQ[m],
        r.dB[m],
        r.sQ[m],
        r.sB[m],
        cls[r.cls[m]!],
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

// Unabhängige Messung (exakte Dezimalrechnung), Minuten mit D = 0 von 1440
const REFERENCE: Record<string, { exactQ: number; exactB: number }> = {
  'BTCUSDT 2026-11-20': { exactQ: 1090, exactB: 1246 },
  'BTCUSDT 2026-11-21': { exactQ: 1115, exactB: 1271 },
  'BTCUSDT 2026-11-22': { exactQ: 1243, exactB: 1310 },
  'ETHUSDT 2026-11-21': { exactQ: 1209, exactB: 1323 },
  'ETHUSDT 2026-11-22': { exactQ: 1308, exactB: 1381 },
};

const BTC_DAYS = ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'];
const ETH_DAYS = ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'];

function checkReference(s: DaySummary): void {
  const key = `${s.symbol} ${s.day}`;
  expect({ exactQ: s.exactQ, exactB: s.exactB }, key).toEqual(REFERENCE[key]);
  expect(s.counts.mismatch, key).toBe(0);
  expect(s.counts.missing, key).toBe(0);
  expect(s.counts.edge_pending, key).toBe(0);
  expect(s.counts.exact + s.counts.shift, key).toBe(1440);
  expect(s.totals.identityQ && s.totals.identityB && s.totals.carryBoundsOk, key).toBe(true);
  expect(s.continuesPrev, key).toBe(true);
  expect(s.aggIdHoles, key).toBe(0);
  expect(s.state, key).toBe('final_ok');
}

function checkGolden(per: { data: DayInfo; recon: ReconcileResult }[]): void {
  for (const { data, recon } of per) {
    const file = join(GOLDEN, `${data.symbol}-${data.dayStr}.csv`);
    const csv = minuteCsv(data, recon);
    if (UPDATE || !existsSync(file)) {
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(file, csv);
    } else {
      expect(csv, file).toBe(readFileSync(file, 'utf8'));
    }
  }
}

describe.skipIf(!available('BTCUSDT', BTC_DAYS, 'daily'))(
  'BTCUSDT 2026-11-20…22 (Tagesdateien + Nachbartage)',
  () => {
    it('reproduziert die unabhängige Messung, 100 % exact/shift, Tagesränder aufgelöst', async () => {
      const { summaries, per } = await run('BTCUSDT', '2026-11-20', '2026-11-22', 'daily');
      expect(summaries.map((s) => s.day)).toEqual(['2026-11-20', '2026-11-21', '2026-11-22']);
      summaries.forEach(checkReference);
      expect(summaries.map((s) => s.candidates)).toEqual([1967, 2273, 907]);
      const [d20, d21, d22] = summaries as [DaySummary, DaySummary, DaySummary];
      // 11-20 Minute 0: −0,013 BTC; letzter aggTrade von 11-19 (3533987380) hat einen Fill um 00:00:00.003
      expect(d20.edges[0]).toMatchObject({ minute: 0, dQ: -13, dB: -13, sQ: 0, cls: 'shift' });
      expect(d20.carryIn).toEqual({ q: 13, b: 13 });
      expect(d20.firstAggId).toBe(3533987381);
      // 11-20 Minute 1439 +0,013 → 11-21 Minute 0 −0,013
      expect(d20.carryOut).toEqual({ q: 13, b: 13 });
      expect(d21.edges[0]).toMatchObject({ dQ: -13, cls: 'shift' });
      // 11-22 Minute 1439: +0,019 BTC, zweiter Fill gehört zu 11-23 00:00:00.008
      expect(d22.edges[1]).toMatchObject({ minute: 1439, dQ: 19, dB: 19, sQ: 19, cls: 'shift' });
      expect(d22.carryOut).toEqual({ q: 19, b: 19 });
      // Tagessummen exakt bis auf Tagesrand-Straddler: Σ unser − Σ kline = s(1439) − s(−1)
      expect(summaries.map((s) => s.totals.ourQ - s.totals.klQ)).toEqual([0, -13, 19]);
      checkGolden(per);
    });
  },
);

describe.skipIf(!available('ETHUSDT', ETH_DAYS, 'daily'))(
  'ETHUSDT 2026-11-21…22 (Tagesdateien + Nachbartage)',
  () => {
    it('reproduziert die unabhängige Messung, 100 % exact/shift', async () => {
      const { summaries, per } = await run('ETHUSDT', '2026-11-21', '2026-11-22', 'daily');
      summaries.forEach(checkReference);
      expect(summaries.map((s) => s.candidates)).toEqual([2122, 885]);
      expect(summaries.map((s) => s.totals.ourQ - s.totals.klQ)).toEqual([0, 0]);
      checkGolden(per);
    });
  },
);

const EQ_DAYS = ['2026-10-01', '2026-10-15', '2026-10-31'];
const eqAvailable =
  available('BTCUSDT', EQ_DAYS, 'daily') &&
  available('BTCUSDT', EQ_DAYS, 'monthly') &&
  available('BTCUSDT', ['2026-09-30', '2026-10-14', '2026-10-16', '2026-11-01']);

describe.skipIf(!eqAvailable)('Gleichwertigkeit Monats-/Tagesdatei BTCUSDT 2026-10', () => {
  it.each(EQ_DAYS)(
    '%s: identische Digests (alle Tabellen), Klassifikation und Tages-Manifest',
    async (day) => {
      const d = (await run('BTCUSDT', day, day, 'daily')).summaries[0]!;
      const m = (await run('BTCUSDT', day, day, 'monthly')).summaries[0]!;
      expect(d.origin).toBe('daily');
      expect(m.origin).toBe('monthly');
      expect(m.digests).toEqual(d.digests);
      expect(m.digest).toBe(d.digest);
      expect(m.qualityDigest).toBe(d.qualityDigest);
      expect(m.manifest).toEqual(d.manifest);
      expect(m.counts).toEqual(d.counts);
      expect(d.state).toBe('final_ok');
      expect(d.counts.edge_pending).toBe(0);
    },
  );
});

describe.skipIf(
  !available('BTCUSDT', ['2026-10-27'], 'daily') ||
    !available('BTCUSDT', ['2026-10-27'], 'monthly'),
)('Bekannte Lücke in den Binance-aggTrades BTCUSDT 2026-10-27', () => {
  it('Minuten 3–29 fehlen (aggIds trotzdem lückenlos) → missing/mismatch, final_bad; Tages- = Monatsdatei', async () => {
    const d = (await run('BTCUSDT', '2026-10-27', '2026-10-27', 'daily')).summaries[0]!;
    const m = (await run('BTCUSDT', '2026-10-27', '2026-10-27', 'monthly')).summaries[0]!;
    expect(m.digest).toBe(d.digest);
    expect(d.aggIdHoles).toBe(0);
    expect(d.continuesPrev).toBe(true);
    expect(d.counts).toMatchObject({ missing: 27, mismatch: 2 });
    expect(d.issues.filter((i) => i.cls === 'missing').map((i) => i.minute)).toEqual(
      Array.from({ length: 27 }, (_, i) => i + 3),
    );
    expect(d.manifest.tradeIdGapMax).toBe(38_458);
    expect(d.state).toBe('final_bad');
  });
});
