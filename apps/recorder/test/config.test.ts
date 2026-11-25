// Server-Konfiguration des Recorders: eigene Rolle, nie Admin-Zugangsdaten; Bind-Adresse.
import { describe, expect, it } from 'vitest';
import { recorderConfig, recorderDbConfig } from '../src/main.ts';

describe('recorderDbConfig', () => {
  const base = { OF_DB_HOST: 'db', OF_DB_PORT: '5432', OF_DB_NAME: 'orderflow' };
  it('nimmt Rolle und Passwort aus OF_RECORDER_DB_*, Host/Port/Name aus OF_DB_*', () => {
    const c = recorderDbConfig({
      ...base,
      OF_DB_USER: 'of_admin',
      OF_DB_PASSWORD: 'admin-secret',
      OF_RECORDER_DB_PASSWORD: 'rec-secret-0123456789',
    });
    expect(c).toEqual({
      host: 'db',
      port: 5432,
      database: 'orderflow',
      user: 'of_recorder',
      password: 'rec-secret-0123456789',
    });
  });
  it('ohne Recorder-Passwort kein Start (Admin-Passwort wird nie übernommen)', () => {
    expect(() =>
      recorderDbConfig({ ...base, OF_DB_USER: 'of_admin', OF_DB_PASSWORD: 'admin-secret' }),
    ).toThrow(/OF_RECORDER_DB_PASSWORD fehlt/);
  });
  it('Admin-Rolle als Recorder-Rolle verweigert', () => {
    expect(() =>
      recorderDbConfig({
        ...base,
        OF_DB_USER: 'of_admin',
        OF_RECORDER_DB_USER: 'of_admin',
        OF_RECORDER_DB_PASSWORD: 'x-0123456789abcdef',
      }),
    ).toThrow(/Admin-Rolle/);
  });
});

describe('recorderConfig', () => {
  it('Health standardmäßig nur auf Loopback, Bind-Adresse einstellbar', () => {
    expect(recorderConfig({}).httpHost).toBe('127.0.0.1');
    expect(recorderConfig({ OF_RECORDER_HTTP_HOST: '0.0.0.0' }).httpHost).toBe('0.0.0.0');
  });
});
