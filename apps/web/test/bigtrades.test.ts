// Big Trades in der Anzeige (KONZEPT §6.4, docs/BIGTRADES-API.md): Schwellenstufen, URL/Speicher,
// Radius/Stufe, Ausdünnung je Pixelzelle, Trefferraster, Abdeckung → Bänder/Legende, exakte Texte,
// Laden (Abschnitte, Cache, Filtern ohne Anfrage, 422-Vorschlag).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBigTrades, type BigTradeColumns, type CoverageSpan } from '@orderflow/core/browser';
import {
  bigTradesParamsQuery,
  coverageBands,
  coverageNote,
  coverageSummary,
  barCoverageText,
  barSegments,
  decimateAdaptive,
  decimateByCell,
  markStalePending,
  PENDING_TOLERANCE_MS,
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
  bandGeometry,
  BigTradesLayer,
  clipSpans,
  MIN_BAND_PX,
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
  it('serialisieren: aus + Untergrenze erzeugt nichts; an schreibt immer btmin; Rundlauf', () => {
    expect(bigTradesParamsQuery({ on: false, min: 500_000 }, 500_000)).toBe('');
    // geteilter Link: dieselbe Schwelle beim Empfänger, auch wenn er eine andere gespeichert hat
    expect(bigTradesParamsQuery({ on: true, min: 500_000 }, 500_000)).toBe('&bt=1&btmin=500000');
    expect(bigTradesParamsQuery({ on: false, min: 2_000_000 }, 500_000)).toBe('&btmin=2000000');
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

  it('ok entfällt; Nachbarn nur bei gleichem Grund zusammengefasst', () => {
    const b = coverageBands(
      [
        span(T, T + D / 2, 'none', null, 'digest_v1'),
        span(T + D / 2, T + D, 'none', null, 'digest_v1'),
        span(T + D, T + 2 * D, 'none', null, 'no_day'),
        span(T + 2 * D, T + 3 * D, 'ok', MIN),
        span(T + 3 * D, T + 4 * D, 'partial', 2 * MIN, 'floor_above'),
        span(T + 4 * D, T + 5 * D, 'partial', 3 * MIN, 'floor_above'),
      ],
      MIN,
    );
    expect(b).toEqual([
      { from: T, to: T + D, kind: 'none', reasons: ['digest_v1'], floorN: null },
      { from: T + D, to: T + 2 * D, kind: 'none', reasons: ['no_day'], floorN: null },
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
    expect(s).toMatchObject({ visibleDays: 14, noneDays: 13, holeDays: 0, partialDays: 0 });
    expect(coverageNote(s, 5)).toBe('13 Tage ohne Big-Trade-Daten (Neuimport ausstehend)');
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
    expect(bands).toHaveLength(2);
    const s = coverageSummary(bands, T, T + 2 * D);
    // Tag T hat ab 00:10 keine Daten, die ersten 10 min schon → Lücken, kein „ganzer Tag"
    expect(s).toMatchObject({ noneDays: 0, holeDays: 1, holeMs: D - 600_000 });
    expect(coverageNote(s, 5)).toBe(
      '1 Tag mit Lücken (1430 min ohne Big-Trade-Daten: Lücke der Aufzeichnung, anderer Grund (future_reason))',
    );
  });

  it('erst kürzen, dann zusammenfassen: Gründe außerhalb des Datenbereichs fallen weg', () => {
    const spans = [
      span(T - 2 * D, T, 'none', null, 'no_day'),
      span(T, T + D, 'none', null, 'digest_v1'),
      span(T + D, T + 2 * D, 'ok', MIN),
    ];
    expect(coverageBands(spans, MIN).map((b) => b.reasons)).toEqual([['no_day'], ['digest_v1']]);
    const b = coverageBands(clipSpans(spans, T, T + 2 * D), MIN);
    expect(b).toEqual([{ from: T, to: T + D, kind: 'none', reasons: ['digest_v1'], floorN: null }]);
    expect(clipSpans(spans, T + D / 2, T + D)).toHaveLength(1);
  });

  it('kurze Lücken ≠ Tag ohne Daten: Minuten getrennt ausgewiesen', () => {
    const bands = coverageBands([span(T + 600_000, T + 660_000, 'none', null, 'gap')], MIN);
    expect(coverageNote(coverageSummary(bands, T, T + 3_600_000), 5)).toBe(
      'Lücken: 1 min ohne Big-Trade-Daten (Lücke der Aufzeichnung)',
    );
    // 5 Tage, zwei ganz ohne Daten, drei mit insgesamt 11 Lückenminuten (Abweichung zur Kline)
    const b5 = coverageBands(
      [
        span(T, T + 2 * D, 'none', null, 'digest_v1'),
        span(T + 2 * D, T + 2 * D + 240_000, 'none', null, 'mismatch'),
        span(T + 2 * D + 240_000, T + 3 * D, 'ok', MIN),
        span(T + 3 * D, T + 3 * D + 300_000, 'none', null, 'mismatch'),
        span(T + 3 * D + 300_000, T + 4 * D, 'ok', MIN),
        span(T + 4 * D, T + 4 * D + 120_000, 'none', null, 'too_many_holes'),
        span(T + 4 * D + 120_000, T + 5 * D, 'ok', MIN),
      ],
      MIN,
    );
    expect(coverageNote(coverageSummary(b5, T, T + 5 * D), 5)).toBe(
      '2 Tage ohne Big-Trade-Daten (Neuimport ausstehend) · 3 Tage mit Lücken (11 min ohne Big-Trade-Daten: Abweichung zur Kline, zu viele Lückenminuten am Tag)',
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
  extra: { final?: boolean; coverage?: (from: number, to: number) => CoverageSpan[] } = {},
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
      coverage: extra.coverage ? extra.coverage(from, to) : coverage(from, to, st),
      dataVersion: 'v',
      final: extra.final ?? false,
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
    expect(ro.coverage!.noneDays).toBe(1);
    expect(ro.coverageNote).toBe('1 Tag ohne Big-Trade-Daten (Neuimport ausstehend)');
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

// ---------------------------------------------------------------- Review 2: Lücken, Live-Rand, Teilung

describe('Bänder je Bar: Fläche nur bei überwiegend fehlenden Daten', () => {
  const H4 = 4 * 3_600_000;
  const T = Date.UTC(2026, 10, 2);
  const band = (from: number, to: number, kind: 'none' | 'pending' = 'none', r = 'mismatch') => ({
    from,
    to,
    kind,
    reasons: kind === 'none' ? [r] : [],
    floorN: null,
  });

  it('4 Lückenminuten in einem 4h-Bar: dünne Markierung, keine Fläche', () => {
    const { full, ticks } = barSegments(
      [band(T + 60_000, T + 180_000), band(T + 7_200_000, T + 7_320_000)],
      H4,
      0,
      T + 10 * D,
    );
    expect(full).toEqual([]);
    expect(ticks).toEqual([{ bar: T, kind: 'none', ms: 240_000 }]);
  });

  it('ganzer Tag ohne Daten: Flächen an Bar-Grenzen, Ränder mit Mehrheit ebenfalls Fläche', () => {
    // [T + 1h, T + D + 3h): Bar T (3 von 4 h) Fläche, Bar T + D (3 von 4 h) Fläche
    const { full, ticks } = barSegments(
      [band(T + 3_600_000, T + D + 3 * 3_600_000, 'none', 'digest_v1')],
      H4,
      0,
      T + 10 * D,
    );
    expect(ticks).toEqual([]);
    expect(full.map((b) => [b.from, b.to])).toEqual([[T, T + D + H4]]);
  });

  it('Randbar mit Minderheit: Markierung; Datenrand zählt beim Anteil', () => {
    const { full, ticks } = barSegments(
      [band(T + 3 * 3_600_000, T + 2 * D, 'none', 'digest_v1')],
      H4,
      0,
      T + 10 * D,
    );
    expect(ticks).toEqual([{ bar: T, kind: 'none', ms: 3_600_000 }]);
    expect(full.map((b) => [b.from, b.to])).toEqual([[T + H4, T + 2 * D]]);
    // Daten beginnen erst T + 3h: die eine Stunde ist der ganze Datenanteil des Bars → Fläche
    expect(
      barSegments([band(T + 3 * 3_600_000, T + 4 * 3_600_000)], H4, T + 3 * 3_600_000, T + D).full,
    ).toHaveLength(1);
  });

  it('Live-Rand (pending) bleibt neutral: weder Fläche noch Markierung', () => {
    expect(barSegments([band(T + 60_000, T + D, 'pending')], D, 0, T + D)).toEqual({
      full: [],
      ticks: [],
    });
  });

  it('Hover-Zusatz nennt Minuten, Gründe und den Live-Rand', () => {
    const bands = [
      band(T + 60_000, T + 180_000, 'none', 'gap'),
      band(T + 3_600_000, T + H4, 'pending'),
    ];
    expect(barCoverageText(bands, T, H4, 5)).toBe(
      'Big Trades: 2 min ohne Daten (Lücke der Aufzeichnung), 180 min noch nicht geschrieben',
    );
    expect(barCoverageText(bands, T + H4, H4, 5)).toBe('');
    expect(barCoverageText([band(T, T + D, 'none', 'digest_v1')], T, H4, 5)).toBe(
      'Big Trades: im ganzen Bar ohne Daten (Neuimport ausstehend)',
    );
  });

  it('Legende: pending zählt nicht, der Live-Chart erreicht „vollständig"', () => {
    const MIN = 50_000_000_000;
    const spans: CoverageSpan[] = [
      { from: T, to: T + 3_600_000, status: 'ok', reason: null, floorN: MIN, final: false },
      {
        from: T + 3_600_000,
        to: T + D,
        status: 'none',
        reason: 'pending',
        floorN: null,
        final: false,
      },
    ];
    const bands = coverageBands(spans, MIN);
    expect(bands.map((b) => b.kind)).toEqual(['pending']);
    expect(coverageNote(coverageSummary(bands, T, T + D), 5)).toBe('');
  });
});

describe('Ausdünnung mit Obergrenze', () => {
  it('viele Marker auf großer Fläche: höchstens max, Zellen wachsen', () => {
    const N = 50_000;
    const x = Float64Array.from({ length: N }, (_, i) => (i * 7919) % 1600);
    const y = Float64Array.from({ length: N }, (_, i) => (i * 104_729) % 800);
    const side = Int32Array.from({ length: N }, (_, i) => 1 + (i % 2));
    const n = Float64Array.from({ length: N }, (_, i) => i);
    const r = decimateAdaptive(N, x, y, side, n, 4000, 1600, 800);
    expect(r.keep.length).toBeLessThanOrEqual(4000);
    expect(r.cellW).toBeGreaterThan(2);
    // wenige Marker: feinste Zellen
    expect(
      decimateAdaptive(3, [1, 50, 99], [1, 1, 1], [1, 1, 1], [1, 2, 3], 4000, 1600, 800),
    ).toMatchObject({ cellW: 2, keep: [0, 1, 2] });
  });
  it('Raster (Typed Array) und Map liefern dasselbe', () => {
    const x = [10.2, 10.9, 10.5, 10.5, 40, -3, 5000];
    const y = [100, 101, 101, 100, 100, -20, 9000];
    const side = [1, 1, 1, 2, 1, 1, 2];
    const n = [5, 9, 7, 1, 2, 3, 4];
    expect(decimateByCell(7, x, y, side, n, 2, 6)).toEqual([1, 3, 4, 5, 6]);
  });
});

describe('BigTradesLayer: Review 2', () => {
  afterEach(() => vi.restoreAllMocks());

  it('source_rows_exceeded: Abschnitt an suggestTo geteilt, Rest geladen', async () => {
    const mid = C0 + 25_000_000 - ((C0 + 25_000_000) % 60_000);
    const { layer, calls } = setup((u) => {
      const from = Number(u.searchParams.get('from'));
      const to = Number(u.searchParams.get('to'));
      if (from === C0 && to === C0 + SPAN_MS)
        return json({ error: 'zu groß', reason: 'source_rows_exceeded', suggestTo: mid }, 422);
      return body(u, ORDERS);
    });
    layer.frame();
    await flush(12);
    const c = calls.filter(
      (u) =>
        Number(u.searchParams.get('from')) >= C0 &&
        Number(u.searchParams.get('to')) <= C0 + SPAN_MS,
    );
    expect(
      c.map((u) => [Number(u.searchParams.get('from')), Number(u.searchParams.get('to'))]),
    ).toEqual([
      [C0, C0 + SPAN_MS],
      [C0, mid],
      [mid, C0 + SPAN_MS],
    ]);
    const ro = layer.readout();
    expect(ro).toMatchObject({ loading: 0, error: '', markers: 3 });
    expect(ro.coverage).toMatchObject({ failedDays: 0 });
    expect(layer.counters.splits).toBe(1);
  });

  it('source_rows_exceeded ohne brauchbares suggestTo: rot, keine Schleife', async () => {
    const { layer, calls } = setup(() =>
      json({ error: 'zu groß', reason: 'source_rows_exceeded', suggestTo: null }, 422),
    );
    layer.frame();
    await flush();
    layer.frame();
    await flush();
    expect(calls).toHaveLength(3);
    expect(layer.readout().coverage).toMatchObject({ failedDays: 1 });
  });

  it('Teilung begrenzt: höchstens 16 Teilstücke je Abschnitt', async () => {
    const { layer } = setup((u) => {
      const from = Number(u.searchParams.get('from'));
      const to = Number(u.searchParams.get('to'));
      const half = from + Math.floor((to - from) / 120_000) * 60_000;
      return json({ error: 'zu groß', reason: 'source_rows_exceeded', suggestTo: half }, 422);
    });
    layer.frame();
    await flush(200);
    const plans = (layer as unknown as { plans: Map<string, number[]> }).plans;
    for (const b of plans.values()) expect(b.length - 1).toBeLessThanOrEqual(16);
    expect(layer.readout().coverage!.failedDays).toBeGreaterThan(0);
  });

  it('nicht finale Antwort: nach der Frist erneut, am Browser-Cache vorbei', async () => {
    let now = 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const inits: (RequestCache | undefined)[] = [];
    const calls: string[] = [];
    const layer = new BigTradesLayer(
      {
        chart: {} as never,
        apiBase: '',
        sym: () => SYM,
        tf: () => '1m',
        tfSec: () => 60,
        items: () => [],
        visibleTimeRange: () => [(C0 + 20_000_000) / 1000, (C0 + 30_000_000) / 1000],
        priceToY: () => 0,
        footprintActive: () => false,
        busy: () => false,
        gestureActive: () => false,
      },
      (url, init) => {
        calls.push(url);
        inits.push(init.cache);
        const u = new URL(url, 'http://x');
        return Promise.resolve(
          body(u, ORDERS, () => 'ok', 0, { final: u.searchParams.get('from') !== String(C0) }),
        );
      },
    );
    layer.enabled = true;
    layer.minUsdt = 500_000;
    layer.frame();
    await flush();
    expect(calls).toHaveLength(3);
    now += 30_000;
    layer.frame();
    await flush();
    expect(calls).toHaveLength(3);
    now += 31_000;
    layer.frame();
    await flush();
    expect(calls).toHaveLength(4); // nur der nicht finale Abschnitt C
    expect(calls[3]).toContain(`from=${C0}&`);
    expect(inits[3]).toBe('reload');
  });

  it('LRU: höchstens 64 Antworten im Cache', async () => {
    let c = C;
    const { layer } = setup((u) => body(u, []), {
      visibleTimeRange: () => [(c * SPAN_MS + 1000) / 1000, (c * SPAN_MS + 2000) / 1000],
    });
    for (let i = 0; i < 80; i++) {
      c = C - 40 + i;
      layer.frame();
      await flush(3);
    }
    const cache = (layer as unknown as { cache: Map<string, unknown> }).cache;
    expect(cache.size).toBe(64);
    // der zuletzt benutzte bleibt
    expect([...cache.keys()].some((k) => k.includes(`|${c}|`))).toBe(true);
  });

  it('tf-Wechsel während einer Anfrage: alte Antwort zeichnet nichts im neuen tf', async () => {
    let tf = '1m';
    const releases: (() => void)[] = [];
    const host: BigTradesHost = {
      chart: {} as never,
      apiBase: '',
      sym: () => SYM,
      tf: () => tf,
      tfSec: () => (tf === '1m' ? 60 : 300),
      items: () => [],
      visibleTimeRange: () => [(C0 + 20_000_000) / 1000, (C0 + 30_000_000) / 1000],
      priceToY: () => 0,
      footprintActive: () => false,
      busy: () => false,
      gestureActive: () => false,
    };
    const layer = new BigTradesLayer(host, (url) => {
      return new Promise((r) => releases.push(() => r(body(new URL(url, 'http://x'), ORDERS))));
    });
    layer.enabled = true;
    layer.minUsdt = 500_000;
    layer.frame();
    tf = '5m';
    for (const f of releases.splice(0)) f();
    await flush();
    const ro = layer.readout();
    expect(ro.markers).toBe(0);
    expect(ro.loading).toBe(1);
    expect(ro.error).toBe('');
  });

  it('below_floor nach Symbolwechsel: Fehler mit Untergrenze, keine Wiederholung', async () => {
    const ETH: SymbolInfo = {
      ...SYM,
      name: 'ETHUSDT',
      bigTrades: { floorN: 250_000_000_000, minUsdt: 250_000, notionalDecimals: 6 },
    };
    let sym = SYM;
    const calls: string[] = [];
    const releases: (() => void)[] = [];
    const layer = new BigTradesLayer(
      {
        chart: {} as never,
        apiBase: '',
        sym: () => sym,
        tf: () => '1m',
        tfSec: () => 60,
        items: () => [],
        visibleTimeRange: () => [(C0 + 20_000_000) / 1000, (C0 + 30_000_000) / 1000],
        priceToY: () => 0,
        footprintActive: () => false,
        busy: () => false,
        gestureActive: () => false,
      },
      (url) => {
        calls.push(url);
        if (url.includes('BTCUSDT'))
          return new Promise((r) => releases.push(() => r(body(new URL(url, 'http://x'), ORDERS))));
        return Promise.resolve(
          json({ error: 'unter', reason: 'below_floor', minUsdt: 300_000, floorN: 3e11 }, 422),
        );
      },
    );
    layer.enabled = true;
    layer.minUsdt = 500_000;
    layer.frame();
    sym = ETH;
    layer.resetForSymbol();
    layer.minUsdt = 250_000;
    layer.changed();
    for (const f of releases.splice(0)) f(); // späte BTC-Antworten
    await flush();
    layer.frame();
    await flush();
    const eth = calls.filter((u) => u.includes('ETHUSDT'));
    expect(eth).toHaveLength(3);
    const ro = layer.readout();
    expect(ro.error).toContain('Untergrenze laut Server 300 k $');
    expect(ro.markers).toBe(0);
    expect(ro.coverage).toMatchObject({ failedDays: 1 });
  });

  it('Netzwerkfehler: rotes Band, Meldung, Wiederholung statt „lädt" für immer', async () => {
    const { layer } = setup(() => Promise.reject(new TypeError('Failed to fetch')) as never);
    layer.frame();
    await flush();
    const ro = layer.readout();
    expect(ro.loading).toBe(0);
    expect(ro.coverage).toMatchObject({ failedDays: 1 });
    expect(ro.error).toContain('keine Verbindung');
    layer.destroy();
  });
});

// ---------------------------------------------------------------- Review 3: Live-Rand, Breite, Zellen

describe('Live-Rand: neutral nur kurz, danach Warnung', () => {
  const T = Date.UTC(2026, 10, 25);
  const pend = (from: number, to: number) => ({
    from,
    to,
    kind: 'pending' as const,
    reasons: [],
    floorN: null,
  });
  it('Toleranz 5 min gegen die neuesten Bars (dataTo)', () => {
    expect(PENDING_TOLERANCE_MS).toBe(300_000);
    const live = T + 18 * 3_600_000;
    // Recorder hängt 2 min hinter den Bars: neutral
    expect(markStalePending([pend(live, T + D)], live + 120_000)[0]!.kind).toBe('pending');
    // genau 5 min: noch neutral; 5 min + 1 ms: Warnung (ganze Spanne ab live_until)
    expect(markStalePending([pend(live, T + D)], live + 300_000)[0]!.kind).toBe('pending');
    const st = markStalePending([pend(live, T + D)], live + 300_001)[0]!;
    expect(st).toMatchObject({ kind: 'stale', from: live, to: T + D });
  });
  it('Warnung in Legende, Fläche und Hover', () => {
    const live = T + 18 * 3_600_000;
    const bands = markStalePending([pend(live, T + 21 * 3_600_000)], T + 21 * 3_600_000);
    const sum = coverageSummary(bands, T, T + 21 * 3_600_000);
    expect(sum.staleSince).toBe(live);
    expect(coverageNote(sum, 5, (ms) => new Date(ms).toISOString().slice(11, 16))).toBe(
      'Big Trades seit 18:00 nicht aktualisiert',
    );
    expect(barSegments(bands, 3_600_000, 0, T + D).full.map((b) => b.kind)).toEqual(['stale']);
    expect(barCoverageText(bands, live, 3_600_000, 5)).toBe(
      'Big Trades: im ganzen Bar nicht aktualisiert (Aufzeichnung steht)',
    );
  });
  it('Schicht: stehende Aufzeichnung → Legendenhinweis; kurzer Verzug → nichts', async () => {
    for (const [lagMin, expectStale] of [
      [2, false],
      [90, true],
    ] as const) {
      const dataTo = C0 + 40_020_000;
      const liveUntil = dataTo - lagMin * 60_000;
      const { layer } = setup(
        (u) =>
          body(u, [], () => 'ok', 0, {
            coverage: (from, to) => {
              const m = Math.min(to, Math.max(from, liveUntil));
              return [
                { from, to: m, status: 'ok' as const, reason: null, floorN: 5e10, final: false },
                {
                  from: m,
                  to,
                  status: 'none' as const,
                  reason: 'pending' as const,
                  floorN: null,
                  final: false,
                },
              ].filter((c) => c.to > c.from);
            },
          }),
        {
          sym: () => ({ ...SYM, dataTo }),
          visibleTimeRange: () => [(C0 + 20_000_000) / 1000, (dataTo - 60_000) / 1000],
        },
      );
      layer.frame();
      await flush();
      const note = layer.readout().coverageNote;
      if (expectStale) expect(note).toMatch(/^Big Trades seit .* nicht aktualisiert$/);
      else expect(note).toBe('');
    }
  });
});

describe('Bandgeometrie auf der Index-Achse', () => {
  const H = 3_600;
  // Bars 0, 1, 2, dann 5 Stunden ohne Bars, dann 8, 9 (Stunden ab T0s)
  const T0s = 1_795_000_000 - (1_795_000_000 % H);
  const items = [0, 1, 2, 8, 9].map((h) => ({ time: T0s + h * H }) as BarItem);
  const band = (fromH: number, toH: number, kind: 'none' | 'stale' = 'none') => ({
    from: (T0s + fromH * H) * 1000,
    to: (T0s + toH * H) * 1000,
    kind,
    reasons: ['gap'],
    floorN: null,
  });
  it('Fläche über Bars: an Bar-Grenzen', () => {
    const g = bandGeometry(items, [band(1, 3)], [], 100, 10, H, 1000);
    expect(g.full.map((f) => [f.a, f.z])).toEqual([[105, 125]]);
    expect(g.marks).toEqual([]);
  });
  it('Spanne nur über Zeit ohne Bars: Grenzmarke statt nichts', () => {
    const g = bandGeometry(items, [band(4, 6)], [], 100, 10, H, 1000);
    expect(g.full).toEqual([]);
    expect(g.marks).toEqual([{ x: 125, kind: 'none' }]);
  });
  it('ein Bar bei starkem Herauszoomen: Mindestbreite', () => {
    const g = bandGeometry(items, [band(1, 2)], [], 0, 0.2, H, 1000);
    expect(g.full[0]!.z - g.full[0]!.a).toBe(MIN_BAND_PX);
  });
  it('Lücken-Markierung: Bar vorhanden → Strich unter dem Bar; Bar fehlt → Grenzmarke', () => {
    const g = bandGeometry(
      items,
      [],
      [
        { bar: (T0s + 2 * H) * 1000, kind: 'none', ms: 60_000 },
        { bar: (T0s + 5 * H) * 1000, kind: 'none', ms: 60_000 },
      ],
      100,
      10,
      H,
      1000,
    );
    expect(g.ticks).toEqual([{ a: 115, z: 125, kind: 'none' }]);
    expect(g.marks).toEqual([{ x: 125, kind: 'none' }]);
  });
  it('außerhalb der Pane: nichts', () => {
    expect(bandGeometry(items, [band(1, 3)], [], -500, 10, H, 1000).full).toEqual([]);
  });
});

describe('Ausdünnung nach dem Pane-Filter', () => {
  it('Marker außerhalb vergröbern die Zellen nicht', async () => {
    const orders: [number, number][] = [];
    for (let i = 0; i < 20_000; i++) orders.push([C0 + i * 3000, 600_000 + (i % 7) * 100_000]);
    const items = Array.from({ length: 1000 }, (_, i) => ({ time: C0 / 1000 + i * 60 }) as BarItem);
    const { layer } = setup((u) => body(u, orders), {
      chart: {
        // nur die letzten ≈ 100 Bars liegen in der 1 600 px breiten Pane
        timeScale: () => ({ logicalToCoordinate: (l: number) => (l - 900) * 1.6 }),
      } as never,
      items: () => items,
      visibleTimeRange: () => [C0 / 1000, (C0 + SPAN_MS) / 1000 - 60],
      priceToY: (p) => 400 + (p - 97_000) * 2,
    });
    layer.frame();
    await flush();
    const noop = () => {};
    const ctx = new Proxy(
      { measureText: () => ({ width: 20 }) },
      {
        get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : noop),
        set: () => true,
      },
    );
    const scope = {
      context: ctx,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
      bitmapSize: { width: 1600, height: 800 },
      mediaSize: { width: 1600, height: 800 },
    };
    for (const v of layer.paneViews())
      v.renderer()!.draw(
        { useBitmapCoordinateSpace: (f: (s: unknown) => void) => f(scope) } as never,
        undefined as never,
      );
    const ro = layer.readout();
    expect(ro.markers).toBe(20_000);
    expect(ro).toMatchObject({ cellW: 2, cellH: 6 });
    expect(ro.drawn).toBeLessThan(3000);
  });
});

describe('BigTradesLayer: Review 3 (optional)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('Teilung gilt für jede Schwelle', async () => {
    const mid = C0 + 24_000_000;
    const { layer, calls } = setup((u) => {
      const from = Number(u.searchParams.get('from'));
      const to = Number(u.searchParams.get('to'));
      if (from === C0 && to === C0 + SPAN_MS)
        return json({ error: 'zu groß', reason: 'source_rows_exceeded', suggestTo: mid }, 422);
      return body(u, ORDERS, () => 'ok', 1); // ausgedünnt: kein Filtern aus dem Cache
    });
    layer.frame();
    await flush(12);
    layer.minUsdt = 1_000_000;
    layer.changed();
    await flush(12);
    const at1m = calls.filter(
      (u) =>
        u.searchParams.get('min') === '1000000' &&
        Number(u.searchParams.get('from')) >= C0 &&
        Number(u.searchParams.get('to')) <= C0 + SPAN_MS,
    );
    expect(
      at1m.map((u) => [Number(u.searchParams.get('from')), Number(u.searchParams.get('to'))]),
    ).toEqual([
      [C0, mid],
      [mid, C0 + SPAN_MS],
    ]);
  });

  it('Zustand veraltet mit der Antwort, nicht erst beim nächsten Versionswechsel', async () => {
    let now = 5_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { layer, calls } = setup((u) => body(u, ORDERS)); // nicht final
    layer.frame();
    await flush();
    layer.minUsdt = 1_000_000;
    layer.changed(); // aus dem Cache gefiltert
    await flush();
    expect(calls).toHaveLength(3);
    expect(layer.readout().loading).toBe(0);
    now += 61_000;
    expect(layer.readout().loading).toBe(1); // ohne frame(): Filtergrundlage veraltet
  });
});
