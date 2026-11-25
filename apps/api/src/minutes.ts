// Gespeicherte Minuten eines UTC-Tages als Bitmaske (Katalogstatistik, Leerprüfung): Wort 2·h + ⌊m/30⌋,
// Bit m mod 30 für Minute m der Stunde h – 48 Wörter zu je 30 Bit (die Datenbank liefert je Stunde zwei
// int4 aus bit_or, ohne 64-Bit-Werte über Number).

/** Ist Minute `m` (0…1439) des Tages in der Maske gespeichert? */
export function hasMinute(mask: Uint32Array, m: number): boolean {
  const mm = m % 60;
  return ((mask[2 * Math.floor(m / 60) + (mm >= 30 ? 1 : 0)]! >>> (mm % 30)) & 1) === 1;
}

/** Maske aus Minuten des Tages (Tests, Referenz). */
export function maskOf(minutes: Iterable<number>): Uint32Array {
  const mask = new Uint32Array(48);
  for (const m of minutes) {
    if (!Number.isInteger(m) || m < 0 || m >= 1440) throw new Error(`Minute ${m} ungültig`);
    const mm = m % 60;
    mask[2 * Math.floor(m / 60) + (mm >= 30 ? 1 : 0)]! |= 1 << (mm % 30);
  }
  return mask;
}

/** Zahl der gespeicherten Minuten einer Maske. */
export function minuteCount(mask: Uint32Array): number {
  let n = 0;
  for (const word of mask) {
    let w = word;
    while (w) {
      w &= w - 1;
      n++;
    }
  }
  return n;
}
