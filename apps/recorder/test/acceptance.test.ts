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
  isTooOld,
  RestError,
  toItem,
  WeightBudget,
  type RawAgg,
  type RestSource,
} from '../src/binance.ts';
import {
  isTransientDbError,
  Recorder,
  REST_ALERT_FAILURES,
  REST_ALERT_MS,
  type LiveSink,
} from '../src/recorder.ts';
import {
  assertRawPrunable,
  pruneRaw,
  RAW_CACHE_MARKER,
  readSpoolDay,
  SpoolWriter,
} from '../src/spool.ts';
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
      bigFloorN: null,
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

describe('Binance-Fehler für fromId außerhalb des Suchfensters', () => {
  it('nur -4166 gilt als „zu alt" (gemessen: HTTP 400, Search window is restricted to recent 2 days only.)', () => {
    expect(
      isTooOld(new RestError(400, -4166, 'Search window is restricted to recent 2 days only.')),
    ).toBe(true);
    expect(isTooOld(new RestError(400, -1100, 'Illegal characters'))).toBe(false);
    expect(isTooOld(new RestError(429, -1003, 'Too many requests'))).toBe(false);
    expect(isTooOld(new Error('x'))).toBe(false);
  });
});

describe('Erster Start mit letztem finalem Tag außerhalb des REST-Fensters (Review)', () => {
  // REST: fromId älter als der heutige Tagesanfang → 400 (zu alt); ab heute lückenlos
  const today = rows(0, 500, 8000); // heute 00:00–08:19, IDs 8000…8999
  const rest: RestSource = {
    aggTrades: async (_s, fromId, limit) => {
      if (fromId < 8000) throw new RestError(400, -4166, 'Binance 400 -4166 zu alt');
      const i = today.findIndex((r) => r.a >= fromId);
      return i < 0 ? [] : today.slice(i, i + limit);
    },
    aggTradesByTime: async (_s, startTime, endTime, limit) =>
      today.filter((r) => r.T >= startTime && r.T <= endTime).slice(0, limit),
    klines: async () => [],
  };

  it('heute wird vollständig geschrieben, nur die Tage davor sind Lücke und eingefroren', async () => {
    const f = make({
      final: { day: DAY - 3, lastAggId: 100 }, // letzter finaler Tag vorgestern-1: Lücke > 48 h
      rest,
      now: () => D0 + 505 * MINUTE_MS,
    });
    await f.rec.start();
    const s = f.rec.sym.get('BTCUSDT')!;
    const live1 = rows(500, 3, 9000); // Stream ab 08:20
    // eine verspätete Nachricht von gestern (ID unter dem Sprungziel) liegt schon im Puffer
    const stale = rows(1439, 1, 7990, (DAY - 1) * DAY_MS)[0]!;
    f.rec.handle(
      s,
      [stale, ...live1].map((r) => toItem(r, BTC, false)),
      true,
    );
    while (await f.rec.catchUpOnce(s)) {
      /* nachholen */
    }
    // nur die zwei Tage vor heute: eingefroren und als Lücke vermerkt; heute nicht
    expect(f.frozen.map(([d]) => d)).toEqual([DAY - 2, DAY - 1]);
    // Ende exklusiv: Minute 00:00 von heute ist keine Lücke (W1)
    expect(f.gaps).toEqual([[(DAY - 2) * DAY_MS, D0 - 1]]);
    expect(s.gapsAbandoned).toBe(1);
    expect(s.feed.gapOpen()).toBe(false); // die alte gepufferte ID hält die Lücke nicht offen
    f.rec.completeMinutes(s, D0 + 503 * MINUTE_MS + 2000);
    await f.rec.drain();
    const mins = f.written.filter((d) => d.day === DAY).map((d) => d.minute);
    expect(mins).toEqual(Array.from({ length: 503 }, (_, i) => i)); // 00:00 bis 08:22 lückenlos
    await f.rec.stop();
  });

  it('ein anderer 400 (nicht -4166) ist ein gewöhnlicher Fehler: kein Sprung, nichts eingefroren', async () => {
    const f = make({
      final: { day: DAY - 3, lastAggId: 100 },
      rest: {
        ...rest,
        aggTrades: async () => {
          throw new RestError(400, -1100, 'Illegal characters found in parameter');
        },
      },
      now: () => D0 + 505 * MINUTE_MS,
    });
    await f.rec.start();
    const s = f.rec.sym.get('BTCUSDT')!;
    f.rec.handle(
      s,
      rows(500, 3, 9000).map((r) => toItem(r, BTC, false)),
      true,
    );
    await expect(f.rec.catchUpOnce(s)).rejects.toThrow(/Illegal/);
    expect(f.frozen).toEqual([]);
    expect(f.gaps).toEqual([]);
    expect(s.gapsAbandoned).toBe(0);
    expect(s.feed.expected).toBe(101);
    await f.rec.stop();
  });

  it('dauerhaft gleicher Fehler an derselben fromId: Alarm nach N Versuchen bzw. 15 min, nie Aufgeben; Erfolg hebt ihn auf (S1)', async () => {
    let now = D0 + 505 * MINUTE_MS;
    let broken = true;
    const f = make({
      final: { day: DAY - 1, lastAggId: 7999 },
      rest: {
        ...rest,
        aggTrades: async (sym, fromId, limit) => {
          if (broken) throw new RestError(400, -1121, 'Invalid symbol.');
          return rest.aggTrades(sym, fromId, limit);
        },
      },
      now: () => now,
    });
    await f.rec.start();
    const s = f.rec.sym.get('BTCUSDT')!;
    f.rec.handle(
      s,
      rows(500, 3, 9000).map((r) => toItem(r, BTC, false)),
      true,
    );
    for (let i = 1; i < REST_ALERT_FAILURES; i++) {
      expect(await f.rec.catchUpStep(s)).toBe('error');
      now += 5000;
    }
    expect(s.restAlert).toBeNull(); // noch unter der Grenze
    expect(await f.rec.catchUpStep(s)).toBe('error');
    expect(s.restAlert).toMatch(
      /REST catch-up failing persistently: -1121 Invalid symbol\..*fromId 8000/,
    );
    // nie aufgegeben: nichts eingefroren, keine Lücke, Erwartung unverändert
    expect(f.frozen).toEqual([]);
    expect(f.gaps).toEqual([]);
    expect(s.feed.expected).toBe(8000);
    // Erfolg hebt den Alarm auf
    broken = false;
    expect(await f.rec.catchUpStep(s)).toBe('moved');
    expect(s.restAlert).toBeNull();
    expect(s.restFail).toBeNull();
    await f.rec.stop();
  });

  it('wechselnde Fehler an derselben fromId zählen zusammen: 12 Versuche (S1a)', async () => {
    let now = D0 + 505 * MINUTE_MS;
    let n = 0;
    const errs = [
      () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      () => new Error('The operation was aborted due to timeout'),
      () => new RestError(502, undefined, 'Bad Gateway'),
    ];
    const f = make({
      final: { day: DAY - 1, lastAggId: 7999 },
      rest: {
        ...rest,
        aggTrades: async () => {
          throw errs[n++ % errs.length]!();
        },
      },
      now: () => now,
    });
    await f.rec.start();
    const s = f.rec.sym.get('BTCUSDT')!;
    f.rec.handle(
      s,
      rows(500, 3, 9000).map((r) => toItem(r, BTC, false)),
      true,
    );
    for (let i = 1; i < REST_ALERT_FAILURES; i++) {
      await f.rec.catchUpStep(s);
      now += 5000;
    }
    expect(s.restAlert).toBeNull();
    await f.rec.catchUpStep(s); // 12. Fehler (ein 502)
    expect(s.restAlert).toMatch(/Bad Gateway.*fromId 8000, 12×/); // nur der letzte Fehler im Text
    await f.rec.stop();
  });

  it('wechselnde Fehler an derselben fromId: 15 min ab dem ersten Fehler (S1a)', async () => {
    let now = D0 + 505 * MINUTE_MS;
    let n = 0;
    const f = make({
      final: { day: DAY - 1, lastAggId: 7999 },
      rest: {
        ...rest,
        aggTrades: async () => {
          throw n++ % 2 ? new RestError(502, undefined, 'Bad Gateway') : new Error('fetch failed');
        },
      },
      now: () => now,
    });
    await f.rec.start();
    const s = f.rec.sym.get('BTCUSDT')!;
    f.rec.handle(
      s,
      rows(500, 3, 9000).map((r) => toItem(r, BTC, false)),
      true,
    );
    const t0 = now;
    await f.rec.catchUpStep(s);
    now = t0 + REST_ALERT_MS / 2;
    await f.rec.catchUpStep(s);
    now = t0 + REST_ALERT_MS - 1;
    await f.rec.catchUpStep(s);
    expect(s.restAlert).toBeNull();
    expect(s.restFail!.since).toBe(t0);
    now = t0 + REST_ALERT_MS;
    await f.rec.catchUpStep(s);
    expect(s.restAlert).toMatch(/Bad Gateway.*fromId 8000, 4×/);
    await f.rec.stop();
  });

  it('Alarm auch nach 15 min bei wenigen Versuchen (S1)', async () => {
    let now = D0 + 505 * MINUTE_MS;
    const f = make({
      final: { day: DAY - 1, lastAggId: 7999 },
      rest: {
        ...rest,
        aggTrades: async () => {
          throw new RestError(502, undefined, 'Bad Gateway');
        },
      },
      now: () => now,
    });
    await f.rec.start();
    const s = f.rec.sym.get('BTCUSDT')!;
    f.rec.handle(
      s,
      rows(500, 3, 9000).map((r) => toItem(r, BTC, false)),
      true,
    );
    await f.rec.catchUpStep(s);
    now += REST_ALERT_MS - 1;
    await f.rec.catchUpStep(s);
    expect(s.restAlert).toBeNull();
    now += 1;
    await f.rec.catchUpStep(s);
    expect(s.restAlert).toMatch(/Bad Gateway/);
    await f.rec.stop();
  });

  it('ohne Zeitabfrage (oder wenn der Tagesanfang nicht bestimmbar ist): bisheriges Verhalten', async () => {
    const f = make({
      final: { day: DAY - 3, lastAggId: 100 },
      rest: { aggTrades: rest.aggTrades, klines: rest.klines },
      now: () => D0 + 505 * MINUTE_MS,
    });
    await f.rec.start();
    const s = f.rec.sym.get('BTCUSDT')!;
    f.rec.handle(
      s,
      rows(500, 3, 9000).map((r) => toItem(r, BTC, false)),
      true,
    );
    await f.rec.catchUpOnce(s);
    expect(f.frozen.map(([d]) => d)).toContain(DAY);
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
    // ohne Marker-Datei (z. B. versehentlich gesetztes OF_RAW_KEEP_DAYS auf dem Mac): nichts löschen
    expect(() => pruneRaw(data, 'BTCUSDT', DAY - 14, () => true)).toThrow(RAW_CACHE_MARKER);
    expect(existsSync(join(agg, 'BTCUSDT-aggTrades-2026-11-01.zip'))).toBe(true);
    writeFileSync(join(data, 'raw/binance-vision', RAW_CACHE_MARKER), '');
    const gone = pruneRaw(data, 'BTCUSDT', DAY - 14, (d) => d <= DAY - 1);
    expect(gone).toHaveLength(2);
    expect(existsSync(join(agg, 'BTCUSDT-aggTrades-2026-11-20.zip'))).toBe(true);
    // Import-Archiv (enthält Monatsdateien): auch mit Marker nie
    mkdirSync(join(data, 'raw/binance-vision/futures/um/monthly'), { recursive: true });
    expect(() => assertRawPrunable(data)).toThrow(/Import-Archiv/);
  });

  it('statement_timeout (57014) zählt als dauerhafter Fehler, Verbindungsfehler als vorübergehend', () => {
    expect(isTransientDbError({ code: '57014' })).toBe(false);
    expect(isTransientDbError({ code: '57P01' })).toBe(true);
    expect(isTransientDbError({ code: '55P03' })).toBe(true);
    expect(isTransientDbError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isTransientDbError({ code: '23514' })).toBe(false);
  });
});
