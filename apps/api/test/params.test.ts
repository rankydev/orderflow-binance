// Parameterprüfung (strikt): kanonische Ganzzahlen, Grenzen, unbekannte/doppelte/leere Parameter,
// Zeitrahmen, Leiter, Ausrichtung; Konfiguration und CORS.
import { describe, expect, it } from 'vitest';
import { corsAllowed, parseApiConfig } from '../src/config.ts';
import { HttpError } from '../src/errors.ts';
import { checkRange, isLadderR, Params } from '../src/params.ts';

const status = (fn: () => unknown): number | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof HttpError ? e.status : -1;
  }
};

describe('Params', () => {
  it('liest kanonische Ganzzahlen und lehnt alles andere mit 400 ab', () => {
    expect(new Params({ a: '0' }).int('a', 0, 10)).toBe(0);
    expect(new Params({ a: '-5' }).int('a', -10, 10)).toBe(-5);
    expect(new Params({}).int('a', 0, 10, 7)).toBe(7);
    for (const bad of [
      '01',
      '1e3',
      '1.0',
      ' 1',
      '+1',
      '0x10',
      '',
      '1_000',
      '９',
      '-0',
      'NaN',
      '99999999999999999',
    ])
      expect(
        status(() => new Params({ a: bad }).int('a', -1e18, 1e18)),
        bad,
      ).toBe(400);
    expect(status(() => new Params({ a: '11' }).int('a', 0, 10))).toBe(400);
    expect(status(() => new Params({}).int('a', 0, 10))).toBe(400);
    expect(status(() => new Params({ a: ['1', '2'] }).int('a', 0, 10))).toBe(400);
  });

  it('unbekannte Parameter → 400 (done)', () => {
    const p = new Params({ sym: 'BTCUSDT', x: '1' });
    p.str('sym', /^[A-Z]+$/);
    expect(status(() => p.done())).toBe(400);
    const q = new Params({ sym: 'BTCUSDT' });
    q.str('sym', /^[A-Z]+$/);
    expect(status(() => q.done())).toBeNull();
  });

  it('Zeitrahmen nur aus der Liste; Symbol nach Muster', () => {
    expect(new Params({ tf: '15m' }).tf()).toBe('15m');
    for (const tf of ['1M', '1w', '7m', '60s', '1h '])
      expect(
        status(() => new Params({ tf }).tf()),
        tf,
      ).toBe(400);
    expect(status(() => new Params({ sym: "BTC'; DROP" }).str('sym', /^[A-Z0-9]{2,20}$/))).toBe(
      400,
    );
  });

  it('Leiter {1,2,5}·10^k', () => {
    const on = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 10_000, 500_000];
    const off = [0, 3, 4, 15, 25, 30, 150, 250, 1001, -1, 1.5];
    for (const r of on) expect(isLadderR(r), String(r)).toBe(true);
    for (const r of off) expect(isLadderR(r), String(r)).toBe(false);
  });

  it('checkRange: Ausrichtung, nicht leer, im Format', () => {
    expect(status(() => checkRange(60_000, 120_000, 60_000, 'x'))).toBeNull();
    expect(status(() => checkRange(60_001, 120_000, 60_000, 'x'))).toBe(400);
    expect(status(() => checkRange(120_000, 120_000, 60_000, 'x'))).toBe(400);
    expect(status(() => checkRange(0, 2 ** 32 * 1000, 1000, 'x'))).toBe(400);
  });
});

describe('Konfiguration', () => {
  const env = { OF_DB_PASSWORD: 'admin-secret', OF_API_DB_PASSWORD: 'api-secret-0123456789' };
  it('nutzt die API-Rolle, nie die Admin-Zugangsdaten; Standard 127.0.0.1', () => {
    const c = parseApiConfig(env);
    expect(c.db.user).toBe('of_api');
    expect(c.db.password).toBe('api-secret-0123456789');
    expect(c.host).toBe('127.0.0.1');
    expect(c.maxSourceRows).toBe(1_500_000);
    expect(c.maxCells).toBe(60_000);
  });
  it('fehlendes API-Passwort, Admin-Rolle als API-Rolle, ungültige Zahlen → Fehler', () => {
    expect(() => parseApiConfig({ OF_DB_PASSWORD: 'x' })).toThrow(/OF_API_DB_PASSWORD/);
    expect(() =>
      parseApiConfig({ ...env, OF_DB_USER: 'of_admin', OF_API_DB_USER: 'of_admin' }),
    ).toThrow(/Admin-Rolle/);
    expect(() => parseApiConfig({ ...env, OF_API_PORT: '70000' })).toThrow(/OF_API_PORT/);
    expect(() => parseApiConfig({ ...env, OF_API_CORS_ORIGINS: 'evil' })).toThrow(/CORS/);
  });
  it('CORS: loopback (Standard), Liste, *', () => {
    expect(corsAllowed('loopback', 'http://127.0.0.1:5174')).toBe(true);
    expect(corsAllowed('loopback', 'http://localhost')).toBe(true);
    expect(corsAllowed('loopback', 'https://example.com')).toBe(false);
    expect(corsAllowed('loopback', 'http://127.0.0.1.evil.com')).toBe(false);
    expect(corsAllowed(['https://of.example'], 'https://of.example')).toBe(true);
    expect(corsAllowed(['https://of.example'], 'https://of.example:444')).toBe(false);
    expect(corsAllowed('*', 'https://any')).toBe(true);
  });
});
