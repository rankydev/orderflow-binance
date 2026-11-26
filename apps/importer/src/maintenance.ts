// Wartung: offene („heiße") Chunks aus dem Columnstore zurück in den Rowstore (Migration 0015).
//
//   node --env-file-if-exists=.env apps/importer/src/main.ts repair-open-chunks [--dry-run]
//        [--lock-timeout-ms 500] [--attempts 30] [--ignore-open-transactions]
//
// Ein Chunk, der noch Schreibzugriffe bekommen kann (range_end > now() - of_hot_margin()), gehört nicht
// in den Columnstore: Live-Minuten machen ihn sonst dauerhaft teilweise komprimiert. Bis 0015 konnte
// ein manueller Komplett-Konvertierungslauf (2026-11-24, Messskript) offene Chunks komprimieren,
// und der Backfill hielt sie danach komprimiert. Dieses Kommando macht das rückgängig:
//  - je Chunk eine eigene Transaktion: lock_timeout, LOCK TABLE … ACCESS EXCLUSIVE, dann
//    convert_to_rowstore. convert_to_rowstore ist für ältere Snapshots nicht MVCC-sicher; die
//    Sperre zuerst wartet auf laufende Leser (die API sperrt ihre Chunks vor dem Snapshot), neue
//    Leser warten auf uns.
//  - idempotent: nur Chunks mit Status-Bit 1 (komprimiert) und offenem Zeitraum; ein zweiter Lauf
//    findet nichts mehr.
//  - Sperre je Versuch höchstens 500 ms (unter der lock_timeout der API von 1 s: API-Leser hinter
//    unserer wartenden Sperre laufen nicht in ihre Zeitüberschreitung).
//  - bricht ab (vor jedem Chunk geprüft), solange auf der Datenbank eine andere Transaktion offen ist
//    (Review W1; ausgenommen nur API/Recorder-Transaktionen jünger als 5 s): ein REPEATABLE-READ-Leser ohne Chunk-Sperren (Prüfbericht verify-db.sql,
//    Dump-Probelauf) sähe den umgewandelten Chunk sonst leer und schlüge laut fehl. Überschreibbar
//    mit --ignore-open-transactions, wenn die offenen Transaktionen bekannt harmlos sind.
//  - als Eigentümer (of_admin) ausführen; der Recorder sollte dabei gestoppt sein (nicht nötig für
//    die Korrektheit, aber seine Schreibzugriffe verlängern die Sperrwartezeit nicht unnötig).
import type { Sql } from '@orderflow/db';
import { DATA_HYPERTABLES } from '@orderflow/core';

export interface RepairResult {
  chunk: string;
  hypertable: string;
  rangeEnd: string;
  status: number;
  /** Wartezeit auf die Sperre und Dauer der Konvertierung (ms); null bei --dry-run */
  lockWaitMs: number | null;
  convertMs: number | null;
}

/** Offene Chunks der Projekttabellen, die (auch teilweise) im Columnstore liegen. */
export async function openColumnstoreChunks(
  sql: Sql,
): Promise<Omit<RepairResult, 'lockWaitMs' | 'convertMs'>[]> {
  const rows = await sql`
    SELECT format('%I.%I', c.chunk_schema, c.chunk_name) AS c, c.hypertable_name AS h,
           c.range_end::text AS e, k.status
      FROM timescaledb_information.chunks c
      JOIN _timescaledb_catalog.chunk k
        ON k.relid = format('%I.%I', c.chunk_schema, c.chunk_name)::regclass
     WHERE c.hypertable_schema = 'public' AND c.hypertable_name = ANY(${[...DATA_HYPERTABLES]}::text[])
       AND (k.status & 1) <> 0 AND (k.status & 4) = 0 AND NOT k.osm_chunk
       AND c.range_end > now() - of_hot_margin()
     ORDER BY c.hypertable_name, c.range_start`;
  return rows.map((r) => ({
    chunk: r.c as string,
    hypertable: r.h as string,
    rangeEnd: r.e as string,
    status: r.status as number,
  }));
}

/**
 * Andere offene Transaktionen auf dieser Datenbank, die die Reparatur gefährden (W1). Ausgenommen
 * sind nur die bekannten kurzlebigen Anwendungen (API-Lesezugriffe und Katalog-Abfrage, Recorder-
 * Schreibvorgänge: Millisekunden; die API sperrt ihre Chunks vor dem Snapshot), solange sie jünger
 * als `shortMaxAgeMs` sind. Jede andere offene Transaktion zählt unabhängig vom Alter – auch ein
 * gerade begonnener REPEATABLE-READ-Leser (Prüfbericht, Dump), der den Chunk noch nicht gelesen hat.
 */
export const SHORT_LIVED_APPS = ['orderflow-api', 'orderflow-api-catalog', 'orderflow-recorder'];
export const SHORT_LIVED_MAX_AGE_MS = 5000;
export async function otherOpenTransactions(
  sql: Sql,
  shortMaxAgeMs = SHORT_LIVED_MAX_AGE_MS,
): Promise<{ pid: number; user: string; app: string; since: string; db: string }[]> {
  const rows = await sql`
    SELECT pid, usename AS u, application_name AS a, xact_start::text AS s, datname AS d
      FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid()
       AND backend_type = 'client backend' AND xact_start IS NOT NULL
       AND NOT (application_name = ANY(${SHORT_LIVED_APPS}::text[])
                AND xact_start >= statement_timestamp() - make_interval(secs => ${shortMaxAgeMs / 1000}))
     ORDER BY xact_start`;
  return rows.map((r) => ({
    pid: r.pid as number,
    user: r.u as string,
    app: r.a as string,
    since: r.s as string,
    db: r.d as string,
  }));
}

/**
 * Nur auf Test-Datenbanken (Review H2c): Skripte unter scripts/ oder bench/, die Chunks
 * konvertieren, rufen dies vorher auf. Der Vorfall vom 2026-11-24 war ein solches Skript gegen
 * die Entwicklungsdatenbank.
 */
export const TEST_DB_PATTERN = /_(test|probe)(_[a-z0-9_]+)?$/;
export async function assertTestDatabase(sql: Sql): Promise<string> {
  const [r] = await sql`SELECT current_database() AS d`;
  const db = r!.d as string;
  if (!TEST_DB_PATTERN.test(db))
    throw new Error(
      `Chunk-Konvertierung nur auf Test-Datenbanken (Muster ${TEST_DB_PATTERN}), nicht auf "${db}"`,
    );
  return db;
}

export async function repairOpenChunks(
  sql: Sql,
  o: {
    dryRun?: boolean;
    lockTimeoutMs?: number | undefined;
    attempts?: number | undefined;
    ignoreOpenTransactions?: boolean;
    /** Ab diesem Alter zählt auch eine Transaktion der kurzlebigen Anwendungen (Standard 5 s). */
    shortLivedMaxAgeMs?: number;
    log?: (s: string) => void;
  },
): Promise<RepairResult[]> {
  const out: RepairResult[] = [];
  const timeout = Math.max(1, Math.trunc(o.lockTimeoutMs ?? 500));
  const attempts = o.attempts ?? 30;
  const chunks = await openColumnstoreChunks(sql);
  // vor jedem Chunk prüfen: ein langer Leser kann auch zwischen zwei Chunks beginnen
  const checkOpen = async () => {
    if (o.ignoreOpenTransactions) return;
    const open = await otherOpenTransactions(sql, o.shortLivedMaxAgeMs ?? SHORT_LIVED_MAX_AGE_MS);
    if (open.length > 0)
      throw new Error(
        `repair-open-chunks: ${open.length} andere offene Transaktion(en) auf ${open[0]!.db} ` +
          `(${open.map((t) => `pid ${t.pid} ${t.app || t.user} seit ${t.since}`).join('; ')}). ` +
          'Ein REPEATABLE-READ-Leser ohne Chunk-Sperren (Prüfbericht, Dump) sähe umgewandelte Chunks leer. ' +
          'Abwarten oder, wenn harmlos, mit --ignore-open-transactions erneut starten.',
      );
  };
  for (const c of chunks) {
    if (o.dryRun) {
      out.push({ ...c, lockWaitMs: null, convertMs: null });
      o.log?.(
        `offen im Columnstore: ${c.chunk} (${c.hypertable}, Ende ${c.rangeEnd}, Status ${c.status})`,
      );
      continue;
    }
    await checkOpen();
    for (let i = 1; ; i++) {
      try {
        const t0 = performance.now();
        let t1 = t0;
        await sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL lock_timeout = '${timeout}ms'`);
          await tx.unsafe(`LOCK TABLE ${c.chunk} IN ACCESS EXCLUSIVE MODE`);
          t1 = performance.now();
          await tx.unsafe('CALL convert_to_rowstore($1::regclass, if_columnstore => true)', [
            c.chunk,
          ]);
        });
        const r = {
          ...c,
          lockWaitMs: Math.round(t1 - t0),
          convertMs: Math.round(performance.now() - t1),
        };
        out.push(r);
        o.log?.(
          `Rowstore: ${c.chunk} (${c.hypertable}, Ende ${c.rangeEnd}) Sperrwartezeit ${r.lockWaitMs} ms, Sperre gehalten ${r.convertMs} ms`,
        );
        break;
      } catch (e) {
        if (String((e as { code?: unknown }).code) !== '55P03' || i >= attempts) throw e;
        o.log?.(`${c.chunk}: Sperre nicht bekommen (Versuch ${i}/${attempts}), neuer Versuch`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  return out;
}
