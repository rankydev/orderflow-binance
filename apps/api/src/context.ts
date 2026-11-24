// Gemeinsame Typen der Routen: Abhängigkeiten und Kontext je Anfrage (Abbruch, Diagnose fürs Log).
import type { ResponseCache } from './cache.ts';
import type { Catalog, SymbolState } from './catalog.ts';
import type { ApiConfig } from './config.ts';
import { readTx, type ReadStats, type ReadTx, type Sql } from './db.ts';
import { HttpError, notFound } from './errors.ts';
import type { Limiter } from './limiter.ts';

export interface Deps {
  cfg: ApiConfig;
  sql: Sql;
  catalog: Catalog;
  cache: ResponseCache;
  limiter: Limiter;
}

export interface ReqCtx {
  /** Wird ausgelöst, wenn der Client die Verbindung schließt, bevor die Antwort fertig ist. */
  ac: AbortController;
  cache: 'hit' | 'miss' | null;
  src: string | null;
  rowsEstimate: number | null;
  db: ReadStats | null;
  bytes: number | null;
  rawBytes: number | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: ReqCtx;
  }
}

export function newCtx(): ReqCtx {
  return {
    ac: new AbortController(),
    cache: null,
    src: null,
    rowsEstimate: null,
    db: null,
    bytes: null,
    rawBytes: null,
  };
}

export function requireSymbol(deps: Deps, name: string): SymbolState {
  if (!deps.catalog.ready) throw new HttpError(503, 'API startet noch (Katalog lädt)', {}, 1);
  const s = deps.catalog.symbol(name);
  if (!s) throw notFound(`unbekanntes Symbol ${name}`);
  return s;
}

/** Lesetransaktion unter dem Gleichzeitigkeitslimit, mit Abbruch und Sperr-Wiederholung. */
export async function guardedRead<T>(
  deps: Deps,
  ctx: ReqCtx,
  fn: (tx: ReadTx) => Promise<T>,
): Promise<T> {
  const release = await deps.limiter.acquire(ctx.ac.signal);
  try {
    const { value, stats } = await readTx(
      deps.sql,
      { signal: ctx.ac.signal, lockRetries: deps.cfg.lockRetries },
      fn,
    );
    ctx.db = stats;
    return value;
  } finally {
    release();
  }
}
