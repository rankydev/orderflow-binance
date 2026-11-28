// Live-Anzeige im Browser (Etappe 1): Naht DB/Live über BarStore + composeLive + mergeLive gegen die
// direkte Aggregation (mehrere Zeitrahmen, zufälliges committedTo), Ablösen (checkHandover),
// Statuszustände (Serverzeit, nicht Besucheruhr), LiveClient (Sprung, Fehler/Backoff, Stille,
// unsichtbarer Tab), BarStore nimmt beim Neuladen keine ältere Antwort.
import {
  encodeTile,
  LIVE_RETAIN_MS,
  LIVE_WIRE_VERSION,
  LiveBook,
  MINUTE_MS,
  STATUS_UNKNOWN,
  type LiveBar,
  type LiveMsg,
} from '@orderflow/core/browser';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BarStore } from '../src/lib/bar-store.ts';
import {
  checkHandover,
  composeLive,
  LIVE_HIDDEN_DISCONNECT_MS,
  LIVE_SILENCE_MS,
  LiveClient,
  liveUiState,
  mergeLive,
  reconnectDelayMs,
  type EventSourceLike,
} from '../src/lib/live.ts';
import type { BarItem } from '../src/lib/types.ts';

const T0 = Date.UTC(2026, 10, 25); // Tagesbeginn
const PD = 1;

interface Min {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  buyQ: number;
  sellQ: number;
  buyA: number;
  sellA: number;
}

/** Referenz: Bucket direkt aus allen Minuten (unabhängig von wire.ts). */
function refBuckets(mins: Min[], tfSec: number): Map<number, Min> {
  const out = new Map<number, Min>();
  for (const m of mins) {
    const k = m.ts - (m.ts % (tfSec * 1000));
    const r = out.get(k);
    if (!r) out.set(k, { ...m, ts: k });
    else {
      r.high = Math.max(r.high, m.high);
      r.low = Math.min(r.low, m.low);
      r.close = m.close;
      r.buyQ += m.buyQ;
      r.sellQ += m.sellQ;
      r.buyA += m.buyA;
      r.sellA += m.sellA;
    }
  }
  return out;
}

/** /bars-Abschnitt aus den Minuten < committedTo, je Bucket (wie die Datenbank) */
function barsTile(mins: Min[], tf: string, tfSec: number, from: number, to: number, C: number) {
  const b = [
    ...refBuckets(
      mins.filter((m) => m.ts < C && m.ts >= from && m.ts < to),
      tfSec,
    ).values(),
  ];
  const I = (f: (x: Min) => number) => Int32Array.from(b, f);
  const F = (f: (x: Min) => number) => Float64Array.from(b, f);
  return encodeTile({
    meta: {
      kind: 'bars',
      sym: 'BTCUSDT',
      tf,
      tfSec,
      R: null,
      priceDecimals: PD,
      qtyDecimals: 3,
      tickRefUnits: 1,
      from,
      to,
      tile: null,
      dataVersion: `v${C}`,
      final: false,
      committedTo: Math.min(to, Math.max(from, C)),
    },
    bars: {
      time: I((x) => x.ts / 1000),
      open: I((x) => x.open),
      high: I((x) => x.high),
      low: I((x) => x.low),
      close: I((x) => x.close),
      buyQ: F((x) => x.buyQ),
      sellQ: F((x) => x.sellQ),
      buyA: I((x) => x.buyA),
      sellA: I((x) => x.sellA),
    },
  }).buffer as ArrayBuffer;
}

const live = (m: Min, a: number): LiveBar => ({ ...m, firstAgg: a, lastAgg: a + m.buyA + m.sellA });

const minutesArb = fc
  .array(
    fc.record({
      gap: fc.integer({ min: 1, max: 4 }),
      o: fc.integer({ min: 900, max: 1100 }),
      up: fc.integer({ min: 0, max: 30 }),
      dn: fc.integer({ min: 0, max: 30 }),
      c: fc.integer({ min: -30, max: 30 }),
      b: fc.integer({ min: 0, max: 50 }),
      s: fc.integer({ min: 0, max: 50 }),
    }),
    { minLength: 1, maxLength: 90 },
  )
  .map((rows) => {
    let t = T0 + 600 * MINUTE_MS;
    return rows.map((r): Min => {
      t += r.gap * MINUTE_MS;
      const close = Math.min(r.o + r.up, Math.max(r.o - r.dn, r.o + r.c));
      return {
        ts: t,
        open: r.o,
        high: r.o + r.up,
        low: r.o - r.dn,
        close,
        buyQ: r.b + 1,
        sellQ: r.s,
        buyA: 1 + (r.b % 3),
        sellA: r.s % 2,
      };
    });
  });

const status = { ...STATUS_UNKNOWN, recorder: true, stream: true };

function bookWith(bars: LiveBar[], committedTo: number): LiveBook {
  const b = new LiveBook('BTCUSDT');
  b.apply({
    v: LIVE_WIRE_VERSION,
    t: 'snap',
    sym: 'BTCUSDT',
    seq: 0,
    serverMs: committedTo,
    committedTo,
    from: committedTo - LIVE_RETAIN_MS,
    price: bars.at(-1)?.close ?? null,
    eventMs: committedTo,
    bars: bars.filter((x) => x.ts >= committedTo - LIVE_RETAIN_MS),
    status,
  });
  return b;
}

describe('Naht im Browser: BarStore + composeLive + mergeLive', () => {
  it('Fenster = direkte Aggregation, für jedes committedTo der DB-Antwort im Live-Vorhalt, mehrere Zeitrahmen', () => {
    const TFS: [string, number][] = [
      ['1m', 60],
      ['5m', 300],
      ['15m', 900],
      ['1h', 3600],
    ];
    fc.assert(
      fc.property(
        minutesArb,
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 12 }),
        (mins, cPct, lagMin) => {
          const first = mins[0]!.ts;
          const last = mins[mins.length - 1]!.ts;
          // Live-Stand: committedTo des Recorders; die DB-Antwort darf bis 10 min älter sein
          const Crec =
            first + Math.floor(((last - first + MINUTE_MS) * cPct) / 100 / MINUTE_MS) * MINUTE_MS;
          const Cdb = Crec - lagMin * MINUTE_MS;
          const book = bookWith(
            mins.map((m, i) => live(m, i * 10)),
            Crec,
          );
          for (const [tf, tfSec] of TFS) {
            const span = 1000 * tfSec; // Abschnitt = 1000 Bars (s)
            const c = Math.floor(first / 1000 / span);
            const c1 = Math.floor(last / 1000 / span);
            const store = new BarStore(`BTCUSDT|${tf}`, PD);
            for (let k = c; k <= c1; k++)
              store.addEncoded(
                k,
                barsTile(mins, tf, tfSec, k * span * 1000, (k + 1) * span * 1000, Cdb),
              );
            const items: BarItem[] = store.items(c, c1);
            const r = composeLive(book.sortedBars(), book.from, tfSec, span, [c, c1], store, PD);
            expect(r.reload.length > 0).toBe(Cdb < book.from);
            if (Cdb < book.from) continue; // dort fehlen Minuten beiden Seiten → neu laden
            mergeLive(items, r.items, true);
            const ref = [...refBuckets(mins, tfSec).values()];
            expect(
              items.map((x) => [x.time * 1000, x.o, x.h, x.l, x.c, x.b, x.s, x.ba, x.sa]),
            ).toEqual(
              ref.map((x) => [
                x.ts,
                x.open,
                x.high,
                x.low,
                x.close,
                x.buyQ,
                x.sellQ,
                x.buyA,
                x.sellA,
              ]),
            );
            // vorläufig gekennzeichnet genau die Buckets mit Live-Minuten ≥ committedTo der DB
            for (const x of items) {
              const hasLive = mins.some(
                (m) => m.ts >= Cdb && m.ts - (m.ts % (tfSec * 1000)) === x.time * 1000,
              );
              expect(!!x.live).toBe(hasLive);
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('mergeLive: ersetzen, anhängen (series.update), mittendrin → rebuild bzw. einfügen', () => {
    const it = (t: number, c: number, live = false) =>
      ({
        time: t,
        t,
        o: c,
        h: c,
        l: c,
        c,
        b: 1,
        s: 0,
        ba: 1,
        sa: 0,
        v: 1,
        ...(live ? { live } : {}),
      }) as unknown as BarItem;
    const items = [it(60, 1), it(120, 2), it(240, 3)];
    let r = mergeLive(items, [it(240, 3)]);
    expect(r.updates).toEqual([]); // unverändert → kein update
    r = mergeLive(items, [it(240, 4, true), it(300, 5, true)]);
    expect(r.updates.map((u) => [u.item.time, u.historical])).toEqual([
      [240, false],
      [300, false],
    ]);
    r = mergeLive(items, [it(120, 9, true)]);
    expect(r.updates.map((u) => [u.item.time, u.historical])).toEqual([[120, true]]);
    expect(mergeLive(items, [it(180, 7, true)]).rebuild).toBe(true);
    const copy = [...items];
    expect(mergeLive(copy, [it(180, 7, true)], true).rebuild).toBe(false);
    expect(copy.map((x) => x.time)).toEqual([60, 120, 180, 240, 300]);
  });

  it('checkHandover: alter DB-Anteil + Live in [altes, neues committedTo) = neuer DB-Anteil; Abweichung benannt', () => {
    const tfSec = 300;
    const ms = (k: number) => T0 + k * MINUTE_MS;
    const mins: Min[] = [0, 1, 2, 3].map((k) => ({
      ts: ms(k),
      open: 100 + k,
      high: 110 + k,
      low: 90 + k,
      close: 101 + k,
      buyQ: 2,
      sellQ: 1,
      buyA: 2,
      sellA: 1,
    }));
    const span = 1000 * tfSec * 1000;
    const c = Math.floor(T0 / span);
    const old = new BarStore('BTCUSDT|5m', PD);
    old.addEncoded(c, barsTile(mins, '5m', tfSec, c * span, (c + 1) * span, ms(2)));
    const fresh = new BarStore('BTCUSDT|5m', PD);
    fresh.addEncoded(c, barsTile(mins, '5m', tfSec, c * span, (c + 1) * span, ms(4)));
    const lv = mins.map((m, i) => live(m, i));
    const ok = checkHandover(
      lv,
      ms(-10),
      ms(2),
      ms(4),
      tfSec,
      (t) => old.itemAt(c, t),
      (t) => fresh.itemAt(c, t),
    );
    expect(ok).toEqual({ checked: 1, diffs: [] });
    const bad = lv.map((x, i) => (i === 3 ? { ...x, high: 999 } : x));
    const r = checkHandover(
      bad,
      ms(-10),
      ms(2),
      ms(4),
      tfSec,
      (t) => old.itemAt(c, t),
      (t) => fresh.itemAt(c, t),
    );
    expect(r.diffs).toHaveLength(1);
    expect(r.diffs[0]).toMatch(/high/);
    // Live-Stand reicht nicht bis zum alten committedTo zurück → keine Prüfung
    expect(
      checkHandover(
        lv,
        ms(3),
        ms(2),
        ms(4),
        tfSec,
        () => null,
        () => null,
      ).checked,
    ).toBe(0);
  });

  it('BarStore: Neuladen mit älterem committedTo (Cache) wird nicht übernommen', () => {
    const tfSec = 60;
    const span = 1000 * tfSec * 1000;
    const mins: Min[] = [0, 1, 2].map((k) => ({
      ts: T0 + k * MINUTE_MS,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      buyQ: 1,
      sellQ: 0,
      buyA: 1,
      sellA: 0,
    }));
    const c = Math.floor(T0 / span);
    const s = new BarStore('BTCUSDT|1m', PD);
    s.addEncoded(c, barsTile(mins, '1m', tfSec, c * span, (c + 1) * span, T0 + 2 * MINUTE_MS));
    expect(s.committedTo(c)).toBe(T0 + 2 * MINUTE_MS);
    expect(
      s.addEncoded(
        c,
        barsTile(mins, '1m', tfSec, c * span, (c + 1) * span, T0 + MINUTE_MS),
        undefined,
        0,
        true,
      ),
    ).toBe(false);
    expect(s.committedTo(c)).toBe(T0 + 2 * MINUTE_MS);
    expect(
      s.addEncoded(
        c,
        barsTile(mins, '1m', tfSec, c * span, (c + 1) * span, T0 + 3 * MINUTE_MS),
        undefined,
        0,
        true,
      ),
    ).toBe(true);
    expect(s.committedTo(c)).toBe(T0 + 3 * MINUTE_MS);
    expect(s.itemAt(c, T0 / 1000 + 120)?.c).toBe(1);
    expect(s.itemAt(c, T0 / 1000 + 180)).toBeNull();
  });
});

describe('Statuszustände', () => {
  const base = {
    connected: true,
    ready: true,
    status,
    eventMs: 1_000_000,
    serverMs: 1_000_500,
    silentMs: 100,
  };
  it('fünf Zustände mit Vorrang; Verzögerung aus Server- gegen Ereigniszeit', () => {
    expect(liveUiState(base)).toBe('live');
    // die Uhr des Besuchers spielt keine Rolle (Date.now weit daneben)
    const realNow = Date.now;
    Date.now = () => 0;
    try {
      expect(liveUiState(base)).toBe('live');
    } finally {
      Date.now = realNow;
    }
    expect(liveUiState({ ...base, serverMs: 1_003_001 })).toBe('delayed');
    expect(liveUiState({ ...base, eventMs: null })).toBe('delayed');
    expect(liveUiState({ ...base, status: { ...status, catchUp: true, gapFrom: 5 } })).toBe(
      'catchup',
    );
    expect(liveUiState({ ...base, status: { ...status, stream: false } })).toBe('catchup');
    expect(liveUiState({ ...base, status: { ...status, catchUp: true, frozen: 'Lücke' } })).toBe(
      'frozen',
    );
    expect(liveUiState({ ...base, status: { ...status, recorder: false, frozen: 'x' } })).toBe(
      'disconnected',
    );
    expect(liveUiState({ ...base, connected: false })).toBe('disconnected');
    expect(liveUiState({ ...base, ready: false })).toBe('disconnected');
    expect(liveUiState({ ...base, silentMs: LIVE_SILENCE_MS + 1 })).toBe('disconnected');
  });

  it('Backoff 1 s, 2 s, 4 s … ≤ 30 s (+ ≤ 30 % Streuung)', () => {
    expect([0, 1, 2, 3, 10].map((a) => reconnectDelayMs(a, () => 0))).toEqual([
      1000, 2000, 4000, 8000, 30000,
    ]);
    expect(reconnectDelayMs(10, () => 1)).toBe(39000);
  });
});

describe('LiveClient', () => {
  class FakeES implements EventSourceLike {
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    closed = false;
    readonly url: string;
    constructor(url: string) {
      this.url = url;
    }
    close() {
      this.closed = true;
    }
    msg(m: LiveMsg | string) {
      this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) });
    }
  }

  function harness() {
    let now = 0;
    const timers: { at: number; f: () => void; id: number }[] = [];
    let ids = 0;
    const es: FakeES[] = [];
    let vis: 'visible' | 'hidden' = 'visible';
    const listeners: (() => void)[] = [];
    const changes: string[] = [];
    const c = new LiveClient({
      base: 'http://x',
      factory: (u) => {
        const e = new FakeES(u);
        es.push(e);
        return e;
      },
      now: () => now,
      setTimer: (f, ms) => {
        const id = ++ids;
        timers.push({ at: now + ms, f, id });
        return id;
      },
      clearTimer: (id) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
      doc: {
        get visibilityState() {
          return vis;
        },
        addEventListener: (_: string, f: () => void) => listeners.push(f),
        removeEventListener: () => {},
      } as unknown as Document,
      onChange: (k) => changes.push(k),
    });
    const advance = (ms: number) => {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.f();
      }
      now = end;
    };
    const setVis = (v: 'visible' | 'hidden') => {
      vis = v;
      for (const f of listeners) f();
    };
    return { c, es, advance, setVis, changes };
  }

  const m = (seq: number, t: 'snap' | 'tick' = 'tick'): LiveMsg =>
    t === 'snap'
      ? {
          v: LIVE_WIRE_VERSION,
          t,
          sym: 'BTCUSDT',
          seq,
          serverMs: 5,
          committedTo: T0,
          from: T0 - LIVE_RETAIN_MS,
          price: 1,
          eventMs: 5,
          bars: [],
          status,
        }
      : {
          v: LIVE_WIRE_VERSION,
          t,
          sym: 'BTCUSDT',
          seq,
          serverMs: 5,
          price: 2,
          eventMs: 5,
          bars: [],
        };

  it('Sequenzsprung → sofort neu verbinden (neuer snap); kaputte Nachricht ignoriert', () => {
    const h = harness();
    h.c.setSymbol('BTCUSDT');
    expect(h.es).toHaveLength(1);
    expect(h.es[0]!.url).toBe('http://x/api/v1/live?sym=BTCUSDT');
    h.es[0]!.onopen?.({});
    h.es[0]!.msg(m(3, 'snap'));
    h.es[0]!.msg(m(4));
    h.es[0]!.msg('kein json');
    expect(h.c.stats.invalid).toBe(1);
    expect(h.c.uiState()).toBe('live');
    h.es[0]!.msg(m(6)); // 5 fehlt
    expect(h.es[0]!.closed).toBe(true);
    expect(h.c.uiState()).toBe('disconnected');
    h.advance(0);
    expect(h.es).toHaveLength(2);
    h.es[1]!.msg(m(0, 'snap'));
    expect(h.c.book!.seq).toBe(0);
    expect(h.c.uiState()).toBe('live');
  });

  it('Fehler → Neuverbinden mit wachsendem Backoff; snap setzt ihn zurück', () => {
    const h = harness();
    h.c.setSymbol('BTCUSDT');
    h.es[0]!.onerror?.({});
    h.advance(999);
    expect(h.es).toHaveLength(1);
    h.advance(400); // 1 s + Streuung ≤ 30 %
    expect(h.es).toHaveLength(2);
    h.es[1]!.onerror?.({});
    h.advance(1_999);
    expect(h.es).toHaveLength(2);
    h.advance(700);
    expect(h.es).toHaveLength(3);
    h.es[2]!.msg(m(0, 'snap'));
    h.es[2]!.onerror?.({});
    h.advance(1_300);
    expect(h.es).toHaveLength(4);
  });

  it('Stille > 8 s → neu verbinden; unsichtbarer Tab trennt nach 30 s und verbindet beim Sichtbarwerden', () => {
    const h = harness();
    h.c.setSymbol('BTCUSDT');
    h.es[0]!.onopen?.({});
    h.es[0]!.msg(m(0, 'snap'));
    h.advance(LIVE_SILENCE_MS + 2_100);
    expect(h.es[0]!.closed).toBe(true);
    expect(h.c.stats.silences).toBe(1);
    h.advance(0);
    expect(h.es).toHaveLength(2);
    h.es[1]!.msg(m(0, 'snap'));
    h.setVis('hidden');
    for (let t = 0; t < LIVE_HIDDEN_DISCONNECT_MS - 1_000; t += 1_000) {
      h.es[1]!.msg(m(h.c.book!.seq + 1));
      h.advance(1_000);
    }
    expect(h.es[1]!.closed).toBe(false);
    h.advance(1_500);
    expect(h.es[1]!.closed).toBe(true);
    expect(h.c.paused).toBe(true);
    h.advance(120_000);
    expect(h.es).toHaveLength(2); // im Hintergrund kein Neuverbinden
    h.setVis('visible');
    expect(h.es).toHaveLength(3);
    expect(h.c.paused).toBe(false);
  });
});
