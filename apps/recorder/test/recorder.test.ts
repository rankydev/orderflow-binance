// Recorder-Ablauf mit Fake-Stream und Fake-REST (ohne Netz, ohne DB): Minutenabschluss genau an den
// Grenzen, keine Minute bei offener Lücke, Nachholen per REST mit Überlappung/Duplikaten,
// 24-h-Wechsel mit doppelten Nachrichten, REST-Gewichtsbudget, Spool-Wiederanlauf nach Absturz.
import { aggregateDay, DAY_MS, getSymbol, MINUTE_MS, type MinuteDelta } from '@orderflow/core';
import { mkdtempSync, readdirSync, readFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toItem, WeightBudget, type RawAgg, type RestSource } from '../src/binance.ts';
import { Recorder, type LiveSink } from '../src/recorder.ts';
import type { SocketLike } from '../src/ws.ts';

const BTC = getSymbol('BTCUSDT');
const DAY = Date.UTC(2026, 10, 25) / DAY_MS;
const D0 = DAY * DAY_MS;

/** Synthetische Trades: je Minute einige, darunter Grenzfälle T = k·60000 − 1, k·60000, k·60000 + 1. */
function trades(minutes: number): RawAgg[] {
  const out: RawAgg[] = [];
  let a = 5000;
  for (let m = 0; m < minutes; m++) {
    for (const off of [0, 1, 30_000, 59_999]) {
      out.push({
        a: a,
        p: (60000 + (a % 7) / 10).toFixed(1),
        q: '0.00' + (1 + (a % 5)),
        f: a * 3,
        l: a * 3 + (a % 2),
        T: D0 + m * MINUTE_MS + off,
        m: a % 3 === 0,
      });
      a++;
    }
  }
  return out;
}

// verbundener, stummer Socket (öffnet sofort; Nachrichten speisen die Tests direkt ein)
const dead = (): SocketLike => {
  const s: SocketLike = { onopen: null, onmessage: null, onclose: null, onerror: null, close() {} };
  queueMicrotask(() => s.onopen?.({}));
  return s;
};

function setup(rows: RawAgg[], spoolDir: string | null = null, budget?: WeightBudget) {
  const written: MinuteDelta[] = [];
  let restCalls = 0;
  const rest: RestSource = {
    async aggTrades(_s, fromId, limit) {
      restCalls++;
      await budget?.take(20);
      const i = rows.findIndex((r) => r.a >= fromId);
      return i < 0 ? [] : rows.slice(i, i + limit);
    },
    async klines() {
      return [];
    },
  };
  const sink: LiveSink = {
    startState: async () => ({
      final: {
        day: DAY - 1,
        lastAggId: rows[0]!.a - 1,
        carry: { q: 0, b: 0 },
        cand: { q: 0, b: 0 },
      },
      provisional: [],
    }),
    writeMinute: async (_s, d) => {
      written.push(d);
      return 'written';
    },
    markGap: async () => {},
    markFrozen: async () => {},
    writeKlineChecks: async () => {},
  };
  const rec = new Recorder({
    symbols: ['BTCUSDT'],
    wsUrl: 'wss://test.invalid',
    socketFactory: dead,
    rest,
    sink,
    spoolDir,
    log: () => {},
    autoLoops: false,
    klineCheck: false,
  });
  return { rec, written, calls: () => restCalls };
}

const items = (rows: RawAgg[], viaRest = false) => rows.map((r) => toItem(r, BTC, viaRest));

describe('Recorder (Fake-Quellen)', () => {
  it('Minute M erst abgeschlossen, wenn ein Trade mit T ≥ M + 62 s vorliegt; Grenzfälle in der richtigen Minute', async () => {
    const rows = trades(5);
    const { rec, written } = setup(rows);
    await rec.start();
    const s = rec.sym.get('BTCUSDT')!;
    // bis Minute 2, T = 2·60000 + 1 (Marge noch nicht erreicht für Minute 1)
    rec.handle(s, items(rows.slice(0, 10)), true);
    await rec.drain();
    expect(written.map((d) => d.minute)).toEqual([0]); // Minute 0 endet 60 000, letzter T = 120 001 ≥ 62 000
    rec.handle(s, items(rows.slice(10)), true);
    rec.completeMinutes(s, D0 + 5 * MINUTE_MS + 2000);
    await rec.drain();
    expect(written.map((d) => d.minute)).toEqual([0, 1, 2, 3, 4]);
    const ref = aggregateDay(
      DAY,
      items(rows).map((x) => x.trade),
    );
    expect(written.map((d) => d.bars.find((b) => b.table === 'bar_1m')!.bars[0])).toEqual(ref.bars);
    await rec.stop();
  });

  it('offene Lücke blockiert jeden Minutenabschluss; REST schließt sie (Überlappung, Duplikate)', async () => {
    const rows = trades(6);
    const { rec, written, calls } = setup(rows);
    await rec.start();
    const s = rec.sym.get('BTCUSDT')!;
    rec.handle(s, items(rows.slice(0, 3)), true);
    rec.handle(s, items(rows.slice(8)), true); // IDs 8.. kommen, 3..7 fehlen
    await rec.drain();
    expect(s.feed.gapOpen()).toBe(true);
    expect(written).toHaveLength(0);
    rec.handle(s, items(rows.slice(8, 12)), true); // Duplikate aus dem Stream
    while (await rec.catchUpOnce(s)) {
      /* nachholen */
    }
    await rec.drain();
    expect(s.feed.gapOpen()).toBe(false);
    expect(calls()).toBeGreaterThanOrEqual(1);
    expect(written.map((d) => d.minute)).toEqual([0, 1, 2, 3, 4]);
    expect(written[1]!.viaRest).toBe(true); // Minute 1 enthält per REST geholte Trades
    await rec.stop();
  });

  it('Neustart aus der Spool nach Absturz (abgeschnittener Frame) + REST ergibt dieselben Minuten', async () => {
    const rows = trades(8);
    const dir = mkdtempSync(join(tmpdir(), 'rspool-'));
    const a = setup(rows, dir);
    await a.rec.start();
    const s = a.rec.sym.get('BTCUSDT')!;
    for (let i = 0; i < 20; i += 4) {
      a.rec.handle(s, items(rows.slice(i, i + 4)), true);
      s.spool!.flush();
    }
    await a.rec.drain();
    // "kill": letzten Frame abschneiden, Prozess ohne stop()
    const d = join(dir, 'BTCUSDT', '2026-11-25');
    const f = join(
      d,
      readdirSync(d).find((x) => x.endsWith('.csv.zst'))!,
    );
    truncateSync(f, readFileSync(f).length - 3);
    const b = setup(rows, dir);
    await b.rec.start(); // spielt die Spool ein
    const s2 = b.rec.sym.get('BTCUSDT')!;
    expect(s2.feed.expected).toBeLessThan(rows[20]!.a); // letzter Frame fehlt
    // erste Stream-Nachricht nach dem Neustart öffnet die Lücke, REST liefert den Rest
    b.rec.handle(s2, items(rows.slice(-1)), true);
    while (await b.rec.catchUpOnce(s2)) {
      /* nachholen */
    }
    b.rec.completeMinutes(s2, D0 + 8 * MINUTE_MS + 2000);
    await b.rec.drain();
    expect(b.written.map((x) => x.minute)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const ref = aggregateDay(
      DAY,
      items(rows).map((x) => x.trade),
    );
    expect(b.written.map((x) => x.bars.find((t) => t.table === 'bar_1m')!.bars[0])).toEqual(
      ref.bars,
    );
    await a.rec.stop();
    await b.rec.stop();
  });

  it('REST-Nachholen hält das Gewichtsbudget ein', async () => {
    const rows = trades(300); // 1200 Trades
    let now = 0;
    const budget = new WeightBudget(
      40,
      () => now,
      async (ms) => {
        now += ms;
      },
    );
    const { rec, calls } = setup(rows, null, budget);
    await rec.start();
    const s = rec.sym.get('BTCUSDT')!;
    rec.handle(s, items(rows.slice(-1)), true);
    // Seiten zu 1000 → 2 Requests à 20, Budget 40/min reicht genau; ein dritter müsste warten
    while (await rec.catchUpOnce(s)) {
      /* nachholen */
    }
    expect(calls()).toBe(2);
    expect(now).toBe(0);
    await budget.take(20);
    expect(now).toBe(60_000);
    await rec.stop();
  });
});
