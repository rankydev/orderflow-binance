// Exakter Dezimal-Parser (KONZEPT §4.4): nie Gleitkomma. Der Dezimalstring wird am Punkt getrennt,
// der Nachkommateil auf `decimals` Stellen mit Nullen aufgefüllt; überzählige Stellen sind nur
// erlaubt, wenn sie 0 sind. Ergebnis ist eine ganze Zahl in Einheiten 10^-decimals.
// Die Bereichsvarianten arbeiten direkt auf (s, start, end) ohne Teilstrings (Durchsatz).

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

const C0 = 48; // '0'
const C9 = 57; // '9'
const DOT = 46; // '.'

/** Größter Wert, bei dem `v * 10 + 9` noch exakt ist. */
const SAFE_DIV10 = Math.floor(Number.MAX_SAFE_INTEGER / 10) - 1;

function show(s: string, start: number, end: number): string {
  return JSON.stringify(s.slice(start, end));
}

/**
 * Nichtnegative Dezimalzahl in s[start, end) → ganze Zahl in 10^-decimals.
 * Erlaubt: "123", "123.4", "0.001", "123.40000" (überzählige Nullen). Abgelehnt: leer, Vorzeichen,
 * Exponent, ".5", "5.", Leerzeichen, überzählige Nicht-Null-Stellen, Werte > 2^53 − 1.
 */
export function parseDecimalRange(
  s: string,
  start: number,
  end: number,
  decimals: number,
  what: string,
): number {
  let v = 0;
  let i = start;
  let intDigits = 0;
  for (; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c === DOT) break;
    if (c < C0 || c > C9)
      throw new ParseError(`${what}: ungültige Dezimalzahl ${show(s, start, end)}`);
    if (v > SAFE_DIV10) throw new ParseError(`${what}: Wert zu groß ${show(s, start, end)}`);
    v = v * 10 + (c - C0);
    intDigits++;
  }
  if (intDigits === 0)
    throw new ParseError(`${what}: ungültige Dezimalzahl ${show(s, start, end)}`);
  let frac = 0;
  if (i < end) {
    // s[i] === '.'
    i++;
    if (i === end) throw new ParseError(`${what}: ungültige Dezimalzahl ${show(s, start, end)}`);
    for (; i < end; i++) {
      const c = s.charCodeAt(i);
      if (c < C0 || c > C9)
        throw new ParseError(`${what}: ungültige Dezimalzahl ${show(s, start, end)}`);
      if (frac < decimals) {
        if (v > SAFE_DIV10) throw new ParseError(`${what}: Wert zu groß ${show(s, start, end)}`);
        v = v * 10 + (c - C0);
        frac++;
      } else if (c !== C0) {
        throw new ParseError(
          `${what}: ${show(s, start, end)} hat mehr als ${decimals} Nachkommastellen ungleich 0 (nicht auf dem Raster)`,
        );
      }
    }
  }
  for (; frac < decimals; frac++) {
    if (v > SAFE_DIV10) throw new ParseError(`${what}: Wert zu groß ${show(s, start, end)}`);
    v *= 10;
  }
  return v;
}

export function parseDecimal(s: string, decimals: number, what = 'Wert'): number {
  return parseDecimalRange(s, 0, s.length, decimals, what);
}

/** Ganze Zahl → Dezimalstring mit genau `decimals` Nachkommastellen (Umkehrung für Tests/Ausgabe). */
export function formatDecimal(v: number, decimals: number): string {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`formatDecimal: ${v}`);
  if (decimals === 0) return String(v);
  const digits = String(v).padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/** Vorzeichenlose ganze Zahl in s[start, end), strikt (nur Ziffern, ≤ 2^53 − 1). */
export function parseUIntRange(s: string, start: number, end: number, what: string): number {
  if (start >= end) throw new ParseError(`${what}: leer`);
  let v = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c < C0 || c > C9) throw new ParseError(`${what}: keine ganze Zahl ${show(s, start, end)}`);
    if (v > SAFE_DIV10) throw new ParseError(`${what}: Wert zu groß ${show(s, start, end)}`);
    v = v * 10 + (c - C0);
  }
  return v;
}

/** Zeitstempel in ms: genau 13 Ziffern (KONZEPT §4.4, Schutz gegen µs-Formate). */
export function parseMsRange(s: string, start: number, end: number, what: string): number {
  if (end - start !== 13) {
    throw new ParseError(
      `${what}: Zeitstempel ${show(s, start, end)} hat nicht genau 13 Ziffern (ms)`,
    );
  }
  return parseUIntRange(s, start, end, what);
}
