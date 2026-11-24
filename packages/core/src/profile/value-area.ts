// Volume Profile: POC, Delta-POC und Value Area (KONZEPT §6.1, einheitlich für Bars, Profile, TPO).
// Rein, ganzzahlig, ohne I/O. Eingabe sind dichte Zeilen (Index 0 = unterste Zeile des Bereichs,
// innere Zeilen ohne Trades zählen als 0), Mengen in Lots (ganzzahlig, < 2^53).

/**
 * Index der Zeile mit dem größten Wert. Gleichstand → näher an der Mitte des Bereichs
 * ((n − 1) / 2), dann die tiefere Zeile (KONZEPT §6.1). −1, wenn alle Werte 0 sind (oder n = 0).
 */
export function maxNearMiddle(values: ArrayLike<number>): number {
  const n = values.length;
  let best = -1;
  let bestV = 0;
  let bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (v <= 0) continue;
    // doppelter Abstand zur Mitte, ganzzahlig: |2i − (n − 1)|
    const dist = Math.abs(2 * i - (n - 1));
    if (v > bestV || (v === bestV && dist < bestDist)) {
      best = i;
      bestV = v;
      bestDist = dist;
    }
    // bei v === bestV und dist === bestDist bleibt die tiefere (frühere) Zeile
  }
  return best;
}

/** POC: Zeile mit dem größten Volumen buy + sell (Regel siehe maxNearMiddle). */
export function pocIndex(buy: ArrayLike<number>, sell: ArrayLike<number>): number {
  const n = buy.length;
  const vol = new Float64Array(n);
  for (let i = 0; i < n; i++) vol[i] = buy[i]! + sell[i]!;
  return maxNearMiddle(vol);
}

/**
 * Delta-POC: Zeile mit dem größten |buy − sell| (KONZEPT §6.1; Vorzeichen per Farbe).
 * Gleichstand wie beim POC (näher an der Mitte, dann tiefer). −1, wenn jedes Delta 0 ist.
 */
export function deltaPocIndex(buy: ArrayLike<number>, sell: ArrayLike<number>): number {
  const n = buy.length;
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.abs(buy[i]! - sell[i]!);
  return maxNearMiddle(d);
}

/**
 * Value Area nach dem klassischen Market-Profile-Verfahren (KONZEPT §6.1): Start bei der POC-Zeile;
 * Summe der zwei nächsten Zeilen oberhalb gegen die Summe der zwei nächsten unterhalb (fehlt eine
 * Seite, nur die andere; am Rand ggf. nur eine Zeile); das größere Paar wird ganz aufgenommen,
 * Gleichstand → oben; bis kumuliert ≥ vaPct % des Gesamtvolumens. Ganzzahlige Bedingung:
 * 100 · kumuliert ≥ vaPct · gesamt. Liefert [lo, hi] als Indizes (inklusive); null ohne Volumen.
 */
export function valueArea(
  vol: ArrayLike<number>,
  poc: number,
  vaPct: number,
): [number, number] | null {
  const n = vol.length;
  if (poc < 0 || poc >= n) return null;
  if (!Number.isInteger(vaPct) || vaPct < 1 || vaPct > 100) {
    throw new RangeError(`vaPct ${vaPct} nicht in 1…100`);
  }
  let total = 0;
  for (let i = 0; i < n; i++) total += vol[i]!;
  if (total <= 0) return null;
  let lo = poc;
  let hi = poc;
  let cum = vol[poc]!;
  while (cum * 100 < vaPct * total) {
    const upN = Math.min(2, n - 1 - hi);
    const dnN = Math.min(2, lo);
    if (upN === 0 && dnN === 0) break; // nicht erreichbar: dann ist cum = total
    const up = upN === 0 ? -1 : vol[hi + 1]! + (upN === 2 ? vol[hi + 2]! : 0);
    const dn = dnN === 0 ? -1 : vol[lo - 1]! + (dnN === 2 ? vol[lo - 2]! : 0);
    if (upN > 0 && (dnN === 0 || up >= dn)) {
      hi += upN;
      cum += up;
    } else {
      lo -= dnN;
      cum += dn;
    }
  }
  return [lo, hi];
}

export interface ProfileMarks {
  /** Absolute Zeilenindizes (Zeile r überdeckt [r·w, (r+1)·w) in price_unit); null ohne Volumen. */
  poc: number | null;
  /** Oberste Zeile der Value Area. */
  vah: number | null;
  /** Unterste Zeile der Value Area. */
  val: number | null;
  /** Zeile mit größtem |Delta|; null, wenn jedes Delta 0 ist. */
  deltaPoc: number | null;
}

/** POC, VAH, VAL und Delta-POC eines dichten Profils ab Zeile rowLo. */
export function profileMarks(
  rowLo: number,
  buy: ArrayLike<number>,
  sell: ArrayLike<number>,
  vaPct: number,
): ProfileMarks {
  const n = buy.length;
  if (sell.length !== n) throw new RangeError('buy/sell: unterschiedliche Längen');
  const vol = new Float64Array(n);
  for (let i = 0; i < n; i++) vol[i] = buy[i]! + sell[i]!;
  const p = maxNearMiddle(vol);
  const va = valueArea(vol, p, vaPct);
  const d = deltaPocIndex(buy, sell);
  return {
    poc: p < 0 ? null : rowLo + p,
    vah: va ? rowLo + va[1] : null,
    val: va ? rowLo + va[0] : null,
    deltaPoc: d < 0 ? null : rowLo + d,
  };
}
