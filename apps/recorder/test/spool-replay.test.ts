// Start mit großer Tages-Spool (Vorfall 2026-11-27): der Recorder spielte die Spool eines Tages als
// ein Array ein (≈ 290 B Heap je Zeile, BTC spät am Tag > 2 Mio. Zeilen) und hielt es noch, während
// das nächste Symbol gelesen wurde → „heap out of memory" bei --max-old-space-size=896 in Schleife.
// Geprüft wird strukturell: die Spool kommt in Stücken ≤ SPOOL_REPLAY_CHUNK, und das Ergebnis
// (alle Minuten-Deltas inkl. big_order, Ordersummen, Abgleichschlüssel; Endstand des Tages) ist
// identisch mit dem Einspielen des ganzen Tages in einem Aufruf.
import { DAY_MS, getSymbol, MINUTE_MS, type MinuteDelta } from '@orderflow/core';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toItem, type RawAgg } from '../src/binance.ts';
import type { FeedItem } from '../src/feed.ts';
import { Recorder, type LiveSink } from '../src/recorder.ts';
import { readSpoolDay, readSpoolDayChunks, SPOOL_REPLAY_CHUNK, SpoolWriter } from '../src/spool.ts';
import type { SocketLike } from '../src/ws.ts';

const BTC = getSymbol('BTCUSDT');
const DAY = Date.UTC(2026, 10, 25) / DAY_MS;
const D0 = DAY * DAY_MS;
const A0 = 1_000_000;

/** ≈ 130 000 aggTrades über zwei Stunden (> SPOOL_REPLAY_CHUNK je Stundendatei); Orders (gleiches T, Seite, aggId +1) mit 1–5 aggTrades. */
function dayRows(): RawAgg[] {
  const out: RawAgg[] = [];
  let a = A0;
  let T = D0 + 1000;
  let k = 0;
  while (T < D0 + 2 * 3_600_000 - 1000) {
    const run = 1 + (k % 5);
    const m = k % 3 === 0;
    for (let i = 0; i < run; i++) {
      out.push({
        a,
        p: (60000 + ((k * 7) % 400) / 10).toFixed(1),
        q: (0.001 * (1 + (k % 4))).toFixed(3),
        f: a * 3,
        l: a * 3 + (k % 2),
        T,
        m,
      });
      a++;
    }
    T += 133 + (k % 2) * 66; // T steigt (gleiches T nur innerhalb einer Order)
    k++;
  }
  return out;
}

function writeSpool(dir: string, raw: RawAgg[]): void {
  const w = new SpoolWriter(dir, 'BTCUSDT');
  const items = raw.map((r, i) => toItem(r, BTC, i % 997 < 40)); // auch REST-Bereiche
  for (let i = 0; i < items.length; i += 4000) {
    w.append(items.slice(i, i + 4000));
    w.flush();
  }
  // Absturzspuren: ein Block doppelt und umgeordnet am Ende einer Stunde
  const dup = items.filter((x) => x.trade.T < D0 + 3_600_000).slice(-300);
  w.append(dup.reverse());
  w.flush();
  w.close();
}

const dead = (): SocketLike => ({
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
  close() {},
});

function make(spoolDir: string | null, floor: number) {
  const written: MinuteDelta[] = [];
  const handled: number[] = [];
  const sink: LiveSink = {
    startState: async () => ({
      final: { day: DAY - 1, lastAggId: A0 - 1, carry: null, cand: null },
      provisional: [],
      bigFloorN: floor,
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
    rest: { aggTrades: async () => [], klines: async () => [] },
    sink,
    spoolDir,
    log: () => {},
    autoLoops: false,
    klineCheck: false,
    now: () => D0 + 4 * 3_600_000,
  });
  const orig = rec.handle.bind(rec);
  rec.handle = (s, items: FeedItem[], spool: boolean, complete?: boolean) => {
    handled.push(items.length);
    orig(s, items, spool, complete);
  };
  return { rec, written, handled };
}

/** Fingerabdruck (SHA-256 über die JSON-Form; bigint und Typed Arrays ausgeschrieben). */
const plain = (v: unknown): string =>
  createHash('sha256')
    .update(
      JSON.stringify(v, (_k, x: unknown) =>
        typeof x === 'bigint'
          ? `${x}n`
          : ArrayBuffer.isView(x)
            ? Array.from(x as unknown as ArrayLike<number>)
            : x,
      ),
    )
    .digest('hex');
const deltaView = (d: MinuteDelta) =>
  plain({ ...d, bigDay: d.bigDay(), dayBarsKey: d.dayBarsKey() });

describe('Start mit großer Tages-Spool (Vorfall 2026-11-27)', () => {
  it('liest die Spool in Stücken ≤ SPOOL_REPLAY_CHUNK; zusammen gleich readSpoolDay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'of-spool-replay-'));
    const raw = dayRows();
    expect(raw.length).toBeGreaterThan(2 * SPOOL_REPLAY_CHUNK);
    writeSpool(dir, raw);
    const stats = { rows: 0, truncatedFiles: 0 };
    const sizes: number[] = [];
    const ids: number[] = [];
    for (const part of readSpoolDayChunks(dir, 'BTCUSDT', DAY, stats, 20_000)) {
      sizes.push(part.length);
      for (const x of part) ids.push(x.trade.a);
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(20_000);
    expect(sizes.length).toBeGreaterThan(raw.length / 20_000);
    const all = await readSpoolDay(dir, 'BTCUSDT', DAY);
    expect(stats.rows).toBe(all.items.length);
    expect(ids).toEqual(all.items.map((x) => x.trade.a));
  });

  it('Recorder.start: Stücke statt ganzem Tag, Ergebnis identisch zum Einspielen in einem Aufruf', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'of-spool-replay-'));
    const raw = dayRows();
    writeSpool(dir, raw);
    const one = toItem(raw[0]!, BTC, false).trade;
    const floor = 3 * one.px * one.q; // Orders ab ≈ 3 aggTrades sind big orders

    // neu: Start mit Spool
    const a = make(dir, floor);
    await a.rec.start();
    await a.rec.drain();
    await a.rec.stop();
    expect(a.handled.length).toBeGreaterThan(2);
    expect(Math.max(...a.handled)).toBeLessThanOrEqual(SPOOL_REPLAY_CHUNK);

    // Referenz: der ganze Tag in einem handle() (bisheriges Verhalten)
    const b = make(null, floor);
    await b.rec.start();
    const sb = b.rec.sym.get('BTCUSDT')!;
    b.rec.handle(sb, (await readSpoolDay(dir, 'BTCUSDT', DAY)).items, false);
    await b.rec.drain();
    await b.rec.stop();

    expect(a.written.length).toBeGreaterThan(110);
    expect(a.written.some((d) => d.big.rows.length > 0)).toBe(true);
    expect(a.written.some((d) => d.viaRest)).toBe(true);
    expect(a.written.map(deltaView)).toEqual(b.written.map(deltaView));
    const sa = a.rec.sym.get('BTCUSDT')!;
    expect(sa.feed.expected).toBe(A0 + raw.length);
    expect(sa.feed.gapOpen()).toBe(false);
    expect(plain(sa.days.get(DAY)!.live.snapshot())).toEqual(
      plain(sb.days.get(DAY)!.live.snapshot()),
    );
    // alle Minuten bis zum letzten Trade (minus Marge) abgeschlossen
    const lastT = raw[raw.length - 1]!.T;
    expect(sa.days.get(DAY)!.completeBefore).toBe(Math.floor((lastT - 2000 - D0) / MINUTE_MS));
  }, 30_000);
});
