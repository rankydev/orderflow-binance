// Kline-Abgleich pro Minute (KONZEPT §4.6). Mengen in Lots, ganzzahlig. Für q = Volumen und
// b = Taker-Buy-Volumen getrennt:
//   D(m) = unser(m) − kline(m);  s(m) = s(m−1) + D(m)  (Übertrag nach m+1, s(−1) aus dem Vortag)
//   exact    : D = 0 und s = 0 (q und b)
//   shift    : sonst, wenn −cand(m−1) ≤ D(m) ≤ cand(m) und 0 ≤ s(m) ≤ cand(m) (q und b)
//   mismatch : sonst; danach wird s auf [0, cand(m)] begrenzt
//   missing  : Kline mit Volumen > 0 ohne eigene Zeile oder umgekehrt (s wie bei mismatch begrenzt)
//   edge_pending : Minute 0 / 1439, solange der Nachbartag nicht abgeglichen ist
import { MINUTES_PER_DAY } from '../time.ts';

export const MinuteClass = {
  exact: 1,
  shift: 2,
  mismatch: 3,
  edge_pending: 4,
  missing: 5,
} as const;
export type MinuteClassCode = (typeof MinuteClass)[keyof typeof MinuteClass];
export const CLASS_NAMES: Record<MinuteClassCode, string> = {
  1: 'exact',
  2: 'shift',
  3: 'mismatch',
  4: 'edge_pending',
  5: 'missing',
};

/**
 * bar_1m.check_state (KONZEPT §3.5: 0 ungeprüft, 1 exact, 2 shift, 3 mismatch, 4 edge_pending).
 * `missing` hat dort keinen eigenen Code; eine eigene Zeile ohne Kline wird als 3 gespeichert, die
 * Art steht in data_day.min_missing und data_minute_issue.kind = 'missing'.
 */
export function checkStateOf(c: MinuteClassCode): number {
  return c === MinuteClass.missing ? MinuteClass.mismatch : c;
}

export interface Carry {
  q: number;
  b: number;
}

/** Eingaben je Minute des Tages (Länge 1440). */
export interface ReconcileInput {
  ourQ: Float64Array;
  ourB: Float64Array;
  /** Eigene bar_1m-Zeile vorhanden. */
  hasRow: Uint8Array;
  klQ: Float64Array;
  klB: Float64Array;
  /** Kline-Zeile vorhanden. */
  hasKline: Uint8Array;
  candQ: Float64Array;
  candB: Float64Array;
}

export interface NeighbourIn {
  /** Übertrag s(1439) des Vortags. */
  carry: Carry;
  /** cand(1439) des Vortags (untere Hüllgrenze für Minute 0). */
  cand: Carry;
}

export interface ReconcileOptions {
  /** Vortag abgeglichen → Übertrag bekannt; sonst Minute 0 edge_pending und s(−1) geschätzt. */
  prev?: NeighbourIn | undefined;
  /** Folgetag abgeglichen (dessen Minute 0 hat unseren Übertrag benutzt) → Minute 1439 entschieden. */
  nextReconciled?: boolean;
}

export interface ReconcileResult {
  /** Endgültige Klasse je Minute (edge_pending an offenen Tagesrändern). */
  cls: Uint8Array;
  /** Klasse ohne Randvorbehalt (für Bericht und spätere Auflösung). */
  ownCls: Uint8Array;
  dQ: Float64Array;
  dB: Float64Array;
  /** Übertrag nach der Minute (nach eventueller Begrenzung). */
  sQ: Float64Array;
  sB: Float64Array;
  carryIn: Carry;
  carryInKnown: boolean;
  /** Aus dem Tag selbst geschätzter Übertrag s(−1) (erste Minute ohne Kandidaten erzwingt s = 0). */
  carryInInferred: Carry;
  carryOut: Carry;
  candLast: Carry;
  counts: Record<'exact' | 'shift' | 'mismatch' | 'missing' | 'edge_pending', number>;
  /** Minuten mit D_q = 0 bzw. D_b = 0 (Vergleich mit der Messung „exakt nach T"). */
  exactQ: number;
  exactB: number;
  totals: {
    ourQ: number;
    klQ: number;
    ourB: number;
    klB: number;
    /** Σ unser − Σ kline = s(1439) − s(−1) (gilt, solange keine Begrenzung nötig war). */
    identityQ: boolean;
    identityB: boolean;
    /** Überträge innerhalb ihrer Kandidatengrenzen. */
    carryBoundsOk: boolean;
  };
}

/** s(−1) aus dem Tag: in der ersten Minute ohne Kandidat muss s = 0 gelten. */
export function inferCarryIn(d: Float64Array, cand: Float64Array): number {
  let pre = 0;
  for (let m = 0; m < d.length; m++) {
    pre += d[m]!;
    if (cand[m] === 0) return Math.max(0, -pre);
  }
  return Math.max(0, -(d[0] ?? 0));
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function reconcileDay(inp: ReconcileInput, opt: ReconcileOptions = {}): ReconcileResult {
  const n = MINUTES_PER_DAY;
  for (const a of [
    inp.ourQ,
    inp.ourB,
    inp.hasRow,
    inp.klQ,
    inp.klB,
    inp.hasKline,
    inp.candQ,
    inp.candB,
  ]) {
    if (a.length !== n) throw new Error('reconcileDay: Eingaben müssen 1440 Minuten haben');
  }
  const dQ = new Float64Array(n);
  const dB = new Float64Array(n);
  let ourQ = 0;
  let klQ = 0;
  let ourB = 0;
  let klB = 0;
  for (let m = 0; m < n; m++) {
    const kq = inp.hasKline[m] ? inp.klQ[m]! : 0;
    const kb = inp.hasKline[m] ? inp.klB[m]! : 0;
    dQ[m] = inp.ourQ[m]! - kq;
    dB[m] = inp.ourB[m]! - kb;
    ourQ += inp.ourQ[m]!;
    ourB += inp.ourB[m]!;
    klQ += kq;
    klB += kb;
  }
  const inferred: Carry = { q: inferCarryIn(dQ, inp.candQ), b: inferCarryIn(dB, inp.candB) };
  const known = opt.prev !== undefined;
  const carryIn: Carry = known ? { ...opt.prev!.carry } : inferred;
  const prevCand: Carry | undefined = known ? opt.prev!.cand : undefined;

  const cls = new Uint8Array(n);
  const ownCls = new Uint8Array(n);
  const sQ = new Float64Array(n);
  const sB = new Float64Array(n);
  let clamped = false;
  let prevSQ = carryIn.q;
  let prevSB = carryIn.b;
  for (let m = 0; m < n; m++) {
    const cq = inp.candQ[m]!;
    const cb = inp.candB[m]!;
    // Untere Hülle: cand der Vorminute; für Minute 0 die des Vortags (unbekannt → nicht geprüft).
    const lq = m > 0 ? inp.candQ[m - 1]! : prevCand ? prevCand.q : Infinity;
    const lb = m > 0 ? inp.candB[m - 1]! : prevCand ? prevCand.b : Infinity;
    const d1 = dQ[m]!;
    const d2 = dB[m]!;
    let s1 = prevSQ + d1;
    let s2 = prevSB + d2;
    const klinePos = inp.hasKline[m] === 1 && inp.klQ[m]! > 0;
    const own = inp.hasRow[m] === 1;
    let c: number;
    if (own !== klinePos) {
      c = MinuteClass.missing;
    } else if (d1 === 0 && d2 === 0 && s1 === 0 && s2 === 0) {
      c = MinuteClass.exact;
    } else if (
      -lq <= d1 &&
      d1 <= cq &&
      0 <= s1 &&
      s1 <= cq &&
      -lb <= d2 &&
      d2 <= cb &&
      0 <= s2 &&
      s2 <= cb
    ) {
      c = MinuteClass.shift;
    } else {
      c = MinuteClass.mismatch;
    }
    if (c === MinuteClass.mismatch || c === MinuteClass.missing) {
      const c1 = clamp(s1, 0, cq);
      const c2 = clamp(s2, 0, cb);
      if (c1 !== s1 || c2 !== s2) clamped = true;
      s1 = c1;
      s2 = c2;
    }
    sQ[m] = s1;
    sB[m] = s2;
    prevSQ = s1;
    prevSB = s2;
    ownCls[m] = c;
    cls[m] = c;
  }
  if (!known) cls[0] = MinuteClass.edge_pending;
  if (!opt.nextReconciled) cls[n - 1] = MinuteClass.edge_pending;

  const counts = { exact: 0, shift: 0, mismatch: 0, missing: 0, edge_pending: 0 };
  let exactQ = 0;
  let exactB = 0;
  for (let m = 0; m < n; m++) {
    counts[CLASS_NAMES[cls[m] as MinuteClassCode] as keyof typeof counts]++;
    if (dQ[m] === 0) exactQ++;
    if (dB[m] === 0) exactB++;
  }
  const carryOut: Carry = { q: sQ[n - 1]!, b: sB[n - 1]! };
  const candLast: Carry = { q: inp.candQ[n - 1]!, b: inp.candB[n - 1]! };
  const identityQ = !clamped && ourQ - klQ === carryOut.q - carryIn.q;
  const identityB = !clamped && ourB - klB === carryOut.b - carryIn.b;
  const carryBoundsOk =
    carryOut.q >= 0 &&
    carryOut.q <= candLast.q &&
    carryOut.b >= 0 &&
    carryOut.b <= candLast.b &&
    carryIn.q >= 0 &&
    carryIn.b >= 0 &&
    (!prevCand || (carryIn.q <= prevCand.q && carryIn.b <= prevCand.b));
  return {
    cls,
    ownCls,
    dQ,
    dB,
    sQ,
    sB,
    carryIn,
    carryInKnown: known,
    carryInInferred: inferred,
    carryOut,
    candLast,
    counts,
    exactQ,
    exactB,
    totals: { ourQ, klQ, ourB, klB, identityQ, identityB, carryBoundsOk },
  };
}
