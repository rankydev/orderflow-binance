// Einheiten des Recorders mit Fake-Quellen: Feed (Duplikate, Umordnung, Sprünge, bewiesene
// Lücken), REST-Gewichtsbudget, WebSocket-Neuaufbau/Stille/24-h-Wechsel, Spool mit abgeschnittenem
// Frame.
import { getSymbol } from '@orderflow/core';
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toItem, WeightBudget } from '../src/binance.ts';
import { SymbolFeed, type FeedItem } from '../src/feed.ts';
import { readSpoolDay, SpoolWriter } from '../src/spool.ts';
import { StreamClient, type SocketLike } from '../src/ws.ts';

const BTC = getSymbol('BTCUSDT');
const T0 = Date.UTC(2026, 10, 25);
const item = (a: number, T = T0 + a, viaRest = false): FeedItem =>
  toItem({ a, p: '60000.10', q: '0.001', f: a * 2, l: a * 2, T, m: a % 2 === 0 }, BTC, viaRest);

describe('SymbolFeed', () => {
  it('gibt nur lückenlose Folgen aus, verwirft Duplikate, puffert vorauseilende IDs', () => {
    const f = new SymbolFeed(100);
    expect(f.push([item(100), item(101)]).map((x) => x.trade.a)).toEqual([100, 101]);
    expect(f.push([item(101)])).toEqual([]); // Duplikat
    expect(f.push([item(104), item(103)])).toEqual([]); // 102 fehlt
    expect(f.gapOpen()).toBe(true);
    expect(f.stats.jumps).toBe(1);
    expect(
      f.push([item(102, T0 + 102, true), item(103, T0 + 103, true)]).map((x) => x.trade.a),
    ).toEqual([102, 103, 104]);
    expect(f.gapOpen()).toBe(false);
    expect(f.stats.duplicates).toBe(2);
  });

  it('unbekannte Startposition: die erste Nachricht setzt sie; bewiesene Lücke; nicht füllbare Lücke', () => {
    const f = new SymbolFeed(null);
    expect(f.push([item(7), item(5), item(6)]).map((x) => x.trade.a)).toEqual([5, 6, 7]);
    f.push([item(20)]);
    f.skipProvenMissing(12); // REST ab 8 liefert als erste ID 12
    expect(f.stats.provenMissing).toBe(4);
    expect(f.abandonGap()).toEqual({ from: 12, to: 19 });
    expect(f.push([]).map((x) => x.trade.a)).toEqual([20]);
    expect(f.push([item(21)]).map((x) => x.trade.a)).toEqual([21]);
  });
});

describe('WeightBudget', () => {
  it('hält das Minutenbudget ein, beachtet den Server-Header und 429-Sperren', async () => {
    let now = 0;
    const slept: number[] = [];
    const b = new WeightBudget(
      60,
      () => now,
      async (ms) => {
        slept.push(ms);
        now += ms;
      },
    );
    await b.take(20);
    await b.take(20);
    await b.take(20);
    expect(slept).toEqual([]);
    await b.take(20); // viertes Mal: wartet, bis der erste Eintrag aus dem Fenster fällt
    expect(now).toBe(60_000);
    b.serverUsed = 2400; // andere Prozesse derselben IP
    expect(b.waitFor(20)).toBeGreaterThan(0);
    b.serverUsed = 0;
    b.block(5000);
    expect(b.waitFor(1)).toBe(5000);
  });
});

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed = false;
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.onopen?.({});
  }
  send(a: number) {
    this.onmessage?.({ data: JSON.stringify({ stream: 'btcusdt@aggTrade', data: { a } }) });
  }
}

describe('StreamClient', () => {
  function setup() {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const socks: FakeSocket[] = [];
    const got: number[] = [];
    const c = new StreamClient({
      url: 'wss://x',
      factory: () => {
        const s = new FakeSocket();
        socks.push(s);
        return s;
      },
      onMessage: (_s, d) => got.push((d as { a: number }).a),
      now: () => now,
      setTimer: (fn, ms) => timers.push({ at: now + ms, fn }),
      clearTimer: () => {},
    });
    const advance = (ms: number) => {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
      }
      now = end;
    };
    return { c, socks, got, advance };
  }

  it('baut nach Abbruch mit Backoff neu auf und nach 15 s Stille', () => {
    const { c, socks, advance } = setup();
    c.start();
    socks[0]!.open();
    socks[0]!.send(1);
    socks[0]!.close();
    expect(c.connected).toBe(false);
    advance(1500);
    expect(socks).toHaveLength(2);
    socks[1]!.open();
    socks[1]!.send(2);
    advance(18_000); // Stille
    expect(socks.length).toBeGreaterThanOrEqual(3);
    expect(c.reconnects).toBeGreaterThanOrEqual(2);
    c.stop();
  });

  it('wechselt nach 23 h mit Überlappung: alte Verbindung erst nach der ersten Nachricht der neuen zu', () => {
    const { c, socks, got, advance } = setup();
    c.start();
    socks[0]!.open();
    for (let h = 0; h < Math.ceil((23 * 3600) / 14) + 2; h++) {
      socks[0]!.send(h);
      advance(14_000);
    }
    expect(socks).toHaveLength(2); // neue Verbindung geöffnet
    expect(socks[0]!.closed).toBe(false);
    socks[1]!.open();
    socks[0]!.send(9_999_990); // alte liefert noch
    socks[1]!.send(9_999_991); // erste der neuen → umschalten
    expect(socks[0]!.closed).toBe(true);
    expect(c.rotations).toBe(1);
    expect(got.slice(-2)).toEqual([9_999_990, 9_999_991]);
    c.stop();
  });
});

describe('Spool', () => {
  it('ein zstd-Frame je Flush; abgeschnittener letzter Frame wird verworfen; REST-Bereiche bleiben', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spool-'));
    const w = new SpoolWriter(dir, 'BTCUSDT');
    w.append([item(1), item(2), item(3, T0 + 3, true)]);
    w.flush();
    w.append([item(4, T0 + 4, true), item(5)]);
    w.flush();
    w.append([item(6), item(7)]);
    w.flush();
    w.close();
    expect(w.flushes).toBe(3);
    const d = join(dir, 'BTCUSDT', '2026-11-25');
    const file = join(
      d,
      readdirSync(d).find((f) => f.endsWith('.csv.zst'))!,
    );
    const day = Date.UTC(2026, 10, 25) / 86_400_000;
    const full = await readSpoolDay(dir, 'BTCUSDT', day);
    expect(full.items.map((x) => [x.trade.a, x.viaRest])).toEqual([
      [1, false],
      [2, false],
      [3, true],
      [4, true],
      [5, false],
      [6, false],
      [7, false],
    ]);
    // Absturz mitten im letzten Frame
    const size = readFileSync(file).length;
    truncateSync(file, size - 5);
    const cut = await readSpoolDay(dir, 'BTCUSDT', day);
    expect(cut.truncatedFiles).toBe(1);
    expect(cut.items.map((x) => x.trade.a).slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(cut.items.length).toBeLessThan(7);
    // Müll am Ende ist ebenfalls nur ein verworfener Frame
    appendFileSync(file, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]));
    expect((await readSpoolDay(dir, 'BTCUSDT', day)).items.length).toBe(cut.items.length);
    writeFileSync(join(d, 'unrelated.txt'), 'x');
  });
});
