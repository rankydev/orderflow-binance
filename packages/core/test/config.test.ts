import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ConfigError, isLocalHost, parseConfig } from '../src/index.ts';

describe('parseConfig', () => {
  it('übernimmt Werte und setzt Standardwerte', () => {
    const cfg = parseConfig({ OF_DB_PASSWORD: 'pw' });
    expect(cfg.db).toEqual({
      host: '127.0.0.1',
      port: 54320,
      user: 'of_admin',
      password: 'pw',
      database: 'orderflow',
    });
    expect(cfg.dataDir).toBe('data');
    expect(cfg.logLevel).toBe('info');
  });

  it('verlangt das Passwort (kein Standardwert im Code)', () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
  });

  it('meldet alle Probleme auf einmal', () => {
    try {
      parseConfig({ OF_DB_PORT: 'abc', OF_LOG_LEVEL: 'x' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems).toHaveLength(3);
    }
  });

  it('akzeptiert genau gültige Ports', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10, max: 70000 }), (p) => {
        const valid = p >= 1 && p <= 65535;
        const run = () => parseConfig({ OF_DB_PASSWORD: 'pw', OF_DB_PORT: String(p) });
        if (valid) expect(run().db.port).toBe(p);
        else expect(run).toThrow(ConfigError);
      }),
    );
  });
});

describe('isLocalHost', () => {
  it('erkennt nur Loopback', () => {
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('10.0.0.5')).toBe(false);
    expect(isLocalHost('db.example.com')).toBe(false);
  });
});
