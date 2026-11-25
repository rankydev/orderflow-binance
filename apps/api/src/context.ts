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
  /** hit: Cache; miss: berechnet; shared: an laufende gleiche Berechnung angehängt; revalidated: 304 */
  cache: 'hit' | 'miss' | 'shared' | 'revalidated' | null;
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

/**
 * Versionsstand frisch genug? 304 und Cache-Treffer beruhen auf der Tagesversionstabelle des Katalogs.
 * Unbrauchbar ist sie, wenn die Aktualisierung länger als staleAfterMs an Verbindungsverlust scheitert
 * oder seit 3 · staleAfterMs gar nicht mehr abschließt (hängende Verbindung) → 503 + Retry-After 5
 * und sofort ein (gebündelter) neuer Versuch. Scheitert sie an Sperren eines laufenden Imports, bleibt
 * der letzte Stand gültig (Daten ändern sich erst mit dem Commit) – nur Health meldet „degraded".
 */
export function assertFresh(deps: Deps): void {
  const c = deps.catalog;
  if (!c.ready) throw new HttpError(503, 'API startet noch (Katalog lädt)', {}, 1);
  const age = Date.now() - c.lastRefresh;
  const lost =
    c.lastError !== null && c.lastErrorKind === 'connection' && age > deps.cfg.staleAfterMs;
  const hung = age > 3 * deps.cfg.staleAfterMs;
  if (lost || hung) {
    void c.refresh();
    throw new HttpError(
      503,
      hung && !lost
        ? 'Datenstand nicht aktuell (Katalog-Aktualisierung hängt)'
        : 'Datenstand nicht aktuell (Datenbank nicht erreichbar)',
      {},
      5,
      'connection',
    );
  }
}

export function requireSymbol(deps: Deps, name: string): SymbolState {
  assertFresh(deps);
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
