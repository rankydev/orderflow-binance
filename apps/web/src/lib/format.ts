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

export class TextTable {
  readonly strings: string[] = [];
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
      this.index.set(lots, i);
    }
    return i;
  }

  get size(): number {
    return this.strings.length;
  }
}
