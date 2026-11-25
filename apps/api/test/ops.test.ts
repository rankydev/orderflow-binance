// Regressionstests zum Review (Betrieb): SCRAM-Verifier statt Klartext (W4a), Zeitgrenzen- und
// Status-Listener-Konfiguration (W2/W3), Cache-Header (W5), Ablauf nicht finaler Cache-Einträge (W1),
// Verbindungsverlust → 503, gedrosselte Katalog-Warnungen bei ausgefallener Datenbank.
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ResponseCache } from '../src/cache.ts';
import { Catalog } from '../src/catalog.ts';
import { parseApiConfig } from '../src/config.ts';
import { isConnectionLoss, type Sql } from '../src/db.ts';
import { cacheControl } from '../src/http.ts';
import { alterRolePasswordSql, scramSha256Verifier } from '../src/scram.ts';

const env = { OF_DB_PASSWORD: 'admin-secret', OF_API_DB_PASSWORD: 'api-secret-0123456789' };

describe('SCRAM-SHA-256-Verifier (W4a)', () => {
  it('Postgres-Format, StoredKey/ServerKey nach RFC 5802, nie der Klartext', () => {
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const v = scramSha256Verifier('pencil', salt);
    const m = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(v)!;
    expect(m[1]).toBe('W22ZaJ0SNY7soEsUEjb6gQ==');
    const salted = pbkdf2Sync('pencil', salt, 4096, 32, 'sha256');
    const stored = createHash('sha256')
      .update(createHmac('sha256', salted).update('Client Key').digest())
      .digest('base64');
    expect(m[2]).toBe(stored);
    expect(m[3]).toBe(createHmac('sha256', salted).update('Server Key').digest('base64'));
    // RFC 7677, Beispiel „pencil": ServerKey aus der bekannten Server-Signatur nicht ableitbar,
    // aber deterministisch und je Salt verschieden
    expect(scramSha256Verifier('pencil', salt)).toBe(v);
    expect(scramSha256Verifier('pencil')).not.toBe(scramSha256Verifier('pencil'));
    const sql = alterRolePasswordSql('of_api', 'api-secret-0123456789');
    expect(sql).toMatch(/^ALTER ROLE "of_api" PASSWORD 'SCRAM-SHA-256\$4096:/);
    expect(sql).not.toContain('api-secret');
    expect(() => alterRolePasswordSql('of_api"; DROP', 'x'.repeat(20))).toThrow();
    expect(() => scramSha256Verifier('pass wort')).toThrow();
  });
});

describe('Konfiguration (W2, W3, Diagnose)', () => {
  it('Standardwerte: Zeitgrenzen 30 s, Keep-Alive über nginx (60 s), Status-Listener, Diagnose aus', () => {
    const c = parseApiConfig(env);
    expect(c.connectionTimeoutMs).toBe(30_000);
    expect(c.requestTimeoutMs).toBe(30_000);
    expect(c.keepAliveTimeoutMs).toBe(65_000);
    expect(c.maxRequestsPerSocket).toBe(1_000);
    expect(c.maxConnections).toBe(1_024);
    expect(c.adminPort).toBe(8781);
    expect(c.diagHeaders).toBe(false);
    expect(c.nonFinalTtlMs).toBe(10_000);
    expect(parseApiConfig({ ...env, OF_API_DIAG_HEADERS: '1' }).diagHeaders).toBe(true);
    expect(parseApiConfig({ ...env, OF_API_ADMIN_PORT: '0' }).adminPort).toBe(0);
    expect(() => parseApiConfig({ ...env, OF_API_ADMIN_PORT: '8780' })).toThrow(/ADMIN_PORT/);
    expect(() => parseApiConfig({ ...env, OF_API_REQUEST_TIMEOUT_MS: '0' })).toThrow();
  });

  it('W5: finale Antworten eine Woche ohne immutable, sonst no-cache', () => {
    expect(cacheControl(true)).toBe('public, max-age=604800');
    expect(cacheControl(false)).toBe('no-cache');
  });
});

describe('Cache-Ablauf (W1)', () => {
  it('Einträge mit expiresAt verfallen, finale nicht', () => {
    const c = new ResponseCache(1_000_000);
    const e = (exp: number | null) => ({
      body: Buffer.alloc(10),
      gzip: null,
      type: 'x',
      etag: 'e',
      final: exp === null,
      expiresAt: exp,
    });
    c.set('a', e(Date.now() - 1));
    c.set('b', e(Date.now() + 60_000));
    c.set('c', e(null));
    expect(c.get('a')).toBeUndefined();
    expect(c.has('a')).toBe(false);
    expect(c.get('b')).toBeDefined();
    expect(c.get('c')).toBeDefined();
  });
});

describe('Datenbankausfall', () => {
  it('Verbindungsverlust-Codes → 503-Klasse, andere nicht', () => {
    for (const c of [
      '57P01',
      '57P02',
      '57P03',
      '08006',
      '08003',
      '53300',
      'ECONNRESET',
      'CONNECTION_CLOSED',
    ])
      expect(isConnectionLoss(c), c).toBe(true);
    for (const c of [undefined, '42P01', '23505', '57014', '55P03'])
      expect(isConnectionLoss(c), String(c)).toBe(false);
  });

  it('Katalog: eine Warnung statt einer je Sekunde, Erholung wird gemeldet', async () => {
    const logs: string[] = [];
    let down = true;
    const sql = {
      begin: async () => {
        if (down) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        return new Map();
      },
    } as unknown as Sql;
    const cat = new Catalog(sql, {
      pollMs: 1000,
      lockRetries: 0,
      maxSourceRows: 1,
      log: (level, msg) => logs.push(`${level}:${msg}`),
    });
    for (let i = 0; i < 5; i++) await cat.refresh();
    expect(cat.failures).toBe(5);
    expect(logs.filter((l) => l.startsWith('warn'))).toHaveLength(1);
    down = false;
    await cat.refresh();
    expect(cat.failures).toBe(0);
    expect(logs.at(-1)).toMatch(/^info:.*wieder erfolgreich/);
  });
});
