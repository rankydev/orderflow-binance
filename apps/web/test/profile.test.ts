// Volume Profile (KONZEPT §6.3, docs/PROFILE-API.md): reine Funktionen und die Schicht ohne Browser.
import { describe, expect, it } from 'vitest';
import {
  batchOfDay,
  batchWindow,
  compareProfileWithBars,
  dailyKey,
  firstTouch,
  isProfileLadderR,
  Paint,
  parseProfileParams,
  prepareProfile,
  profileDayOf,
  profileDayWindow,
  profileLadder,
  profileParamsQuery,
  profileRects,
  profileRowSize,
  PROFILE_DEFAULTS,
  rangeFromBars,
  rangeKey,
  snapRange,
  wantedDayBatches,
  type PreparedProfile,
} from '../src/lib/profile/model.ts';
import {
  clampBatch,
  PROFILE_COLORS,
  ProfileLayer,
  type ProfileHost,
} from '../src/lib/profile/layer.ts';
import type { BarItem, SymbolInfo } from '../src/lib/types.ts';

const D = 86_400_000;
const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 20); // 2026-11-20 00:00 UTC

describe('Tagesfenster mit offsetH', () => {
  it('ordnet Zeiten dem Profiltag zu (Grenze bei offsetH)', () => {
    const d = T0 / D;
    expect(profileDayOf(T0, 0)).toBe(d);
    expect(profileDayOf(T0 - 1, 0)).toBe(d - 1);
    // Tag beginnt 01:00 UTC: 00:30 gehört noch zum Vortag
    expect(profileDayOf(T0 + 30 * 60_000, 1)).toBe(d - 1);
    expect(profileDayOf(T0 + H, 1)).toBe(d);
    // negativer Offset: Tag d beginnt 22:00 UTC des Vortags
    expect(profileDayWindow(d, -2)).toEqual([T0 - 2 * H, T0 + D - 2 * H]);
    expect(profileDayOf(T0 - 2 * H, -2)).toBe(d);
    expect(profileDayOf(T0 - 2 * H - 1, -2)).toBe(d - 1);
  });

  it('Batches sind an Vielfachen von 16 Tagen ausgerichtet', () => {
    expect(batchOfDay(31, 16)).toBe(1);
    expect(batchOfDay(32, 16)).toBe(2);
    expect(batchOfDay(-1, 16)).toBe(-1);
    expect(batchWindow(2, 3, 16)).toEqual([32 * D + 3 * H, 48 * D + 3 * H]);
  });

  it('bündelt sichtbare Tage ±1 zu Batches, geklemmt auf die Daten, von der Mitte nach außen', () => {
    const b = batchOfDay(T0 / D);
    // 3 Tage sichtbar mitten in einem Batch → genau ein Batch
    const dayIn = (b * 16 + 5) * D;
    expect(wantedDayBatches(dayIn / 1000, (dayIn + 3 * D) / 1000, 0, 0, 1e15)).toEqual([b]);
    // 40 Tage sichtbar → 3–4 Batches, mittlere zuerst
    const from = (b * 16 + 10) * D;
    const got = wantedDayBatches(from / 1000, (from + 40 * D) / 1000, 0, 0, 1e15);
    expect([...got].sort((x, y) => x - y)).toEqual([b, b + 1, b + 2, b + 3]);
    expect(got.slice(0, 2).sort()).toEqual([b + 1, b + 2]);
    // außerhalb der Daten nichts
    expect(
      wantedDayBatches(from / 1000, (from + D) / 1000, 0, from + 10 * D, from + 20 * D),
    ).toEqual([]);
    // Padding ±1 Tag über eine Batchgrenze
    const edge = (b + 1) * 16 * D; // erster Tag von Batch b+1
    expect(wantedDayBatches(edge / 1000, (edge + D / 2) / 1000, 0, 0, 1e15).sort()).toEqual([
      b,
      b + 1,
    ]);
  });

  it('kürzt Batches auf ganze Datentage', () => {
    const s = { dataFrom: T0 + 5 * H, dataTo: T0 + 3 * D } as SymbolInfo;
    const bw = batchWindow(batchOfDay(T0 / D), 0);
    expect(clampBatch(bw, s, 0)).toEqual([T0, T0 + 3 * D]);
    expect(clampBatch(batchWindow(batchOfDay(T0 / D, 16), 2), s, 2)).toEqual([
      T0 + 2 * H,
      T0 + 3 * D + 2 * H,
    ]);
  });
});

describe('Bereichsauswahl', () => {
  it('rundet auf Minuten, Reihenfolge egal, mindestens 1 Minute', () => {
    expect(snapRange(T0 + 61_000, T0 + 5_000)).toEqual([T0, T0 + 120_000]);
    expect(snapRange(T0, T0)).toEqual([T0, T0 + 60_000]);
    expect(snapRange(T0 + 59_999, T0 + 1)).toEqual([T0, T0 + 60_000]);
  });
  it('zwei angeklickte Bars: Beginn des früheren bis Ende des späteren', () => {
    const a = T0 / 1000;
    expect(rangeFromBars(a + 7200, a, 3600)).toEqual([T0, T0 + 3 * H]);
    expect(rangeFromBars(a, a, 60)).toEqual([T0, T0 + 60_000]);
  });
});

describe('Cache-Schlüssel', () => {
  it('enthalten sym, R, va, offsetH bzw. from/to', () => {
    expect(dailyKey({ sym: 'BTCUSDT', R: 50, va: 70, offsetH: -3, batch: 1279 })).toBe(
      'pd|BTCUSDT|50|70|-3|1279',
    );
    expect(rangeKey({ sym: 'BTCUSDT', R: 5, va: 68, from: 1, to: 2 })).toBe('pr|BTCUSDT|5|68|1|2');
    const k = new Set([
      dailyKey({ sym: 'A', R: 5, va: 70, offsetH: 0, batch: 1 }),
      dailyKey({ sym: 'A', R: 5, va: 70, offsetH: 1, batch: 1 }),
      dailyKey({ sym: 'A', R: 5, va: 68, offsetH: 0, batch: 1 }),
      dailyKey({ sym: 'A', R: 10, va: 70, offsetH: 0, batch: 1 }),
      dailyKey({ sym: 'B', R: 5, va: 70, offsetH: 0, batch: 1 }),
    ]);
    expect(k.size).toBe(5);
  });
});

describe('Profil-Zeilengröße', () => {
  it('Leiter {1,2,5}·10^k bis 1 000 000, nicht feiner als der Tick', () => {
    const l = profileLadder(10, 10);
    expect(l[0]).toBe(1);
    expect(l.at(-1)).toBe(1_000_000);
    expect(profileLadder(10, 50)[0]).toBe(5);
    expect(l.every(isProfileLadderR)).toBe(true);
    expect(isProfileLadderR(3)).toBe(false);
  });
  it('wählt nach Pixelhöhe (Ziel 5 px) mit Hysterese', () => {
    const l = profileLadder(10, 10);
    // 0.01 px je price_unit → R·10·0.01 = 5 px bei R = 50
    expect(profileRowSize(null, l, 0.01, 10)).toBe(50);
    // aktuelles R im Band (2.5…12 px) bleibt
    expect(profileRowSize(100, l, 0.01, 10)).toBe(100); // 10 px
    expect(profileRowSize(500, l, 0.01, 10)).toBe(50); // 50 px → neu
  });
});

// Handgerechnetes Mini-Profil: Zeilen 10…13, w = 10 (R 1, tickRefUnits 10)
//   buy  = [2, 6, 0, 1], sell = [2, 2, 4, 0] → Volumen [4, 8, 4, 1], Delta [0, +4, −4, +1]
function mini(): PreparedProfile {
  return prepareProfile(
    'k',
    {
      rowLo: 10,
      buy: [2, 6, 0, 1],
      sell: [2, 2, 4, 0],
      poc: 11,
      vah: 12,
      val: 10,
      deltaPoc: 11,
      buyQ: 9,
      sellQ: 8,
      notional: '1955',
      low: 100,
      high: 139,
    },
    0,
    D,
    true,
    1,
    10,
  );
}
const yOf = (u: number) => 1000 - u;

describe('Balkenlayout (exakte Koordinaten und Farben)', () => {
  it('Total: ein Balken je Zeile, Länge ∝ Volumen / maxVol', () => {
    const r = profileRects(mini(), 'total', 100, 80, yOf, 0, 2000, 0);
    expect(r).toEqual([
      { x: 100, y: 890, w: 40, h: 10, paint: Paint.Total },
      { x: 100, y: 880, w: 80, h: 10, paint: Paint.Total },
      { x: 100, y: 870, w: 40, h: 10, paint: Paint.Total },
      { x: 100, y: 860, w: 10, h: 10, paint: Paint.Total },
    ]);
    expect(PROFILE_COLORS[r[0]!.paint]).toBe('rgba(120, 144, 180, 0.40)');
  });

  it('Buy/Sell: Sell links, Buy rechts angesetzt, Gesamtlänge wie Total', () => {
    const r = profileRects(mini(), 'buysell', 100, 80, yOf, 0, 2000, 0);
    expect(r).toEqual([
      { x: 100, y: 890, w: 20, h: 10, paint: Paint.Sell },
      { x: 120, y: 890, w: 20, h: 10, paint: Paint.Buy },
      { x: 100, y: 880, w: 20, h: 10, paint: Paint.Sell },
      { x: 120, y: 880, w: 60, h: 10, paint: Paint.Buy },
      { x: 100, y: 870, w: 40, h: 10, paint: Paint.Sell },
      { x: 100, y: 860, w: 10, h: 10, paint: Paint.Buy },
    ]);
    expect(PROFILE_COLORS[Paint.Sell]).toBe('rgba(239, 83, 80, 0.42)');
    expect(PROFILE_COLORS[Paint.Buy]).toBe('rgba(38, 166, 154, 0.42)');
  });

  it('Delta: ab der linken Kante, Länge ∝ |Δ| / max|Δ|, Farbe nach Vorzeichen, Δ = 0 entfällt', () => {
    const r = profileRects(mini(), 'delta', 100, 80, yOf, 0, 2000, 0);
    expect(r).toEqual([
      { x: 100, y: 880, w: 80, h: 10, paint: Paint.DeltaPos },
      { x: 100, y: 870, w: 80, h: 10, paint: Paint.DeltaNeg },
      { x: 100, y: 860, w: 20, h: 10, paint: Paint.DeltaPos },
    ]);
    expect(PROFILE_COLORS[Paint.DeltaPos]).toBe('rgba(38, 166, 154, 0.55)');
    expect(PROFILE_COLORS[Paint.DeltaNeg]).toBe('rgba(239, 83, 80, 0.55)');
  });

  it('Lücke zwischen Zeilen und Zuschnitt auf den sichtbaren Bereich', () => {
    const r = profileRects(mini(), 'total', 0, 80, yOf, 875, 895, 1);
    expect(r.map((x) => [x.y, x.h])).toEqual([
      [890, 9],
      [880, 9],
      [870, 9],
    ]);
  });
});

describe('Naked Levels und Querprüfung', () => {
  it('firstTouch: erster Bar, dessen Spanne den Preis berührt', () => {
    const bars = [
      { h: 10, l: 5 },
      { h: 20, l: 12 },
      { h: 30, l: 21 },
    ];
    expect(firstTouch(bars, 0, 15)).toBe(1);
    expect(firstTouch(bars, 2, 15)).toBe(-1);
    expect(firstTouch(bars, 0, 21)).toBe(2);
  });
  it('vergleicht buy+sell mit der Summe der Bars im Zeitraum', () => {
    const p = { buyQ: 9, sellQ: 8, from: 0, to: 3600_000 };
    expect(compareProfileWithBars(p, [0, 1800, 3600], [10, 7, 99])).toBe('');
    expect(compareProfileWithBars(p, [0, 1800], [10, 6])).toBe('Profil 17 Lots, Bars 16 Lots');
  });
});

describe('URL-Zustand', () => {
  it('Standard: Tagesprofile, Buy/Sell, ohne Parameter', () => {
    const p = parseProfileParams(new URLSearchParams(''));
    expect(p).toMatchObject({ ...PROFILE_DEFAULTS, R: null, range: null, extend: false });
    expect(profileParamsQuery(p)).toBe('');
  });
  it('liest/schreibt alle Felder, Bereich als ISO-Minute', () => {
    const q = new URLSearchParams(
      'pm=both&pv=delta&va=68&oh=-23&pr=50&pe=1&pl=0&pf=2026-10-27T00:00&pt=2026-11-02T12:30',
    );
    const p = parseProfileParams(q);
    expect(p).toEqual({
      mode: 'both',
      view: 'delta',
      va: 68,
      offsetH: 1,
      R: 50,
      extend: true,
      showVa: false,
      range: [Date.UTC(2026, 9, 27), Date.UTC(2026, 10, 2, 12, 30)],
    });
    expect(profileParamsQuery(p)).toBe(
      '&pm=both&pv=delta&va=68&oh=1&pr=50&pe=1&pl=0&pf=2026-10-27T00:00&pt=2026-11-02T12:30',
    );
    // ungültige Werte → Standard; R nicht auf der Leiter → auto; Bereich ohne Bereichsmodus → beides
    const bad = parseProfileParams(new URLSearchParams('pm=x&pv=y&va=0&pr=3&pf=1000&pt=500'));
    expect(bad).toMatchObject({
      mode: 'both',
      view: 'buysell',
      va: 70,
      R: null,
      range: [0, 60_000],
    });
  });
});

// ---------------------------------------------------------------- Schicht (ohne Browser)

const SYM: SymbolInfo = {
  name: 'BTCUSDT',
  priceDecimals: 2,
  qtyDecimals: 3,
  tickRefUnits: 10,
  tickUnits: 10,
  dataFrom: T0,
  dataTo: T0 + 3 * D,
  tileConfigVersion: 1,
  tiles: {},
};

function bars(fromMs: number, n: number, tfSec: number, v: number): BarItem[] {
  return Array.from({ length: n }, (_, i) => {
    const t = fromMs / 1000 + i * tfSec;
    return {
      time: t,
      t,
      open: 0,
      high: 0,
      low: 0,
      close: 0,
      o: 0,
      h: 120,
      l: 100,
      c: 110,
      v,
    } as BarItem;
  });
}

function dayBody(from: number, q: number) {
  return {
    day: new Date(from).toISOString().slice(0, 10),
    from,
    to: from + D,
    final: true,
    rowLo: 10,
    buy: [q, 0],
    sell: [0, 1],
    poc: 10,
    vah: 11,
    val: 10,
    deltaPoc: 10,
    buyQ: q,
    sellQ: 1,
    notional: '0',
    low: 100,
    high: 119,
  };
}

function envelope(u: URL, extra: object) {
  return {
    format: 1,
    sym: 'BTCUSDT',
    R: Number(u.searchParams.get('R')),
    priceDecimals: 2,
    qtyDecimals: 3,
    tickRefUnits: 10,
    from: Number(u.searchParams.get('from')),
    to: Number(u.searchParams.get('to')),
    va: 70,
    dataVersion: 'v',
    final: true,
    sources: [],
    sourceRowsEstimate: 0,
    ...extra,
  };
}

function setup(handler: (u: URL) => Response, items: BarItem[] = bars(T0, 72, 3600, 1)) {
  const calls: string[] = [];
  const host: ProfileHost = {
    chart: { timeScale: () => ({ options: () => ({ barSpacing: 10 }) }) } as never,
    apiBase: '',
    sym: () => SYM,
    tfSec: () => 3600,
    items: () => items,
    visibleTimeRange: () => [T0 / 1000, (T0 + 3 * D) / 1000],
    priceToY: () => 0,
    barsCoverFinal: () => true,
  };
  const layer = new ProfileLayer(host, (url) => {
    calls.push(url);
    return Promise.resolve(handler(new URL(url, 'http://x')));
  });
  return { layer, calls };
}
const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ProfileLayer', () => {
  it('lädt die sichtbaren Tage in einem Batch und fragt geladene nicht erneut an', async () => {
    const { layer, calls } = setup((u) =>
      json(
        envelope(u, {
          kind: 'profiles/daily',
          offsetH: 0,
          days: [0, 1, 2].map((i) => dayBody(T0 + i * D, 23)),
        }),
      ),
    );
    layer.manualR = 1;
    layer.frame();
    await flush();
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      `/api/v1/profiles/daily?sym=BTCUSDT&from=${T0}&to=${T0 + 3 * D}&R=1&offsetH=0&va=70`,
    );
    layer.frame();
    await flush();
    expect(calls).toHaveLength(1); // aus dem Cache, keine Schleife
    expect(layer.readout().error).toBe('');
    expect(layer.counters.crossChecks).toBe(3); // 24 Bars × 1 Lot = 23 + 1 ✓
    expect(layer.counters.crossMismatches).toBe(0);
  });

  it('422 mit suggestR: genau ein neuer Versuch mit dem Vorschlag, sichtbar in der Anzeige', async () => {
    const { layer, calls } = setup((u) =>
      u.searchParams.get('R') === '1'
        ? json({ error: 'zu fein', suggestR: 5 }, 422)
        : json(envelope(u, { kind: 'profiles/daily', offsetH: 0, days: [] })),
    );
    layer.manualR = 1;
    layer.frame();
    for (let i = 0; i < 5; i++) await flush();
    expect(calls.map((c) => new URL(c, 'http://x').searchParams.get('R'))).toEqual(['1', '5']);
    expect(layer.readout().note).toContain('→ 5');
    expect(layer.readout().error).toBe('');
  });

  it('422 ohne brauchbaren Vorschlag: Fehler sichtbar, keine Wiederholung', async () => {
    const { layer, calls } = setup(() => json({ error: 'zu groß', suggestR: null }, 422));
    layer.manualR = 1;
    layer.frame();
    for (let i = 0; i < 5; i++) await flush();
    layer.frame();
    for (let i = 0; i < 5; i++) await flush();
    expect(calls).toHaveLength(1);
    expect(layer.readout().error).toContain('zu groß für R 1');
  });

  it('Querprüfung: erste Abweichung lädt neu, wiederholte wird gemeldet', async () => {
    const { layer, calls } = setup((u) =>
      json(
        envelope(u, { kind: 'profiles/daily', offsetH: 0, days: [dayBody(T0, 99)] }), // Bars: 24 Lots
      ),
    );
    layer.manualR = 1;
    layer.frame();
    for (let i = 0; i < 6; i++) await flush();
    expect(calls).toHaveLength(2);
    expect(layer.counters.crossMismatches).toBe(2);
    expect(layer.readout().error).toContain(
      'passt nicht zu den Bars (Profil 100 Lots, Bars 24 Lots)',
    );
  });

  it('LOD: zu schmale Tage werden nicht angefragt', async () => {
    const { layer, calls } = setup(() => json({}));
    layer.manualR = 1;
    // 1h, barSpacing 10 → Tag 240 px; mit 0,25 px → 6 px < MIN_DAY_PX (8)
    (layer as unknown as { host: ProfileHost }).host.chart = {
      timeScale: () => ({ options: () => ({ barSpacing: 0.25 }) }),
    } as never;
    layer.frame();
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('Bereichsprofil: Anfrage an /profile mit Minutengrenzen; Bereich wählen setzt den Modus', async () => {
    const { layer, calls } = setup((u) =>
      json(envelope(u, { kind: 'profile', profile: { ...dayBody(T0, 2), day: undefined } })),
    );
    layer.manualR = 2;
    layer.startSelect();
    expect(layer.click(T0 / 1000 + 7200)).toBe(true);
    expect(layer.click(T0 / 1000)).toBe(true);
    expect(layer.mode).toBe('both');
    expect(layer.range).toEqual([T0, T0 + 3 * H]);
    await flush();
    await flush();
    expect(
      calls.some((c) => c === `/api/v1/profile?sym=BTCUSDT&from=${T0}&to=${T0 + 3 * H}&R=2&va=70`),
    ).toBe(true);
    const s = layer.summary()!;
    expect(s.loading).toBe(false);
    expect(s.delta).toBe('1 Lots = 0.001 BTC');
    expect(s.poc).toBe('2.00–2.20');
    layer.clearRange();
    expect(layer.mode).toBe('daily');
  });
});
