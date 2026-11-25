// Anzeige in Ortszeit/UTC (time-format.ts): Sommerzeitwechsel, Halbstunden-Zonen, Achsenmarken,
// Sitzungstage ohne falschen Kalendertag, URL-Parameter.
import { describe, expect, it } from 'vitest';
import { TickMarkType } from 'lightweight-charts';
import {
  fitLabel,
  formatDateTime,
  sessionLabelForms,
  parseZoneSetting,
  sessionLabel,
  tickMarkLabel,
  zoneLabel,
  zoneOf,
  zoneOffsetMinutes,
  zoneSettingQuery,
} from '../src/lib/time-format.ts';

const ZRH = 'Europe/Zurich';
const H = 3_600_000;
const u = (s: string) => Date.parse(`${s}Z`);

describe('Europe/Zurich: Sommerzeitbeginn 2026-03-29', () => {
  it('01:00 UTC springt von UTC+1 auf UTC+2', () => {
    expect(zoneOffsetMinutes(u('2026-03-29T00:59:59'), ZRH)).toBe(60);
    expect(zoneOffsetMinutes(u('2026-03-29T01:00:00'), ZRH)).toBe(120);
    expect(formatDateTime(u('2026-03-29T00:30'), ZRH)).toBe('2026-03-29 01:30');
    // 02:00–03:00 Ortszeit gibt es nicht: 00:59 → 01:59, 01:00 → 03:00
    expect(formatDateTime(u('2026-03-29T00:59'), ZRH)).toBe('2026-03-29 01:59');
    expect(formatDateTime(u('2026-03-29T01:00'), ZRH)).toBe('2026-03-29 03:00');
    expect(zoneLabel(u('2026-03-29T00:00'), ZRH)).toBe('UTC+1');
    expect(zoneLabel(u('2026-03-29T02:00'), ZRH)).toBe('UTC+2');
  });
});

describe('Europe/Zurich: Sommerzeitende 2026-10-25', () => {
  it('02:00–03:00 Ortszeit kommt zweimal vor, UTC eindeutig', () => {
    expect(formatDateTime(u('2026-10-25T00:30'), ZRH)).toBe('2026-10-25 02:30');
    expect(formatDateTime(u('2026-10-25T01:30'), ZRH)).toBe('2026-10-25 02:30');
    expect(zoneLabel(u('2026-10-25T00:30'), ZRH)).toBe('UTC+2');
    expect(zoneLabel(u('2026-10-25T01:30'), ZRH)).toBe('UTC+1');
  });
  it('UTC-Tagesgrenze fällt auf 02:00 bzw. 01:00 Ortszeit, Tag bleibt der UTC-Tag', () => {
    expect(sessionLabel(u('2026-10-25T00:00'), ZRH)).toBe('2026-10-25 UTC · ab 02:00');
    expect(sessionLabel(u('2026-10-26T00:00'), ZRH)).toBe('2026-10-26 UTC · ab 01:00');
  });
});

describe('Halbstunden-Zonen', () => {
  it('Asia/Kolkata UTC+5:30', () => {
    expect(zoneLabel(u('2026-11-25T00:00'), 'Asia/Kolkata')).toBe('UTC+5:30');
    expect(formatDateTime(u('2026-11-25T20:00'), 'Asia/Kolkata')).toBe('2026-11-26 01:30');
  });
  it('America/St_Johns UTC−3:30 (Winter) / UTC−2:30 (Sommer)', () => {
    expect(zoneLabel(u('2026-11-25T12:00'), 'America/St_Johns')).toBe('UTC−3:30');
    expect(zoneLabel(u('2026-07-01T12:00'), 'America/St_Johns')).toBe('UTC−2:30');
    expect(formatDateTime(u('2026-11-25T02:00'), 'America/St_Johns')).toBe('2026-11-24 22:30');
  });
  it('Sitzungstag westlich von UTC: UTC-Datum bleibt, Beginn mit Ortsdatum', () => {
    expect(sessionLabel(u('2026-11-25T00:00'), 'America/St_Johns')).toBe(
      '2026-11-25 UTC · ab 24.11. 20:30',
    );
  });
});

describe('UTC-Anzeige', () => {
  it('unverändert wie bisher', () => {
    expect(formatDateTime(u('2026-11-25T13:07'), 'UTC')).toBe('2026-11-25 13:07');
    expect(zoneLabel(u('2026-11-25T13:07'), 'UTC')).toBe('UTC');
    expect(sessionLabel(u('2026-11-25T00:00'), 'UTC')).toBe('2026-11-25 ab 00:00');
    expect(sessionLabel(u('2026-11-24T22:00'), 'UTC')).toBe('2026-11-24 ab 22:00');
  });
});

describe('Zeitachsenmarken', () => {
  const s = (iso: string) => u(iso) / 1000;
  it('Uhrzeit in der Zone', () => {
    expect(tickMarkLabel(s('2026-11-25T13:00'), TickMarkType.Time, ZRH)).toBe('14:00');
    expect(tickMarkLabel(s('2026-11-25T13:00:30'), TickMarkType.TimeWithSeconds, ZRH)).toBe(
      '14:00:30',
    );
    expect(tickMarkLabel(s('2026-11-25T13:00'), TickMarkType.Time, 'Asia/Kolkata')).toBe('18:30');
  });
  it('Tagesmarke (00:00 UTC) ist in Zürich 01:00: Tag und Uhrzeit, kein falscher Tag', () => {
    expect(tickMarkLabel(s('2026-11-25T00:00'), TickMarkType.DayOfMonth, ZRH)).toBe('25. 01:00');
    expect(tickMarkLabel(s('2026-11-25T00:00'), TickMarkType.DayOfMonth, 'UTC')).toBe('25');
    // westlich: 00:00 UTC ist noch der Vortag
    expect(tickMarkLabel(s('2026-11-25T00:00'), TickMarkType.DayOfMonth, 'America/St_Johns')).toBe(
      '24. 20:30',
    );
  });
  it('Monats-/Jahresmarken', () => {
    expect(tickMarkLabel(s('2026-11-01T00:00'), TickMarkType.Month, 'UTC')).toBe('Nov');
    expect(tickMarkLabel(s('2026-11-01T00:00'), TickMarkType.Month, ZRH)).toBe('1. Nov');
    expect(tickMarkLabel(s('2026-01-01T00:00'), TickMarkType.Year, 'UTC')).toBe('2026');
    expect(tickMarkLabel(s('2026-01-01T00:00'), TickMarkType.Year, 'America/St_Johns')).toBe(
      '31. Dez 2025',
    );
  });
});

describe('Einstellung und URL', () => {
  it('Standard Ortszeit, tz=utc schaltet um; URL nur bei UTC', () => {
    expect(parseZoneSetting(new URLSearchParams(''))).toBe('local');
    expect(parseZoneSetting(new URLSearchParams('tz=utc'))).toBe('utc');
    expect(parseZoneSetting(new URLSearchParams('tz=xyz'))).toBe('local');
    expect(zoneSettingQuery('local')).toBe('');
    expect(zoneSettingQuery('utc')).toBe('&tz=utc');
    expect(zoneOf('utc')).toBe('UTC');
    expect(zoneOf('local')).toBeUndefined();
  });
  it('Ortszeit = Zone des Prozesses (undefined an Intl)', () => {
    const t = u('2026-11-25T12:00');
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(zoneOffsetMinutes(t, undefined)).toBe(zoneOffsetMinutes(t, local));
    expect(zoneOffsetMinutes(t + H, undefined)).toBe(-new Date(t + H).getTimezoneOffset());
  });
});

describe('Folgeprüfung 86844d8', () => {
  it('tz=UTC/Utc ohne Rücksicht auf Groß-/Kleinschreibung, ausgegeben klein', () => {
    expect(parseZoneSetting(new URLSearchParams('tz=UTC'))).toBe('utc');
    expect(parseZoneSetting(new URLSearchParams('tz=Utc'))).toBe('utc');
    expect(zoneSettingQuery(parseZoneSetting(new URLSearchParams('tz=UTC')))).toBe('&tz=utc');
  });
  it('Ortsmitternacht trägt das Datum, 00:00-UTC-Marke bleibt Tag + Uhrzeit', () => {
    const s = (iso: string) => u(iso) / 1000;
    // 2026-11-24 23:00 UTC = 25.11. 00:00 Zürich (Stundenmarke der Bibliothek)
    expect(tickMarkLabel(s('2026-11-24T23:00'), TickMarkType.Time, ZRH)).toBe('25.');
    expect(tickMarkLabel(s('2026-11-25T00:00'), TickMarkType.DayOfMonth, ZRH)).toBe('25. 01:00');
    expect(tickMarkLabel(s('2026-11-25T01:00'), TickMarkType.Time, ZRH)).toBe('02:00');
    // Monats-/Jahreswechsel in Ortszeit
    expect(tickMarkLabel(s('2026-10-31T23:00'), TickMarkType.Time, ZRH)).toBe('Nov');
    expect(tickMarkLabel(s('2025-12-31T23:00'), TickMarkType.Time, ZRH)).toBe('2026');
    // Sommerzeit: Ortsmitternacht ist 22:00 UTC
    expect(tickMarkLabel(s('2026-07-14T22:00'), TickMarkType.Time, ZRH)).toBe('15.');
    // UTC-Anzeige: Time-Marken um 00:00 gibt es nicht als Time-Typ; falls doch, Datum
    expect(tickMarkLabel(s('2026-11-25T13:00'), TickMarkType.Time, 'UTC')).toBe('13:00');
  });
  it('Spaltenkopf: volle Form, sonst Datum, sonst nichts', () => {
    const forms = sessionLabelForms(u('2026-11-24T00:00'), 'America/St_Johns');
    expect(forms).toEqual(['2026-11-24 UTC · ab 23.11. 20:30', '2026-11-24', '']);
    expect(sessionLabelForms(u('2026-11-24T00:00'), 'UTC')).toEqual([
      '2026-11-24 ab 00:00',
      '2026-11-24',
      '',
    ]);
    const w = [180, 60, 0];
    expect(fitLabel(forms, w, 200)).toBe(forms[0]);
    expect(fitLabel(forms, w, 180)).toBe(forms[0]);
    expect(fitLabel(forms, w, 179)).toBe('2026-11-24');
    expect(fitLabel(forms, w, 59)).toBe('');
    expect(fitLabel(forms, w, -10)).toBe('');
  });
});
