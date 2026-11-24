// Datenbankzugriff der API: Pool mit der nur lesenden Rolle, jede Anfrage als READ ONLY REPEATABLE
// READ-Transaktion (Tagesversionen und Daten aus demselben Snapshot), lock_timeout + begrenzte
// Wiederholung bei Sperrwartezeit (Importer konvertiert Chunks unter exklusiver Sperre),
// statement_timeout, Abbruch der laufenden Abfrage bei Client-Abbruch (Query.cancel → pg_cancel).
import postgres from 'postgres';
import type { ApiConfig } from './config.ts';
import { busy, HttpError } from './errors.ts';

export type Sql = postgres.Sql;
export type Row = unknown[];

export function createPool(cfg: ApiConfig, applicationName = 'orderflow-api'): Sql {
  return postgres({
    host: cfg.db.host,
    port: cfg.db.port,
    username: cfg.db.user,
    password: cfg.db.password,
    database: cfg.db.database,
    max: cfg.dbPool,
    idle_timeout: 300,
    max_lifetime: 3600,
    connect_timeout: 10,
    // Ungebundene Anweisungen: Postgres plant mit den tatsächlichen Werten (Chunk-Ausschluss beim
    // Planen); Zeitgrenzen stehen ohnehin als Literale im Text (queries.ts).
    prepare: false,
    onnotice: () => {},
    connection: {
      application_name: applicationName,
      statement_timeout: cfg.statementTimeoutMs,
      lock_timeout: cfg.lockTimeoutMs,
      idle_in_transaction_session_timeout: 30_000,
      default_transaction_read_only: true,
      timezone: 'UTC',
    },
  });
}

/** Ganzzahl aus einer Ergebnisspalte (int4 als Zahl, int8/numeric als Text); wirft außerhalb 2^53. */
export function int(v: unknown): number {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`Wert ${v} ist keine sichere Ganzzahl`);
    return v;
  }
  if (typeof v === 'string') {
    if (!/^-?\d+$/.test(v)) throw new Error(`Wert "${v}" ist keine Ganzzahl`);
    const n = Number(v);
    if (!Number.isSafeInteger(n))
      throw new Error(`Wert ${v} überschreitet 2^53 (nie per Number lesen)`);
    return n;
  }
  throw new Error(`Wert ${String(v)} ist keine Ganzzahl`);
}

/** Exakte große Ganzzahl (Notional) aus Text; leer/NULL → 0n. */
export function bigintOf(v: unknown): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new Error(`Wert ${String(v)} ist keine exakte Ganzzahl`);
}

const pgCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined;

export interface ReadStats {
  queries: number;
  attempts: number;
  dbMs: number;
}

export class ReadTx {
  private readonly tx: postgres.TransactionSql;
  private readonly signal: AbortSignal;
  readonly stats: ReadStats;
  constructor(tx: postgres.TransactionSql, signal: AbortSignal, stats: ReadStats) {
    this.tx = tx;
    this.signal = signal;
    this.stats = stats;
  }

  /** Führt eine Abfrage aus (Text nur aus Whitelists/Literalen, Werte als Parameter); Zeilen als Arrays. */
  async rows(text: string, params: (string | number)[] = []): Promise<Row[]> {
    if (this.signal.aborted) throw new HttpError(499, 'Client hat abgebrochen');
    const q = this.tx.unsafe(text, params).values();
    const onAbort = () => q.cancel();
    this.signal.addEventListener('abort', onAbort, { once: true });
    const t0 = performance.now();
    try {
      return (await q) as unknown as Row[];
    } finally {
      this.stats.queries++;
      this.stats.dbMs += performance.now() - t0;
      this.signal.removeEventListener('abort', onAbort);
    }
  }
}

export interface ReadOptions {
  signal: AbortSignal;
  lockRetries: number;
  /** Basis des Backoffs (ms) bei Sperrwartezeit: base, 3·base, 9·base … */
  backoffMs?: number;
}

/**
 * Lesetransaktion mit Wiederholung bei lock_not_available (55P03). Abbruch durch den Client → 499
 * (Antwort wird nicht mehr gesendet); statement_timeout → 503 mit Retry-After.
 */
export async function readTx<T>(
  sql: Sql,
  opt: ReadOptions,
  fn: (tx: ReadTx) => Promise<T>,
): Promise<{ value: T; stats: ReadStats }> {
  const stats: ReadStats = { queries: 0, attempts: 0, dbMs: 0 };
  const base = opt.backoffMs ?? 100;
  for (let attempt = 0; ; attempt++) {
    stats.attempts = attempt + 1;
    try {
      const value = (await sql.begin('isolation level repeatable read read only', (tx) =>
        fn(new ReadTx(tx, opt.signal, stats)),
      )) as T;
      return { value, stats };
    } catch (e) {
      if (opt.signal.aborted) throw new HttpError(499, 'Client hat abgebrochen');
      const code = pgCode(e);
      if (code === '55P03') {
        if (attempt < opt.lockRetries) {
          await new Promise((r) => setTimeout(r, base * 3 ** attempt));
          if (opt.signal.aborted) throw new HttpError(499, 'Client hat abgebrochen');
          continue;
        }
        throw busy('Daten werden gerade ersetzt (Sperre), bitte gleich erneut', 2);
      }
      if (code === '57014') throw busy('Abfrage zu langsam (statement_timeout)', 2);
      if (
        code === '53300' ||
        code === '57P03' ||
        code === 'ECONNREFUSED' ||
        code === 'CONNECT_TIMEOUT'
      )
        throw busy('Datenbank nicht erreichbar', 5);
      throw e;
    }
  }
}
