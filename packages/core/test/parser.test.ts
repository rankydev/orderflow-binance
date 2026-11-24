// T1 Parser (KONZEPT §4.10): zufällige Dezimalstrings → px/Lots exakt; Off-Grid → Fehler; Rundtrip.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AGG_HEADER,
  detectHeader,
  formatDecimal,
  getSymbol,
  KLINE_HEADER,
  ParseError,
  parseAggTradeLine,
  parseDecimal,
  parseKlineLine,
} from '../src/index.ts';

const BTC = getSymbol('BTCUSDT');
const ETH = getSymbol('ETHUSDT');

/** Referenz über BigInt-Arithmetik auf Ziffernfolgen (unabhängig vom Parser). */
function refParse(s: string, d: number): bigint {
  const [i, f = ''] = s.split('.');
  return BigInt(i! + f.padEnd(d, '0').slice(0, d));
}

const digits = (min: number, max: number) =>
  fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength: min, maxLength: max })
    .map((a) => a.join(''));

describe('parseDecimal', () => {
  it('Rundtrip: formatDecimal(v, d) → v für alle v und d', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 40 }), fc.integer({ min: 0, max: 6 }), (v, d) => {
        expect(parseDecimal(formatDecimal(v, d), d)).toBe(v);
      }),
    );
  });

  it('zufällige Dezimalstrings auf dem Raster = BigInt-Referenz (inkl. überzähliger Nullen)', () => {
    const arb = fc
      .integer({ min: 0, max: 6 })
      .chain((d) =>
        fc.tuple(fc.constant(d), digits(1, 9), digits(0, d), fc.integer({ min: 0, max: 4 })),
      );
    fc.assert(
      fc.property(arb, ([d, intPart, frac, zeros]) => {
        const s = frac.length + zeros > 0 ? `${intPart}.${frac}${'0'.repeat(zeros)}` : intPart;
        expect(BigInt(parseDecimal(s, d))).toBe(refParse(s, d));
      }),
    );
  });

  it('Off-Grid: eine Nicht-Null-Stelle jenseits der Einheit ist ein Fehler', () => {
    fc.assert(
      fc.property(
        digits(1, 6),
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 1, max: 9 }),
        (i, d, last) => {
          const s = `${i}.${'0'.repeat(d)}${last}`;
          expect(() => parseDecimal(s, d)).toThrow(/Raster/);
        },
      ),
    );
  });

  it('kein Gleitkomma-Artefakt an typischen Grenzpreisen', () => {
    // 0.1 + 0.2 ≠ 0.3 in Float; hier exakt
    expect(parseDecimal('61959.2', 2)).toBe(6195920);
    expect(parseDecimal('0.3', 3)).toBe(300);
    expect(parseDecimal('1622.02', 3)).toBe(1622020);
    expect(parseDecimal('4395935.84579', 6)).toBe(4395935845790);
    expect(parseDecimal('0.29', 2)).toBe(29); // 0.29 * 100 = 28.999999999999996 in Float
    expect(parseDecimal('1.005', 3)).toBe(1005);
  });

  it('lehnt ungültige Formen ab', () => {
    for (const s of [
      '',
      '.',
      '1.',
      '.5',
      '-1',
      '+1',
      '1e3',
      ' 1',
      '1 ',
      '1,5',
      '1.2.3',
      'NaN',
      '0x10',
    ]) {
      expect(() => parseDecimal(s, 2), s).toThrow(ParseError);
    }
  });

  it('lehnt Werte über 2^53 ab', () => {
    expect(() => parseDecimal('9007199254740993', 0)).toThrow(/zu groß/);
    expect(() => parseDecimal('90071992547409.93', 3)).toThrow(/zu groß/);
  });
});

describe('Kopfzeilen-Erkennung', () => {
  it('erkennt mit und ohne Kopfzeile, lehnt Unbekanntes ab', () => {
    expect(detectHeader(AGG_HEADER, 'aggTrades')).toBe(true);
    expect(detectHeader(`${AGG_HEADER}\r`, 'aggTrades')).toBe(true);
    expect(
      detectHeader(
        '3533987381,61959.2,1.516,8300806799,8300806839,1795132800058,true',
        'aggTrades',
      ),
    ).toBe(false);
    expect(detectHeader(KLINE_HEADER, 'klines')).toBe(true);
    expect(() => detectHeader('a,b,c', 'aggTrades')).toThrow(/Kopfzeile/);
    expect(() => detectHeader(KLINE_HEADER, 'aggTrades')).toThrow(/Kopfzeile/);
  });
});

describe('aggTrades-Zeile', () => {
  it('parst eine echte Zeile exakt', () => {
    const t = parseAggTradeLine(
      '3533987381,61959.2,1.516,8300806799,8300806839,1795132800058,true',
      BTC,
    );
    expect(t).toEqual({
      a: 3533987381,
      px: 6195920,
      q: 1516,
      f: 8300806799,
      l: 8300806839,
      T: 1795132800058,
      m: true,
    });
    const e = parseAggTradeLine(
      '1953027711,3336.58,6.583,4936628773,4936628773,1735689605058,false',
      ETH,
    );
    expect(e).toMatchObject({ px: 3336580, q: 6583, m: false });
  });

  it('lehnt strikt ab: Feldzahl, Seite, µs-Zeit, Menge 0, f > l, Off-Grid', () => {
    const bad = [
      '1,61959.2,1.516,1,2,1795132800058', // 6 Felder
      '1,61959.2,1.516,1,2,1795132800058,true,x', // 8 Felder
      '1,61959.2,1.516,1,2,1795132800058,True',
      '1,61959.2,1.516,1,2,1795132800058000,true', // µs
      '1,61959.2,1.516,1,2,179513280005,true', // 12 Ziffern
      '1,61959.2,0.000,1,2,1795132800058,true',
      '1,61959.2,1.516,3,2,1795132800058,true',
      '1,61959.205,1.516,1,2,1795132800058,true', // Preis feiner als price_unit
      '1,61959.2,1.5161,1,2,1795132800058,true', // Menge feiner als qty_unit
      '-1,61959.2,1.516,1,2,1795132800058,true',
    ];
    for (const l of bad) expect(() => parseAggTradeLine(l, BTC), l).toThrow(ParseError);
  });
});

describe('Kline-Zeile', () => {
  const line =
    '1795132800000,61959.30,61990.00,61941.90,61987.40,90.347,1795132859999,5599008.74920,2795,59.109,3663044.98890,0';
  it('parst exakt, Notional in price_unit·qty_unit', () => {
    expect(parseKlineLine(line, BTC)).toEqual({
      openTime: 1795132800000,
      open: 6195930,
      high: 6199000,
      low: 6194190,
      close: 6198740,
      vol: 90347,
      closeTime: 1795132859999,
      quoteVolN: 559900874920,
      trades: 2795,
      takerBuy: 59109,
      takerBuyQuoteN: 366304498890,
    });
  });
  it('lehnt inkonsistente Klines ab', () => {
    expect(() => parseKlineLine(line.replace('1795132859999', '1795132859998'), BTC)).toThrow(
      /close_time/,
    );
    expect(() => parseKlineLine(line.replace('1795132800000', '1795132800001'), BTC)).toThrow(
      /Minutengrenze|close_time/,
    );
    expect(() => parseKlineLine(line.replace(',59.109,', ',90.348,'), BTC)).toThrow(/taker_buy/);
    expect(() => parseKlineLine(line.replace(/,0$/, ',1'), BTC)).toThrow(/ignore/);
    expect(() => parseKlineLine(line + ',0', BTC)).toThrow(/12 Felder/);
  });
});
