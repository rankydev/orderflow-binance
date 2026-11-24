// Zeilenparser für Binance-Vision-CSV (aggTrades, 1m-Klines). Rein, ohne I/O. Arbeitet auf
// (Zeichenkette, Start, Ende), damit der Leser keine Teilstrings je Zeile erzeugen muss.
import type { SymbolSpec } from '../symbols.ts';
import { MINUTE_MS } from '../constants.ts';
import { ParseError, parseDecimalRange, parseMsRange, parseUIntRange } from './decimal.ts';

/** Ein aggTrade in Ganzzahl-Einheiten. `m` = is_buyer_maker (true → Verkäufer ist Aggressor). */
export interface AggTrade {
  a: number;
  px: number;
  q: number;
  f: number;
  l: number;
  T: number;
  m: boolean;
}

export const AGG_HEADER =
  'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker';
export const KLINE_HEADER =
  'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore';

export type CsvKind = 'aggTrades' | 'klines';

/**
 * Kopfzeilen-Erkennung: ältere Dumps haben keine Kopfzeile (erste Zeile beginnt mit einer Ziffer),
 * neuere genau die bekannte. Alles andere ist ein Fehler (unbekanntes Format).
 */
export function detectHeader(firstLine: string, kind: CsvKind): boolean {
  const line = firstLine.endsWith('\r') ? firstLine.slice(0, -1) : firstLine;
  const c = line.charCodeAt(0);
  if (c >= 48 && c <= 57) return false;
  const want = kind === 'aggTrades' ? AGG_HEADER : KLINE_HEADER;
  if (line === want) return true;
  throw new ParseError(`Unbekannte Kopfzeile für ${kind}: ${JSON.stringify(line.slice(0, 200))}`);
}

function nextComma(s: string, from: number, end: number, field: string): number {
  const k = s.indexOf(',', from);
  if (k < 0 || k >= end) throw new ParseError(`zu wenige Felder (vor ${field})`);
  return k;
}

/**
 * Parst eine aggTrades-Zeile s[start, end) (ohne Zeilenende) in `out` (wird wiederverwendet).
 * Strikt: genau 7 Felder, Preis/Menge auf dem Einheitenraster, Menge > 0, Preis > 0, f ≤ l,
 * T mit 13 Ziffern, is_buyer_maker genau "true"/"false".
 */
export function parseAggTradeRange(
  s: string,
  start: number,
  end: number,
  spec: SymbolSpec,
  out: AggTrade,
): AggTrade {
  let p = start;
  let k = nextComma(s, p, end, 'price');
  out.a = parseUIntRange(s, p, k, 'agg_trade_id');
  p = k + 1;
  k = nextComma(s, p, end, 'quantity');
  out.px = parseDecimalRange(s, p, k, spec.priceDecimals, 'price');
  p = k + 1;
  k = nextComma(s, p, end, 'first_trade_id');
  out.q = parseDecimalRange(s, p, k, spec.qtyDecimals, 'quantity');
  p = k + 1;
  k = nextComma(s, p, end, 'last_trade_id');
  out.f = parseUIntRange(s, p, k, 'first_trade_id');
  p = k + 1;
  k = nextComma(s, p, end, 'transact_time');
  out.l = parseUIntRange(s, p, k, 'last_trade_id');
  p = k + 1;
  k = nextComma(s, p, end, 'is_buyer_maker');
  out.T = parseMsRange(s, p, k, 'transact_time');
  p = k + 1;
  const len = end - p;
  if (len === 4 && s.startsWith('true', p)) out.m = true;
  else if (len === 5 && s.startsWith('false', p)) out.m = false;
  else {
    const rest = s.slice(p, end);
    if (rest.includes(',')) throw new ParseError('zu viele Felder');
    throw new ParseError(`is_buyer_maker: erwartet true/false, gefunden ${JSON.stringify(rest)}`);
  }
  if (out.px <= 0) throw new ParseError('price muss > 0 sein');
  if (out.q <= 0) throw new ParseError('quantity muss > 0 sein');
  if (out.f > out.l) throw new ParseError(`first_trade_id ${out.f} > last_trade_id ${out.l}`);
  return out;
}

export function parseAggTradeLine(line: string, spec: SymbolSpec): AggTrade {
  const out: AggTrade = { a: 0, px: 0, q: 0, f: 0, l: 0, T: 0, m: false };
  return parseAggTradeRange(line, 0, line.length, spec, out);
}

/** Eine 1m-Kline in Ganzzahl-Einheiten. Notional-Felder in price_unit·qty_unit. */
export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  closeTime: number;
  quoteVolN: number;
  trades: number;
  takerBuy: number;
  takerBuyQuoteN: number;
}

/**
 * Parst eine 1m-Kline-Zeile. Strikt: 12 Felder, open_time auf Minutenraster,
 * close_time = open_time + 59 999, low ≤ open/close ≤ high, taker_buy ≤ volume, ignore = 0.
 */
export function parseKlineRange(s: string, start: number, end: number, spec: SymbolSpec): Kline {
  const pd = spec.priceDecimals;
  const qd = spec.qtyDecimals;
  const nd = pd + qd;
  const fields: [number, number][] = [];
  let p = start;
  for (;;) {
    const k = s.indexOf(',', p);
    if (k < 0 || k >= end) {
      fields.push([p, end]);
      break;
    }
    fields.push([p, k]);
    p = k + 1;
  }
  if (fields.length !== 12)
    throw new ParseError(`Kline: erwartet 12 Felder, gefunden ${fields.length}`);
  const f = (i: number): [number, number] => fields[i]!;
  const dec = (i: number, d: number, what: string) =>
    parseDecimalRange(s, f(i)[0], f(i)[1], d, what);
  const k: Kline = {
    openTime: parseMsRange(s, f(0)[0], f(0)[1], 'open_time'),
    open: dec(1, pd, 'open'),
    high: dec(2, pd, 'high'),
    low: dec(3, pd, 'low'),
    close: dec(4, pd, 'close'),
    vol: dec(5, qd, 'volume'),
    closeTime: parseMsRange(s, f(6)[0], f(6)[1], 'close_time'),
    quoteVolN: dec(7, nd, 'quote_volume'),
    trades: parseUIntRange(s, f(8)[0], f(8)[1], 'count'),
    takerBuy: dec(9, qd, 'taker_buy_volume'),
    takerBuyQuoteN: dec(10, nd, 'taker_buy_quote_volume'),
  };
  const ign = s.slice(f(11)[0], f(11)[1]);
  if (ign !== '0')
    throw new ParseError(`Kline: Feld ignore erwartet "0", gefunden ${JSON.stringify(ign)}`);
  if (k.openTime % MINUTE_MS !== 0)
    throw new ParseError(`Kline: open_time ${k.openTime} nicht auf Minutengrenze`);
  if (k.closeTime !== k.openTime + MINUTE_MS - 1) {
    throw new ParseError(`Kline: close_time ${k.closeTime} ≠ open_time + 59999`);
  }
  if (k.takerBuy > k.vol) throw new ParseError('Kline: taker_buy_volume > volume');
  if (k.vol > 0) {
    if (
      k.low > k.high ||
      k.open < k.low ||
      k.open > k.high ||
      k.close < k.low ||
      k.close > k.high
    ) {
      throw new ParseError('Kline: OHLC inkonsistent');
    }
  }
  return k;
}

export function parseKlineLine(line: string, spec: SymbolSpec): Kline {
  return parseKlineRange(line, 0, line.length, spec);
}
