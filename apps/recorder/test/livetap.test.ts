// Live-Tap (Etappe 1): snap + Deltas ergeben an jeder Commit-Grenze exakt agg.minute(m) – für einen
// Client ab Beginn und einen später verbundenen, nach Spool-Wiedergabe und zufällig gestückeltem
// Weiterlauf; ein Fehler in der Tap stört Aggregation und Schreiben nicht; GET /live (Clientgrenze).
import {
  DAY_MS,
  getSymbol,
  LiveBook,
  liveBarOf,
  MINUTE_MS,
  parseLiveMsg,
  type MinuteDelta,
} from '@orderflow/core';
import fc from 'fast-check';
import { mkdtempSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toItem, type RawAgg, type RestSource } from '../src/binance.ts';
import { LiveTap } from '../src/livetap.ts';
import { Recorder, type LiveSink } from '../src/recorder.ts';
import { SpoolWriter } from '../src/spool.ts';
import type { SocketLike } from '../src/ws.ts';

const BTC = getSymbol('BTCUSDT');
const DAY = Date.UTC(2026, 10, 25) / DAY_MS;
const D0 = DAY * DAY_MS;
const A0 = 7_000;

const dead = (): SocketLike => {
  const s: SocketLike = { onopen: null, onmessage: null, onclose: null, onerror: null, close() {} };
  queueMicrotask(() => s.onopen?.({}));
  return s;
};

/** Ein „Client": sammelt SSE-Blöcke wie ein ServerResponse und setzt sie zu einem LiveBook zusammen. */
class FakeClient {
  readonly book = new LiveBook('BTCUSDT');
  readonly results: string[] = [];
  private buf = '';
  readonly res = {
    writableLength: 0,
    writeHead: () => {},
    write: (s: string) => {
      this.buf += s;
      return true;
    },
    on: () => {},
    end: () => {},
    destroy: () => {},
  } as unknown as ServerResponse;

  drain(): void {
    for (let i = this.buf.indexOf('\n\n'); i >= 0; i = this.buf.indexOf('\n\n')) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      if (!block.startsWith('data: ')) continue;
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const m = parseLiveMsg(JSON.parse(line.slice(6)));
        if (!m) throw new Error(`ungültig: ${line}`);
        if (m.sym !== 'BTCUSDT') continue;
        this.results.push(this.book.apply(m));
      }
    }
  }
}

interface Step {
  dt: number;
  dpx: number;
  q: number;
  m: boolean;
}

function rowsOf(steps: Step[]): RawAgg[] {
  let T = D0 + 1_000;
  let px = 600_000;
  return steps.map((x, i) => {
    T += x.dt;
    px = Math.max(10, px + x.dpx);
    return {
      a: A0 + i,
      p: (px / 10).toFixed(1),
      q: (x.q / 1000).toFixed(3),
      f: (A0 + i) * 2,
      l: (A0 + i) * 2,
      T,
      m: x.m,
    };
  });
}

function setup(rows: RawAgg[], spoolDir: string | null, now: () => number) {
  const written: MinuteDelta[] = [];
  const rest: RestSource = {
    async aggTrades(_s, fromId, limit) {
      const i = rows.findIndex((r) => r.a >= fromId);
      return i < 0 ? [] : rows.slice(i, i + limit);
    },
    async klines() {
      return [];
    },
  };
  const sink: LiveSink = {
    startState: async () => ({
      final: { day: DAY - 1, lastAggId: A0 - 1, carry: null, cand: null },
      provisional: [],
      bigFloorN: null,
    }),
    writeMinute: async (_s, d) => {
      await new Promise((r) => setTimeout(r, 0));
      written.push(d);
      return 'written';
    },
    markGap: async () => {},
    markFrozen: async () => {},
    writeKlineChecks: async () => {},
  };
  const hooks: { onCommit: (sym: string, ms: number) => void } = { onCommit: () => {} };
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
    now,
    onMinuteCommitted: (sym, ms) => hooks.onCommit(sym, ms),
  });
  return { rec, written, hooks };
}

const stepArb = fc.record({
  dt: fc.oneof(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 1_000, max: 45_000 })),
  dpx: fc.integer({ min: -30, max: 30 }),
  q: fc.integer({ min: 1, max: 900 }),
  m: fc.boolean(),
});

describe('LiveTap', () => {
  it('Spool-Wiedergabe + Weiterlauf: an jeder Commit-Grenze ist die Minute beim Client exakt agg.minute(m)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 20, maxLength: 160 }),
        fc.integer({ min: 0, max: 100 }),
        fc.array(fc.integer({ min: 1, max: 25 }), { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 0, max: 30 }),
        async (steps, spoolPct, chunks, lateAt) => {
          const rows = rowsOf(steps);
          const dir = mkdtempSync(join(tmpdir(), 'livetap-'));
          const nSpool = Math.floor((rows.length * spoolPct) / 100);
          if (nSpool > 0) {
            const w = new SpoolWriter(dir, 'BTCUSDT');
            w.append(rows.slice(0, nSpool).map((r) => toItem(r, BTC, false)));
            w.close();
          }
          let clock = (rows[nSpool - 1]?.T ?? D0) + 500;
          const { rec, written, hooks } = setup(rows, dir, () => clock);
          await rec.start(); // spielt die Spool ein (Commits davor sieht die Tap nicht)
          await rec.drain();
          const s = rec.sym.get('BTCUSDT')!;
          const tap = new LiveTap(rec, { now: () => clock });
          const early = new FakeClient();
          tap.attach({} as never, early.res);
          let late: FakeClient | null = null;
          let checks = 0;
          let commits = 0;
          hooks.onCommit = (sym, ms) => {
            commits++;
            tap.commit(sym, ms);
            const want = liveBarOf(s.days.get(DAY)!.live.agg.minuteBar((ms - D0) / MINUTE_MS)!);
            for (const c of [early, late]) {
              if (!c) continue;
              c.drain();
              expect(c.book.bars.get(ms)).toEqual(want);
              expect(c.book.committedTo).toBe(ms + MINUTE_MS);
              checks++;
            }
          };
          let i = nSpool;
          let k = 0;
          while (i < rows.length) {
            const n = chunks[k++ % chunks.length]!;
            const part = rows.slice(i, i + n);
            i += part.length;
            clock = part[part.length - 1]!.T + 300;
            rec.handle(
              s,
              part.map((r) => toItem(r, BTC, false)),
              true,
            );
            if (k % 3 !== 0) tap.poll(); // nicht nach jedem Stück: auch mehrere Änderungen je Durchgang
            if (k === lateAt) {
              late = new FakeClient();
              tap.attach({} as never, late.res);
            }
            await rec.drain();
          }
          clock = rows[rows.length - 1]!.T + 70_000;
          rec.completeMinutes(s, clock);
          await rec.drain();
          tap.poll();
          early.drain();
          // jede Nachricht passte (keine Lücke, keine Dublette); alle live geschriebenen Minuten geprüft
          expect(early.results.every((r) => r === 'ok')).toBe(true);
          if (late) expect(late.results.every((r) => r === 'ok')).toBe(true);
          expect(checks).toBeGreaterThanOrEqual(commits);
          expect(written.length).toBeGreaterThan(0);
          expect(tap.stats.errors).toBe(0);
          tap.stop();
          await rec.stop();
        },
      ),
      { numRuns: 30 },
    );
  });

  it('Fehler in der Tap stören Aggregation und Schreiben nicht', async () => {
    const steps: Step[] = Array.from({ length: 120 }, (_, i) => ({
      dt: 1_500 + (i % 7) * 100,
      dpx: (i % 5) - 2,
      q: 1 + (i % 9),
      m: i % 3 === 0,
    }));
    const rows = rowsOf(steps);
    const run = async (broken: boolean) => {
      let clock = D0;
      const { rec, written, hooks } = setup(rows, null, () => clock);
      await rec.start();
      const s = rec.sym.get('BTCUSDT')!;
      const tap = new LiveTap(rec, { now: () => clock });
      if (broken) {
        // jede innere Stelle wirft: Diff, Senden, Begrüßung
        const t = tap as unknown as Record<string, unknown>;
        t.changedBars = () => {
          throw new Error('boom diff');
        };
        tap.hub.broadcast = () => {
          throw new Error('boom send');
        };
        t.greeting = () => {
          throw new Error('boom greet');
        };
      }
      hooks.onCommit = (sym, ms) => tap.commit(sym, ms);
      tap.attach({} as never, new FakeClient().res);
      for (let i = 0; i < rows.length; i += 5) {
        clock = rows[Math.min(rows.length, i + 5) - 1]!.T;
        rec.handle(
          s,
          rows.slice(i, i + 5).map((r) => toItem(r, BTC, false)),
          true,
        );
        tap.poll();
        await rec.drain();
      }
      rec.completeMinutes(s, rows[rows.length - 1]!.T + 70_000);
      await rec.drain();
      const out = { written: written.map((d) => d.bars[0]!.bars[0]), errors: tap.stats.errors };
      tap.stop();
      await rec.stop();
      return { ...out, committed: s.lastCommittedMinute, writeErrors: rec.writeErrors };
    };
    const ok = await run(false);
    const bad = await run(true);
    expect(bad.errors).toBeGreaterThan(0);
    expect(ok.errors).toBe(0);
    expect(bad.written).toEqual(ok.written);
    expect(bad.written.length).toBeGreaterThan(3);
    expect(bad.committed).toBe(ok.committed);
    expect(bad.writeErrors).toBe(0);
  });

  it('Recorder: ein werfender onMinuteCommitted unterbricht die Schreibwarteschlange nicht', async () => {
    const rows = rowsOf(
      Array.from({ length: 60 }, (_, i) => ({ dt: 4_000, dpx: i % 3, q: 5, m: false })),
    );
    const { rec, written, hooks } = setup(rows, null, () => D0);
    hooks.onCommit = () => {
      throw new Error('boom');
    };
    await rec.start();
    const s = rec.sym.get('BTCUSDT')!;
    rec.handle(
      s,
      rows.map((r) => toItem(r, BTC, false)),
      true,
    );
    rec.completeMinutes(s, rows[rows.length - 1]!.T + 70_000);
    await rec.drain();
    expect(written.length).toBe(new Set(rows.map((r) => Math.floor(r.T / MINUTE_MS))).size);
    expect(rec.queueLength()).toBe(0);
    await rec.stop();
  });

  it('GET /live: snap beim Verbinden, höchstens 2 Clients (dritter 503), Herzschlag ≥ 1 Hz', async () => {
    const rows = rowsOf(Array.from({ length: 30 }, () => ({ dt: 500, dpx: 1, q: 3, m: false })));
    let clock = D0;
    const { rec } = setup(rows, null, () => clock);
    await rec.start();
    const s = rec.sym.get('BTCUSDT')!;
    rec.handle(
      s,
      rows.map((r) => toItem(r, BTC, false)),
      true,
    );
    clock = rows[rows.length - 1]!.T;
    const tap = new LiveTap(rec, { now: () => clock });
    const server = createServer((req, res) => tap.attach(req, res)).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/live`;
    const ac = new AbortController();
    const a = await fetch(url, { signal: ac.signal });
    const b = await fetch(url, { signal: ac.signal });
    const c = await fetch(url, { signal: ac.signal });
    expect([a.status, b.status, c.status]).toEqual([200, 200, 503]);
    const reader = a.body!.getReader();
    let text = '';
    while (!text.includes('"t":"snap"'))
      text += new TextDecoder().decode((await reader.read()).value);
    const snap = parseLiveMsg(JSON.parse(text.split('data: ')[1]!.split('\n')[0]!))!;
    expect(snap.t).toBe('snap');
    // Herzschlag: ohne Änderung nach ≥ 1 s ein leerer tick
    tap.poll();
    const before = tap.stats.ticks;
    tap.poll();
    expect(tap.stats.ticks).toBe(before);
    clock += 1_000;
    tap.poll();
    expect(tap.stats.ticks).toBe(before + 1);
    ac.abort();
    tap.stop();
    server.close();
    await rec.stop();
  });
});

describe('Konfiguration OF_LIVE / OF_LIVE_HZ', () => {
  it('Standard an mit 4 Hz; abschaltbar; Frequenz begrenzt', async () => {
    const { recorderConfig } = await import('../src/main.ts');
    expect(recorderConfig({})).toMatchObject({ live: true, liveHz: 4 });
    expect(recorderConfig({ OF_LIVE: '0', OF_LIVE_HZ: '10' })).toMatchObject({
      live: false,
      liveHz: 10,
    });
    expect(() => recorderConfig({ OF_LIVE_HZ: '0' })).toThrow(/OF_LIVE_HZ/);
    expect(() => recorderConfig({ OF_LIVE_HZ: '50' })).toThrow(/OF_LIVE_HZ/);
  });
});

describe('LiveTap: Rückstand, frische Installation, eingefrorener Tag', () => {
  /** Recorder mit zurückhaltbaren Schreibvorgängen (DB steht) */
  function blocked(final: boolean, now: () => number) {
    const written: MinuteDelta[] = [];
    let release: (() => void)[] = [];
    const block = { on: true };
    const sink: LiveSink = {
      startState: async () => ({
        final: final ? { day: DAY - 1, lastAggId: A0 - 1, carry: null, cand: null } : null,
        provisional: [],
        bigFloorN: null,
      }),
      writeMinute: async (_s, d) => {
        if (block.on) await new Promise<void>((r) => release.push(r));
        written.push(d);
        return 'written';
      },
      markGap: async () => {},
      markFrozen: async () => {},
      writeKlineChecks: async () => {},
    };
    const hooks = { onCommit: (_s: string, _m: number) => {} };
    const rec = new Recorder({
      symbols: ['BTCUSDT'],
      wsUrl: 'wss://test.invalid',
      socketFactory: dead,
      rest: { aggTrades: async () => [], klines: async () => [] },
      sink,
      spoolDir: null,
      log: () => {},
      autoLoops: false,
      klineCheck: false,
      now,
      onMinuteCommitted: (s, m) => hooks.onCommit(s, m),
    });
    const releaseAll = () => {
      block.on = false;
      const r = release;
      release = [];
      for (const f of r) f();
    };
    return { rec, written, hooks, releaseAll };
  }
  const row = (i: number, T: number): RawAgg => ({
    a: A0 + i,
    p: (60000 + (i % 13) / 10).toFixed(1),
    q: '0.010',
    f: (A0 + i) * 2,
    l: (A0 + i) * 2,
    T,
    m: i % 2 === 0,
  });

  for (const final of [true, false]) {
    it(`Schreibrückstand über 300 Minuten (${final ? 'mit' : 'ohne'} bekannte Grenze): höchstens 240 Minuten, Nachrichten klein, danach commits`, async () => {
      const t0 = D0 + 60 * MINUTE_MS;
      let clock = t0;
      const { rec, written, hooks, releaseAll } = blocked(final, () => clock);
      await rec.start();
      const s = rec.sym.get('BTCUSDT')!;
      // frische Installation: die ersten 300 Minuten liegen schon im Speicher, bevor die Tap startet
      let i = 0;
      const feed = (until: number) => {
        for (; t0 + i * 20_000 < until; i++) {
          const T = t0 + i * 20_000;
          clock = T + 50;
          rec.handle(s, [toItem(row(i, T), BTC, false)], true);
        }
      };
      feed(t0 + 300 * MINUTE_MS);
      const tap = new LiveTap(rec, { now: () => clock });
      hooks.onCommit = (sym, ms) => tap.commit(sym, ms);
      const c = new FakeClient();
      let maxBlock = 0;
      const res = c.res as unknown as { write: (s: string) => boolean };
      const w = res.write;
      res.write = (x: string) => {
        maxBlock = Math.max(maxBlock, x.length);
        return w(x);
      };
      tap.attach({} as never, c.res);
      tap.poll();
      feed(t0 + 320 * MINUTE_MS);
      tap.poll();
      c.drain();
      expect(c.book.bars.size).toBeLessThanOrEqual(240);
      expect(c.book.from).toBeGreaterThanOrEqual(t0 + 320 * MINUTE_MS - 241 * MINUTE_MS);
      expect(maxBlock).toBeLessThan(80_000); // ≤ 240 Minuten à ≈ 200 B
      expect(s.unwritten).toBeGreaterThan(240);
      releaseAll();
      await new Promise((r) => setTimeout(r, 20));
      await rec.drain();
      tap.poll();
      c.drain();
      expect(c.results.every((r) => r === 'ok')).toBe(true);
      expect(c.book.committedTo).toBe(
        written.at(-1)!.day * DAY_MS + (written.at(-1)!.minute + 1) * MINUTE_MS,
      );
      expect(tap.stats.errors).toBe(0);
      tap.stop();
      await rec.stop();
    });
  }

  it('eingefrorener Tag: status.frozen, keine Live-Minuten mehr; recvMs im tick', async () => {
    let clock = D0 + 5 * MINUTE_MS;
    const { rec, hooks } = blocked(true, () => clock);
    await rec.start();
    const s = rec.sym.get('BTCUSDT')!;
    const tap = new LiveTap(rec, { now: () => clock });
    hooks.onCommit = (sym, ms) => tap.commit(sym, ms);
    const c = new FakeClient();
    tap.attach({} as never, c.res);
    s.wsLastMsg = clock - 20;
    s.eventLagMs = 30;
    rec.handle(s, [toItem(row(0, clock - 100), BTC, false)], true);
    tap.poll();
    c.drain();
    expect(c.book.recvMs).toBe(clock - 20);
    expect(c.book.eventMs).toBe(clock - 50);
    expect(c.book.bars.size).toBe(1);
    rec.freeze(s, DAY, 'Test');
    clock += 30_000;
    rec.handle(s, [toItem(row(1, clock - 100), BTC, false)], true);
    tap.poll();
    c.drain();
    expect(c.book.status.frozen).toBe('Test');
    expect([...c.book.bars.values()].map((b) => b.lastAgg)).toEqual([A0]); // nichts Neues
    expect(c.results.every((r) => r === 'ok')).toBe(true);
    tap.stop();
    await rec.stop();
  });
});
