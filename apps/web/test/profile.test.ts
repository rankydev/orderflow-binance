// Volume Profile (KONZEPT §6.3, docs/PROFILE-API.md): reine Funktionen und die Schicht ohne Browser.
import { describe, expect, it, vi } from 'vitest';
import {
  batchOfDay,
  batchWindow,
  compareProfileWithBars,
  dailyKey,
  commonScale,
  dayDetail,
  profilePlacement,
  rowBarLength,
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
  hitAt,
  PROFILE_COLORS,
  PROFILE_MAX_HOLD_MS,
  PROFILE_MAX_PARALLEL,
  PROFILE_NONFINAL_TTL_MS,
  ProfileLayer,
  type Hit,
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
      vwap: 115,
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
    // Zeilenintervall [lo, hi): Schnitt mit [l, h]
    expect(firstTouch(bars, 0, 15, 16)).toBe(1);
    expect(firstTouch(bars, 2, 15, 16)).toBe(-1);
    expect(firstTouch(bars, 0, 21, 22)).toBe(2);
    // Ränder: h = lo berührt; l = hi nicht (halboffen)
    expect(firstTouch(bars, 0, 10, 11)).toBe(0);
    expect(firstTouch([{ h: 20, l: 12 }], 0, 11, 12)).toBe(-1);
    // Intervall statt Mitte: Mitte 14 ungetroffen, Zeile [10, 18) aber von [9, 11] berührt
    expect(firstTouch([{ h: 11, l: 9 }], 0, 10, 18)).toBe(0);
    // end begrenzt, fromIdx < 0 wird geklemmt, leere Liste
    expect(firstTouch(bars, -5, 21, 22, 2)).toBe(-1);
    expect(firstTouch([], 0, 1, 2)).toBe(-1);
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
      scale: 'profile',
      range: [Date.UTC(2026, 9, 27), Date.UTC(2026, 10, 2, 12, 30)],
      rangeNote: '',
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
    notional: String(105 * (q + 1)),
    vwap: 105,
    dataVersion: 'v',
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
    va: Number(u.searchParams.get('va') ?? 70),
    dataVersion: 'v',
    final: true,
    sources: [],
    sourceRowsEstimate: 0,
    ...extra,
  };
}

function setup(
  handler: (u: URL) => Response,
  items: BarItem[] = bars(T0, 72, 3600, 1),
  over: Partial<ProfileHost> = {},
) {
  const calls: string[] = [];
  const inits: (RequestCache | undefined)[] = [];
  const host: ProfileHost = {
    chart: { timeScale: () => ({ options: () => ({ barSpacing: 10 }) }) } as never,
    apiBase: '',
    sym: () => SYM,
    tfSec: () => 3600,
    items: () => items,
    visibleTimeRange: () => [T0 / 1000, (T0 + 3 * D) / 1000],
    priceToY: () => 0,
    barsCoverFinal: () => true,
    footprintActive: () => false,
    busy: () => false,
    gestureActive: () => false,
    ...over,
  };
  const layer = new ProfileLayer(host, (url, init) => {
    calls.push(url);
    inits.push(init.cache);
    return Promise.resolve(handler(new URL(url, 'http://x')));
  });
  return { layer, calls, inits, host };
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
    // 1h, barSpacing 10 → Tag 240 px; mit 0,5 px → 12 px < MIN_DAY_PX (16)
    (layer as unknown as { host: ProfileHost }).host.chart = {
      timeScale: () => ({ options: () => ({ barSpacing: 0.5 }) }),
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

// ---------------------------------------------------------------- Review-Runde (W-1 … W-4, B, C)

describe('Lage der Profile (W-2: Deckel und klebender Anker)', () => {
  const PANE = 1000;
  it('Tagesbeginn sichtbar: Profil hängt am Beginn, Breite gedeckelt auf max(120, 0,3 · Pane)', () => {
    // Tag 200…1304 px breit (1h, 46 px je Bar) → 0,8 · 1104 = 883 > 300 → 300
    expect(profilePlacement(200, 1304, PANE, false)).toEqual({ x0: 200, maxW: 300 });
    // schmaler Tag: 0,8 · Tagesbreite
    expect(profilePlacement(100, 200, PANE, false)).toEqual({ x0: 100, maxW: 80 });
    // kleine Pane: Untergrenze 120 px
    expect(profilePlacement(0, 1000, 300, false)).toEqual({ x0: 0, maxW: 120 });
  });
  it('Tag überdeckt die Pane: Profil klebt am linken Rand (Footprint aktiv: 0,25 · Pane)', () => {
    // 1m: Tag 66 240 px, Beginn 60 000 px links außerhalb
    expect(profilePlacement(-60_000, 6_240, PANE, false)).toEqual({ x0: 0, maxW: 300 });
    expect(profilePlacement(-60_000, 6_240, PANE, true)).toEqual({ x0: 0, maxW: 250 });
  });
  it('Tag endet in der Pane: Profil endet mit dem Tag (x0 = Ende − Breite), sonst unsichtbar', () => {
    expect(profilePlacement(-2_000, 150, PANE, false)).toEqual({ x0: -150, maxW: 300 });
    expect(profilePlacement(-2_000, -10, PANE, false)).toBeNull();
    expect(profilePlacement(1_200, 2_000, PANE, false)).toBeNull();
    // Footprint-Deckel nur, wenn der Tag breiter als die Pane ist
    expect(profilePlacement(-500, 400, PANE, true)).toEqual({ x0: 0, maxW: 300 });
  });
  it('Bereich: Anteil 0,6, Mindestbreite 40 px', () => {
    expect(profilePlacement(10, 30, PANE, false, 0.6, 40)).toEqual({ x0: 10, maxW: 20 });
    expect(profilePlacement(10, 110, PANE, false, 0.6, 40)).toEqual({ x0: 10, maxW: 60 });
  });
});

describe('Detailstufe schmaler Tage (B)', () => {
  it('< 16 px aus, 16…48 px Silhouette, ab 48 px alles', () => {
    expect(dayDetail(15.9)).toBe('skip');
    expect(dayDetail(16)).toBe('silhouette');
    expect(dayDetail(47.9)).toBe('silhouette');
    expect(dayDetail(48)).toBe('full');
  });
});

describe('Hover-Treffer (W-1)', () => {
  const p = mini(); // Zeilen 10…13, Volumen [4, 8, 4, 1], Delta [0, 4, −4, 1]
  const hit = (view: 'total' | 'delta', scale: number): Hit => ({
    x0: 100,
    maxW: 80,
    p,
    range: false,
    view,
    scale,
  });
  it('trifft nur den gezeichneten Balken der Zeile, nicht die ganze Profilbreite', () => {
    const h = [hit('total', 8)];
    // Zeile 10 (Preis 100…109): Balken 40 px → 100…140
    expect(hitAt(h, 140, 105)?.i).toBe(0);
    expect(hitAt(h, 141, 105)).toBeNull(); // rechts vom Balken → Footprint/Kerze
    expect(hitAt(h, 99, 105)).toBeNull();
    // Zeile 13: 10 px
    expect(hitAt(h, 110, 135)?.i).toBe(3);
    expect(hitAt(h, 111, 135)).toBeNull();
    // außerhalb der Zeilen
    expect(hitAt(h, 100, 95)).toBeNull();
    expect(hitAt(h, 100, 140)).toBeNull();
  });
  it('Delta-Ansicht: Länge nach |Delta|; Delta 0 ist nie ein Treffer', () => {
    const h = [hit('delta', 4)];
    expect(hitAt(h, 100, 105)).toBeNull(); // Zeile 10: Delta 0
    expect(hitAt(h, 180, 125)?.i).toBe(2); // |−4| → 80 px
  });
  it('gemeinsame Skala verkürzt den Balken (Skala 16 statt 8)', () => {
    expect(rowBarLength(p, 'total', 1, 80, 16)).toBe(40);
    expect(hitAt([hit('total', 16)], 141, 115)).toBeNull();
  });
  it('Bereichsprofil zuerst (Reihenfolge der Treffer)', () => {
    const r: Hit = { ...hit('total', 8), range: true };
    expect(hitAt([r, hit('total', 8)], 120, 115)?.h.range).toBe(true);
  });
});

describe('Zeitachse und Naked Levels (Schicht, ohne Browser)', () => {
  // indexbasierte Zeitachse: x(logical) = 10 · logical, 10 px je Bar
  const chart = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      logicalToCoordinate: (l: number) => 10 * l,
    }),
  } as never;
  const items = bars(T0, 48, 3600, 1); // 2 Tage 1h
  it('xOfTime: linke Kante des ersten Bars ≥ t; vor/nach dem Fenster linear fortgesetzt', () => {
    const { layer } = setup(() => json({}), items, { chart });
    expect(layer.xOfTime(T0, items, 3600, 10)).toBe(-5);
    expect(layer.xOfTime(T0 + D, items, 3600, 10)).toBe(235); // Index 24
    expect(layer.xOfTime(T0 + 30 * 60_000, items, 3600, 10)).toBe(5); // nächster Bar
    expect(layer.xOfTime(T0 - D, items, 3600, 10)).toBe(-245); // −24 Bars
    expect(layer.xOfTime(T0 + 3 * D, items, 3600, 10)).toBe(715); // 47 + 25 Bars
  });
  it('nakedEnd: berührt → linke Kante des Bars; unberührt → Ende der geladenen Bars; je Fenster einmal', () => {
    const its = bars(T0, 48, 3600, 1).map((b, i) => (i === 30 ? { ...b, h: 200, l: 150 } : b));
    const { layer } = setup(() => json({}), its, { chart });
    const p = prepareProfile('k', { ...dayBodyLike(), rowLo: 10 }, T0, T0 + D, true, 1, 10);
    // Zeile 15 ([150, 160)): erst Bar 30 reicht hinein
    expect(layer.nakedEnd(15, p, { items: its, bs: 10 })).toEqual({ x: 295, touched: true });
    // Zeile 12 ([120, 130)): h = 120 aller Bars berührt → erster Bar nach dem Tag (Index 24)
    expect(layer.nakedEnd(12, p, { items: its, bs: 10 })).toEqual({ x: 235, touched: true });
    // Zeile 40: nie berührt → rechte Kante des letzten Bars
    expect(layer.nakedEnd(40, p, { items: its, bs: 10 })).toEqual({ x: 475, touched: false });
    const scans = layer.counters.nakedScans;
    layer.nakedEnd(40, p, { items: its, bs: 10 });
    expect(layer.counters.nakedScans).toBe(scans); // aus dem Zwischenspeicher
    // Profil am Ende der Daten: keine Bars danach
    const late = prepareProfile('l', dayBodyLike(), T0 + D, T0 + 2 * D, true, 1, 10);
    expect(layer.nakedEnd(15, late, { items: its, bs: 10 })).toBeNull();
  });
});

function dayBodyLike() {
  const body: Partial<ReturnType<typeof dayBody>> = { ...dayBody(T0, 5) };
  delete body.day;
  delete body.from;
  delete body.to;
  delete body.final;
  return body as Omit<ReturnType<typeof dayBody>, 'day' | 'from' | 'to' | 'final'>;
}

describe('ProfileLayer: Review-Punkte', () => {
  const daily =
    (final: (from: number) => boolean, q = 23) =>
    (u: URL) => {
      const from = Number(u.searchParams.get('from'));
      const to = Number(u.searchParams.get('to'));
      const days = [];
      for (let d = from; d < to; d += D) days.push({ ...dayBody(d, q), final: final(d) });
      return json(
        envelope(u, {
          kind: 'profiles/daily',
          offsetH: 0,
          final: days.every((d) => d.final),
          days,
        }),
      );
    };
  const settle = async () => {
    for (let i = 0; i < 8; i++) await flush();
  };

  it('W-4: höchstens 2 parallel; solange Kacheln/Bars laden, keine neuen Profilanfragen', async () => {
    expect(PROFILE_MAX_PARALLEL).toBe(2);
    let busy = true;
    const { layer, calls } = setup(
      daily(() => true),
      undefined,
      { busy: () => busy },
    );
    layer.manualR = 1;
    layer.frame();
    await settle();
    expect(calls).toHaveLength(0);
    expect(layer.counters.held).toBe(1);
    busy = false;
    layer.frame();
    await settle();
    expect(calls).toHaveLength(1);
    layer.destroy();
  });

  it('Gesamthistorie: jeder Batch genau einmal, danach aus dem Cache', async () => {
    const sym = { ...SYM, dataFrom: T0 - 160 * D, dataTo: T0 + 7 * D };
    const { layer, calls } = setup(
      daily(() => true),
      bars(T0, 72, 3600, 1),
      {
        sym: () => sym,
        visibleTimeRange: () => [sym.dataFrom / 1000, sym.dataTo / 1000],
        barsCoverFinal: () => false,
      },
    );
    layer.manualR = 1;
    layer.frame();
    await settle();
    const n = calls.length;
    const b0 = batchOfDay(sym.dataFrom / D);
    const b1 = batchOfDay((sym.dataTo - 1) / D);
    expect(n).toBe(b1 - b0 + 1);
    expect(new Set(calls).size).toBe(n);
    layer.frame();
    await settle();
    expect(calls).toHaveLength(n);
  });

  it('nicht finaler Rest: nach 60 s nur der offene Teil, finale Tage bleiben im Cache', async () => {
    let now = 1_000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const last = T0 + 2 * D;
      const { layer, calls } = setup(
        daily((d) => d < last),
        undefined,
        { barsCoverFinal: () => false },
      );
      layer.manualR = 1;
      layer.frame();
      await settle();
      expect(calls).toHaveLength(1);
      layer.frame();
      await settle();
      expect(calls).toHaveLength(1); // innerhalb der 60 s
      now += PROFILE_NONFINAL_TTL_MS + 1;
      layer.frame();
      await settle();
      expect(calls).toHaveLength(2);
      const u = new URL(calls[1]!, 'http://x');
      expect(Number(u.searchParams.get('from'))).toBe(last);
      expect(Number(u.searchParams.get('to'))).toBe(T0 + 3 * D);
    } finally {
      spy.mockRestore();
    }
  });

  it('W-3: Neuladen nach Abweichung am Browser-Cache vorbei; Meldung bleibt stehen', async () => {
    const { layer, calls, inits } = setup(daily(() => true, 99)); // Bars: 24 Lots je Tag
    layer.manualR = 1;
    layer.frame();
    await settle();
    expect(calls).toHaveLength(2);
    expect(inits).toEqual([undefined, 'reload']);
    const msg = layer.readout().error;
    expect(msg).toContain('passt nicht zu den Bars');
    expect(layer.readout().sticky).toBe(true);
    // ein späterer erfolgreicher Ladevorgang löscht die Meldung nicht
    layer.va = 68;
    layer.frame();
    await settle();
    expect(layer.readout().error).toBe(msg);
    layer.dismissError();
    expect(layer.readout().error).toBe('');
  });

  it('prüft Antworten gegen offsetH/va/from/to der Anfrage', async () => {
    const { layer } = setup((u) =>
      json(envelope(u, { kind: 'profiles/daily', offsetH: 3, days: [] })),
    );
    layer.manualR = 1;
    layer.frame();
    await settle();
    expect(layer.readout().error).toContain('unbrauchbar');
  });

  it('Bereich: auf die Daten gekürzt (Hinweis), außerhalb nicht übernommen', () => {
    const { layer } = setup(() => json({}));
    expect(layer.setRange([T0 - D, T0 + H])).toBe(true);
    expect(layer.range).toEqual([T0, T0 + H]);
    expect(layer.readout().note).toContain('gekürzt');
    expect(layer.setRange([T0 + 10 * D, T0 + 11 * D])).toBe(false);
    expect(layer.readout().note).toContain('außerhalb der Daten');
  });
});

describe('URL: Offset ±12 und Skala', () => {
  it('oh = −12 und +12 ergeben dieselben Grenzen → 12; ps=common', () => {
    expect(parseProfileParams(new URLSearchParams('oh=-12')).offsetH).toBe(12);
    expect(parseProfileParams(new URLSearchParams('oh=12')).offsetH).toBe(12);
    expect(parseProfileParams(new URLSearchParams('oh=-11')).offsetH).toBe(-11);
    const p = parseProfileParams(
      new URLSearchParams('ps=common&pf=2026-11-02T00:00&pt=2026-11-01T00:00'),
    );
    expect(p.scale).toBe('common');
    expect(p.rangeNote).toContain('vertauscht');
    expect(profileParamsQuery(p)).toContain('&ps=common');
  });
});

describe('Prüfrunde 0195c61 (W-A, W-B, H-1 … H-4)', () => {
  const settle = async () => {
    for (let i = 0; i < 8; i++) await flush();
  };
  const daily = (q: number) => (u: URL) => {
    const from = Number(u.searchParams.get('from'));
    const to = Number(u.searchParams.get('to'));
    const days = [];
    for (let d = from; d < to; d += D) days.push(dayBody(d, q));
    return json(envelope(u, { kind: 'profiles/daily', offsetH: 0, days }));
  };

  it('W-A: Zurückstehen höchstens 2 s, danach eine Profilanfrage gleichzeitig', async () => {
    let now = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const sym = { ...SYM, dataFrom: T0 - 40 * D, dataTo: T0 + 7 * D };
      const { layer, calls } = setup(daily(23), undefined, {
        busy: () => true,
        sym: () => sym,
        visibleTimeRange: () => [sym.dataFrom / 1000, sym.dataTo / 1000],
        barsCoverFinal: () => false,
      });
      layer.manualR = 1;
      layer.frame();
      await settle();
      expect(calls).toHaveLength(0);
      now = PROFILE_MAX_HOLD_MS - 1;
      layer.frame();
      await settle();
      expect(calls).toHaveLength(0);
      now = PROFILE_MAX_HOLD_MS;
      layer.frame();
      await settle();
      expect(calls).toHaveLength(1); // nur eine, obwohl mehrere Batches fehlen
      layer.frame();
      await settle();
      expect(calls).toHaveLength(2); // die erste ist fertig → die nächste
      layer.destroy();
    } finally {
      spy.mockRestore();
    }
  });

  it('W-A: der Wartetimer startet während einer Geste nichts', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let gesture = true;
      const { layer } = setup(daily(23), undefined, {
        busy: () => true,
        gestureActive: () => gesture,
      });
      layer.manualR = 1;
      layer.frame();
      expect(layer.counters.held).toBe(1);
      vi.advanceTimersByTime(1_000);
      expect(layer.counters.held).toBe(1); // Timer feuerte, aber kein frame() in der Geste
      gesture = false;
      layer.frame();
      vi.advanceTimersByTime(160);
      expect(layer.counters.held).toBe(3);
      layer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('W-B: gemeinsame Skala nur über Profile der aktuellen Zeilenbreite; fest bis Datenankunft', async () => {
    const mk = (width: number, maxVol: number, maxAbsDelta: number) => ({
      width,
      maxVol,
      maxAbsDelta,
    });
    expect(commonScale([mk(10, 5, 2), mk(10, 9, 1), mk(20, 99, 99)], 10)).toEqual({
      width: 10,
      total: 9,
      delta: 2,
    });
    let vis: [number, number] = [T0 / 1000, (T0 + 3 * D) / 1000];
    let q = 23;
    const sym = { ...SYM, dataFrom: T0 - 60 * D };
    const { layer } = setup((u) => daily(q)(u), undefined, {
      sym: () => sym,
      visibleTimeRange: () => vis,
      barsCoverFinal: () => false,
    });
    layer.manualR = 1;
    layer.scaleMode = 'common';
    layer.frame();
    await settle();
    const common = () => (layer as unknown as { common: { total: number } }).common.total;
    expect(common()).toBe(23);
    // Pannen (sichtbarer Bereich ändert sich, kein Gestenende, keine Daten) → unverändert
    vis = [(T0 - 40 * D) / 1000, (T0 - 37 * D) / 1000];
    layer.redraw();
    expect(common()).toBe(23);
    // neue Daten mit größerem Maximum → erst bei Ankunft übernommen
    q = 50;
    layer.frame();
    await settle();
    expect(common()).toBe(50);
  });

  it('H-1: Profilbreite folgt dem Modus vom Gestenende, nicht der Detailstufe je Frame', () => {
    // der Controller übergibt mode === 'footprint'; hier nur der Vertrag der Lage-Funktion
    expect(profilePlacement(-60_000, 6_240, 1000, true)?.maxW).toBe(250);
    expect(profilePlacement(-60_000, 6_240, 1000, false)?.maxW).toBe(300);
  });

  it('H-2: Schließen löscht auch den Fehler der Anfragewarteschlange', async () => {
    const { layer } = setup(() => new Response('x', { status: 500 }));
    layer.manualR = 1;
    layer.frame();
    await settle();
    expect(layer.readout().error).toContain('HTTP 500');
    layer.dismissError();
    expect(layer.readout().error).toBe('');
    layer.destroy();
  });

  it('H-3: nach der stehenden Meldung lädt eine spätere Abweichung wieder zuerst neu', async () => {
    const { layer, calls, inits } = setup(daily(99)); // Bars: 24 Lots je Tag
    layer.manualR = 1;
    layer.frame();
    await settle();
    expect(calls).toHaveLength(2);
    expect(layer.readout().sticky).toBe(true);
    layer.crossCheckAll(); // z. B. nach einem Fensterwechsel
    await settle();
    expect(calls).toHaveLength(3);
    expect(inits[2]).toBe('reload');
  });

  it('H-4: Hover trifft Balken ab derselben Mindestlänge wie das Zeichnen (0,5 px)', () => {
    const p = mini();
    // Zeile 13: Volumen 1 von 8 bei 6 px → 0,75 px
    const h: Hit = { x0: 0, maxW: 6, p, range: false, view: 'total', scale: 8 };
    expect(hitAt([h], 0.7, 135)?.i).toBe(3);
    expect(hitAt([{ ...h, maxW: 3 }], 0.2, 135)).toBeNull(); // 0,375 px < 0,5 px: nicht gezeichnet
  });
});

// ---------------------------------------------------------------- Vertrag 60f6264 / 7f1b626 (Teil 1)
import {
  dayIndexOfLabel,
  dayRanges,
  dayStatus,
  minRowsR,
  vwapProblem,
} from '../src/lib/profile/layer.ts';

describe('Profil-Vertrag: vwap, Tageslisten, 422-Grund, Grenzen, 503', () => {
  const settle = async () => {
    for (let i = 0; i < 8; i++) await flush();
  };

  it('vwap = floor(notional · 10^6 / Volumen) / 10^6 (BigInt), null ohne Volumen', () => {
    // 1 955 / 17 = 115,0000…  → 115; 2 000 / 3 = 666,666666… → 666,666666 (abgeschnitten)
    expect(vwapProblem({ notional: '1955', buyQ: 9, sellQ: 8, vwap: 115 })).toBe('');
    expect(vwapProblem({ notional: '2000', buyQ: 1, sellQ: 2, vwap: 666.666666 })).toBe('');
    expect(vwapProblem({ notional: '2000', buyQ: 1, sellQ: 2, vwap: 666.666667 })).toContain('≠');
    // über 2^53 im Zähler
    expect(
      vwapProblem({
        notional: '12345678901234567890',
        buyQ: 2_000_000,
        sellQ: 0,
        vwap: Number('6172839450617.283'),
      }),
    ).toBe('');
    expect(vwapProblem({ notional: '0', buyQ: 0, sellQ: 0, vwap: null })).toBe('');
    expect(vwapProblem({ notional: '0', buyQ: 0, sellQ: 0, vwap: 1 })).toContain('ohne Volumen');
  });

  it('Tagesbezeichnung → Index; Tage ohne Daten vs. ohne Trades', () => {
    expect(dayIndexOfLabel('2026-11-20')).toBe(T0 / D);
    const e = { emptyDays: new Set([5]), missingDays: new Set([6]) };
    expect(dayStatus(e, 5)).toBe('empty');
    expect(dayStatus(e, 6)).toBe('missing');
    expect(dayStatus(e, 7)).toBe('unknown');
    expect(dayStatus(undefined, 5)).toBe('unknown');
  });

  it('Antwort mit emptyDays/missingDays: Tage im Cache unterschieden; Tagesversion hält das Profil', async () => {
    const { layer } = setup((u) =>
      json(
        envelope(u, {
          kind: 'profiles/daily',
          offsetH: 0,
          days: [dayBody(T0, 23)],
          emptyDays: ['2026-11-21'],
          missingDays: ['2026-11-22'],
        }),
      ),
    );
    layer.manualR = 1;
    layer.frame();
    await settle();
    const cache = (
      layer as unknown as {
        cache: Map<string, { emptyDays: Set<number>; missingDays: Set<number> }>;
      }
    ).cache;
    const e = [...cache.values()][0]!;
    expect([...e.emptyDays]).toEqual([T0 / D + 1]);
    expect([...e.missingDays]).toEqual([T0 / D + 2]);
  });

  it('nicht finaler Rest: Tage mit gleicher dataVersion behalten ihr vorbereitetes Profil', async () => {
    let now = 1_000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const last = T0 + 2 * D;
      const { layer } = setup(
        (u) => {
          const from = Number(u.searchParams.get('from'));
          const days = [];
          for (let d = from; d < T0 + 3 * D; d += D)
            days.push({ ...dayBody(d, 23), final: d < last, dataVersion: `v${d}` });
          return json(envelope(u, { kind: 'profiles/daily', offsetH: 0, final: false, days }));
        },
        undefined,
        { barsCoverFinal: () => false },
      );
      layer.manualR = 1;
      layer.frame();
      await settle();
      const cache = (layer as unknown as { cache: Map<string, { profiles: Map<number, unknown> }> })
        .cache;
      const before = [...cache.values()][0]!.profiles.get(T0);
      now += 61_000;
      layer.frame();
      await settle();
      expect([...cache.values()][0]!.profiles.get(T0)).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });

  it('422 mit reason: Meldung nennt den Grund', async () => {
    const { layer } = setup(() =>
      json(
        { error: 'x', reason: 'profile_rows', rows: 70_000, limit: 60_000, suggestR: null },
        422,
      ),
    );
    layer.manualR = 1;
    layer.frame();
    await settle();
    expect(layer.readout().error).toContain('zu viele Zeilen');
  });

  it('Zeilengrenze aus /symbols: R vorab so groß, dass Σ Zeilen ≤ maxRows (kein 422-Umweg)', async () => {
    // Bars T0…T0+3D mit h 120 / l 100 → je Tag floor(120/w) − floor(100/w) + 1 Zeilen
    expect(dayRanges(bars(T0, 72, 3600, 1), T0, T0 + 3 * D, 0)).toEqual([
      [100, 120],
      [100, 120],
      [100, 120],
    ]);
    // w = R · 10: R 1 → 3 Zeilen je Tag (9 gesamt); maxRows 6 → R 2 (2 Zeilen je Tag … 120/20 − 100/20 + 1 = 2)
    expect(
      minRowsR(
        [
          [100, 120],
          [100, 120],
          [100, 120],
        ],
        10,
        [1, 2, 5, 10],
        6,
        1,
      ),
    ).toBe(2);
    const { layer, calls } = setup(
      (u) => json(envelope(u, { kind: 'profiles/daily', offsetH: 0, days: [] })),
      undefined,
      { limits: () => ({ maxRows: 6, maxR: 1_000_000, maxRangeDays: 3660 }) },
    );
    layer.manualR = 1;
    layer.updateRowFloors();
    layer.frame();
    await settle();
    expect(new URL(calls[0]!, 'http://x').searchParams.get('R')).toBe('2');
  });

  it('503 + Retry-After: die Profil-Warteschlange wiederholt nach der angegebenen Zeit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      let n = 0;
      const { layer, calls } = setup((u) =>
        n++ === 0
          ? new Response('busy', { status: 503, headers: { 'Retry-After': '3' } })
          : json(envelope(u, { kind: 'profiles/daily', offsetH: 0, days: [] })),
      );
      layer.manualR = 1;
      layer.frame();
      for (let i = 0; i < 8; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toHaveLength(1);
      expect(layer.readout().error).toContain('HTTP 503');
      await vi.advanceTimersByTimeAsync(2_500);
      expect(calls).toHaveLength(1); // noch nicht (Retry-After 3 s)
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toHaveLength(2);
      layer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('H-5: Tag wird bei gleicher dataVersion final', () => {
  it('das Flag des behaltenen Profils wird übernommen', async () => {
    let now = 1_000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      let finalNow = false;
      const { layer } = setup(
        (u) => {
          const from = Number(u.searchParams.get('from'));
          const days = [];
          for (let d = from; d < T0 + 3 * D; d += D)
            days.push({
              ...dayBody(d, 23),
              final: d < T0 + 2 * D || finalNow,
              dataVersion: `v${d}`,
            });
          return json(envelope(u, { kind: 'profiles/daily', offsetH: 0, final: finalNow, days }));
        },
        undefined,
        { barsCoverFinal: () => false },
      );
      layer.manualR = 1;
      layer.frame();
      for (let i = 0; i < 8; i++) await flush();
      const cache = (
        layer as unknown as { cache: Map<string, { profiles: Map<number, { final: boolean }> }> }
      ).cache;
      const p = [...cache.values()][0]!.profiles.get(T0 + 2 * D)!;
      expect(p.final).toBe(false);
      finalNow = true;
      now += 61_000;
      layer.frame();
      for (let i = 0; i < 8; i++) await flush();
      expect([...cache.values()][0]!.profiles.get(T0 + 2 * D)).toBe(p); // gleiches Objekt …
      expect(p.final).toBe(true); // … aber nun final
    } finally {
      spy.mockRestore();
    }
  });
});
