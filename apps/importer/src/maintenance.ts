// Wartung: offene („heiße") Chunks aus dem Columnstore zurück in den Rowstore (Migration 0015).
//
//   node --env-file-if-exists=.env apps/importer/src/main.ts repair-open-chunks [--dry-run]
//        [--lock-timeout-ms 2000] [--attempts 30]
//
// Ein Chunk, der noch Schreibzugriffe bekommen kann (range_end > now() - HOT_MARGIN), gehört nicht
// in den Columnstore: Live-Minuten machen ihn sonst dauerhaft teilweise komprimiert. Bis 0015 konnte
// ein manueller Komplett-Konvertierungslauf (2026-11-24, Messskript) offene Chunks komprimieren,
// und der Backfill hielt sie danach komprimiert. Dieses Kommando macht das rückgängig:
//  - je Chunk eine eigene Transaktion: lock_timeout, LOCK TABLE … ACCESS EXCLUSIVE, dann
//    convert_to_rowstore. convert_to_rowstore ist für ältere Snapshots nicht MVCC-sicher; die
//    Sperre zuerst wartet auf laufende Leser (die API sperrt ihre Chunks vor dem Snapshot), neue
//    Leser warten auf uns.
//  - idempotent: nur Chunks mit Status-Bit 1 (komprimiert) und offenem Zeitraum; ein zweiter Lauf
//    findet nichts mehr.
//  - als Eigentümer (of_admin) ausführen; der Recorder sollte dabei gestoppt sein (nicht nötig für
//    die Korrektheit, aber seine Schreibzugriffe verlängern die Sperrwartezeit nicht unnötig).
import type { Sql } from '@orderflow/db';
import { DIGEST_TABLES } from '@orderflow/core';
import { HOT_MARGIN } from './writer/postgres.ts';

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
     WHERE c.hypertable_schema = 'public' AND c.hypertable_name = ANY(${[...DIGEST_TABLES]}::text[])
       AND (k.status & 1) <> 0 AND (k.status & 4) = 0 AND NOT k.osm_chunk
       AND c.range_end > now() - ${HOT_MARGIN}::interval
     ORDER BY c.hypertable_name, c.range_start`;
  return rows.map((r) => ({
    chunk: r.c as string,
    hypertable: r.h as string,
    rangeEnd: r.e as string,
    status: r.status as number,
  }));
}

export async function repairOpenChunks(
  sql: Sql,
  o: {
    dryRun?: boolean;
    lockTimeoutMs?: number | undefined;
    attempts?: number | undefined;
    log?: (s: string) => void;
  },
): Promise<RepairResult[]> {
  const out: RepairResult[] = [];
  const timeout = Math.max(1, Math.trunc(o.lockTimeoutMs ?? 2000));
  const attempts = o.attempts ?? 30;
  for (const c of await openColumnstoreChunks(sql)) {
    if (o.dryRun) {
      out.push({ ...c, lockWaitMs: null, convertMs: null });
      o.log?.(
        `offen im Columnstore: ${c.chunk} (${c.hypertable}, Ende ${c.rangeEnd}, Status ${c.status})`,
      );
      continue;
    }
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
