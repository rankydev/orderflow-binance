// Big Trades in der Anzeige (KONZEPT §6.4, docs/BIGTRADES-API.md): Schwellenstufen, URL/Speicher,
// Radius/Stufe, Ausdünnung je Pixelzelle, Trefferraster, Abdeckung → Bänder/Legende, exakte Texte,
// Laden (Abschnitte, Cache, Filtern ohne Anfrage, 422-Vorschlag).
import { describe, expect, it } from 'vitest';
import { encodeBigTrades, type BigTradeColumns, type CoverageSpan } from '@orderflow/core/browser';
import {
  bigTradesParamsQuery,
  coverageBands,
  coverageNote,
  coverageSummary,
  decimateByCell,
  effectiveStatus,
  fmtNotionalShort,
  fmtNotionalUsdt,
  fmtUsdtCompact,
  fmtVwap,
  HitGrid,
  loadStoredMin,
  mergeBands,
  parseBigTradesParams,
  radiusPx,
  resolveThreshold,
  stepAfter,
  stepsWith,
  storageKey,
  storeMin,
  thresholdSteps,
  tierOf,
  wantedChunks,
} from '../src/lib/bigtrades/model.ts';
import {
  BigTradesLayer,
  clipSpans,
  logicalOfSec,
  lowerBound,
  overlaps,
  type BigTradesHost,
} from '../src/lib/bigtrades/layer.ts';
import type { BarItem, SymbolInfo } from '../src/lib/types.ts';

const D = 86_400_000;

describe('Schwellenstufen', () => {
  it('BTC: Untergrenze 500 k, dann 1-2-5 · 10^k bis 10⁹', () => {
    const s = thresholdSteps(500_000);
    expect(s.slice(0, 5)).toEqual([500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000]);
    expect(s[s.length - 1]).toBe(1_000_000_000);
    expect(s).toHaveLength(11);
  });
  it('ETH: 250 k liegt nicht auf der Leiter – erste Stufe ist die Untergrenze', () => {
    expect(thresholdSteps(250_000).slice(0, 3)).toEqual([250_000, 500_000, 1_000_000]);
  });
  it('max begrenzt; Untergrenze über max bleibt die einzige Stufe', () => {
    expect(thresholdSteps(500_000, 2_000_000)).toEqual([500_000, 1_000_000, 2_000_000]);
    expect(thresholdSteps(5e9, 1e9)).toEqual([5e9]);
  });
  it('fremder Wert wird als eigene Stufe einsortiert; Schritt vor/zurück', () => {
    const s = stepsWith(thresholdSteps(500_000), 750_000);
    expect(s.slice(0, 3)).toEqual([500_000, 750_000, 1_000_000]);
    expect(stepAfter(s, 750_000, 1)).toBe(1_000_000);
    expect(stepAfter(s, 750_000, -1)).toBe(500_000);
    expect(stepAfter(s, 500_000, -1)).toBe(500_000);
    expect(stepAfter(s, 1e9, 1)).toBe(1e9);
  });
  it('wirksame Schwelle: nie unter der Untergrenze, nie über max, sonst unverändert', () => {
    expect(resolveThreshold(null, 500_000)).toBe(500_000);
    expect(resolveThreshold(100_000, 500_000)).toBe(500_000);
    expect(resolveThreshold(1_234_567, 500_000)).toBe(1_234_567);
    expect(resolveThreshold(5e9, 500_000)).toBe(1e9);
    expect(resolveThreshold(1.5, 500_000)).toBe(500_000);
  });
});

describe('URL und Speicher', () => {
  it('parse: bt=1, btmin nur als positive ganze Zahl', () => {
    expect(parseBigTradesParams(new URLSearchParams(''))).toEqual({ on: false, min: null });
    expect(parseBigTradesParams(new URLSearchParams('bt=1&btmin=2000000'))).toEqual({
      on: true,
      min: 2_000_000,
    });
    for (const v of ['0', '-5', '1e6', '1.5', 'abc', '01', '99999999999'])
      expect(parseBigTradesParams(new URLSearchParams(`btmin=${v}`)).min).toBeNull();
    expect(parseBigTradesParams(new URLSearchParams('bt=true')).on).toBe(false);
  });
  it('serialisieren: Standard (aus, Untergrenze) erzeugt nichts; Rundlauf', () => {
    expect(bigTradesParamsQuery({ on: false, min: 500_000 }, 500_000)).toBe('');
    expect(bigTradesParamsQuery({ on: true, min: 500_000 }, 500_000)).toBe('&bt=1');
    const q = bigTradesParamsQuery({ on: true, min: 5_000_000 }, 500_000);
    expect(q).toBe('&bt=1&btmin=5000000');
    expect(parseBigTradesParams(new URLSearchParams(q.slice(1)))).toEqual({
      on: true,
      min: 5_000_000,
    });
    // Untergrenze noch unbekannt (vor /symbols): Wert aus der URL bleibt erhalten
    expect(bigTradesParamsQuery({ on: false, min: 500_000 }, null)).toBe('&btmin=500000');
  });
  it('Speicher je Symbol; ungültiger Inhalt und werfender Speicher → null', () => {
    const m = new Map<string, string>();
    const store = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
    storeMin('BTCUSDT', 2_000_000, store);
    storeMin('ETHUSDT', 250_000, store);
    expect(m.get(storageKey('BTCUSDT'))).toBe('2000000');
    expect(loadStoredMin('BTCUSDT', store)).toBe(2_000_000);
    expect(loadStoredMin('ETHUSDT', store)).toBe(250_000);
    expect(loadStoredMin('SOLUSDT', store)).toBeNull();
    m.set(storageKey('BTCUSDT'), 'x');
    expect(loadStoredMin('BTCUSDT', store)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(loadStoredMin('BTCUSDT', broken)).toBeNull();
    expect(() => storeMin('BTCUSDT', 1, broken)).not.toThrow();
    expect(loadStoredMin('BTCUSDT', null)).toBeNull();
  });
});

describe('Radius und Stufe', () => {
  const S = 50_000_000_000; // 500 000 USDT bei 5 Dezimalen
  it('r = clamp(3·√(N/S), 3, 18)', () => {
    expect(radiusPx(S, S)).toBe(3);
    expect(radiusPx(4 * S, S)).toBe(6);
    expect(radiusPx(25 * S, S)).toBe(15);
    expect(radiusPx(36 * S, S)).toBe(18);
    expect(radiusPx(1000 * S, S)).toBe(18);
    expect(radiusPx(S / 2, S)).toBe(3); // unter der Schwelle (Filter) nie kleiner als 3
  });
  it('Stufen 1× / 2,5× / 10× exakt an den Grenzen', () => {
    expect(tierOf(S, S)).toBe(0);
    expect(tierOf(2.5 * S - 1, S)).toBe(0);
    expect(tierOf(2.5 * S, S)).toBe(1);
    expect(tierOf(10 * S - 1, S)).toBe(1);
    expect(tierOf(10 * S, S)).toBe(2);
    // ungerade Schwelle (ETH 250 000 USDT · 10^6): 2,5 S ganzzahlig
    const E = 250_000_000_000;
    expect(tierOf(625_000_000_000, E)).toBe(1);
    expect(tierOf(624_999_999_999, E)).toBe(0);
  });
});

describe('Ausdünnung je Pixelzelle', () => {
  it('je (Spalte, Zeile, Seite) nur der größte; Seiten getrennt; Reihenfolge erhalten', () => {
    const x = [10.2, 10.9, 10.5, 10.5, 40];
    const y = [100, 101, 101, 100, 100];
    const side = [1, 1, 1, 2, 1];
    const n = [5, 9, 7, 1, 2];
    expect(decimateByCell(5, x, y, side, n, 2, 6)).toEqual([1, 3, 4]);
  });
  it('verschiedene Preise in derselben Spalte bleiben (eigene Zeilen)', () => {
    expect(decimateByCell(3, [5, 5, 5], [10, 30, 50], [1, 1, 1], [1, 2, 3], 2, 6)).toEqual([
      0, 1, 2,
    ]);
  });
  it('viele Marker auf wenigen Pixeln: höchstens eine je Zelle und Seite', () => {
    const N = 20_000;
    const x = Array.from({ length: N }, (_, i) => (i / N) * 100); // 100 px breit
    const y = Array.from({ length: N }, () => 50);
    const side = Array.from({ length: N }, (_, i) => 1 + (i % 2));
    const n = Array.from({ length: N }, (_, i) => i);
    const keep = decimateByCell(N, x, y, side, n, 2, 6);
    expect(keep.length).toBe(100); // 50 Spalten × 2 Seiten
    // je Zelle der größte (= letzte Index der Zelle und Seite)
    expect(keep).toContain(N - 1);
  });
  it('gleich große: der erste bleibt', () => {
    expect(decimateByCell(2, [1, 1], [1, 1], [2, 2], [7, 7])).toEqual([0]);
  });
});

describe('Trefferraster', () => {
  it('findet den Kreis unter dem Zeiger, auch über Zellgrenzen; außerhalb null', () => {
    const g = new HitGrid(32);
    g.add(0, 30, 30, 10); // überdeckt Zellen (0..1, 0..1)
    g.add(1, 200, 50, 3);
    expect(g.query(38, 30)).toBe(0); // Zelle (1,0)
    expect(g.query(22, 22)).toBe(0);
    expect(g.query(201, 51)).toBe(1);
    expect(g.query(200, 55)).toBe(1); // 5 px ≤ r 3 + Spielraum 2
    expect(g.query(200, 56)).toBeNull(); // 6 px > 5
    // Spielraum über eine Zellgrenze hinweg (Kreis endet bei x = 31, Zeiger in der Nachbarzelle)
    const e = new HitGrid(32);
    e.add(3, 28, 10, 3);
    expect(e.query(32.5, 10)).toBe(3);
  });
  it('Vorrang: nächster Mittelpunkt, bei Gleichstand der zuletzt gezeichnete', () => {
    const g = new HitGrid(32);
    g.add(7, 100, 100, 18); // großer Kreis
    g.add(8, 104, 100, 3); // kleiner darüber
    expect(g.query(104, 100)).toBe(8); // Zeiger auf dem kleinen: der kleine
    expect(g.query(92, 100)).toBe(7); // sonst der große
    expect(g.query(140, 100)).toBeNull();
    const h = new HitGrid(32);
    h.add(1, 10, 10, 5);
    h.add(2, 10, 10, 5);
    expect(h.query(10, 10)).toBe(2);
    h.clear();
    expect(h.size).toBe(0);
    expect(h.query(10, 10)).toBeNull();
  });
});

describe('Abdeckung → Bänder und Legende', () => {
  const T = Date.UTC(2026, 10, 1);
  const span = (
    from: number,
    to: number,
    status: CoverageSpan['status'],
    floorN: number | null,
    reason: CoverageSpan['reason'] = null,
  ): CoverageSpan => ({ from, to, status, reason, floorN, final: true });
  const MIN = 50_000_000_000;

  it('partial wird ok, sobald die Schwelle die Tagesuntergrenze erreicht', () => {
    const p = span(T, T + D, 'partial', 2 * MIN, 'floor_above');
    expect(effectiveStatus(p, MIN)).toBe('partial');
    expect(effectiveStatus(p, 2 * MIN)).toBe('ok');
    expect(effectiveStatus(span(T, T + D, 'none', null, 'digest_v1'), 10 * MIN)).toBe('none');
  });

  it('ok entfällt; gleiche Nachbarn zusammengefasst, Gründe gesammelt', () => {
    const b = coverageBands(
      [
        span(T, T + D, 'none', null, 'digest_v1'),
        span(T + D, T + 2 * D, 'none', null, 'no_day'),
        span(T + 2 * D, T + 3 * D, 'ok', MIN),
        span(T + 3 * D, T + 4 * D, 'partial', 2 * MIN, 'floor_above'),
        span(T + 4 * D, T + 5 * D, 'partial', 3 * MIN, 'floor_above'),
      ],
      MIN,
    );
    expect(b).toEqual([
      { from: T, to: T + 2 * D, kind: 'none', reasons: ['digest_v1', 'no_day'], floorN: null },
      { from: T + 3 * D, to: T + 4 * D, kind: 'partial', reasons: [], floorN: 2 * MIN },
      { from: T + 4 * D, to: T + 5 * D, kind: 'partial', reasons: [], floorN: 3 * MIN },
    ]);
  });

  it('Bänder mehrerer Abschnitte verbinden (Abschnittsgrenze mitten im Tag)', () => {
    const m = mergeBands([
      { from: T + D / 2, to: T + D, kind: 'none', reasons: ['digest_v1'], floorN: null },
      { from: T, to: T + D / 2, kind: 'none', reasons: ['digest_v1'], floorN: null },
      { from: T + D, to: T + 2 * D, kind: 'toomany', reasons: [], floorN: null },
    ]);
    expect(m.map((x) => [x.from, x.to, x.kind])).toEqual([
      [T, T + D, 'none'],
      [T + D, T + 2 * D, 'toomany'],
    ]);
  });

  it('fast alles none (Stand vor dem Neuimport): Legende sagt es ausdrücklich', () => {
    const bands = coverageBands(
      [span(T, T + 13 * D, 'none', null, 'digest_v1'), span(T + 13 * D, T + 14 * D, 'ok', MIN)],
      MIN,
    );
    const s = coverageSummary(bands, T, T + 14 * D);
    expect(s).toMatchObject({ visibleDays: 14, noneDays: 13, partialDays: 0 });
    expect(coverageNote(s, 5)).toBe(
      'keine Big-Trade-Daten in 13 von 14 Tagen (Neuimport ausstehend)',
    );
    const all = coverageSummary(bands, T + D, T + 2 * D);
    expect(coverageNote(all, 5)).toBe(
      'keine Big-Trade-Daten im sichtbaren Bereich (Neuimport ausstehend)',
    );
    expect(coverageNote(coverageSummary(bands, T + 13 * D, T + 14 * D), 5)).toBe('');
  });

  it('Lückenminuten und künftige Gründe: zählen als keine Daten, Text roh falls unbekannt', () => {
    const bands = coverageBands(
      [
        span(T, T + 600_000, 'ok', MIN),
        span(T + 600_000, T + 660_000, 'none', null, 'gap'),
        { ...span(T + 660_000, T + D, 'none', null), reason: 'future_reason' as never },
      ],
      MIN,
    );
    expect(bands).toHaveLength(1);
    const s = coverageSummary(bands, T, T + 2 * D);
    expect(coverageNote(s, 5)).toBe(
      'keine Big-Trade-Daten in 1 von 2 Tagen (Lücke der Aufzeichnung, future_reason)',
    );
  });

  it('erst kürzen, dann zusammenfassen: Gründe außerhalb des Datenbereichs fallen weg', () => {
    const spans = [
      span(T - 2 * D, T, 'none', null, 'no_day'),
      span(T, T + D, 'none', null, 'digest_v1'),
      span(T + D, T + 2 * D, 'ok', MIN),
    ];
    expect(coverageBands(spans, MIN)[0]!.reasons).toEqual(['no_day', 'digest_v1']);
    const b = coverageBands(clipSpans(spans, T, T + 2 * D), MIN);
    expect(b).toEqual([{ from: T, to: T + D, kind: 'none', reasons: ['digest_v1'], floorN: null }]);
    expect(clipSpans(spans, T + D / 2, T + D)).toHaveLength(1);
  });

  it('eine Lückenminute in jedem sichtbaren Tag: „in Teilen", nicht „im sichtbaren Bereich"', () => {
    const bands = coverageBands([span(T + 600_000, T + 660_000, 'none', null, 'gap')], MIN);
    expect(coverageNote(coverageSummary(bands, T, T + 3_600_000), 5)).toBe(
      'keine Big-Trade-Daten in Teilen des sichtbaren Bereichs (Lücke der Aufzeichnung)',
    );
    expect(coverageNote(coverageSummary(bands, T + 600_000, T + 660_000), 5)).toBe(
      'keine Big-Trade-Daten im sichtbaren Bereich (Lücke der Aufzeichnung)',
    );
  });

  it('partial mit Untergrenze in USDT; Tage am Rand des sichtbaren Bereichs zählen', () => {
    const bands = coverageBands([span(T, T + 2 * D, 'partial', 2 * MIN, 'floor_above')], MIN);
    const s = coverageSummary(bands, T + D - 1, T + 3 * D);
    expect(s).toMatchObject({ visibleDays: 3, partialDays: 2, partialFloorN: 2 * MIN });
    expect(coverageNote(s, 5)).toBe('an 2 von 3 Tagen Big Trades erst ab 1 Mio. $ gespeichert');
  });
});

describe('Texte exakt', () => {
  it('Schwellen kompakt (deutsch)', () => {
    expect(fmtUsdtCompact(500_000)).toBe('500 k $');
    expect(fmtUsdtCompact(250_000)).toBe('250 k $');
    expect(fmtUsdtCompact(1_000_000)).toBe('1 Mio. $');
    expect(fmtUsdtCompact(2_500_000)).toBe('2,5 Mio. $');
    expect(fmtUsdtCompact(1_000_000_000)).toBe('1 Mrd. $');
    // exakt: keine abgerundete Untergrenze
    expect(fmtUsdtCompact(1_234_567)).toBe('1,23 Mio. $');
    expect(fmtUsdtCompact(1_234_567, true)).toBe('1\u202f234\u202f567 $');
    expect(fmtUsdtCompact(2_500_000, true)).toBe('2,5 Mio. $');
    expect(fmtUsdtCompact(500, true)).toBe('500 $');
  });
  it('Notional auf ganze USDT half-up, gruppiert; Kurzlabel', () => {
    expect(fmtNotionalUsdt(123_456_789_049_999, 5)).toBe('1 234 567 890 USDT');
    expect(fmtNotionalUsdt(50_000_050_000, 5)).toBe('500 001 USDT'); // .5 → auf
    expect(fmtNotionalUsdt(50_000_049_999, 5)).toBe('500 000 USDT');
    expect(fmtNotionalShort(240_000_000_000, 5)).toBe('2,4 M');
    expect(fmtNotionalShort(85_000_000_000, 5)).toBe('850 k');
    expect(fmtNotionalShort(99_996_000_000, 5)).toBe('1 M'); // nicht „1000 k"
  });
  it('VWAP = notional / qty mit priceDecimals + 1 Stellen, exakt gerundet', () => {
    // 3 Fills: 97 000.00 × 1.000, 97 001.00 × 1.000, 97 001.50 × 1.000 (price_unit 0.01, qty_unit 0.001)
    const qty = 3000;
    const notional = (9_700_000 + 9_700_100 + 9_700_150) * 1000;
    expect(fmtVwap(notional, qty, 2)).toBe('97000.833'); // 97000.8333… → .833
    expect(fmtVwap(9_700_005 * 2, 2, 2)).toBe('97000.050');
    // half-up: 0.xx5 → auf
    expect(fmtVwap(5, 2, 0)).toBe('2.5');
    expect(fmtVwap(1, 3, 0)).toBe('0.3');
    expect(fmtVwap(2, 3, 0)).toBe('0.7');
  });
});

describe('Abschnitte und Zeitachse', () => {
  it('sichtbare Abschnitte von der Mitte nach außen, dann Padding, im Datenbereich', () => {
    const span = 60_000; // 1 000 Bars à 60 s
    const w = wantedChunks(2.5 * span, 4.5 * span, span, 0, 10 * span);
    expect(w).toEqual([
      { c: 3, priority: 0 },
      { c: 2, priority: 0 },
      { c: 4, priority: 0 },
      { c: 1, priority: 1 },
      { c: 5, priority: 1 },
    ]);
    expect(wantedChunks(0, 2 * span, span, span, 10 * span).map((x) => x.c)).toEqual([1, 2, 3]);
    expect(wantedChunks(20 * span, 30 * span, span, 0, 10 * span)).toEqual([]);
    expect(wantedChunks(0, 100 * span, span, 0, 100 * span, 1, 24)).toHaveLength(24);
  });
  it('logische Position: Bar-Index, Lücke → nächster Bar, außerhalb linear', () => {
    const items = [0, 60, 180, 240].map((t) => ({ time: t }) as BarItem);
    expect(logicalOfSec(items, 60, 60)).toBe(1);
    expect(logicalOfSec(items, 120, 60)).toBe(2); // Minute ohne Trades
    expect(logicalOfSec(items, -120, 60)).toBe(-2);
    expect(logicalOfSec(items, 360, 60)).toBe(5);
    expect(lowerBound(new Float64Array([1, 3, 3, 5]), 3)).toBe(1);
    expect(lowerBound(new Float64Array([1, 3]), 9)).toBe(2);
  });
  it('Label-Kollision: Überlappung ja, berührende Kanten nein', () => {
    const a = { x: 0, y: 0, w: 10, h: 12 };
    expect(overlaps(a, { x: 9, y: 11, w: 5, h: 5 })).toBe(true);
    expect(overlaps(a, { x: 10, y: 0, w: 5, h: 5 })).toBe(false);
    expect(overlaps(a, { x: 0, y: 12, w: 5, h: 5 })).toBe(false);
  });
});

// ---------------------------------------------------------------- Laden

const SPAN_MS = 60_000_000; // 1 000 Bars 1m
const C = 29_800; // Abschnitt ≈ 2026-09
const C0 = C * SPAN_MS;
const SYM: SymbolInfo = {
  name: 'BTCUSDT',
  priceDecimals: 2,
  qtyDecimals: 3,
  tickRefUnits: 10,
  tickUnits: 10,
  dataFrom: C0 - 30 * D,
  dataTo: C0 + 30 * D,
  tileConfigVersion: 1,
  tiles: {},
  bigTrades: { floorN: 50_000_000_000, minUsdt: 500_000, notionalDecimals: 5 },
};

/** Abdeckung von [from, to) an UTC-Tagen; status je Tag. */
function coverage(from: number, to: number, st: (day: number) => 'ok' | 'none'): CoverageSpan[] {
  const out: CoverageSpan[] = [];
  for (let a = from; a < to;) {
    const b = Math.min(to, (Math.floor(a / D) + 1) * D);
    const ok = st(Math.floor(a / D)) === 'ok';
    out.push({
      from: a,
      to: b,
      status: ok ? 'ok' : 'none',
      reason: ok ? null : 'digest_v1',
      floorN: ok ? 50_000_000_000 : null,
      final: true,
    });
    a = b;
  }
  return out;
}

/** Antwort für einen Abschnitt: Orders (ts, notional USDT) ≥ min, Tage nach `st`. */
function body(
  u: URL,
  orders: [number, number][],
  st: (d: number) => 'ok' | 'none' = () => 'ok',
  omitted = 0,
): Response {
  const from = Number(u.searchParams.get('from'));
  const to = Number(u.searchParams.get('to'));
  const min = Number(u.searchParams.get('min'));
  const rows = orders
    .filter(([ts, usdt]) => usdt >= min && ts >= from && ts < to && st(Math.floor(ts / D)) === 'ok')
    .sort((a, b) => a[0] - b[0]);
  const n = rows.length;
  const cols: BigTradeColumns = {
    ts: Float64Array.from(rows, (r) => r[0]),
    bar: Int32Array.from(rows, (r) => Math.floor(r[0] / 60_000) * 60),
    side: Int32Array.from(rows, (_, i) => 1 + (i % 2)),
    pxFirst: Int32Array.from(rows, () => 9_700_000),
    pxLast: Int32Array.from(rows, () => 9_700_500),
    // qty so, dass notional / qty ≈ 97 000 USDT
    qty: Float64Array.from(rows, (r) => Math.round((r[1] * 1000) / 97_000)),
    notional: Float64Array.from(rows, (r) => r[1] * 100_000),
    aggN: Int32Array.from(rows, () => 3),
    firstAggId: Float64Array.from(rows, (_, i) => 1000 + i),
  };
  const bytes = encodeBigTrades({
    meta: {
      kind: 'bigtrades',
      sym: 'BTCUSDT',
      tf: '1m',
      tfSec: 60,
      priceDecimals: 2,
      qtyDecimals: 3,
      tickRefUnits: 10,
      notionalDecimals: 5,
      from,
      to,
      minUsdt: min,
      minN: min * 100_000,
      maxRows: 20_000,
      total: n + omitted,
      omitted,
      k: omitted > 0 ? 2 : null,
      coverage: coverage(from, to, st),
      dataVersion: 'v',
      final: false,
    },
    rows: cols,
  });
  return new Response(bytes.slice().buffer, { status: 200 });
}

const json = (x: unknown, status: number) =>
  new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } });
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(handler: (u: URL) => Response, over: Partial<BigTradesHost> = {}) {
  const calls: URL[] = [];
  const host: BigTradesHost = {
    chart: {} as never,
    apiBase: '',
    sym: () => SYM,
    tf: () => '1m',
    tfSec: () => 60,
    items: () => [],
    // sichtbar: Mitte von Abschnitt C (≈ 3 h)
    visibleTimeRange: () => [(C0 + 20_000_000) / 1000, (C0 + 30_000_000) / 1000],
    priceToY: () => 0,
    footprintActive: () => false,
    busy: () => false,
    gestureActive: () => false,
    ...over,
  };
  const layer = new BigTradesLayer(host, (url) => {
    const u = new URL(url, 'http://x');
    calls.push(u);
    return Promise.resolve(handler(u));
  });
  layer.enabled = true;
  layer.minUsdt = 500_000;
  return { layer, calls, host };
}

const ORDERS: [number, number][] = [
  [C0 + 21_000_000, 600_000],
  [C0 + 22_000_000, 1_500_000],
  [C0 + 25_000_000, 3_000_000],
];

describe('BigTradesLayer: Laden', () => {
  it('fragt sichtbare Abschnitte + Padding an, an den Bar-Abschnitten ausgerichtet', async () => {
    const { layer, calls } = setup((u) => body(u, ORDERS));
    layer.frame();
    await flush();
    expect(calls.map((u) => Number(u.searchParams.get('from')) / SPAN_MS)).toEqual([
      C,
      C - 1,
      C + 1,
    ]);
    const u = calls[0]!;
    expect(u.pathname).toBe('/api/v1/bigtrades');
    expect([...u.searchParams.keys()]).toEqual(['sym', 'tf', 'from', 'to', 'min']);
    expect(u.searchParams.get('to')).toBe(String(C0 + SPAN_MS));
    expect(u.searchParams.get('min')).toBe('500000');
    layer.frame();
    await flush();
    expect(calls).toHaveLength(3); // aus dem Cache
    const ro = layer.readout();
    expect(ro).toMatchObject({ loading: 0, omitted: 0, error: '', coverageNote: '' });
  });

  it('aus oder ohne Untergrenze: keine Anfrage', async () => {
    const a = setup((u) => body(u, ORDERS));
    a.layer.enabled = false;
    a.layer.frame();
    const b = setup((u) => body(u, ORDERS), { sym: () => ({ ...SYM, bigTrades: null }) });
    b.layer.frame();
    await flush();
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
    expect(b.layer.readout().available).toBe(false);
  });

  it('Geste läuft: Bedarf erst danach', async () => {
    let g = true;
    const { layer, calls } = setup((u) => body(u, ORDERS), { gestureActive: () => g });
    layer.frame();
    await flush();
    expect(calls).toHaveLength(0);
    g = false;
    layer.frame();
    await flush();
    expect(calls).toHaveLength(3);
  });

  it('Schwelle angehoben über eine nicht ausgedünnte Antwort: Filtern ohne neue Anfrage', async () => {
    const { layer, calls } = setup((u) => body(u, ORDERS));
    layer.frame();
    await flush();
    layer.minUsdt = 2_000_000;
    layer.changed();
    await flush();
    expect(calls).toHaveLength(3);
    expect(layer.counters.filteredFromCache).toBeGreaterThan(0);
    // gesenkt unter die geladene: neue Anfrage
    layer.minUsdt = 500_000;
    layer.changed();
    await flush();
    expect(calls).toHaveLength(3); // 500 k ist geladen
    layer.minUsdt = 1_000_000;
    layer.changed();
    await flush();
    expect(calls).toHaveLength(3); // 1 Mio. aus 500 k gefiltert
  });

  it('ausgedünnte Antwort wird nicht gefiltert, sondern neu angefragt; omitted in der Legende', async () => {
    const { layer, calls } = setup((u) =>
      body(u, ORDERS, () => 'ok', u.searchParams.get('min') === '500000' ? 1234 : 0),
    );
    layer.frame();
    await flush();
    expect(layer.readout()).toMatchObject({ omitted: 1234, k: 2 });
    layer.minUsdt = 1_000_000;
    layer.changed();
    await flush();
    expect(calls.filter((u) => u.searchParams.get('min') === '1000000')).toHaveLength(3);
    expect(layer.readout().omitted).toBe(0);
  });

  it('422 matched_rows_exceeded: Vorschlag sichtbar, Schwelle bleibt, keine Wiederholung', async () => {
    const { layer, calls } = setup((u) =>
      u.searchParams.get('min') === '500000'
        ? json(
            {
              error: 'zu viele',
              reason: 'matched_rows_exceeded',
              rowsEstimate: 193_000,
              limit: 150_000,
              suggestMinUsdt: 1_000_000,
            },
            422,
          )
        : body(u, ORDERS),
    );
    layer.frame();
    await flush();
    layer.frame();
    await flush();
    expect(calls).toHaveLength(3);
    const ro = layer.readout();
    expect(layer.minUsdt).toBe(500_000);
    expect(ro.suggestMinUsdt).toBe(1_000_000);
    expect(ro.coverage).toMatchObject({ toomanyDays: 1 });
    expect(ro.coverageNote).toContain('zu viele Orders im sichtbaren Bereich');
    expect(ro.error).toBe('');
    // Klick auf den Vorschlag (App setzt die Schwelle)
    layer.minUsdt = 1_000_000;
    layer.changed();
    await flush();
    expect(layer.readout().suggestMinUsdt).toBeNull();
  });

  it('422 ohne Vorschlag: Hinweis statt Knopf', async () => {
    const { layer } = setup(() =>
      json({ error: 'x', reason: 'matched_rows_exceeded', suggestMinUsdt: null }, 422),
    );
    layer.frame();
    await flush();
    expect(layer.readout()).toMatchObject({ suggestMinUsdt: null, tooManyNoSuggest: true });
  });

  it('Tage ohne Order-Daten (none): Legende meldet sie, keine Marker heißt nicht „keine Big Trades"', async () => {
    const day = (t: number) => Math.floor(t / D);
    const dOk = day(C0 + 30_000_000);
    const { layer } = setup((u) => body(u, [], (d) => (d === dOk ? 'ok' : 'none')), {
      // sichtbar: ganzer Abschnitt C (≈ 16,7 h über zwei UTC-Tage)
      visibleTimeRange: () => [C0 / 1000, (C0 + SPAN_MS - 60_000) / 1000],
    });
    layer.frame();
    await flush();
    const ro = layer.readout();
    expect(ro.coverage!.visibleDays).toBe(day(C0 + SPAN_MS - 1) - day(C0) + 1);
    expect(ro.coverage!.noneDays).toBeGreaterThan(0);
    expect(ro.coverageNote).toMatch(
      /^keine Big-Trade-Daten (in \d+ von \d+ Tagen|im sichtbaren Bereich) \(Neuimport ausstehend\)$/,
    );
  });

  it('Antwort passt nicht zur Anfrage: sichtbarer Fehler, nicht übernommen', async () => {
    const { layer } = setup((u) => {
      const v = new URL(u);
      v.searchParams.set('min', '600000'); // Server liefert eine andere Schwelle
      return body(v, ORDERS);
    });
    layer.frame();
    await flush();
    const ro = layer.readout();
    expect(ro.error).toContain('Big Trades');
    expect(ro.loading).toBe(0); // als nicht ladbar geführt, nicht „lädt"
    expect(ro.coverage).toMatchObject({ failedDays: 1 });
  });

  it('Symbolwechsel: Antworten des alten Symbols werden verworfen', async () => {
    let sym = SYM;
    const releases: (() => void)[] = [];
    const host: Partial<BigTradesHost> = { sym: () => sym };
    const calls: string[] = [];
    const layer = new BigTradesLayer(
      {
        chart: {} as never,
        apiBase: '',
        tf: () => '1m',
        tfSec: () => 60,
        items: () => [],
        visibleTimeRange: () => [(C0 + 20_000_000) / 1000, (C0 + 30_000_000) / 1000],
        priceToY: () => 0,
        footprintActive: () => false,
        busy: () => false,
        gestureActive: () => false,
        sym: () => sym,
        ...host,
      },
      (url) => {
        calls.push(url);
        return new Promise((r) => {
          releases.push(() => r(body(new URL(url, 'http://x'), ORDERS)));
        });
      },
    );
    layer.enabled = true;
    layer.minUsdt = 500_000;
    layer.frame();
    sym = { ...SYM, name: 'ETHUSDT' };
    for (const f of releases) f();
    await flush();
    expect(layer.readout().error).toBe('');
    expect(layer.readout().loading).toBe(1);
  });
});
