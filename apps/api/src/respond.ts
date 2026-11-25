// Versionierte Antworten (Review W1): Revalidierung, Cache und Bündelung gleicher Anfragen, bevor
// eine Datenbankabfrage entsteht.
//
//   1. If-None-Match = vorab berechnete dataVersion (Katalog: Tagesversionen, ≤ pollMs alt) → 304,
//      ohne Datenabfrage und ohne Platz im Gleichzeitigkeitslimit.
//   2. Cache-Treffer unter (Schlüssel, dataVersion) – finale Antworten bis zur LRU-Verdrängung,
//      nicht finale höchstens nonFinalTtlMs lang.
//   3. Läuft dieselbe Berechnung schon, warten alle auf sie (ein Ansturm auf den laufenden Tag kostet
//      eine Abfrage). Die gemeinsame Abfrage bricht erst ab, wenn alle Wartenden abgebrochen haben.
//   4. Sonst rechnen: dataVersion und Daten stammen aus demselben Snapshot (compute); gespeichert wird
//      unter dieser dataVersion. Weicht sie vom Katalog ab, aktualisiert compute den Katalog.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CachedResponse } from './cache.ts';
import { newCtx, type Deps, type ReqCtx } from './context.ts';
import { HttpError } from './errors.ts';
import { cacheControl, matchesEtag, send } from './http.ts';

interface Flight {
  promise: Promise<CachedResponse>;
  ctx: ReqCtx;
  waiters: number;
}

const flights = new WeakMap<Deps, Map<string, Flight>>();

function flightsOf(deps: Deps): Map<string, Flight> {
  let m = flights.get(deps);
  if (!m) flights.set(deps, (m = new Map()));
  return m;
}

/** Anzahl laufender gemeinsamer Berechnungen (Diagnose/Tests). */
export function inflightCount(deps: Deps): number {
  return flightsOf(deps).size;
}

export async function serveVersioned(
  deps: Deps,
  req: FastifyRequest,
  reply: FastifyReply,
  key: string,
  pre: { dataVersion: string; final: boolean },
  compute: (ctx: ReqCtx) => Promise<CachedResponse>,
): Promise<FastifyReply> {
  // `If-None-Match: *` heißt „irgendeine Fassung existiert": nur mit einer gespeicherten erfolgreichen
  // Antwort dieser Version beantworten, sonst rechnen (eine Ablehnung wird nie zu 304, Review Pass 3).
  const inm = req.headers['if-none-match'];
  const star = (Array.isArray(inm) ? inm.join(',') : (inm ?? '')).trim() === '*';
  const cached = star ? deps.cache.peek(`${key}|${pre.dataVersion}`) : undefined;
  if (
    star
      ? cached !== undefined && (cached.status ?? 200) === 200
      : matchesEtag(req, pre.dataVersion)
  ) {
    req.ctx.cache = 'revalidated';
    req.ctx.bytes = 0;
    reply.header('ETag', `"${pre.dataVersion}"`);
    reply.header('Cache-Control', cacheControl(pre.final));
    reply.header('Vary', 'Accept-Encoding, Origin');
    return reply.code(304).send();
  }
  const ck = `${key}|${pre.dataVersion}`;
  const hit = deps.cache.get(ck);
  if (hit) {
    req.ctx.cache = 'hit';
    return send(req, reply, hit);
  }
  const all = flightsOf(deps);
  let f = all.get(ck);
  // eine schon abgebrochene Berechnung (alle Wartenden weg) nicht mehr teilen
  if (f?.ctx.ac.signal.aborted) f = undefined;
  if (f) req.ctx.cache = 'shared';
  else {
    req.ctx.cache = 'miss';
    const ctx = newCtx();
    ctx.src = req.ctx.src;
    ctx.rowsEstimate = req.ctx.rowsEstimate;
    const flight: Flight = { ctx, waiters: 0, promise: Promise.resolve(null as never) };
    flight.promise = (async () => {
      try {
        const r = await compute(ctx);
        r.expiresAt = r.final ? null : Date.now() + deps.cfg.nonFinalTtlMs;
        deps.cache.set(`${key}|${r.etag}`, r);
        return r;
      } finally {
        if (all.get(ck) === flight) all.delete(ck);
      }
    })();
    all.set(ck, (f = flight));
  }
  const flight = f;
  flight.waiters++;
  const signal = req.ctx.ac.signal;
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    if (--flight.waiters === 0) flight.ctx.ac.abort();
  };
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => {
      leave();
      reject(new HttpError(499, 'Client hat abgebrochen'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    const r = await Promise.race([flight.promise, aborted]);
    req.ctx.db = flight.ctx.db;
    return send(req, reply, r);
  } finally {
    if (!signal.aborted) {
      left = true;
      flight.waiters--;
    }
  }
}
