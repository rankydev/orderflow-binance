// Live-Format (wire.ts): Naht DB/Live für alle Zeitrahmen gegen die direkte Aggregation,
// Zusammensetzen aus snap + Deltas (Sprung, Neuverbindung, doppelte/verspätete Nachrichten),
// Ablöseprüfung, Formprüfung.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  aggregateDay,
  bucketOf,
  combineBars,
  composeBars,
  DayAggregator,
  groupByBucket,
  handoverDiff,
  LIVE_MAX_MINUTES,
  LIVE_RETAIN_MS,
  LIVE_WIRE_VERSION,
  LiveBook,
  liveBarOf,
  liveTail,
  MINUTE_MS,
  parseLiveMsg,
  STATUS_UNKNOWN,
  TIMEFRAMES,
  type Bar,
  type LiveBar,
  type LiveMsg,
  type OhlcvLite,
} from '../src/index.ts';
import { DAY, DAY_START, tradesArb } from './gen.ts';

const lite = (b: Bar | OhlcvLite): OhlcvLite => ({
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  buyQ: b.buyQ,
  sellQ: b.sellQ,
  buyA: b.buyA,
  sellA: b.sellA,
});

const bar = (ts: number, close: number, a: number): LiveBar => ({
  ts,
  open: close,
  high: close,
  low: close,
  close,
  buyQ: 1,
  sellQ: 0,
  buyA: 1,
  sellA: 0,
  firstAgg: a,
  lastAgg: a,
});

const base = { v: LIVE_WIRE_VERSION, sym: 'BTCUSDT', serverMs: 1 };
const status = { ...STATUS_UNKNOWN, recorder: true, stream: true };
const snap = (seq: number, committedTo: number, bars: LiveBar[] = []): LiveMsg => ({
  ...base,
  t: 'snap',
  seq,
  committedTo,
  from: committedTo - LIVE_RETAIN_MS,
  price: null,
  eventMs: null,
  bars,
  status,
});
const tick = (seq: number, bars: LiveBar[]): LiveMsg => ({
  ...base,
  t: 'tick',
  seq,
  price: bars.at(-1)?.close ?? null,
  eventMs: 1,
  bars,
});
const commit = (seq: number, ts: number): LiveMsg => ({
  ...base,
  t: 'commit',
  seq,
  ts,
  committedTo: ts + MINUTE_MS,
});

describe('Naht live → final', () => {
  it('DB-Anteil (< committedTo) + Live-Minuten (≥ committedTo) = direkte Aggregation, alle Zeitrahmen', () => {
    fc.assert(
      fc.property(
        tradesArb({ spanMin: 1440, maxTrades: 400 }),
        fc.integer({ min: 0, max: 1440 }),
        (trades, cMin) => {
          const minutes = aggregateDay(DAY, trades).bars;
          const C = DAY_START + cMin * MINUTE_MS;
          for (const tfSec of Object.values(TIMEFRAMES)) {
            const buckets = new Map<number, Bar[]>();
            for (const b of minutes) {
              const k = bucketOf(b.ts, tfSec);
              buckets.set(k, [...(buckets.get(k) ?? []), b]);
            }
            // DB-Antwort: nur Minuten < C, je Bucket komponiert (wie time_bucket über bar_1m/bar_1h)
            const db = new Map<number, OhlcvLite>();
            for (const [k, parts] of buckets) {
              const before = parts.filter((b) => b.ts < C);
              if (before.length) db.set(k, lite(composeBars(k, before)));
            }
            const tail = minutes.filter((b) => b.ts >= C).map(liveBarOf);
            const live = new Map(groupByBucket(tail, tfSec).map((g) => [g.ts, g.parts]));
            let vol = 0;
            for (const [k, parts] of buckets) {
              const got = combineBars(db.get(k) ?? null, live.get(k) ?? []);
              expect(got, `tf ${tfSec} bucket ${k}`).toEqual(lite(composeBars(k, parts)));
              vol += got!.buyQ + got!.sellQ;
            }
            // disjunkt: jede Menge genau einmal
            expect(vol).toBe(minutes.reduce((s, b) => s + b.buyQ + b.sellQ, 0));
            for (const k of live.keys()) expect(buckets.has(k)).toBe(true);
          }
        },
      ),
      { numRuns: 80 },
    );
  });

  it('liveTail: nur ts ≥ committedTo der DB-Antwort; unvollständig, wenn der Live-Stand nicht so weit zurückreicht', () => {
    const b = new LiveBook('BTCUSDT');
    const C = DAY_START + 100 * MINUTE_MS;
    b.apply(snap(0, C, [bar(C - 3 * MINUTE_MS, 1, 1), bar(C, 2, 2), bar(C + MINUTE_MS, 3, 3)]));
    expect(liveTail(b, C).bars.map((x) => x.close)).toEqual([2, 3]);
    expect(liveTail(b, C).complete).toBe(true);
    // DB-Antwort älter (verspätet, Cache): Minuten ab dort kommen live dazu
    expect(liveTail(b, C - 5 * MINUTE_MS).bars.map((x) => x.close)).toEqual([1, 2, 3]);
    // DB-Antwort älter als der Vorhalt → neu laden
    expect(liveTail(b, C - LIVE_RETAIN_MS - MINUTE_MS).complete).toBe(false);
    // DB-Antwort neuer als der Live-Stand: DB ist Wahrheit, Live nur ab dort
    expect(liveTail(b, C + MINUTE_MS).bars.map((x) => x.close)).toEqual([3]);
  });

  it('handoverDiff: gleich → leer; Abweichung in OHLC/Volumen/Trades benannt', () => {
    const agg = new DayAggregator(DAY, null);
    const t = (a: number, T: number, px: number, q: number, m = false) =>
      agg.add({ a, px, q, f: a, l: a, T, m });
    t(1, DAY_START + 5, 100, 2);
    t(2, DAY_START + MINUTE_MS + 5, 110, 3, true);
    t(3, DAY_START + 2 * MINUTE_MS + 5, 90, 1);
    agg.closeOpenMinute(3);
    const m = [0, 1, 2].map((i) => agg.minuteBar(i)!);
    const tf = 180;
    const oldDb = lite(composeBars(DAY_START, [m[0]!]));
    const newDb = lite(composeBars(DAY_START, [m[0]!, m[1]!]));
    expect(handoverDiff(oldDb, [liveBarOf(m[1]!)], newDb)).toBe('');
    expect(handoverDiff(null, [liveBarOf(m[0]!)], lite(m[0]!))).toBe('');
    expect(handoverDiff(oldDb, [{ ...liveBarOf(m[1]!), high: 111 }], newDb)).toMatch(/^high/);
    expect(handoverDiff(oldDb, [{ ...liveBarOf(m[1]!), sellQ: 4 }], newDb)).toMatch(/^Volumen/);
    expect(handoverDiff(oldDb, [{ ...liveBarOf(m[1]!), sellA: 2 }], newDb)).toMatch(/^Trades/);
    expect(handoverDiff(oldDb, [], newDb)).not.toBe('');
    expect(bucketOf(DAY_START + 2 * MINUTE_MS, tf)).toBe(DAY_START);
  });
});

describe('LiveBook (snap + Deltas)', () => {
  const C = DAY_START + 600 * MINUTE_MS;

  it('Sprung → gap (Zustand unverändert); Neuverbindung (snap) setzt zurück; doppelte/verspätete ignoriert', () => {
    const b = new LiveBook('BTCUSDT');
    expect(b.apply(tick(1, [bar(C, 1, 1)]))).toBe('nosnap');
    expect(b.apply(snap(5, C))).toBe('ok');
    expect(b.apply(tick(6, [bar(C, 1, 1)]))).toBe('ok');
    expect(b.apply(tick(6, [bar(C, 9, 9)]))).toBe('duplicate');
    expect(b.apply(tick(4, [bar(C, 9, 9)]))).toBe('duplicate');
    expect(b.bars.get(C)!.close).toBe(1);
    expect(b.apply(tick(8, [bar(C, 2, 2)]))).toBe('gap');
    expect(b.seq).toBe(6);
    expect(b.bars.get(C)!.close).toBe(1);
    // Neuverbindung: neuer Strom mit eigener Zählung (auch kleiner) – snap gilt immer
    expect(b.apply(snap(0, C + MINUTE_MS, [bar(C + MINUTE_MS, 3, 3)]))).toBe('ok');
    expect([...b.bars.keys()]).toEqual([C + MINUTE_MS]);
    expect(b.apply(tick(1, [bar(C + MINUTE_MS, 4, 4)]))).toBe('ok');
    expect(b.price).toBe(4);
    expect(b.apply({ ...tick(2, []), sym: 'ETHUSDT' })).toBe('invalid');
  });

  it('commit verschiebt committedTo und verwirft Minuten vor committedTo − 10 min; verspätete Minuten davor zählen nicht', () => {
    const b = new LiveBook('BTCUSDT');
    b.apply(snap(0, C, [bar(C - 10 * MINUTE_MS, 1, 1), bar(C - 2 * MINUTE_MS, 2, 2)]));
    expect(b.bars.size).toBe(2);
    expect(b.apply(commit(1, C))).toBe('ok');
    expect(b.committedTo).toBe(C + MINUTE_MS);
    expect(b.from).toBe(C + MINUTE_MS - LIVE_RETAIN_MS);
    expect([...b.bars.keys()]).toEqual([C - 2 * MINUTE_MS]);
    // verspätete Minute vor from → ignoriert
    b.apply(tick(2, [bar(C - 10 * MINUTE_MS, 5, 5)]));
    expect(b.bars.has(C - 10 * MINUTE_MS)).toBe(false);
    // älterer commit ändert nichts
    b.apply(commit(3, C - 5 * MINUTE_MS));
    expect(b.committedTo).toBe(C + MINUTE_MS);
  });

  it('höchstens LIVE_MAX_MINUTES Minuten; from folgt', () => {
    const b = new LiveBook('BTCUSDT');
    b.apply(snap(0, C));
    const many = Array.from({ length: LIVE_MAX_MINUTES + 5 }, (_, i) =>
      bar(C + i * MINUTE_MS, i, i),
    );
    b.apply(tick(1, many));
    expect(b.bars.size).toBe(LIVE_MAX_MINUTES);
    expect(b.from).toBe(C + 5 * MINUTE_MS);
  });

  it('snapshot + gleiche Deltas = gleicher Zustand (Sender/Verteiler/Empfänger)', () => {
    const sender = new LiveBook('BTCUSDT');
    const msgs: LiveMsg[] = [snap(0, C)];
    sender.apply(msgs[0]!);
    for (let i = 1; i <= 30; i++) {
      const m =
        i % 7 === 0
          ? commit(sender.seq + 1, (sender.committedTo ?? C) + 0)
          : tick(sender.seq + 1, [bar(C + (i >> 1) * MINUTE_MS, i, i)]);
      expect(sender.apply(m)).toBe('ok');
      msgs.push(m);
    }
    const late = new LiveBook('BTCUSDT');
    late.apply(sender.snapshot(sender.seq));
    const full = new LiveBook('BTCUSDT');
    for (const m of msgs) full.apply(m);
    for (const x of [late, full]) {
      expect(x.sortedBars()).toEqual(sender.sortedBars());
      expect(x.committedTo).toBe(sender.committedTo);
      expect(x.from).toBe(sender.from);
    }
  });
});

describe('parseLiveMsg', () => {
  it('prüft Form und Version, lässt zusätzliche Felder zu', () => {
    const s = snap(0, 60_000 * 1000, [bar(60_000 * 1000, 1, 1)]);
    expect(parseLiveMsg(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseLiveMsg({ ...s, levels: [[1, 2]] })).not.toBeNull();
    expect(parseLiveMsg({ ...s, v: 2 })).toBeNull();
    expect(parseLiveMsg({ ...s, t: 'nope' })).toBeNull();
    expect(parseLiveMsg({ ...s, bars: [{ ...bar(1, 1, 1) }] })).toBeNull(); // ts nicht minutengenau
    expect(parseLiveMsg({ ...tick(1, []), price: 'x' })).toBeNull();
    expect(parseLiveMsg(null)).toBeNull();
    expect(parseLiveMsg(commit(3, 120_000))).not.toBeNull();
  });
});

describe('DayAggregator: nur lesende Live-Sicht', () => {
  it('openMinuteView/minuteBar nach jedem Trade ändern das Ergebnis nicht und zeigen den laufenden Bar', () => {
    fc.assert(
      fc.property(tradesArb({ spanMin: 30, maxTrades: 200 }), (trades) => {
        const agg = new DayAggregator(DAY, 10_000_000);
        for (const t of trades) {
          agg.add(t);
          const v = agg.openMinuteView()!;
          expect(v.minute).toBe(agg.currentMinute);
          // laufender Bar = Aggregation der bisherigen Trades dieser Minute
          const mine = trades.filter(
            (x) => x.a <= t.a && Math.floor((x.T - DAY_START) / MINUTE_MS) === v.minute,
          );
          expect(v.bar.close).toBe(t.px);
          expect(v.bar.buyA + v.bar.sellA).toBe(mine.length);
          if (v.minute > 0) agg.minuteBar(v.minute - 1);
        }
        const ref = aggregateDay(DAY, trades, 10_000_000);
        const got = agg.finish();
        expect(got.bars).toEqual(ref.bars);
        expect(got.bigOrders).toEqual(ref.bigOrders);
        expect(got.fp1m).toEqual(ref.fp1m);
        expect(agg.openMinuteView()).toBeNull();
      }),
      { numRuns: 60 },
    );
  });
});
