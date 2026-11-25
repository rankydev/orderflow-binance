// P4 (KONZEPT §6.1/§6.2): Imbalance, Stacked, Delta-POC, Value Area je Bar, Stats-Grid, URL-Zustand –
// gegen von Hand gerechnete Mini-Bars.
import { describe, expect, it } from 'vitest';
import {
  barValueArea,
  deltaPocRow,
  dominates,
  IMB_BUY,
  IMB_BUY_STACK,
  IMB_SELL,
  IMB_SELL_STACK,
  IMBALANCE_DEFAULTS,
  imbalanceFlags,
  stackZones,
  zoneTouch,
  type ImbalanceOptions,
} from '../src/lib/footprint-marks.ts';
import {
  FOOTPRINT_DEFAULTS,
  footprintParamsQuery,
  parseFootprintParams,
} from '../src/lib/footprint-options.ts';
import {
  computeStats,
  CVD_UNALIGNED_NOTE,
  cvdAligned,
  formatStat,
  StatsContext,
  highLowRatio,
  meanSd,
  shadeIntensity,
  statColor,
  STATS_STEPS,
} from '../src/lib/stats-grid.ts';
import type { BarItem } from '../src/lib/types.ts';

// Mini-Bar: Zeilen 10…15 (Low-/High-Zeile), Zeile 13 ohne Trades
//   Zeile  10 11 12 13 14 15
//   buy     5  9 12  –  4  0
//   sell    1  3  2  –  6  8
const row = Int32Array.of(10, 11, 12, 14, 15);
const buy = Float64Array.of(5, 9, 12, 4, 0);
const sell = Float64Array.of(1, 3, 2, 6, 8);
const flags = (o: Partial<ImbalanceOptions>) => {
  const out = new Uint8Array(5);
  imbalanceFlags(row, buy, sell, 0, 5, 10, 15, { ...IMBALANCE_DEFAULTS, ...o }, out);
  return [...out];
};

describe('Imbalance (ganzzahlig, §6.1)', () => {
  it('Schwelle exakt: 100·x ≥ ratio·c und x − c ≥ minDiff', () => {
    const o = { ...IMBALANCE_DEFAULTS };
    expect(dominates(9, 3, o)).toBe(true); // 900 ≥ 900
    expect(dominates(8, 3, o)).toBe(false);
    expect(dominates(9, 3, { ...o, minDiff: 7 })).toBe(false); // 6 < 7
    expect(dominates(5, 0, o)).toBe(false); // Gegenseite 0 nur mit includeZero
    expect(dominates(5, null, { ...o, includeZero: true })).toBe(true);
    expect(dominates(0, 0, { ...o, includeZero: true })).toBe(false);
    expect(dominates(5, 0, { ...o, includeZero: true, minDiff: 6 })).toBe(false);
  });

  it('diagonal (Standard): Buy in 11 und 12; Rand, leere Zeile 13 und Gegenseite 0 zählen nicht', () => {
    // 10: unterste Zeile, s(9) fehlt · 11: 9 vs s10 = 1 · 12: 12 vs s11 = 3 · 14: 4 vs s13 = 0 (leer)
    // Sell: 12: 2 vs b13 = 0 · 14: 6 vs b15 = 0 · 15: oberste Zeile
    expect(flags({})).toEqual([0, IMB_BUY, IMB_BUY, 0, 0]);
  });

  it('includeZero: Randzeilen und Gegenseite 0 zählen; Stacked Buy 10–12, Sell 14–15 zu kurz', () => {
    const B = IMB_BUY | IMB_BUY_STACK;
    expect(flags({ includeZero: true })).toEqual([
      B,
      B,
      B | IMB_SELL,
      IMB_BUY | IMB_SELL,
      IMB_SELL,
    ]);
    // Stacked ab 2: Sell 14–15 benachbart → Stack; Sell 12 allein (13 leer bricht die Folge)
    const f2 = flags({ includeZero: true, stack: 2 });
    expect(f2[2]! & IMB_SELL_STACK).toBe(0);
    expect(f2[3]! & IMB_SELL_STACK).toBe(IMB_SELL_STACK);
    expect(f2[4]! & IMB_SELL_STACK).toBe(IMB_SELL_STACK);
  });

  it('minDiff: 11 (Differenz 8) fällt bei 9 heraus, 12 (Differenz 9) bleibt', () => {
    expect(flags({ minDiff: 9 })).toEqual([0, 0, IMB_BUY, 0, 0]);
  });

  it('horizontal: b_i gegen s_i; Buy 10–12 → Stacked (3)', () => {
    const B = IMB_BUY | IMB_BUY_STACK;
    expect(flags({ horizontal: true })).toEqual([B, B, B, 0, 0]);
  });

  it('Stacked-Zonen und Projektion', () => {
    const f = Uint8Array.from(flags({ horizontal: true }));
    expect(stackZones(row, f, 0, 5)).toEqual([[10, 12, 0]]);
    const bars = [
      { h: 99, l: 90 },
      { h: 140, l: 130 }, // Zone [100, 130) bei w = 10: berührt nicht (l = 130 = Oberkante)
      { h: 125, l: 101 },
    ];
    expect(zoneTouch(bars, 0, 3, 100, 130)).toBe(2);
    expect(zoneTouch(bars, 0, 2, 100, 130)).toBe(-1);
  });
});

describe('Delta-POC und Value Area je Bar', () => {
  it('Delta-POC: größtes |Delta| (Zeile 12, +10)', () => {
    expect(deltaPocRow(row, buy, sell, 0, 5, 10, 15)).toBe(12);
  });
  it('Gleichstand → näher an der Mitte, dann die tiefere; alles 0 → −1', () => {
    // Zeilen 0…3, |Delta| 3, 0, 0, 3: beide gleich weit von der Mitte 1,5 → die tiefere (0)
    const r = Int32Array.of(0, 3);
    expect(deltaPocRow(r, Float64Array.of(4, 0), Float64Array.of(1, 3), 0, 2, 0, 3)).toBe(0);
    // Zeilen 0…4, |Delta| 3 in 0 und 2 → 2 liegt in der Mitte
    const r2 = Int32Array.of(0, 2, 4);
    expect(deltaPocRow(r2, Float64Array.of(3, 3, 1), Float64Array.of(0, 0, 1), 0, 3, 0, 4)).toBe(2);
    expect(deltaPocRow(r, Float64Array.of(1, 2), Float64Array.of(1, 2), 0, 2, 0, 3)).toBe(-1);
  });
  it('VA 70 % mit dem Paarverfahren des Kerns: [10, 14]', () => {
    // Volumen 6, 12, 14, 0, 10, 8 (Σ 50), POC 12; Paar unten (12 + 6 = 18) > oben (0 + 10) → 10…12
    // (32); dann nur oben: 0 + 10 → 42 ≥ 35
    expect(barValueArea(row, buy, sell, 0, 5, 10, 15, 12, 70)).toEqual([10, 14]);
    expect(barValueArea(row, buy, sell, 0, 5, 10, 15, 12, 20)).toEqual([12, 12]);
  });
});

const item = (t: number, b: number, s: number, ba = 0, sa = 0, x?: Record<string, number>) =>
  ({ time: t, t, b, s, ba, sa, v: b + s, ...(x ? { x } : {}) }) as unknown as BarItem;

describe('Stats-Grid (§6.2)', () => {
  const H = 3600;
  it('Volume, Delta, Delta %, aggTrades, Vol/s (letzter Bar läuft noch)', () => {
    const items = [item(0, 30, 10, 5, 2), item(H, 0, 0, 0, 0), item(2 * H, 6, 2, 1, 3)];
    const c = computeStats(items, {
      offsetH: 0,
      tfSec: H,
      dataTo: (2 * H + 1800) * 1000,
      windowStartSec: 0,
    });
    expect([...c.vol!]).toEqual([40, 0, 8]);
    expect([...c.delta!]).toEqual([20, 0, 4]);
    expect(c.deltaPct![0]).toBe(50);
    expect(Number.isNaN(c.deltaPct![1])).toBe(true);
    expect([...c.aggN!]).toEqual([7, 0, 4]);
    expect([...c.aggDelta!]).toEqual([3, 0, -2]);
    expect(c.volSec![0]).toBeCloseTo(40 / H);
    expect(c.volSec![2]).toBeCloseTo(8 / 1800); // 30 min verstrichen
    expect(c.trades).toBeUndefined(); // API-Spalte fehlt → keine Werte, nie geschätzt
  });

  it('CVD setzt an der Tagesgrenze (UTC + offsetH) zurück; unbekannt, solange der Tag vor dem Fenster begann', () => {
    const D = 86_400;
    // offsetH 2: Tage beginnen 02:00 UTC. Fenster ab 00:00 → erster Tag (ab −22:00) unvollständig
    const items = [item(0, 5, 1), item(H, 2, 4), item(2 * H, 3, 0), item(3 * H, 1, 2)];
    const c = computeStats(items, { offsetH: 2, tfSec: H, dataTo: D * 1000, windowStartSec: 0 });
    expect(Number.isNaN(c.cvd![0])).toBe(true);
    expect(Number.isNaN(c.cvd![1])).toBe(true);
    expect(c.cvd![2]).toBe(3); // 02:00: neuer Tag
    expect(c.cvd![3]).toBe(2);
    const c0 = computeStats(items, { offsetH: 0, tfSec: H, dataTo: D * 1000, windowStartSec: 0 });
    expect([...c0.cvd!]).toEqual([4, 2, 5, 4]);
  });

  it('Zusatzspalten der API werden übernommen, fehlende Bars als „–"', () => {
    const items = [item(0, 1, 1, 0, 0, { 'x.trades': 17 }), item(H, 1, 1)];
    const c = computeStats(items, { offsetH: 0, tfSec: H, dataTo: 1e12, windowStartSec: 0 });
    expect(c.trades![0]).toBe(17);
    expect(Number.isNaN(c.trades![1])).toBe(true);
  });

  it('High/Low Ratio aus den Leveln (≥ 3 Zeilen, Nenner > 0)', () => {
    // oberste Zeile 15: b = 0 → High „–"; Low = s(11) / s(10) = 3 / 1
    const [hi, lo] = highLowRatio(row, buy, sell, 0, 5, 10, 15);
    expect(Number.isNaN(hi)).toBe(true);
    expect(lo).toBe(3);
    // oberste Zeile mit Käufen: b(14) / b(15)
    const b2 = Float64Array.of(5, 9, 12, 4, 2);
    expect(highLowRatio(row, b2, sell, 0, 5, 10, 15)[0]).toBe(2);
    // nur 2 Zeilen → „–"
    expect(highLowRatio(Int32Array.of(1, 2), b2, sell, 0, 2, 1, 2).every(Number.isNaN)).toBe(true);
  });

  it('K-Formatierung und Einheiten', () => {
    expect(formatStat(1_234_567, 'qty', 3)).toBe('1.23K'); // 1 234,567 BTC
    expect(formatStat(12_345_678, 'qty', 3)).toBe('12.3K');
    expect(formatStat(1.5e9, 'qty', 3)).toBe('1.50M');
    expect(formatStat(-5000, 'qty', 3)).toBe('-5.00');
    expect(formatStat(45_600, 'qty', 3)).toBe('45.6');
    expect(formatStat(1234, 'count', 3)).toBe('1.23K');
    expect(formatStat(987, 'count', 3)).toBe('987');
    expect(formatStat(12.345, 'pct', 3)).toBe('12.3%');
    expect(formatStat(2.5, 'ratio', 3)).toBe('2.50');
    expect(formatStat(Number.NaN, 'qty', 3)).toBe('–');
  });

  it('Schattierung: z über die sichtbaren Bars, min(1, |z|/3); Vorzeichen bzw. nur über dem Mittel', () => {
    const v = Float64Array.of(1, 2, 3, 4, Number.NaN);
    const [m, sd] = meanSd(v, 0, 5);
    expect(m).toBe(2.5);
    expect(sd).toBeCloseTo(Math.sqrt(1.25));
    expect(shadeIntensity(2.5, m, sd)).toBe(0);
    expect(shadeIntensity(100, m, sd)).toBe(1);
    expect(statColor(-50, true, 0, 10)).toBe(STATS_STEPS + STATS_STEPS - 1); // negativ, volle Stufe
    expect(statColor(50, false, 0, 10)).toBe(2 * STATS_STEPS + STATS_STEPS - 1);
    expect(statColor(-50, false, 0, 10)).toBe(-1); // ohne Vorzeichen: unter dem Mittel keine Füllung
  });
});

describe('URL-Zustand Footprint/Stats', () => {
  it('Standard ruhig: Delta, Box, POC an, Imbalance aus, Stats aus; leere Query', () => {
    const o = parseFootprintParams(new URLSearchParams(''));
    expect(o).toEqual(FOOTPRINT_DEFAULTS);
    expect(o).toMatchObject({
      type: 'delta',
      mode: 'box',
      poc: true,
      imbalance: false,
      stats: false,
    });
    expect(footprintParamsQuery(o)).toBe('');
  });
  it('liest/schreibt alle Felder; Ungültiges → Standard', () => {
    const q =
      'type=deltavol&fm=profile&poc=0&dpoc=1&bva=1&imb=1&imbr=250&imbd=500&imbz=1&imbh=1&imbs=4&sg=1&sgr=delta,cvd,trades';
    const o = parseFootprintParams(new URLSearchParams(q));
    expect(o).toEqual({
      type: 'deltavol',
      mode: 'profile',
      poc: false,
      deltaPoc: true,
      barVa: true,
      imbalance: true,
      imb: { ratio: 250, minDiff: 500, includeZero: true, horizontal: true, stack: 4 },
      stats: true,
      statsRows: ['delta', 'cvd', 'trades'],
    });
    expect(footprintParamsQuery(o)).toBe(`&${q.replace('type=deltavol&', '')}`);
    const bad = parseFootprintParams(new URLSearchParams('type=x&imbr=50&imbs=99&sgr=nope'));
    expect(bad).toEqual(FOOTPRINT_DEFAULTS);
  });
});

describe('Tages-CVD: Grenzen und Lücken (F-1, F-2, H-1)', () => {
  const H = 3600;
  it('F-1: Tagesgrenze nicht auf der Bar-Grenze → kein CVD (Hinweis), ausgerichtet → CVD', () => {
    expect(cvdAligned(1, 4 * H)).toBe(false); // 4h, Tag ab 01:00
    expect(cvdAligned(0, 86_400)).toBe(true);
    expect(cvdAligned(2, 86_400)).toBe(false); // 1d mit Offset
    expect(cvdAligned(-3, H)).toBe(true);
    expect(cvdAligned(-2, 4 * H)).toBe(false);
    expect(cvdAligned(4, 4 * H)).toBe(true);
    // Beispiel der Prüfung: 4h, offsetH +1, Bars 00/04/08 Uhr mit Delta 1/10/100
    const items = [item(0, 1, 0), item(4 * H, 10, 0), item(8 * H, 100, 0)];
    const c = computeStats(items, { offsetH: 1, tfSec: 4 * H, dataTo: 1e12, windowStartSec: 0 });
    expect(c.cvd).toBeUndefined();
    expect(CVD_UNALIGNED_NOTE).toContain('Bar-Grenze');
    const c4 = computeStats(items, {
      offsetH: 4,
      tfSec: 4 * H,
      dataTo: 1e12,
      windowStartSec: -86_400,
    });
    // Tag ab 04:00: 00:00 gehört zum Vortag (dessen Beginn im Fenster liegt), dann Rücksetzen
    expect([...c4.cvd!]).toEqual([1, 10, 110]);
  });

  it('F-2: ab einer Lücke im Tag bis zur nächsten Tagesgrenze „–"; Lücke über den Tagesbeginn → ganzer Tag', () => {
    const D = 86_400;
    const items = [
      item(0, 1, 0),
      item(H, 2, 0),
      item(5 * H, 3, 0),
      item(D, 4, 0),
      item(D + H, 5, 0),
    ];
    // Lücke [2h, 5h) im ersten Tag
    const c = computeStats(items, {
      offsetH: 0,
      tfSec: H,
      dataTo: 1e12,
      windowStartSec: 0,
      gaps: [[2 * H, 5 * H]],
    });
    expect(c.cvd![0]).toBe(1);
    expect(c.cvd![1]).toBe(3);
    expect(Number.isNaN(c.cvd![2])).toBe(true); // nach der Lücke
    expect([c.cvd![3], c.cvd![4]]).toEqual([4, 9]); // nächster Tag wieder bekannt
    // Lücke über den Beginn des zweiten Tages [D − 1h, D + 1h) → der ganze zweite Tag unbekannt
    const items2 = [item(0, 1, 0), item(H, 2, 0), item(D + H, 5, 0), item(D + 2 * H, 1, 0)];
    const c2 = computeStats(items2, {
      offsetH: 0,
      tfSec: H,
      dataTo: 1e12,
      windowStartSec: 0,
      gaps: [[D - H, D + H]],
    });
    expect([c2.cvd![0], c2.cvd![1]]).toEqual([1, 3]); // erster Tag vor der Lücke
    expect(Number.isNaN(c2.cvd![2]) && Number.isNaN(c2.cvd![3])).toBe(true);
  });

  it('H-1: Zurücksetzen beim Serienwechsel verwirft Werte, Hinweise und Zeilengröße', () => {
    const sc = new StatsContext();
    sc.cols = { vol: Float64Array.of(1) };
    sc.notes = { cvd: CVD_UNALIGNED_NOTE };
    sc.rowSize = '20 USDT';
    sc.reset();
    expect(sc.cols).toEqual({});
    expect(sc.notes).toEqual({});
    expect(sc.rowSize).toBe('');
  });
});
