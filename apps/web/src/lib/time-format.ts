// Anzeige von Zeitpunkten in Ortszeit (Standard) oder UTC. Nur Anzeige: Anfragen, Kachel-/Bar-Schlüssel,
// Tagesgrenzen (UTC + offsetH) und URL-Parameter bleiben UTC. Die Zeitzone kommt aus Intl (IANA-Regeln,
// Sommerzeit je Zeitpunkt), kein fest verdrahteter Offset.
import { TickMarkType } from 'lightweight-charts';

/** Einstellung der Anzeige; URL: `tz=utc`, Standard Ortszeit. */
export type ZoneSetting = 'local' | 'utc';

/** IANA-Zone für Intl; undefined = Zone des Browsers. */
export type Zone = string | undefined;

export function zoneOf(setting: ZoneSetting): Zone {
  return setting === 'utc' ? 'UTC' : undefined;
}

export function parseZoneSetting(q: URLSearchParams): ZoneSetting {
  return q.get('tz')?.toLowerCase() === 'utc' ? 'utc' : 'local';
}

export function zoneSettingQuery(s: ZoneSetting): string {
  return s === 'utc' ? '&tz=utc' : '';
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(zone: Zone): Intl.DateTimeFormat {
  const key = zone ?? '';
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    fmtCache.set(key, f);
  }
  return f;
}

/** Offset der Zone zum Zeitpunkt ms in Minuten (Ortszeit − UTC), sommerzeitrichtig. */
export function zoneOffsetMinutes(ms: number, zone: Zone): number {
  if (zone === 'UTC') return 0;
  const sec = Math.floor(ms / 1000) * 1000;
  const p: Record<string, number> = {};
  for (const x of dtf(zone).formatToParts(sec))
    if (x.type !== 'literal') p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
  return Math.round((asUtc - sec) / 60_000);
}

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

function parts(ms: number, zone: Zone): Parts {
  const t = new Date(ms + zoneOffsetMinutes(ms, zone) * 60_000);
  return {
    y: t.getUTCFullYear(),
    mo: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    h: t.getUTCHours(),
    mi: t.getUTCMinutes(),
  };
}

const p2 = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** „YYYY-MM-DD HH:mm" in der Zone. */
export function formatDateTime(ms: number, zone: Zone): string {
  const p = parts(ms, zone);
  return `${p.y}-${p2(p.mo)}-${p2(p.d)} ${p2(p.h)}:${p2(p.mi)}`;
}

/** Kurze Zonenangabe zum Zeitpunkt: „UTC", „UTC+1", „UTC+5:30", „UTC−3:30". */
export function zoneLabel(ms: number, zone: Zone): string {
  const off = zoneOffsetMinutes(ms, zone);
  if (off === 0) return 'UTC';
  const a = Math.abs(off);
  const hm = a % 60 === 0 ? `${a / 60}` : `${Math.floor(a / 60)}:${p2(a % 60)}`;
  return `UTC${off > 0 ? '+' : '−'}${hm}`;
}

/** IANA-Name der Browserzone (für den Tooltip der Zonenangabe). */
export function browserZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'lokal';
}

/**
 * Beschriftung einer Zeitachsenmarke (lightweight-charts tickMarkFormatter). Die Bibliothek gewichtet die
 * Marken nach UTC (Tageswechsel = 00:00 UTC). Eine Datumsmarke, die in der Zone nicht auf Mitternacht
 * fällt, zeigt deshalb Tag und Uhrzeit („25. 01:00"), damit kein falscher Kalendertag entsteht; sie
 * bleibt so (nicht nur „01:00"), weil sie bei grobem Zoom die einzige Marke mit Datum ist. Die Marke der
 * Ortsmitternacht (Typ Time) zeigt das Datum („25.").
 */
export function tickMarkLabel(sec: number, type: TickMarkType, zone: Zone): string {
  const p = parts(sec * 1000, zone);
  const midnight = p.h === 0 && p.mi === 0;
  switch (type) {
    case TickMarkType.Year:
      return midnight && p.mo === 1 && p.d === 1
        ? String(p.y)
        : `${p.d}. ${MONTHS[p.mo - 1]} ${p.y}`;
    case TickMarkType.Month:
      return midnight && p.d === 1 ? MONTHS[p.mo - 1]! : `${p.d}. ${MONTHS[p.mo - 1]}`;
    case TickMarkType.DayOfMonth:
      return midnight ? String(p.d) : `${p.d}. ${p2(p.h)}:${p2(p.mi)}`;
    case TickMarkType.Time:
      // Ortsmitternacht (die Bibliothek gewichtet sie nur als Stunde): Datum statt „00:00", damit der
      // Tageswechsel in der Anzeigezone sichtbar ist (1. des Monats: Monat, 1. Januar: Jahr)
      if (midnight) return p.d !== 1 ? `${p.d}.` : p.mo !== 1 ? MONTHS[p.mo - 1]! : String(p.y);
      return `${p2(p.h)}:${p2(p.mi)}`;
    case TickMarkType.TimeWithSeconds: {
      const s = new Date(sec * 1000).getUTCSeconds();
      return `${p2(p.h)}:${p2(p.mi)}:${p2(s)}`;
    }
  }
  return `${p2(p.h)}:${p2(p.mi)}`;
}

/**
 * Bezeichnung eines Sitzungstags (Tagesprofil/TPO, Beginn UTC + offsetH): das UTC-Datum des Beginns
 * bleibt der Name des Tags (wie die API), damit kein Tag auf ein anderes Kalenderdatum rutscht; der
 * Beginn steht in der Anzeigezone dabei. UTC: „2026-11-24 ab 00:00"; Ortszeit: „2026-11-24 UTC · ab
 * 01:00", bei anderem Ortsdatum „2026-11-24 UTC · ab 23.11. 19:00".
 */
export function sessionLabel(dayStartMs: number, zone: Zone): string {
  const iso = new Date(dayStartMs).toISOString();
  const date = iso.slice(0, 10);
  if (zoneOffsetMinutes(dayStartMs, zone) === 0) return `${date} ab ${iso.slice(11, 16)}`;
  const p = parts(dayStartMs, zone);
  const sameDay = `${p.y}-${p2(p.mo)}-${p2(p.d)}` === date;
  const at = `${sameDay ? '' : `${p2(p.d)}.${p2(p.mo)}. `}${p2(p.h)}:${p2(p.mi)}`;
  return `${date} UTC · ab ${at}`;
}

// ------------------------------------------------------------- aktuelle Anzeigezone (eine je Seite)

let current: ZoneSetting = 'local';

export function setDisplayZone(s: ZoneSetting): void {
  current = s;
}

export function displayZoneSetting(): ZoneSetting {
  return current;
}

export function displayZone(): Zone {
  return zoneOf(current);
}

/** „YYYY-MM-DD HH:mm" in der Anzeigezone. */
export function fmtShown(ms: number): string {
  return formatDateTime(ms, displayZone());
}

/** „YYYY-MM-DD HH:mm UTC+1" in der Anzeigezone, mit Zonenangabe. */
export function fmtShownZ(ms: number): string {
  return `${fmtShown(ms)} ${zoneLabel(ms, displayZone())}`;
}

/**
 * Kurzformen einer Sitzungsbezeichnung, längste zuerst: volle Bezeichnung, nur das UTC-Datum, nichts.
 * (Kopf der TPO-Spalten: die erste, die in die Spaltenbreite passt.)
 */
export function sessionLabelForms(dayStartMs: number, zone: Zone): string[] {
  const full = sessionLabel(dayStartMs, zone);
  const date = new Date(dayStartMs).toISOString().slice(0, 10);
  return full === date ? [full, ''] : [full, date, ''];
}

/** Erste Form, deren Breite (gleiche Reihenfolge) in avail passt; '' wenn keine. */
export function fitLabel(
  forms: readonly string[],
  widths: readonly number[],
  avail: number,
): string {
  for (let i = 0; i < forms.length; i++)
    if (forms[i] === '' || widths[i]! <= avail) return forms[i]!;
  return '';
}
