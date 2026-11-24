// Zelltext (KONZEPT §7.3: vorformatierte Text-Strings, einmal je Kachel). Werte sind ganzzahlige Lots;
// der Text hängt nur vom Wert ab, daher eine gemeinsame Tabelle (Interning) statt eines Strings je Zelle:
// je Kachel werden nur Int32-Indizes abgelegt.

/** Kompakte Darstellung einer Menge in Lots (qtyDecimals Nachkommastellen) mit höchstens 6 Zeichen. */
export function formatQty(lots: number, qtyDecimals: number): string {
  if (lots === 0) return '0';
  const neg = lots < 0;
  const a = Math.abs(lots) / 10 ** qtyDecimals;
  let s: string;
  if (a >= 1_000_000) s = `${(a / 1_000_000).toFixed(a >= 100_000_000 ? 0 : 1)}M`;
  else if (a >= 10_000) s = `${(a / 1000).toFixed(a >= 100_000 ? 0 : 1)}k`;
  else if (a >= 1000) s = a.toFixed(0);
  else if (a >= 100) s = a.toFixed(1);
  else if (a >= 10) s = a.toFixed(2);
  else s = a.toFixed(Math.min(3, qtyDecimals));
  return neg ? `-${s}` : s;
}

/**
 * Kurzform (höchstens 4 Zeichen ohne Vorzeichen) für schmale Zellen, nach denselben Regeln wie
 * formatQty, nur mit weniger Stellen: < 1 → zwei Nachkommastellen ohne führende 0 (".01"),
 * < 10 → eine Nachkommastelle ("1.2"), < 1000 → ganzzahlig ("12", "123"), sonst k/M ("1.2k", "45k").
 */
export function formatQtyShort(lots: number, qtyDecimals: number): string {
  if (lots === 0) return '0';
  const neg = lots < 0;
  const a = Math.abs(lots) / 10 ** qtyDecimals;
  let s: string;
  const k = (v: number, unit: string) =>
    v < 9.95 ? `${v.toFixed(1)}${unit}` : `${Math.min(999, Math.round(v))}${unit}`;
  if (a >= 999_500) s = k(a / 1_000_000, 'M');
  else if (a >= 999.5) s = k(a / 1000, 'k');
  else if (a >= 9.95) s = String(Math.round(a));
  else if (a >= 0.995) s = a.toFixed(1);
  else s = (a < 0.0995 ? a.toFixed(3) : a.toFixed(2)).slice(1); // ".012", ".25"
  return neg ? `-${s}` : s;
}

export class TextTable {
  readonly strings: string[] = [];
  /** Kurzform je Index (gleiche Indizes wie strings). */
  readonly short: string[] = [];
  private readonly index = new Map<number, number>();
  readonly qtyDecimals: number;
  constructor(qtyDecimals: number) {
    this.qtyDecimals = qtyDecimals;
  }

  /** Index des Texts zu `lots` (einmalig formatiert). */
  id(lots: number): number {
    let i = this.index.get(lots);
    if (i === undefined) {
      i = this.strings.length;
      this.strings.push(formatQty(lots, this.qtyDecimals));
      this.short.push(formatQtyShort(lots, this.qtyDecimals));
      this.index.set(lots, i);
    }
    return i;
  }

  get size(): number {
    return this.strings.length;
  }
}
