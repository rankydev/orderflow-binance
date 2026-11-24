// Zelltext (KONZEPT §7.3). Werte sind ganzzahlige Lots; Rundung ausschließlich ganzzahlig (Review W10:
// keine Gleitkomma-Rundung, Klassengrenzen nach dem Runden geprüft). Die Texte bildet beim Zeichnen ein
// begrenzter Cache (TextCache), nicht eine Tabelle je Kachel.

/**
 * |lots| / 10^shift auf ganze Einheiten gerundet (half-up), exakt in Ganzzahlen (lots < 2^53).
 * shift ≤ 0 multipliziert.
 */
function roundShift(abs: number, shift: number): number {
  if (shift <= 0) return abs * 10 ** -shift;
  const p = 10 ** shift;
  const r = abs % p;
  return (abs - r) / p + (2 * r >= p ? 1 : 0);
}

/** Ganzzahl q mit dp Nachkommastellen als Text, z. B. (12345, 2) → "123.45". */
function fixed(q: number, dp: number): string {
  if (dp === 0) return String(q);
  const s = String(q).padStart(dp + 1, '0');
  return `${s.slice(0, -dp)}.${s.slice(-dp)}`;
}

interface Cls {
  /** Nachkommastellen bezogen auf die Einheit (Basiswährung; bei k/M auf Tausend/Million). */
  dp: number;
  /** Einheit als Zehnerpotenz der Basiswährung (0, 3 = k, 6 = M). */
  unit: number;
  /** obere Grenze (exklusiv) des gerundeten Werts in Einheiten. */
  below: number;
  suffix: string;
}

/**
 * Erste Klasse, deren gerundeter Wert unter ihrer Grenze bleibt (Grenze nach dem Runden geprüft: 9.9996
 * wird nicht "10.000", sondern fällt in die nächste Klasse "10.00").
 */
function formatWith(
  lots: number,
  qtyDecimals: number,
  classes: readonly Cls[],
  tiny: string,
): string {
  if (lots === 0) return '0';
  const neg = lots < 0;
  const abs = Math.abs(lots);
  for (const c of classes) {
    const dp = Math.min(c.dp, qtyDecimals + c.unit);
    const q = roundShift(abs, qtyDecimals + c.unit - dp);
    if (q >= c.below * 10 ** dp) continue;
    if (q === 0) return neg ? `-${tiny}` : tiny; // nicht als 0 darstellen (W10)
    return `${neg ? '-' : ''}${fixed(q, dp)}${c.suffix}`;
  }
  const last = classes[classes.length - 1]!;
  return `${neg ? '-' : ''}${roundShift(abs, qtyDecimals + last.unit)}${last.suffix}`;
}

const FULL: readonly Cls[] = [
  { dp: 3, unit: 0, below: 10, suffix: '' },
  { dp: 2, unit: 0, below: 100, suffix: '' },
  { dp: 1, unit: 0, below: 1000, suffix: '' },
  { dp: 0, unit: 0, below: 10_000, suffix: '' },
  { dp: 1, unit: 3, below: 100, suffix: 'k' },
  { dp: 0, unit: 3, below: 1000, suffix: 'k' },
  { dp: 1, unit: 6, below: 100, suffix: 'M' },
  { dp: 0, unit: 6, below: Infinity, suffix: 'M' },
];

const SHORT: readonly Cls[] = [
  { dp: 3, unit: 0, below: 0.1, suffix: '' },
  { dp: 2, unit: 0, below: 1, suffix: '' },
  { dp: 1, unit: 0, below: 10, suffix: '' },
  { dp: 0, unit: 0, below: 1000, suffix: '' },
  { dp: 1, unit: 3, below: 10, suffix: 'k' },
  { dp: 0, unit: 3, below: 1000, suffix: 'k' },
  { dp: 1, unit: 6, below: 10, suffix: 'M' },
  { dp: 0, unit: 6, below: Infinity, suffix: 'M' },
];

/**
 * Kompakte Darstellung einer Menge in Lots (qtyDecimals Nachkommastellen), höchstens 6 Zeichen ohne
 * Vorzeichen: "0.001" … "9.999", "10.00" … "99.99", "100.0" … "999.9", "1000" … "9999", "10.0k" …
 * "99.9k", "100k" … "999k", dann M. Werte ≠ 0, die auf 0 runden würden, erscheinen als "<0.001".
 */
export function formatQty(lots: number, qtyDecimals: number): string {
  return formatWith(lots, qtyDecimals, FULL, '<0.001');
}

/**
 * Kurzform (höchstens 4 Zeichen ohne Vorzeichen) für schmale Zellen: ".012", ".25", "1.2", "12", "123",
 * "1.2k", "45k", "1.2M"; führende 0 entfällt.
 */
export function formatQtyShort(lots: number, qtyDecimals: number): string {
  const s = formatWith(lots, qtyDecimals, SHORT, '<.001');
  return s.replace(/^(-?)0\./, '$1.');
}

/**
 * Begrenzter Cache Wert → Text (Lang- und Kurzform). Beim Zeichnen werden je Frame höchstens einige
 * tausend Zahlen gebraucht; Werte wiederholen sich stark. Bei Überlauf wird der Cache geleert (Review W5:
 * keine unbegrenzt wachsende Tabelle).
 */
export class TextCache {
  readonly qtyDecimals: number;
  readonly limit: number;
  private fullMap = new Map<number, string>();
  private shortMap = new Map<number, string>();
  constructor(qtyDecimals: number, limit = 20_000) {
    this.qtyDecimals = qtyDecimals;
    this.limit = limit;
  }
  full(lots: number): string {
    let s = this.fullMap.get(lots);
    if (s === undefined) {
      if (this.fullMap.size >= this.limit) this.fullMap = new Map();
      s = formatQty(lots, this.qtyDecimals);
      this.fullMap.set(lots, s);
    }
    return s;
  }
  short(lots: number): string {
    let s = this.shortMap.get(lots);
    if (s === undefined) {
      if (this.shortMap.size >= this.limit) this.shortMap = new Map();
      s = formatQtyShort(lots, this.qtyDecimals);
      this.shortMap.set(lots, s);
    }
    return s;
  }
  get size(): number {
    return this.fullMap.size + this.shortMap.size;
  }
}
