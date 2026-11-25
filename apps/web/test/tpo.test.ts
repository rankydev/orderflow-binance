// TPO (KONZEPT §6.5, P6): reine Funktionen gegen von Hand gerechnete Tage.
import { describe, expect, it } from 'vitest';
import {
  blockOf,
  cellRect,
  chooseSourceTf,
  computeTpo,
  letterCycle,
  letterOf,
  parseTpoParams,
  rowLetters,
  TPO_DEFAULTS,
  tpoColumns,
  tpoDayOf,
  tpoDayStart,
  tpoParamsQuery,
  tpoRowSize,
  type TpoBars,
} from '../src/lib/tpo/model.ts';

const D = 86_400_000;
const T0 = Date.UTC(2026, 10, 20);

describe('Tage, Blöcke, Buchstaben', () => {
  it('Tag und Block mit offsetH', () => {
    const d = T0 / D;
    expect(tpoDayStart(d, 2)).toBe(T0 + 2 * 3_600_000);
    expect(tpoDayOf(T0 + 3_600_000, 2)).toBe(d - 1); // 01:00 gehört bei Tag ab 02:00 zum Vortag
    expect(tpoDayOf(T0 + 2 * 3_600_000, 2)).toBe(d);
    const start = tpoDayStart(d, 2);
    expect(blockOf(start / 1000, start, 30)).toBe(0);
    expect(blockOf(start / 1000 + 29 * 60 + 59, start, 30)).toBe(0);
    expect(blockOf(start / 1000 + 30 * 60, start, 30)).toBe(1);
    expect(blockOf(start / 1000 + 23.5 * 3600, start, 30)).toBe(47);
  });

  it('Buchstaben A–Z, a–z, ab Block 52 von vorn (5-min-Blöcke: 288 je Tag)', () => {
    expect(letterOf(0)).toBe('A');
    expect(letterOf(25)).toBe('Z');
    expect(letterOf(26)).toBe('a');
    expect(letterOf(51)).toBe('z');
    expect(letterOf(52)).toBe('A');
    expect(letterOf(287)).toBe('b'); // 287 mod 52 = 27
    expect([letterCycle(51), letterCycle(52), letterCycle(287)]).toEqual([0, 1, 5]);
  });
});

describe('Quell-Zeitrahmen', () => {
  const all = [
    ['1m', 60],
    ['3m', 180],
    ['5m', 300],
    ['15m', 900],
    ['30m', 1800],
    ['1h', 3600],
    ['2h', 7200],
    ['4h', 14_400],
    ['1d', 86_400],
  ].map(([tf, sec]) => ({ tf: tf as string, sec: sec as number }));
  it('gröbster, der Block, IB und Tagesgrenze teilt', () => {
    expect(chooseSourceTf(all, 30, 60, 0)).toBe('30m');
    expect(chooseSourceTf(all, 5, 60, 0)).toBe('5m');
    expect(chooseSourceTf(all, 60, 90, 0)).toBe('30m'); // IB 90 min schließt 1h aus
    expect(chooseSourceTf(all, 240, 60, 0)).toBe('1h'); // IB 60 min schließt 2h/4h aus
    expect(chooseSourceTf(all, 240, 240, 0)).toBe('4h');
    expect(chooseSourceTf(all, 240, 240, 1)).toBe('1h'); // Tag ab 01:00
    expect(chooseSourceTf(all, 240, 240, -3)).toBe('1h');
    // Fixture: nur 1m/5m/15m/1h angeboten → 15m für 30-min-Blöcke
    expect(
      chooseSourceTf(
        all.filter((x) => ['1m', '5m', '15m', '1h'].includes(x.tf)),
        30,
        60,
        0,
      ),
    ).toBe('15m');
    expect(chooseSourceTf([], 30, 60, 0)).toBe('1m');
  });
});

// Hand gerechneter Tag (30-min-Blöcke, w = 10): Block 0: 100…129 (Zeilen 10–12), Block 1: 110…139 (11–13),
// Block 2: 120 (12), Block 3: keine Bars (Loch), Block 4: 100…109 (10)
function bars(): TpoBars {
  const t = (m: number) => T0 / 1000 + m * 60;
  return {
    time: [t(0), t(30), t(60), t(120)],
    open: [105, 115, 120, 101],
    high: [129, 139, 120, 109],
    low: [100, 110, 120, 100],
    close: [128, 121, 120, 107],
  };
}

describe('TPO-Tag', () => {
  const day = computeTpo(
    bars(),
    T0,
    { blockMin: 30, ibMin: 60, vaPct: 70 },
    10,
    T0 + 4 * 3_600_000,
  );
  it('Zeilen je Block, Zählung, POC, Value Area, über/unter POC', () => {
    expect([...day.blockLo.slice(0, 5)]).toEqual([10, 11, 12, -1, 10]);
    expect([...day.blockHi.slice(0, 5)]).toEqual([12, 13, 12, -1, 10]);
    expect(day.rowLo).toBe(10);
    expect([...day.counts]).toEqual([2, 2, 3, 1]);
    expect(day.total).toBe(8);
    expect(day.poc).toBe(12);
    // 70 % von 8 → ≥ 5,6: Start 3; unten 2 + 2 = 4 > oben 1 → 10…12 (7)
    expect([day.val, day.vah]).toEqual([10, 12]);
    expect([day.above, day.below]).toEqual([1, 4]);
    expect(day.singles).toEqual([]); // Zeile 13 hat 1 TPO, ist aber die oberste
  });
  it('IB (erste 60 min), Open/Close, fehlende Blöcke bis zum Datenende', () => {
    expect(day.ibPrice).toEqual([100, 139]);
    expect(day.ibRows).toEqual([10, 13]);
    expect([day.open, day.close]).toEqual([105, 107]);
    // Datenende nach 4 h → 8 erwartete Blöcke, davon ohne Bars: 3, 5, 6, 7
    expect(day.missingBlocks).toBe(4);
    expect(day.lastBlock).toBe(4);
    // laufender Tag (Datenende 1 h 30): nur Block 3 noch nicht erwartet → 0 fehlend
    const partial = computeTpo(
      bars(),
      T0,
      { blockMin: 30, ibMin: 60, vaPct: 70 },
      10,
      T0 + 90 * 60_000,
    );
    expect(partial.missingBlocks).toBe(0);
  });
  it('Spalten: gestapelt (k-ter TPO der Zeile) bzw. Split (Spalte = Block) mit Koordinaten', () => {
    // Blockreihenfolge: B0 10/11/12 → Spalte 0; B1 11/12/13 → 1/1/0; B2 12 → 2; B4 10 → 1
    expect([...day.cellBlock]).toEqual([0, 0, 0, 1, 1, 1, 2, 4]);
    expect([...day.cellRow]).toEqual([10, 11, 12, 11, 12, 13, 12, 10]);
    expect([...day.cellCol]).toEqual([0, 0, 0, 1, 1, 0, 2, 1]);
    expect(tpoColumns(day, false)).toBe(3);
    expect(tpoColumns(day, true)).toBe(5);
    const yOf = (u: number) => 1000 - 2 * u; // 20 px je Zeile
    expect(cellRect(day, 7, false, 100, 10, yOf)).toEqual({ x: 110, y: 780, w: 10, h: 20 });
    expect(cellRect(day, 7, true, 100, 10, yOf)).toEqual({ x: 140, y: 780, w: 10, h: 20 });
  });
  it('Single Prints (innere Zeilen mit 1 TPO) und Buchstaben einer Zeile', () => {
    const t = (m: number) => T0 / 1000 + m * 60;
    const b: TpoBars = {
      time: [t(0), t(30), t(60)],
      open: [0, 0, 20],
      high: [29, 9, 29],
      low: [0, 0, 20],
      close: [0, 0, 20],
    };
    const d2 = computeTpo(b, T0, { blockMin: 30, ibMin: 60, vaPct: 70 }, 10);
    expect([...d2.counts]).toEqual([2, 1, 2]);
    expect(d2.singles).toEqual([1]);
    expect(rowLetters(day, 12)).toEqual({ blocks: [0, 1, 2], letters: 'ABC' });
    expect(rowLetters(day, 10).letters).toBe('AE');
  });
  it('leerer Tag', () => {
    const e = computeTpo(
      { time: [], open: [], high: [], low: [], close: [] },
      T0,
      TPO_DEFAULTS,
      10,
      T0 + D,
    );
    expect(e.total).toBe(0);
    expect(e.poc).toBeNull();
    expect(e.missingBlocks).toBe(48);
  });
});

describe('Zeilengröße und URL', () => {
  it('Ziel 12 px, Halteband 9…20 px', () => {
    const ladder = [1, 2, 5, 10, 20, 50, 100];
    expect(tpoRowSize(null, ladder, 0.12, 10)).toBe(10); // 10 · 10 · 0,12 = 12 px
    expect(tpoRowSize(20, ladder, 0.08, 10)).toBe(20); // 16 px im Band
    expect(tpoRowSize(50, ladder, 0.08, 10)).toBe(20); // 40 px → neu
  });
  it('view=tpo und Optionen', () => {
    const p = parseTpoParams(new URLSearchParams('view=tpo&tb=5&tib=90&ts=1&tvp=0&tr=200'));
    expect(p.view).toBe('tpo');
    expect(p.tpo).toMatchObject({ blockMin: 5, ibMin: 90, split: true, volume: false, R: 200 });
    expect(tpoParamsQuery(p.view, p.tpo)).toBe('&view=tpo&tb=5&tib=90&ts=1&tvp=0&tr=200');
    expect(tpoParamsQuery('chart', p.tpo)).toBe('');
    expect(parseTpoParams(new URLSearchParams('tb=7')).tpo.blockMin).toBe(30);
  });
});
