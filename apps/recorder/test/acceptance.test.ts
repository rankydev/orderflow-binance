// Abnahmeprüfungen 1, 2, 6, 7 des Recorder-Reviews, automatisiert mit Fake-Quellen (ohne Netz/DB):
// 1 Start ohne Spool mit Lücke außerhalb des REST-Fensters (K1/W1), 2 Absturz an einem
// abgeschnittenen Frame zweimal hintereinander (W2), 6 DB-Ausfall und 429/418 (W4), 7 Plattenwächter
// und Aufbewahrung (W3).
import { DAY_MS, getSymbol, MINUTE_MS, type MinuteDelta } from '@orderflow/core';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BinanceRest,
  RestError,
  toItem,
  WeightBudget,
  type RawAgg,
  type RestSource,
} from '../src/binance.ts';
import { Recorder, type LiveSink } from '../src/recorder.ts';
import { pruneRaw, readSpoolDay, SpoolWriter } from '../src/spool.ts';
import type { SocketLike } from '../src/ws.ts';

const BTC = getSymbol('BTCUSDT');
const DAY = Date.UTC(2026, 10, 25) / DAY_MS;
const D0 = DAY * DAY_MS;

const live = (): SocketLike => {
  const s: SocketLike = { onopen: null, onmessage: null, onclose: null, onerror: null, close() {} };
  queueMicrotask(() => s.onopen?.({}));
  return s;
};

function rows(fromMin: number, minutes: number, a0: number, base = D0): RawAgg[] {
  const out: RawAgg[] = [];
  let a = a0;
  for (let m = fromMin; m < fromMin + minutes; m++) {
    for (const off of [5, 30_000]) {
      out.push({
        a,
        p: '60000.1',
        q: '0.002',
        f: a * 2,
        l: a * 2,
        T: base + m * MINUTE_MS + off,
        m: a % 2 === 0,
      });
      a++;
    }
  }
  return out;
}

interface Fake {
  rec: Recorder;
  written: MinuteDelta[];
  gaps: [number, number][];
  frozen: [number, string][];
}

function make(o: {
  final: { day: number; lastAggId: number } | null;
  rest?: RestSource;
  writeMinute?: (d: MinuteDelta) => Promise<'written'>;
  spoolDir?: string | null;
  freeBytes?: () => number;
  now?: () => number;
}): Fake {
  const written: MinuteDelta[] = [];
  const gaps: [number, number][] = [];
  const frozen: [number, string][] = [];
  const sink: LiveSink = {
    startState: async () => ({
      final: o.final ? { ...o.final, carry: null, cand: null } : null,
      provisional: [],
    }),
    writeMinute: async (_s, d) => {
      if (o.writeMinute) await o.writeMinute(d);
      written.push(d);
      return 'written';
    },
    markGap: async (_s, f, t) => {
      gaps.push([f, t]);
    },
    markFrozen: async (_s, d, r) => {
      frozen.push([d, r]);
    },
    writeKlineChecks: async () => {},
  };
  const rec = new Recorder({
    symbols: ['BTCUSDT'],
    wsUrl: 'wss://test.invalid',
    socketFactory: live,
    rest: o.rest ?? { aggTrades: async () => [], klines: async () => [] },
    sink,
    spoolDir: o.spoolDir ?? null,
    log: () => {},
    autoLoops: false,
    klineCheck: false,
    freeBytes: o.freeBytes ?? null,
    minFreeBytes: 1000,
    spoolKeepDays: 7,
    ...(o.now ? { now: o.now } : {}),
  });
  return { rec, written, gaps, frozen };
}

const tooOld: RestSource = {
  aggTrades: async () => {
    throw new RestError(400, -4166, 'Binance 400 -4166 zu alt');
  },
  klines: async () => [],
};

describe('Abnahme 1: Lücke außerhalb des REST-Fensters (K1, W1)', () => {
  it('ohne Spool und ohne verarbeiteten Trade: Lücke vom Ende des letzten finalen Tages, begrenzt, Tage eingefroren', async () => {
    const f = make({
      final: { day: DAY - 2, lastAggId: 100 },
      rest: tooOld,
      now: () => D0 + 600 * MINUTE_MS,
    });
    await f.rec.start();
    const s = f.rec.sym.get('BTCUSDT')!;
    const live1 = rows(500, 3, 9000); // Stream beginnt heute 08:20, IDs weit hinter 101
    f.rec.handle(
      s,
      live1.map((r) => toItem(r, BTC, false)),
      true,
    );
    const heapBefore = process.memoryUsage().heapUsed;
    await f.rec.catchUpOnce(s);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(50 * 2 ** 20);
    // Lücke: von Ende 11-23 (Ende des letzten finalen Tages) bis zum ersten Trade nach der Lücke
    expect(f.gaps).toEqual([[(DAY - 1) * DAY_MS, live1[0]!.T]]);
    // jeder berührte Tag eingefroren und sichtbar markiert: gestern und heute
    expect(f.frozen.map(([d]) => d)).toEqual([DAY - 1, DAY]);
    // heute wird trotz lückenloser Folge danach nicht geschrieben (ihm fehlen die Trades vor der Lücke)
    f.rec.handle(
      s,
      rows(503, 3, 9006).map((r) => toItem(r, BTC, false)),
      true,
    );
    f.rec.completeMinutes(s, D0 + 506 * MINUTE_MS + 2000);
    await f.rec.drain();
    expect(f.written).toHaveLength(0);
    await f.rec.stop();
  });

  it('ganz ohne Startpunkt (kein finaler Tag, kein Trade): Lücke höchstens ab Tagesbeginn, nie ab 1970', async () => {
    const f = make({ final: null, rest: tooOld });
    await f.rec.start();
    const s = f.rec.sym.get('BTCUSDT')!;
    const r = rows(100, 1, 500);
    f.rec.handle(s, [toItem(r[1]!, BTC, false)], true); // erste Nachricht setzt die Erwartung
    f.rec.handle(
      s,
      rows(110, 1, 520).map((x) => toItem(x, BTC, false)),
      true,
    ); // Sprung
    s.feed.lastT = 0; // Zustand wie direkt nach dem Start
    await f.rec.catchUpOnce(s);
    expect(f.gaps).toHaveLength(1);
    expect(f.gaps[0]![0]).toBeGreaterThanOrEqual(D0);
    expect(f.gaps[0]![1] - f.gaps[0]![0]).toBeLessThanOrEqual(3 * DAY_MS);
    await f.rec.stop();
  });

  it('Lücke über Mitternacht: beide Tage eingefroren, Gap-Minuten nur im echten Bereich', async () => {
    const f = make({ final: { day: DAY - 2, lastAggId: 999 }, rest: tooOld });
    await f.rec.start();
    const s = f.rec.sym.get('BTCUSDT')!;
    const before = rows(1430, 5, 1000, (DAY - 1) * DAY_MS); // gestern 23:50–23:54
    f.rec.handle(
      s,
      before.map((r) => toItem(r, BTC, false)),
      true,
    ); // ab 1000 lückenlos
    const after = rows(10, 3, 5000); // heute 00:10, Lücke 1010…4999
    f.rec.handle(
      s,
      after.map((r) => toItem(r, BTC, false)),
      true,
    );
    await f.rec.catchUpOnce(s);
    expect(f.gaps).toEqual([[before[before.length - 1]!.T, after[0]!.T]]);
    expect(f.frozen.map(([d]) => d)).toEqual([DAY - 1, DAY]);
    await f.rec.stop();
  });
});

describe('Abnahme 2: zweimal Absturz an einem abgeschnittenen Frame (W2)', () => {
  it('Wiedergabe liefert alle IDs ohne REST', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acc2-'));
    const it = (a: number) =>
      toItem({ a, p: '60000.1', q: '0.001', f: a, l: a, T: D0 + a, m: false }, BTC, false);
    const w1 = new SpoolWriter(dir, 'BTCUSDT');
    w1.append([it(1), it(2)]);
    w1.flush();
    w1.close();
    const file = join(dir, 'BTCUSDT', '2026-11-25', '00.csv.zst');
    appendFileSync(file, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x09, 0x00])); // abgeschnittener Frame
    const w2 = new SpoolWriter(dir, 'BTCUSDT'); // neuer Prozess
    w2.append([it(3), it(4)]);
    w2.flush();
    w2.close();
    expect(w2.truncatedOnOpen).toBe(1);
    appendFileSync(file, Buffer.from([0x28, 0xb5, 0x2f])); // zweiter Absturz
    const w3 = new SpoolWriter(dir, 'BTCUSDT');
    w3.append([it(5), it(6)]);
    w3.flush();
    w3.close();
    const { items, truncatedFiles } = await readSpoolDay(dir, 'BTCUSDT', DAY);
    expect(items.map((x) => x.trade.a)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(truncatedFiles).toBe(0);
  });
});

describe('Abnahme 6: DB-Ausfall und Rate-Limits (W4)', () => {
  it('vorübergehender DB-Ausfall: Warteschlange läuft nach, keine Minute fehlt, Reihenfolge bleibt', async () => {
    let down = 3;
    const f = make({
      final: { day: DAY - 1, lastAggId: 99 },
      writeMinute: async () => {
        if (down-- > 0)
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        return 'written';
      },
    });
    await f.rec.start();
    const s = f.rec.sym.get('BTCUSDT')!;
    f.rec.handle(
      s,
      rows(0, 4, 100).map((r) => toItem(r, BTC, false)),
      true,
    );
    f.rec.completeMinutes(s, D0 + 4 * MINUTE_MS + 2000);
    await f.rec.drain();
    expect(f.written.map((d) => d.minute)).toEqual([0, 1, 2, 3]);
    expect(f.rec.writeErrors).toBe(3);
    await f.rec.stop();
  }, 20_000);

  it('dauerhafter Fehler einer Minute: nach N Versuchen Tag eingefroren, Warteschlange blockiert nicht', async () => {
    const f = make({
      final: { day: DAY - 1, lastAggId: 99 },
      writeMinute: async (d) => {
        if (d.minute === 1)
          throw Object.assign(new Error('violates check constraint'), { code: '23514' });
        return 'written';
      },
    });
    (f.rec.o as { maxPermanentFailures: number }).maxPermanentFailures = 2;
    await f.rec.start();
    const s = f.rec.sym.get('BTCUSDT')!;
    f.rec.handle(
      s,
      rows(0, 4, 100).map((r) => toItem(r, BTC, false)),
      true,
    );
    f.rec.completeMinutes(s, D0 + 4 * MINUTE_MS + 2000);
    await f.rec.drain();
    expect(f.written.map((d) => d.minute)).toEqual([0]);
    expect(f.frozen).toHaveLength(1);
    expect(f.frozen[0]![1]).toMatch(/Schreibfehler Minute 1/);
    expect(f.rec.queueLength()).toBe(0);
    await f.rec.stop();
  }, 20_000);

  it('429/418: bis Retry-After keine weitere Anfrage', async () => {
    let now = 0;
    const calls: number[] = [];
    const budget = new WeightBudget(
      1200,
      () => now,
      async (ms) => {
        now += ms;
      },
    );
    let n = 0;
    const fakeFetch = (async () => {
      calls.push(now);
      n++;
      if (n === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '7' } });
      if (n === 2) return new Response('{}', { status: 418, headers: { 'retry-after': '120' } });
      return new Response('[]', { status: 200, headers: { 'x-mbx-used-weight-1m': '20' } });
    }) as unknown as typeof fetch;
    const rest = new BinanceRest('https://x', budget, getSymbol, fakeFetch);
    await expect(rest.aggTrades('BTCUSDT', 1, 1000)).rejects.toThrow(/429/);
    await expect(rest.aggTrades('BTCUSDT', 1, 1000)).rejects.toThrow(/418/);
    await rest.aggTrades('BTCUSDT', 1, 1000);
    expect(calls[1]).toBeGreaterThanOrEqual(7000);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(120_000);
  });
});

describe('Abnahme 7: Plattenwächter und Aufbewahrung (W3)', () => {
  it('unter der Grenze wächst die Spool nicht mehr; darüber wieder; DB-Schreiben läuft weiter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acc7-'));
    let free = 10_000;
    let now = D0 + 10 * MINUTE_MS;
    const f = make({
      final: { day: DAY - 1, lastAggId: 99 },
      spoolDir: dir,
      freeBytes: () => free,
      now: () => now,
    });
    await f.rec.start();
    const s = f.rec.sym.get('BTCUSDT')!;
    f.rec.handle(
      s,
      rows(0, 2, 100).map((r) => toItem(r, BTC, false)),
      true,
    );
    s.spool!.flush();
    const b0 = s.spool!.bytes;
    free = 500; // unter minFreeBytes (1000)
    now += 20_000;
    f.rec.diskAndRetention(now);
    expect(f.rec.spoolEnabled).toBe(false);
    f.rec.handle(
      s,
      rows(2, 2, 104).map((r) => toItem(r, BTC, false)),
      true,
    );
    s.spool!.flush();
    expect(s.spool!.bytes).toBe(b0);
    f.rec.completeMinutes(s, D0 + 4 * MINUTE_MS + 2000);
    await f.rec.drain();
    expect(f.written.map((d) => d.minute)).toEqual([0, 1, 2, 3]);
    free = 5000;
    now += 20_000;
    f.rec.diskAndRetention(now);
    expect(f.rec.spoolEnabled).toBe(true);
    await f.rec.stop();
  });

  it('Spool-Aufbewahrung unabhängig von der Finalisierung; Rohdateien nur finale, alte Tage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acc7r-'));
    for (const d of ['2026-11-10', '2026-11-17', '2026-11-18', '2026-11-25'])
      mkdirSync(join(dir, 'BTCUSDT', d), { recursive: true });
    const f = make({
      final: { day: DAY - 1, lastAggId: 99 },
      spoolDir: dir,
      now: () => D0 + 3600_000 * 5,
    });
    await f.rec.start();
    f.rec.diskAndRetention(D0 + 3600_000 * 5);
    expect(readdirSync(join(dir, 'BTCUSDT')).sort()).toEqual(['2026-11-18', '2026-11-25']);
    await f.rec.stop();
    const data = mkdtempSync(join(tmpdir(), 'acc7d-'));
    const agg = join(data, 'raw/binance-vision/futures/um/daily/aggTrades/BTCUSDT');
    mkdirSync(agg, { recursive: true });
    for (const d of ['2026-11-01', '2026-11-20']) {
      writeFileSync(join(agg, `BTCUSDT-aggTrades-${d}.zip`), 'x');
      writeFileSync(join(agg, `BTCUSDT-aggTrades-${d}.zip.CHECKSUM`), 'x');
    }
    const gone = pruneRaw(data, 'BTCUSDT', DAY - 14, (d) => d <= DAY - 1);
    expect(gone).toHaveLength(2);
    expect(existsSync(join(agg, 'BTCUSDT-aggTrades-2026-11-20.zip'))).toBe(true);
  });
});
