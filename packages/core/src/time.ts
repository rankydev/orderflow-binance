// Zeitregeln (KONZEPT §3.3): Minute und UTC-Tag eines aggTrades ausschließlich per Ganzzahl-Rest.
import { DAY_MS, MINUTE_MS } from './constants.ts';

export const MINUTES_PER_DAY = 1440;

/** Minutenbeginn (ms) von T: T − (T mod 60 000). T ist eine nichtnegative ganze Zahl. */
export function minuteStart(t: number): number {
  return t - (t % MINUTE_MS);
}

/** UTC-Tagesindex seit Epoch: floor(T / 86 400 000) (ganzzahlig über den Rest). */
export function dayIndex(t: number): number {
  return (t - (t % DAY_MS)) / DAY_MS;
}

/** Minute innerhalb des UTC-Tages (0…1439). */
export function minuteOfDay(t: number): number {
  return ((t % DAY_MS) - (t % MINUTE_MS)) / MINUTE_MS;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' → Tagesindex; strikt (ungültige Kalendertage werden abgelehnt). */
export function parseDay(s: string): number {
  const m = DAY_RE.exec(s);
  if (!m) throw new Error(`Ungültiges Datum "${s}" (erwartet YYYY-MM-DD)`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const idx = ms / DAY_MS;
  if (formatDay(idx) !== s) throw new Error(`Ungültiges Kalenderdatum "${s}"`);
  return idx;
}

export function formatDay(idx: number): string {
  return new Date(idx * DAY_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM' → [erster Tagesindex, letzter Tagesindex] des Monats. */
export function monthDays(month: string): [number, number] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Ungültiger Monat "${month}" (erwartet YYYY-MM)`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error(`Ungültiger Monat "${month}"`);
  const first = Date.UTC(y, mo - 1, 1) / DAY_MS;
  const next = Date.UTC(y, mo, 1) / DAY_MS;
  return [first, next - 1];
}

export function monthOfDay(idx: number): string {
  return formatDay(idx).slice(0, 7);
}

/**
 * Kanonische Textform eines Zeitpunkts wie Postgres `timestamptz` bei `timezone = 'UTC'` und
 * `datestyle = 'ISO'` ihn ausgibt (nur für sekundengenaue Werte; Bruchteile werden abgelehnt).
 */
export function pgTimestamptz(ms: number): string {
  if (ms % 1000 !== 0) throw new Error(`pgTimestamptz: Zeitpunkt ${ms} hat Millisekunden`);
  const iso = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:SS.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}+00`;
}

/**
 * Wie pgTimestamptz, aber mit Millisekunden (big_order.ts = T der Order): Postgres gibt den
 * Sekundenbruch ohne abschließende Nullen aus („…:05.12+00" für 120 ms, ganz ohne bei 0 ms).
 */
export function pgTimestamptzMs(ms: number): string {
  if (!Number.isSafeInteger(ms)) throw new Error(`pgTimestamptzMs: ${ms} ist keine Ganzzahl`);
  const iso = new Date(ms).toISOString();
  const frac = iso.slice(20, 23).replace(/0+$/, '');
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${frac ? `.${frac}` : ''}+00`;
}
