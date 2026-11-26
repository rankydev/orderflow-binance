// ZIP-Leser und CSV-Leser auf kleinen, aus echten Binance-Dateien geschnittenen Fixtures
// (test/fixtures/*.csv; ZIPs mit dem macOS-`zip` erzeugt): Tagesrand 2026-11-19/20 (mit und ohne
// Kopfzeile, deflate und stored), Tagesrand 2026-11-22/23 mit Straddler.
import { getSymbol, parseDay, type DayAggregate } from '@orderflow/core';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyFile } from '../src/files.ts';
import { readAggTrades, readKlineDay, type AggDayChunk } from '../src/readers.ts';
import { readSingleEntry, streamSingleEntry } from '../src/zip.ts';
import { makeZip, tmpDir } from './helpers.ts';

const FIX = new URL('./fixtures/', import.meta.url).pathname;
const BTC = getSymbol('BTCUSDT');
const D19 = parseDay('2026-11-19');
const D20 = parseDay('2026-11-20');
const D22 = parseDay('2026-11-22');
const D23 = parseDay('2026-11-23');

async function readAll(path: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of streamSingleEntry(path)) parts.push(c);
  return Buffer.concat(parts);
}

async function split(path: string, first: number, last: number) {
  const days: AggDayChunk[] = [];
  const summary = await readAggTrades(path, BTC, {
    firstDay: first,
    lastDay: last,
    want: () => true,
    bigFloorN: null,
    onDay: (c) => {
      days.push(c);
    },
  });
  return { days, summary };
}

describe('ZIP-Leser', () => {
  it('liest deflate (zip -9), stored (zip -0) und eigene ZIPs byte-gleich zur CSV', async () => {
    const csv = readFileSync(join(FIX, 'BTCUSDT-aggTrades-edge-2026-11-19_20.csv'));
    expect(await readAll(join(FIX, 'BTCUSDT-aggTrades-edge-2026-11-19_20.zip'))).toEqual(csv);
    expect(await readAll(join(FIX, 'BTCUSDT-aggTrades-edge-2026-11-19_20-stored.zip'))).toEqual(
      csv,
    );
    const e = await readSingleEntry(join(FIX, 'BTCUSDT-aggTrades-edge-2026-11-19_20-stored.zip'));
    expect(e.method).toBe(0);
    const dir = tmpDir('zip-');
    const p = join(dir, 'x.zip');
    writeFileSync(p, makeZip('x.csv', csv));
    expect(await readAll(p)).toEqual(csv);
  });

  it('erkennt beschädigte Daten (CRC32), abgeschnittene Dateien und mehrere Einträge', async () => {
    const dir = tmpDir('zip-');
    const csv = Buffer.from('a'.repeat(1000));
    // stored: Datenbyte ändern → CRC-Fehler
    const z = makeZip('x.csv', csv, 0);
    z[60] = 0x62;
    writeFileSync(join(dir, 'crc.zip'), z);
    await expect(readAll(join(dir, 'crc.zip'))).rejects.toThrow(/CRC32/);
    const good = makeZip('x.csv', csv);
    writeFileSync(join(dir, 'cut.zip'), good.subarray(0, good.length - 30));
    await expect(readAll(join(dir, 'cut.zip'))).rejects.toThrow();
    const two = Buffer.from(good);
    two.writeUInt16LE(2, two.length - 22 + 10);
    writeFileSync(join(dir, 'two.zip'), two);
    await expect(readAll(join(dir, 'two.zip'))).rejects.toThrow(/genau 1 Eintrag/);
  });

  it('SHA256-Prüfung gegen .CHECKSUM; Abweichung ist ein Fehler', async () => {
    const v = await verifyFile(join(FIX, 'BTCUSDT-aggTrades-edge-2026-11-19_20.zip'));
    expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    const dir = tmpDir('sha-');
    const p = join(dir, 'BTCUSDT-aggTrades-edge-2026-11-19_20.zip');
    copyFileSync(join(FIX, 'BTCUSDT-aggTrades-edge-2026-11-19_20.zip'), p);
    writeFileSync(`${p}.CHECKSUM`, `${'0'.repeat(64)}  BTCUSDT-aggTrades-edge-2026-11-19_20.zip\n`);
    await expect(verifyFile(p)).rejects.toThrow(/SHA256-Abweichung/);
    writeFileSync(`${p}.CHECKSUM`, `${v.sha256}  andere.zip\n`);
    await expect(verifyFile(p)).rejects.toThrow(/nennt/);
  });
});

describe('aggTrades-Leser (Tageszerlegung, Kopfzeile, Tagesrand)', () => {
  it('Tagesrand 2026-11-19/20: Zerlegung nach UTC-Tag, aggIds fortlaufend über die Grenze', async () => {
    const { days, summary } = await split(
      join(FIX, 'BTCUSDT-aggTrades-edge-2026-11-19_20.zip'),
      D19,
      D20,
    );
    expect(summary.headerPresent).toBe(true);
    expect(summary.rows).toBe(300);
    expect(days.map((d) => [d.day, d.stats.rows])).toEqual([
      [D19, 150],
      [D20, 150],
    ]);
    expect(days[0]!.stats.lastAggId).toBe(3533987380);
    expect(days[1]!.stats.firstAggId).toBe(3533987381);
    expect(days[0]!.stats.holes + days[1]!.stats.holes).toBe(0);
    // Letzter aggTrade von 11-19 (T = 23:59:59.939, 2 Fills) ist Kandidat in Minute 1439
    const a19 = days[0]!.agg!;
    expect(a19.candQ[1439]).toBeGreaterThanOrEqual(16);
    expect(a19.bars[a19.bars.length - 1]!.lastAggId).toBe(3533987380);
    expect(a19.bars[a19.bars.length - 1]!.lastTradeMs).toBe(1795132799939);
    // Erster Trade von 11-20 in Minute 0
    expect(days[1]!.agg!.bars[0]!.ts).toBe(D20 * 86_400_000);
  });

  it('ohne Kopfzeile, stored und deflate liefern identische Aggregate', async () => {
    const strip = (d: AggDayChunk[]) => d.map((x) => x.agg as DayAggregate);
    const a = await split(join(FIX, 'BTCUSDT-aggTrades-edge-2026-11-19_20.zip'), D19, D20);
    const b = await split(join(FIX, 'BTCUSDT-aggTrades-edge-2026-11-19_20-noheader.zip'), D19, D20);
    const c = await split(join(FIX, 'BTCUSDT-aggTrades-edge-2026-11-19_20-stored.zip'), D19, D20);
    expect(b.summary.headerPresent).toBe(false);
    expect(strip(b.days)).toEqual(strip(a.days));
    expect(strip(c.days)).toEqual(strip(a.days));
  });

  it('Tagesdatei-Modus: Zeilen außerhalb des Tages sind ein Fehler mit Zeilennummer', async () => {
    await expect(
      split(join(FIX, 'BTCUSDT-aggTrades-edge-2026-11-19_20.zip'), D20, D20),
    ).rejects.toThrow(/:2: .*außerhalb des Dateizeitraums/);
  });

  it('Straddler 2026-11-22 23:59:59.944 (5 Fills) ist Kandidat in Minute 1439', async () => {
    const { days } = await split(join(FIX, 'BTCUSDT-aggTrades-edge-2026-11-22_23.zip'), D22, D23);
    const a22 = days[0]!.agg!;
    expect(a22.candQ[1439]).toBeGreaterThanOrEqual(41);
    expect(a22.candB[1439]).toBeGreaterThanOrEqual(41);
    expect(days[1]!.stats.firstAggId).toBe(days[0]!.stats.lastAggId! + 1);
  });

  it('strikte Zeilenprüfung: Fehler nennen Datei und Zeile', async () => {
    const dir = tmpDir('bad-');
    const head =
      'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker\n';
    const cases: [string, RegExp][] = [
      [
        '1,61959.2,1.516,1,2,1795132800058,true\n1,61959.2,1.516,3,3,1795132800059,true\n',
        /:3: .*Duplikat/,
      ],
      [
        '1,61959.2,1.516,1,2,1795132800058,true\n\n2,61959.2,1.516,3,3,1795132800059,true\n',
        /leere Zeile/,
      ],
      ['1,61959.255,1.516,1,2,1795132800058,true\n', /:2: price/],
      ['foo,bar\n', /Kopfzeile/],
    ];
    for (const [i, [body, re]] of cases.entries()) {
      const p = join(dir, `b${i}.zip`);
      writeFileSync(p, makeZip('b.csv', (body.startsWith('foo') ? '' : head) + body));
      await expect(split(p, D20, D20), body).rejects.toThrow(re);
    }
  });
});

describe('Kline-Leser', () => {
  it('liest 1m-Klines exakt und lehnt Zeilen anderer Tage ab', async () => {
    await expect(
      readKlineDay(join(FIX, 'BTCUSDT-1m-edge-2026-11-22_23.zip'), BTC, D22),
    ).rejects.toThrow(/nicht im Tag 2026-11-22/);
    const dir = tmpDir('kl-');
    const csv = readFileSync(join(FIX, 'BTCUSDT-1m-edge-2026-11-22_23.csv'), 'latin1')
      .split('\n')
      .slice(0, 4)
      .join('\n');
    const p = join(dir, 'k.zip');
    writeFileSync(p, makeZip('k.csv', csv));
    const k = await readKlineDay(p, BTC, D22);
    expect(k.headerPresent).toBe(true);
    expect(k.klines.map((x) => [x.openTime % 86_400_000, x.vol, x.takerBuy])).toEqual([
      [1437 * 60_000, 111818, 24825],
      [1438 * 60_000, 101680, 44384],
      [1439 * 60_000, 80315, 49309],
    ]);
  });
});

describe('Download-Inaktivitäts-Timeout (H3)', () => {
  it('bricht nur ohne Fortschritt ab, nicht nach einer Gesamtfrist', async () => {
    const { idleAbort } = await import('../src/download.ts');
    const a = idleAbort(80);
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 40));
      a.touch(); // Fortschritt: insgesamt 160 ms > 80 ms, aber nie 80 ms ohne Daten
    }
    expect(a.signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(a.signal.aborted).toBe(true);
    a.done();
  });
});
