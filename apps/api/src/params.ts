// Strikte Prüfung der Query-Parameter (rein). Jeder Endpunkt nennt seine Parameter; unbekannte,
// doppelte oder leere Parameter sind ein 400. Zahlen nur in kanonischer Dezimalform (keine
// führenden Nullen, kein Exponent, kein Vorzeichen außer bei Offsets). SQL entsteht nie aus diesen
// Zeichenketten, sondern nur aus den geprüften Werten (Whitelists, Ganzzahlen).
import { isTimeframe, TIMEFRAMES, type Timeframe } from '@orderflow/core';
import { badRequest } from './errors.ts';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
/** Größter Zeitpunkt (ms), den das Kachelformat abbilden kann (Int32-Sekunden). */
export const MAX_TIME_MS = 2 ** 31 * 1000;

export type RawQuery = Record<string, unknown>;

export class Params {
  private readonly q: RawQuery;
  private readonly used = new Set<string>();
  constructor(q: unknown) {
    this.q = (q && typeof q === 'object' ? q : {}) as RawQuery;
  }

  private raw(name: string, required: boolean): string | undefined {
    this.used.add(name);
    const v = this.q[name];
    if (v === undefined) {
      if (required) throw badRequest(`Parameter ${name} fehlt`);
      return undefined;
    }
    if (typeof v !== 'string') throw badRequest(`Parameter ${name} mehrfach oder ungültig`);
    if (v.length === 0) throw badRequest(`Parameter ${name} ist leer`);
    if (v.length > 64) throw badRequest(`Parameter ${name} zu lang`);
    return v;
  }

  str(name: string, re: RegExp): string {
    const v = this.raw(name, true)!;
    if (!re.test(v)) throw badRequest(`Parameter ${name} ungültig`);
    return v;
  }

  int(name: string, min: number, max: number): number;
  int(name: string, min: number, max: number, def: number): number;
  int(name: string, min: number, max: number, def?: number): number {
    const v = this.raw(name, def === undefined);
    if (v === undefined) return def!;
    if (!/^(0|-?[1-9]\d{0,15})$/.test(v)) throw badRequest(`Parameter ${name} ist keine Ganzzahl`);
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw badRequest(`Parameter ${name} außerhalb ${min}…${max}`);
    return n;
  }

  tf(name = 'tf'): Timeframe {
    const v = this.raw(name, true)!;
    if (!isTimeframe(v))
      throw badRequest(`Zeitrahmen ${v} unbekannt (${Object.keys(TIMEFRAMES).join(', ')})`);
    return v;
  }

  /** Keine weiteren Parameter als die abgefragten (nach allen Zugriffen aufrufen). */
  done(): void {
    for (const k of Object.keys(this.q)) {
      if (!this.used.has(k)) throw badRequest(`unbekannter Parameter ${k}`);
    }
  }
}

export const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;

/** Zeilengröße der Leiter {1, 2, 5}·10^k Ticks (KONZEPT §3.6, §6.1). */
export function isLadderR(r: number): boolean {
  if (!Number.isSafeInteger(r) || r < 1) return false;
  let p = 1;
  while (p <= r) {
    if (r === p || r === 2 * p || r === 5 * p) return true;
    p *= 10;
  }
  return false;
}

/** Zeitraum [from, to) in ms: ausgerichtet an `alignMs`, nicht leer, innerhalb [0, MAX_TIME_MS]. */
export function checkRange(from: number, to: number, alignMs: number, what: string): void {
  if (from % alignMs !== 0 || to % alignMs !== 0)
    throw badRequest(`${what}: from/to nicht an ${alignMs / 1000} s ausgerichtet`);
  if (to <= from) throw badRequest(`${what}: to muss größer als from sein`);
  if (from < 0 || to > MAX_TIME_MS) throw badRequest(`${what}: Zeitraum außerhalb des Formats`);
}
