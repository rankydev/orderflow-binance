// Gemeinsame Berechnung gleicher Anfragen (respond.ts) und Cache-Aufteilung final/nicht final:
// die Fälle, die das Review von Hand prüfen musste, als Unit-Tests.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ResponseCache, type CachedResponse } from '../src/cache.ts';
import { newCtx, type Deps } from '../src/context.ts';
import { inflightCount, serveVersioned } from '../src/respond.ts';

function deps(): Deps {
  return { cfg: { nonFinalTtlMs: 10_000 }, cache: new ResponseCache(1_000_000) } as unknown as Deps;
}
function req(inm?: string): FastifyRequest {
  return {
    headers: inm ? { 'if-none-match': inm } : {},
    ctx: newCtx(),
  } as unknown as FastifyRequest;
}
interface FakeReply {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
function rep(): FastifyReply & FakeReply {
  const r = {
    status: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    header(k: string, v: string) {
      r.headers[k.toLowerCase()] = v;
      return r;
    },
    type(t: string) {
      r.headers['content-type'] = t;
      return r;
    },
    code(c: number) {
      r.status = c;
      return r;
    },
    send(b?: unknown) {
      r.body = b;
      return r;
    },
  };
  return r as unknown as FastifyReply & FakeReply;
}
const resp = (etag: string, final = false): CachedResponse => ({
  body: Buffer.from(`body-${etag}`),
  gzip: null,
  type: 'application/json',
  etag,
  final,
});
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const PRE = { dataVersion: 'V', final: false };

describe('serveVersioned: gemeinsame Berechnung', () => {
  it('ein Wartender geht: die Abfrage läuft weiter, das Ergebnis wird gecacht', async () => {
    const d = deps();
    let aborted = false;
    let calls = 0;
    let release!: () => void;
    const compute = (ctx: ReturnType<typeof newCtx>) => {
      calls++;
      return new Promise<CachedResponse>((res, rej) => {
        release = () => res(resp('V'));
        ctx.ac.signal.addEventListener('abort', () => {
          aborted = true;
          rej(new Error('abgebrochen'));
        });
      });
    };
    const a = req();
    const b = req();
    const rb = rep();
    const pa = serveVersioned(d, a, rep(), 'k', PRE, compute).catch(
      (e: { status: number }) => e.status,
    );
    const pb = serveVersioned(d, b, rb, 'k', PRE, compute);
    await tick();
    expect(b.ctx.cache).toBe('shared');
    a.ctx.ac.abort();
    expect(await pa).toBe(499);
    expect(aborted).toBe(false);
    expect(inflightCount(d)).toBe(1);
    release();
    await pb;
    expect(calls).toBe(1);
    expect(String(rb.body)).toBe('body-V');
    expect(d.cache.has('k|V')).toBe(true);
    expect(inflightCount(d)).toBe(0);
  });

  it('alle Wartenden gehen: Abbruch der Abfrage, nichts gecacht, keine Flight-Leiche', async () => {
    const d = deps();
    let aborted = false;
    const compute = (ctx: ReturnType<typeof newCtx>) =>
      new Promise<CachedResponse>((_, rej) =>
        ctx.ac.signal.addEventListener('abort', () => {
          aborted = true;
          rej(new Error('DB-Abfrage abgebrochen'));
        }),
      );
    const a = req();
    const b = req();
    const pa = serveVersioned(d, a, rep(), 'k', PRE, compute).catch(
      (e: { status: number }) => e.status,
    );
    const pb = serveVersioned(d, b, rep(), 'k', PRE, compute).catch(
      (e: { status: number }) => e.status,
    );
    await tick();
    a.ctx.ac.abort();
    await tick();
    expect(aborted).toBe(false);
    b.ctx.ac.abort();
    await tick();
    expect(aborted).toBe(true);
    expect([await pa, await pb]).toEqual([499, 499]);
    expect(inflightCount(d)).toBe(0);
    expect(d.cache.has('k|V')).toBe(false);
    // eine neue Anfrage startet eine neue Berechnung
    let calls = 0;
    await serveVersioned(d, req(), rep(), 'k', PRE, async () => {
      calls++;
      return resp('V');
    });
    expect(calls).toBe(1);
  });

  it('Berechnung wirft: alle Wartenden bekommen den Fehler, nichts gecacht', async () => {
    const d = deps();
    let n = 0;
    const compute = async () => {
      n++;
      await tick(20);
      throw Object.assign(new Error('Datenbank nicht erreichbar'), { status: 503 });
    };
    const rs = await Promise.allSettled(
      [1, 2, 3].map(() => serveVersioned(d, req(), rep(), 'k', PRE, compute)),
    );
    expect(rs.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(rs.map((r) => (r as PromiseRejectedResult).reason.status)).toEqual([503, 503, 503]);
    expect(n).toBe(1);
    expect(inflightCount(d)).toBe(0);
    expect(d.cache.has('k|V')).toBe(false);
  });

  it('Snapshot-Version ≠ Katalog-Version: gespeichert unter der Snapshot-Version', async () => {
    const d = deps();
    const r = rep();
    await serveVersioned(d, req(), r, 'k', { dataVersion: 'OLD', final: false }, async () =>
      resp('NEW'),
    );
    expect(d.cache.has('k|NEW')).toBe(true);
    expect(d.cache.has('k|OLD')).toBe(false);
    expect(r.headers.etag).toBe('"NEW"');
  });

  it('If-None-Match = vorab berechnete Version → 304 ohne Berechnung; sonst Treffer aus dem Cache', async () => {
    const d = deps();
    let calls = 0;
    const compute = async () => {
      calls++;
      return resp('V', true);
    };
    const r1 = rep();
    await serveVersioned(d, req('"V"'), r1, 'k', { dataVersion: 'V', final: true }, compute);
    expect(r1.status).toBe(304);
    expect(r1.headers['cache-control']).toBe('public, max-age=604800');
    expect(calls).toBe(0);
    await serveVersioned(d, req(), rep(), 'k', { dataVersion: 'V', final: true }, compute);
    const q = req();
    await serveVersioned(d, q, rep(), 'k', { dataVersion: 'V', final: true }, compute);
    expect(calls).toBe(1);
    expect(q.ctx.cache).toBe('hit');
  });
});

describe('ResponseCache: final und nicht final getrennt', () => {
  const e = (n: number, ttl: number | null): CachedResponse => ({
    body: Buffer.alloc(n),
    gzip: null,
    type: 'x',
    etag: 'e',
    final: ttl === null,
    expiresAt: ttl === null ? null : Date.now() + ttl,
  });

  it('nicht finale Einträge verdrängen keine finalen (Anteil ≤ 25 %)', () => {
    const c = new ResponseCache(100_000);
    for (let i = 0; i < 7; i++) c.set(`f${i}`, e(10_000, null));
    for (let i = 0; i < 50; i++) c.set(`t${i}`, e(5_000, 60_000));
    for (let i = 0; i < 7; i++) expect(c.has(`f${i}`), `f${i}`).toBe(true);
    expect(c.stats().nonFinalBytes).toBeLessThanOrEqual(25_000);
    expect(c.stats().bytes).toBeLessThanOrEqual(100_000);
    expect(c.has('t49')).toBe(true); // die jüngsten bleiben
    expect(c.has('t0')).toBe(false);
  });

  it('abgelaufene nicht finale Einträge werden beim Einfügen weggeräumt', () => {
    const c = new ResponseCache(1_000_000);
    c.set('old', e(1_000, -1));
    c.sweep(Date.now(), true);
    expect(c.has('old')).toBe(false);
    expect(c.stats().nonFinalBytes).toBe(0);
  });
});
